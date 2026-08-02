"""The render worker: drains the job queue, one chapter at a time.

Runs as its own process (``python -m naudiobooker.worker``) so a synthesis
crash cannot take the API down with it, and so a render can saturate its
threads without making the UI unresponsive.

Audio is streamed to disk as it is produced rather than accumulated. A single
Calibre-split chapter can run to two and a half hours, which at 24 kHz float32
is roughly 860 MB in memory -- fine to write, ruinous to hold.
"""

from __future__ import annotations

import logging
import re
import signal
import threading
from collections import deque
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

from .. import jobs, store
from ..audio import (
    EncodeError,
    GainPlan,
    Loudness,
    M4BChapter,
    TrackTags,
    build_m4b,
    combine,
    measure,
    plan_gain,
    tag_mp3,
    wav_to_mp3,
)
from ..cache import ChunkCache, chunk_key
from ..config import Settings, get_settings
from ..db import init_db
from ..models import BookDetail, JobInfo
from ..text import Chunk, chunk_paragraphs
from ..tts import TTSError, get_backend
from ..tts.base import NO_OPTIONS, AudioChunk, ModelOptions, ReferenceClip, TTSBackend
from ..voices import VoiceLibrary

log = logging.getLogger(__name__)

#: Silence inserted between chunks. Paragraph breaks get a longer pause; this
#: is the one structural signal the source text hands us for free.
SENTENCE_GAP_S = 0.30
PARAGRAPH_GAP_S = 0.65

#: How often the worker checks whether it has been asked to stop. Cheap (one
#: indexed SELECT) so it can run between every chunk.
CANCEL_CHECK_EVERY = 5


class Cancelled(Exception):
    """The job was cancelled while running."""


class ShuttingDown(Exception):
    """The worker was asked to stop. The job is requeued, not cancelled.

    Distinct from Cancelled because the two mean opposite things to a user: one
    is "you asked for this to stop", the other is "the machine is going down
    and your render will resume". Conflating them would leave a book marked
    cancelled after a routine container restart.
    """


@dataclass
class _Progress:
    """Job-wide counters, kept here so chapter loops stay readable."""

    chunks_total: int = 0
    chunks_done: int = 0
    cache_hits: int = 0
    audio_seconds: float = 0.0
    chapters_done: int = 0
    plan: dict[int, list[Chunk]] = field(default_factory=dict)


#: Characters that are legal in a filename on Linux but break on Windows or in
#: a zip. Output lands on other people's machines, so be conservative.
_UNSAFE_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _render_dir(settings: Settings, book_id: str, job_id: str) -> Path:
    return settings.books_dir / book_id / "render" / job_id


def _safe_filename(text: str, limit: int = 60) -> str:
    cleaned = _UNSAFE_FILENAME.sub("", text).strip().rstrip(".")
    cleaned = " ".join(cleaned.split())
    return cleaned[:limit].strip() or "Untitled"


def _silence(seconds: float, sample_rate: int) -> np.ndarray:
    return np.zeros(int(seconds * sample_rate), dtype=np.float32)


def _plan_chunks(book_id: str, job: JobInfo, max_chars: int) -> _Progress:
    """Chunk every chapter before synthesising any of it.

    Costs a second of text processing and buys an honest progress bar: without
    a real total, a nine-hour render can only show a spinner.
    """
    progress = _Progress()
    for chapter in job.chapters:
        text = store.chapter_text(book_id, chapter.chapter_index)
        chunks = chunk_paragraphs(text.paragraphs, max_chars)
        progress.plan[chapter.chapter_index] = chunks
        progress.chunks_total += len(chunks)
        jobs.update_chapter(job.id, chapter.chapter_index, chunks_total=len(chunks))
    return progress


def _resolve_reference(job: JobInfo) -> ReferenceClip | None:
    """Find the reference clip a cloned voice points at.

    Resolved once per job rather than per chunk: it is a filesystem lookup, and
    a book is twenty thousand chunks.
    """
    if not job.voice_ref:
        return None

    library = VoiceLibrary.open()
    clip = library.by_hash(job.voice_ref)
    if clip is None:
        raise TTSError(
            f"the voice this render was queued with ({job.voice_ref[:12]}) is no "
            "longer in the voice library; re-upload the clip or pick another voice"
        )
    return ReferenceClip(
        path=library.path_for(clip),
        ref_hash=clip.ref_hash,
        transcript=getattr(clip, "transcript", None),
    )


def _check_cancelled(job_id: str, stop: threading.Event | None = None) -> None:
    # Shutdown is checked first and locally: it must not depend on a database
    # round trip, and a stopping worker should not be recorded as a
    # user-initiated cancellation.
    if stop is not None and stop.is_set():
        raise ShuttingDown
    if jobs.read_status(job_id) in ("cancelling", "cancelled"):
        raise Cancelled


