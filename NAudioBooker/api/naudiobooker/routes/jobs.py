"""Render job endpoints, including the live progress stream."""

from __future__ import annotations

import asyncio
import re
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from .. import jobs as job_queue
from .. import store
from ..config import get_settings
from ..models import JobInfo, RenderRequest
from ..tts import BackendUnavailable, get_backend
from ..tts.models import get_model
from ..voices import VoiceError, resolve_reference

router = APIRouter(tags=["jobs"])

#: How often the SSE stream re-reads job state. Fast enough to feel live,
#: slow enough that a nine-hour render does not spend its time being queried.
POLL_INTERVAL_S = 0.5

#: Proxies and browsers drop idle connections; a comment line keeps the
#: stream alive without confusing the EventSource client.
HEARTBEAT_EVERY_S = 15.0


def _safe_name(text: str, limit: int = 60) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", text).strip().rstrip(".")
    return " ".join(cleaned.split())[:limit].strip() or "audiobook"


def _job_or_404(job_id: str) -> JobInfo:
    try:
        return job_queue.get_job(job_id)
    except job_queue.JobNotFound:
        raise HTTPException(status_code=404, detail="Job not found") from None


@router.post("/books/{book_id}/render", response_model=JobInfo, status_code=201)
def start_render(book_id: str, request: RenderRequest) -> JobInfo:
    try:
        book = store.load_book(book_id)
    except store.BookNotFound:
        raise HTTPException(status_code=404, detail="Book not found") from None

    included = [(c.index, c.title) for c in book.chapters if c.include]
    if not included:
        raise HTTPException(
            status_code=400,
            detail="No chapters are selected for narration.",
        )

    existing = job_queue.active_job_for_book(book_id)
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"A render is already {existing.status} for this book.",
        )

    settings = get_settings()
    # The model chosen in the UI. Dropping it here is silent: create_job
    # defaults the column to "kokoro", so the job looks well-formed and the
    # worker dutifully renders the wrong model hours later.
    try:
        spec = get_model(request.model or settings.tts_model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Resolved now rather than in the worker so an unusable pairing is rejected
    # while someone is still looking at the screen.
    try:
        reference = resolve_reference(spec, request.voice)
    except VoiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        backend = get_backend(settings, spec.id)
        model_version = backend.model_version
    except (BackendUnavailable, NotImplementedError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return job_queue.create_job(
        book_id=book_id,
        voice=request.voice,
        speed=request.speed,
        backend=backend.id,
        model=spec.id,
        voice_ref=reference.ref_hash if reference else None,
        model_version=model_version,
        chapters=included,
        output_format=request.output_format,
    )


@router.get("/books/{book_id}/jobs", response_model=list[JobInfo])
def list_book_jobs(book_id: str) -> list[JobInfo]:
    return job_queue.list_jobs(book_id=book_id)


@router.get("/jobs", response_model=list[JobInfo])
def list_all_jobs(limit: int = 50) -> list[JobInfo]:
    return job_queue.list_jobs(limit=limit)


@router.get("/jobs/{job_id}", response_model=JobInfo)
def get_job(job_id: str) -> JobInfo:
    return _job_or_404(job_id)


@router.post("/jobs/{job_id}/cancel", response_model=JobInfo)
def cancel_job(job_id: str) -> JobInfo:
    try:
        return job_queue.request_cancel(job_id)
    except job_queue.JobNotFound:
        raise HTTPException(status_code=404, detail="Job not found") from None


@router.get("/jobs/{job_id}/chapters/{index}/audio")
def get_chapter_audio(job_id: str, index: int) -> FileResponse:
    """Play one chapter.

    Serves the intermediate WAV while a render is still in flight and the
    tagged MP3 once finalisation has replaced it, so playback keeps working
    across the handover rather than 404ing for the minute encoding takes.
    """
    job = _job_or_404(job_id)
    render_dir = Path(get_settings().books_dir) / job.book_id / "render" / job.id

    wav = render_dir / f"{index:03d}.wav"
    if wav.exists():
        return FileResponse(wav, media_type="audio/wav", filename=wav.name)

    chapter = next((c for c in job.chapters if c.chapter_index == index), None)
    if chapter is not None:
        position = [c.chapter_index for c in job.chapters if c.status == "done"]
        if index in position:
            track = position.index(index) + 1
            matches = sorted((render_dir / "mp3").glob(f"{track:02d} *.mp3"))
            if matches:
                return FileResponse(matches[0], media_type="audio/mpeg", filename=matches[0].name)

    raise HTTPException(status_code=404, detail="That chapter has not rendered yet")


@router.get("/jobs/{job_id}/download")
def download_artifact(job_id: str) -> FileResponse:
    """The finished audiobook: the M4B, or a zip of the tagged MP3s."""
    job = _job_or_404(job_id)
    if not job.artifact_path:
        raise HTTPException(
            status_code=409,
            detail="This render has not produced its output yet.",
        )

    artifact = Path(job.artifact_path)
    if artifact.is_file():
        return FileResponse(artifact, media_type="audio/mp4", filename=artifact.name)

    if not artifact.is_dir():
        raise HTTPException(status_code=404, detail="Output files are missing.")

    book = store.load_book(job.book_id)
    # Zipped once and kept: MP3 is already compressed so ZIP_STORED is just
    # framing, and rebuilding it on every download would re-read the whole
    # book from disk.
    archive = artifact.parent / f"{_safe_name(book.title)}.zip"
    if not archive.exists():
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as zf:
            for track in sorted(artifact.glob("*.mp3")):
                zf.write(track, arcname=f"{_safe_name(book.title)}/{track.name}")

    return FileResponse(archive, media_type="application/zip", filename=archive.name)


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str) -> StreamingResponse:
    """Server-sent events carrying job state until the job reaches a terminal
    status, at which point the stream closes and the client stops reconnecting."""
    _job_or_404(job_id)

    async def stream() -> AsyncIterator[str]:
        last_payload: str | None = None
        since_heartbeat = 0.0
        while True:
            try:
                # Sync SQLite read, kept off the event loop.
                job = await run_in_threadpool(job_queue.get_job, job_id)
            except job_queue.JobNotFound:
                yield 'event: gone\ndata: {"detail":"job deleted"}\n\n'
                return

            payload = job.model_dump_json()
            if payload != last_payload:
                yield f"data: {payload}\n\n"
                last_payload = payload
                since_heartbeat = 0.0

            if job.is_terminal:
                yield "event: end\ndata: {}\n\n"
                return

            await asyncio.sleep(POLL_INTERVAL_S)
            since_heartbeat += POLL_INTERVAL_S
            if since_heartbeat >= HEARTBEAT_EVERY_S:
                yield ": keepalive\n\n"
                since_heartbeat = 0.0

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Nginx and friends buffer streamed responses by default, which
            # would hold every progress update until the render finished.
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
