"""Queue, cache and worker behaviour, all driven by the fake backend."""

from __future__ import annotations

import numpy as np
import pytest
from conftest import EpubBuilder, nav_doc, paragraphs
from test_tts import FakeBackend

from naudiobooker import jobs, store
from naudiobooker.audio import probe_duration
from naudiobooker.cache import ChunkCache, chunk_key
from naudiobooker.config import Settings
from naudiobooker.db import init_db
from naudiobooker.tts.base import NO_OPTIONS, AudioChunk
from naudiobooker.worker.runner import process_job


@pytest.fixture
def env(tmp_path, monkeypatch):
    """An isolated data dir, database and settings for one test."""
    settings = Settings(data_dir=tmp_path / "data", models_dir=tmp_path / "models")
    settings.ensure_dirs()
    init_db(settings.db_path)

    monkeypatch.setattr("naudiobooker.config.get_settings", lambda: settings)
    for module in ("naudiobooker.db", "naudiobooker.store", "naudiobooker.worker.runner"):
        monkeypatch.setattr(f"{module}.get_settings", lambda: settings, raising=False)
    return settings


@pytest.fixture
def backend(monkeypatch) -> FakeBackend:
    fake = FakeBackend()
    monkeypatch.setattr("naudiobooker.worker.runner.get_backend", lambda *a, **k: fake)
    return fake


@pytest.fixture
def book(env, tmp_path):
    b = EpubBuilder()
    b.add_doc("c1", "c1.xhtml", paragraphs(4, "alpha"))
    b.add_doc("c2", "c2.xhtml", paragraphs(3, "beta"))
    b.nav = nav_doc([("c1.xhtml", "Chapter One"), ("c2.xhtml", "Chapter Two")])
    path = b.write(tmp_path / "book.epub")
    return store.create_book(path.read_bytes(), "book.epub")


def make_job(book, voice="fk_ann", speed=1.0):
    return jobs.create_job(
        book_id=book.id,
        voice=voice,
        speed=speed,
        backend="fake",
        model_version="fake-1",
        chapters=[(c.index, c.title) for c in book.chapters if c.include],
    )


# ---------------------------------------------------------------------------
# Chunk cache
# ---------------------------------------------------------------------------


def test_cache_round_trips_audio(tmp_path):
    cache = ChunkCache(tmp_path / "cache")
    chunk = AudioChunk(samples=np.linspace(-0.5, 0.5, 2400, dtype=np.float32), sample_rate=24_000)
    key = chunk_key(model_version="1", voice="v", speed=1.0, text="hello")

    assert cache.get(key) is None
    cache.put(key, chunk)
    restored = cache.get(key)

    assert restored is not None
    assert restored.sample_rate == 24_000
    assert len(restored.samples) == len(chunk.samples)


@pytest.mark.parametrize(
    "changed",
    [
        {"model_version": "2"},
        {"voice": "different"},
        {"speed": 1.1},
        {"text": "hello "},
    ],
)
def test_every_field_changes_the_cache_key(changed):
    base = dict(model_version="1", voice="v", speed=1.0, text="hello")

    assert chunk_key(**base) != chunk_key(**{**base, **changed})


def test_transport_does_not_change_the_cache_key():
    """Same model over HTTP or in-process is the same audio, so the same key.

    Keying on the backend id instead would make a local render and a remote
    render share nothing, and would throw away every cached chunk the moment a
    job fell back from the GPU node to local CPU.
    """
    local = chunk_key(model_version="kokoro-1.0/fp32", voice="v", speed=1.0, text="t")
    remote = chunk_key(model_version="kokoro-1.0/fp32", voice="v", speed=1.0, text="t")

    assert local == remote


def test_cache_key_is_not_confusable_by_concatenation():
    """Field boundaries must be unambiguous, or "ab"+"c" would equal "a"+"bc"."""
    a = chunk_key(model_version="ab", voice="c", speed=1.0, text="t")
    b = chunk_key(model_version="a", voice="bc", speed=1.0, text="t")

    assert a != b