def _in_order[T, R](work: Callable[[T], R], items: Sequence[T], concurrency: int) -> Iterator[R]:
    """Apply ``work`` to ``items`` concurrently, yielding results in order.

    Kokoro's ONNX graph is fixed at batch 1, so the only way to keep the GPU
    busy is to have several calls in flight at once. Results are still yielded
    in the original order, which is what makes this safe to drop into a loop
    that streams straight to a file: the audio is byte-identical to a serial
    render, only the wall-clock changes.

    The look-ahead is bounded at ``concurrency + 1``. Unbounded submission
    would race ahead of the consumer and hold every finished chunk in memory
    -- twenty thousand of them for a novel.
    """
    if concurrency <= 1:
        for item in items:
            yield work(item)
        return

    pool = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="synth")
    try:
        pending: deque[Future[R]] = deque()
        upcoming = iter(items)

        def fill() -> None:
            while len(pending) < concurrency + 1:
                nxt = next(upcoming, None)
                if nxt is None:
                    return
                pending.append(pool.submit(work, nxt))

        fill()
        while pending:
            result = pending.popleft().result()
            fill()
            yield result
    finally:
        # cancel_futures drops whatever has not started; the handful already
        # running still have to finish, which bounds how long a cancellation
        # takes to one chunk rather than one per worker.
        pool.shutdown(wait=True, cancel_futures=True)


def _render_chapter(
    *,
    job: JobInfo,
    chapter_index: int,
    chunks: list[Chunk],
    backend: TTSBackend,
    cache: ChunkCache,
    destination: Path,
    progress: _Progress,
    stop: threading.Event | None = None,
    reference: ReferenceClip | None = None,
    options: ModelOptions = NO_OPTIONS,
    concurrency: int = 1,
) -> float:
    """Synthesize one chapter to a WAV file. Returns its duration."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(".partial.wav")

    def render_one(chunk: Chunk) -> tuple[AudioChunk, bool]:
        """One chunk, start to finish. Returns (audio, came_from_cache).

        Deliberately free of shared mutable state: with concurrency > 1 this
        runs on a pool thread, and every counter it might have touched is
        updated by the consumer below instead, in chunk order.
        """
        # Keyed on the model, not the backend: a chunk made on the GPU node
        # and the same chunk made locally are interchangeable, and must
        # stay so across a mid-job fallback.
        key = chunk_key(
            model_version=backend.model_version,
            voice=job.voice,
            speed=job.speed,
            text=chunk.text,
            # A cloned voice is named by the user, so the name alone does
            # not identify the audio. Without the clip hash here, pointing
            # a voice at a new recording would serve the old one forever.
            voice_ref=job.voice_ref,
            # The tuning the job was queued with, not whatever the model
            # defaults to now. A render resumed after a settings change
            # must keep sounding like the chapters already on disk.
            options=options.cache_token(),
        )
        cached = cache.get(key)
        if cached is not None:
            return cached, True
        audio = backend.synthesize(chunk.text, job.voice, job.speed, reference, options)
        cache.put(key, audio)
        return audio, False

    duration = 0.0
    done_here = 0
    with sf.SoundFile(
        tmp, "w", samplerate=backend.sample_rate, channels=1, subtype="PCM_16"
    ) as out:
        for position, (audio, from_cache) in enumerate(_in_order(render_one, chunks, concurrency)):
            if position % CANCEL_CHECK_EVERY == 0:
                _check_cancelled(job.id, stop)

            chunk = chunks[position]
            if from_cache:
                progress.cache_hits += 1

            out.write(np.asarray(audio.samples, dtype=np.float32))
            duration += audio.duration_s

            gap = PARAGRAPH_GAP_S if chunk.ends_paragraph else SENTENCE_GAP_S
            if position < len(chunks) - 1:
                out.write(_silence(gap, backend.sample_rate))
                duration += gap

            progress.chunks_done += 1
            done_here += 1
            if done_here % 10 == 0 or position == len(chunks) - 1:
                jobs.update_chapter(job.id, chapter_index, chunks_done=done_here)
                jobs.update_progress(
                    job.id,
                    chunks_done=progress.chunks_done,
                    cache_hits=progress.cache_hits,
                    audio_seconds=progress.audio_seconds + duration,
                )

    tmp.replace(destination)
    return duration


@dataclass
class _Rendered:
    """A finished chapter WAV, ready to normalise and encode."""

    chapter_index: int
    title: str
    wav: Path
    duration_s: float
    loudness: Loudness | None = None
    plan: GainPlan | None = None


def _finalize(
    job: JobInfo,
    settings: Settings,
    book: BookDetail,
    out_dir: Path,
    stop: threading.Event | None = None,
) -> None:
    """Normalise, encode and tag everything the synthesis pass produced.

    Runs after synthesis rather than during it because loudness can only be
    measured once a chapter is complete -- normalising chunk by chunk would
    make every paragraph a slightly different volume.
    """
    jobs.update_progress(job.id, stage="encoding", current_title=None)

    finished = jobs.get_job(job.id)
    rendered: list[_Rendered] = []
    for chapter in finished.chapters:
        wav = out_dir / f"{chapter.chapter_index:03d}.wav"
        if chapter.status == "done" and wav.exists():
            rendered.append(
                _Rendered(
                    chapter_index=chapter.chapter_index,
                    title=chapter.title,
                    wav=wav,
                    duration_s=chapter.audio_seconds,
                )
            )

    if not rendered:
        return

    cover = store.cover_file(job.book_id)
    author = ", ".join(book.authors) or "Unknown author"
    year = str(book.created_at.year)
    mp3_dir = out_dir / "mp3"

    # One measurement pass over the whole book, then one gain for all of it.
    #
    # Per chapter was the obvious thing and the wrong one. Measured on Kokoro,
    # five very different passages in a single voice span 0.4 dB of RMS, so a
    # per-chapter correction is chasing inaudible noise -- and it is the wrong
    # shape besides, because normalising chapters independently flattens real
    # differences between them. Measuring is cheap either way: about three
    # seconds for a seventeen-hour book.
    measurements = []
    for item in rendered:
        _check_cancelled(job.id, stop)
        item.loudness = measure(item.wav)
        measurements.append(item.loudness)

    book_loudness = combine(measurements)
    plan = plan_gain(book_loudness)
    spread = max(m.rms_dbfs for m in measurements) - min(m.rms_dbfs for m in measurements)
    log.info(
        "job %s: book rms=%.1f peak=%.1f dBFS across %s chapters (rms spread %.1f dB)"
        " -> gain %+.1f dB, limiting %.1f dB",
        job.id,
        book_loudness.rms_dbfs,
        book_loudness.peak_dbfs,
        len(measurements),
        spread,
        plan.gain_db,
        plan.limiting_db,
    )

    for position, item in enumerate(rendered, start=1):
        _check_cancelled(job.id, stop)
        item.plan = plan

        mp3 = mp3_dir / f"{position:02d} {_safe_filename(item.title)}.mp3"
        wav_to_mp3(
            item.wav,
            mp3,
            gain_db=plan.gain_db,
            limit_dbfs=plan.limit_dbfs,
            bitrate=settings.mp3_bitrate,
        )
        tag_mp3(
            mp3,
            TrackTags(
                title=item.title,
                album=book.title,
                artist=author,
                track=position,
                total_tracks=len(rendered),
                year=year,
            ),
            cover=cover,
        )
        jobs.update_chapter(
            job.id, item.chapter_index, path=str(mp3), gain_db=round(plan.gain_db, 2)
        )

    artifact: Path | None = None
    if job.output_format in ("m4b", "both"):
        _check_cancelled(job.id, stop)
        jobs.update_progress(job.id, stage="building m4b")
        artifact = out_dir / f"{_safe_filename(book.title)}.m4b"
        build_m4b(
            [M4BChapter(title=r.title, source=r.wav, duration_s=r.duration_s) for r in rendered],
            artifact,
            title=book.title,
            artist=author,
            year=year,
            cover=cover,
            bitrate=settings.m4b_bitrate,
            work_dir=out_dir,
            gain_db=plan.gain_db,
            limit_dbfs=plan.limit_dbfs,
            sample_rate=settings.m4b_sample_rate,
        )

    # The intermediate WAVs are enormous -- roughly 170 MB per hour -- and
    # everything in them now exists as MP3 or M4B. Rebuilding them costs
    # nothing anyway: every chunk is still in the cache.
    for item in rendered:
        item.wav.unlink(missing_ok=True)

    if artifact is None:
        artifact = mp3_dir
    size = (
        artifact.stat().st_size
        if artifact.is_file()
        else sum(f.stat().st_size for f in artifact.rglob("*") if f.is_file())
    )
    jobs.update_progress(job.id, stage="complete", artifact_path=str(artifact), artifact_bytes=size)


def process_job(
    job: JobInfo,
    settings: Settings | None = None,
    stop: threading.Event | None = None,
) -> None:
    """Render every included chapter of one job."""
    settings = settings or get_settings()
    backend = get_backend(settings, job.model)
    cache = ChunkCache(settings.cache_dir)
    out_dir = _render_dir(settings, job.book_id, job.id)

    log.info(
        "job %s: rendering %s chapters with %s%s",
        job.id,
        len(job.chapters),
        job.model,
        f" (cloned voice {job.voice_ref[:12]})" if job.voice_ref else "",
    )
    try:
        reference = _resolve_reference(job)
        options = ModelOptions.from_dict(job.options)
        progress = _plan_chunks(job.book_id, job, backend.max_chars)
        jobs.update_progress(job.id, chunks_total=progress.chunks_total)

        for chapter in job.chapters:
            _check_cancelled(job.id, stop)
            chunks = progress.plan.get(chapter.chapter_index, [])
            destination = out_dir / f"{chapter.chapter_index:03d}.wav"

            if not chunks:
                jobs.update_chapter(job.id, chapter.chapter_index, status="skipped")
                progress.chapters_done += 1
                continue

            jobs.update_chapter(job.id, chapter.chapter_index, status="running")
            jobs.update_progress(job.id, current_title=chapter.title)

            try:
                duration = _render_chapter(
                    job=job,
                    chapter_index=chapter.chapter_index,
                    chunks=chunks,
                    backend=backend,
                    cache=cache,
                    destination=destination,
                    progress=progress,
                    stop=stop,
                    reference=reference,
                    options=options,
                    concurrency=settings.render_concurrency,
                )
            except Cancelled:
                raise
            except TTSError as exc:
                # One bad chapter should not throw away the other twenty that
                # rendered fine. Record it and carry on.
                log.exception("job %s: chapter %s failed", job.id, chapter.chapter_index)
                jobs.update_chapter(job.id, chapter.chapter_index, status="failed", error=str(exc))
                continue

            progress.audio_seconds += duration
            progress.chapters_done += 1
            jobs.update_chapter(
                job.id,
                chapter.chapter_index,
                status="done",
                audio_seconds=duration,
                path=str(destination),
            )
            jobs.update_progress(
                job.id,
                chapters_done=progress.chapters_done,
                audio_seconds=progress.audio_seconds,
            )

        book = store.load_book(job.book_id)
        try:
            _finalize(job, settings, book, out_dir, stop)
        except (Cancelled, ShuttingDown):
            raise
        except EncodeError as exc:
            # Synthesis is the expensive part and it succeeded; say so rather
            # than reporting a generic failure that implies the audio is gone.
            log.exception("job %s: encoding failed", job.id)
            jobs.finish_job(job.id, "failed", f"Audio rendered but encoding failed: {exc}")
            return

        failed = [c for c in jobs.get_job(job.id).chapters if c.status == "failed"]
        if failed:
            jobs.finish_job(job.id, "failed", f"{len(failed)} chapter(s) failed to render")
        else:
            jobs.finish_job(job.id, "done")
        log.info("job %s: finished", job.id)

    except ShuttingDown:
        # Not a failure and not a cancellation: the work is unfinished and will
        # be picked up again. Everything synthesized so far is in the cache, so
        # resuming costs almost nothing.
        log.info("job %s: worker stopping, requeued", job.id)
        jobs.requeue(job.id)
        raise
    except Cancelled:
        log.info("job %s: cancelled", job.id)
        jobs.finish_job(job.id, "cancelled")
    except Exception as exc:
        log.exception("job %s: failed", job.id)
        jobs.finish_job(job.id, "failed", str(exc))


@dataclass
class RenderWorker:
    settings: Settings
    stop: threading.Event = field(default_factory=threading.Event)

    def run(self) -> None:
        init_db(self.settings.db_path)
        reclaimed = jobs.reclaim_orphaned_jobs()
        if reclaimed:
            # Safe to requeue: every chunk already synthesized is in the cache,
            # so a restart re-does almost no work.
            log.info("requeued %s job(s) left running by a previous worker", reclaimed)

        log.info("worker ready (backend=%s)", self.settings.tts_backend)
        while not self.stop.is_set():
            job = jobs.claim_next_job()
            if job is None:
                # Event.wait rather than sleep, so a stop signal is acted on
                # immediately instead of after the poll interval elapses.
                self.stop.wait(self.settings.worker_poll_interval_s)
                continue
            try:
                process_job(job, self.settings, self.stop)
            except ShuttingDown:
                break
        log.info("worker stopped")


def _install_signal_handlers(worker: RenderWorker) -> None:
    """Stop cleanly on SIGTERM and SIGINT.

    Necessary, not merely tidy. In a container the worker is PID 1, and the
    kernel does not deliver a signal to PID 1 unless a handler is installed --
    the default disposition is simply skipped. So SIGTERM was being discarded,
    `docker stop` waited out its ten-second grace period, and the process was
    then SIGKILLed mid-render every single time.
    """

    def handle(signum, _frame):
        log.info("received %s, finishing current chunk then stopping", signal.Signals(signum).name)
        worker.stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, handle)


def run_forever(settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    settings.ensure_dirs()
    worker = RenderWorker(settings=settings)
    _install_signal_handlers(worker)
    try:
        worker.run()
    except KeyboardInterrupt:  # pragma: no cover - handler normally catches it
        worker.stop.set()