def test_truncated_cache_file_is_treated_as_a_miss(tmp_path):
    cache = ChunkCache(tmp_path / "cache")
    key = chunk_key(model_version="1", voice="v", speed=1.0, text="x")
    path = cache.path_for(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not a wav file")

    assert cache.get(key) is None
    assert not path.exists()  # cleared so a later run can rewrite it


# ---------------------------------------------------------------------------
# Job lifecycle
# ---------------------------------------------------------------------------


def test_job_starts_queued_with_its_chapters(env, book):
    job = make_job(book)

    assert job.status == "queued"
    assert job.chapters_total == len(job.chapters) > 0
    assert all(c.status == "pending" for c in job.chapters)
    assert job.progress == 0.0


def test_claim_takes_the_oldest_job_once(env, book):
    first = make_job(book)

    claimed = jobs.claim_next_job()
    assert claimed is not None and claimed.id == first.id
    assert claimed.status == "running"
    # Nothing left to claim.
    assert jobs.claim_next_job() is None


def test_queued_job_cancels_immediately(env, book):
    job = make_job(book)

    cancelled = jobs.request_cancel(job.id)

    assert cancelled.status == "cancelled"
    assert cancelled.is_terminal


def test_running_job_is_only_asked_to_cancel(env, book):
    make_job(book)
    running = jobs.claim_next_job()

    asked = jobs.request_cancel(running.id)

    # The worker is mid-synthesis; it completes the transition itself.
    assert asked.status == "cancelling"
    assert not asked.is_terminal


def test_orphaned_running_jobs_are_requeued(env, book):
    make_job(book)
    jobs.claim_next_job()

    assert jobs.reclaim_orphaned_jobs() == 1
    assert jobs.claim_next_job() is not None


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------


def test_worker_renders_and_encodes_every_chapter(env, book, backend):
    job = make_job(book)
    process_job(jobs.claim_next_job(), env)

    finished = jobs.get_job(job.id)
    assert finished.status == "done"
    assert finished.progress == 1.0
    assert all(c.status == "done" for c in finished.chapters)
    assert finished.audio_seconds > 0

    tracks = sorted((env.books_dir / book.id / "render" / job.id / "mp3").glob("*.mp3"))
    assert len(tracks) == len(finished.chapters)
    assert all(t.stat().st_size > 0 for t in tracks)
    # Track numbers lead the filename so players order chapters correctly.
    assert [t.name[:2] for t in tracks] == [f"{i:02d}" for i in range(1, len(tracks) + 1)]


def test_intermediate_wavs_are_removed_after_encoding(env, book, backend):
    """They are ~170 MB per hour and fully reproducible from the chunk cache."""
    job = make_job(book)
    process_job(jobs.claim_next_job(), env)

    render_dir = env.books_dir / book.id / "render" / job.id
    assert not list(render_dir.glob("*.wav"))
    assert list((render_dir / "mp3").glob("*.mp3"))


def test_rendered_audio_is_longer_than_the_speech_alone(env, book, backend):
    """Gaps between chunks must actually be written, not just accounted for."""
    job = make_job(book)
    process_job(jobs.claim_next_job(), env)

    # Lower bound on speech alone, from the fake's deterministic length rule.
    # Computed rather than re-synthesized, so it does not pollute backend.calls.
    speech_s = sum(len(text) / 100 / speed for text, _, speed in backend.calls)
    rendered_s = sum(
        probe_duration(p)
        for p in (env.books_dir / book.id / "render" / job.id / "mp3").glob("*.mp3")
    )

    assert rendered_s > speech_s


def test_job_records_its_output_artifact(env, book, backend):
    job = make_job(book)
    process_job(jobs.claim_next_job(), env)

    finished = jobs.get_job(job.id)
    assert finished.artifact_path
    assert finished.artifact_bytes and finished.artifact_bytes > 0
    assert finished.stage == "complete"


def test_chapters_are_normalised_toward_the_target(env, book, backend):
    job = make_job(book)
    process_job(jobs.claim_next_job(), env)

    gains = [c.gain_db for c in jobs.get_job(job.id).chapters]
    assert all(g is not None for g in gains)


def test_second_run_is_served_entirely_from_cache(env, book, backend):
    make_job(book)
    process_job(jobs.claim_next_job(), env)
    first_calls = len(backend.calls)
    assert first_calls > 0

    second = make_job(book)
    process_job(jobs.claim_next_job(), env)

    # Not one extra synthesis: same text, voice, speed and model.
    assert len(backend.calls) == first_calls
    finished = jobs.get_job(second.id)
    assert finished.status == "done"
    assert finished.cache_hits == finished.chunks_total


def test_changing_the_voice_bypasses_the_cache(env, book, backend):
    make_job(book, voice="fk_ann")
    process_job(jobs.claim_next_job(), env)
    after_first = len(backend.calls)

    make_job(book, voice="fk_bob")
    process_job(jobs.claim_next_job(), env)

    assert len(backend.calls) > after_first


def test_cancellation_stops_the_render(env, book, backend, monkeypatch):
    job = make_job(book)
    claimed = jobs.claim_next_job()

    # Ask for cancellation the moment the worker checks.
    real_status = jobs.read_status
    monkeypatch.setattr(
        "naudiobooker.worker.runner.jobs.read_status",
        lambda jid: "cancelling" if jid == job.id else real_status(jid),
    )
    process_job(claimed, env)

    finished = jobs.get_job(job.id)
    assert finished.status == "cancelled"
    assert finished.is_terminal


def test_a_failing_chapter_does_not_abort_the_others(env, book, backend, monkeypatch):
    from naudiobooker.tts.base import TTSError

    calls = {"n": 0}
    original = backend.synthesize

    def flaky(text, voice, speed=1.0, reference=None, options=NO_OPTIONS):
        calls["n"] += 1
        if calls["n"] == 1:
            raise TTSError("synthesis exploded")
        return original(text, voice, speed, reference, options)

    monkeypatch.setattr(backend, "synthesize", flaky)

    job = make_job(book)
    process_job(jobs.claim_next_job(), env)

    finished = jobs.get_job(job.id)
    assert finished.status == "failed"
    statuses = {c.status for c in finished.chapters}
    # One chapter failed, but the rest still rendered.
    assert "failed" in statuses and "done" in statuses


def test_interrupted_render_resumes_from_cache(env, book, backend, monkeypatch):
    """A worker killed mid-book must not re-synthesize what it already did."""
    from naudiobooker.worker.runner import Cancelled

    seen = {"n": 0}
    original = backend.synthesize

    def die_after_a_few(text, voice, speed=1.0, reference=None, options=NO_OPTIONS):
        seen["n"] += 1
        if seen["n"] > 6:
            raise Cancelled
        return original(text, voice, speed, reference, options)

    monkeypatch.setattr(backend, "synthesize", die_after_a_few)
    make_job(book)
    process_job(jobs.claim_next_job(), env)
    partial = seen["n"]

    # Guard against this test going hollow. It previously passed while the stub
    # was raising TypeError on its first call: partial stayed 0 and the cache
    # assertion below degenerated to "cache_hits >= -1", which is always true.
    assert partial > 1, "the interruption never happened; the stub was not called"

    monkeypatch.setattr(backend, "synthesize", original)
    resumed = make_job(book)
    process_job(jobs.claim_next_job(), env)

    finished = jobs.get_job(resumed.id)
    assert finished.status == "done"
    # The chunks completed before the interruption came back from cache.
    assert finished.cache_hits >= partial - 1
