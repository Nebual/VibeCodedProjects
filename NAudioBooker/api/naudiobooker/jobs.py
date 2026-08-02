"""Render job queue.

The API enqueues; the worker claims and drains. All coordination goes through
SQLite so the two processes need nothing else in common but a filesystem.
"""

from __future__ import annotations

import sqlite3
import uuid
from datetime import UTC, datetime

from . import db
from .models import TERMINAL_STATUSES, JobChapterInfo, JobInfo


class JobNotFound(Exception):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _job_from_row(row: sqlite3.Row, chapters: list[JobChapterInfo]) -> JobInfo:
    return JobInfo(**dict(row), chapters=chapters)


def _chapters_for(conn: sqlite3.Connection, job_id: str) -> list[JobChapterInfo]:
    rows = conn.execute(
        "SELECT chapter_index, title, status, chunks_total, chunks_done,"
        " audio_seconds, gain_db, error FROM job_chapters WHERE job_id = ?"
        " ORDER BY chapter_index",
        (job_id,),
    ).fetchall()
    return [JobChapterInfo(**dict(r)) for r in rows]


# ---------------------------------------------------------------------------
# Creating and reading
# ---------------------------------------------------------------------------


def create_job(
    *,
    book_id: str,
    voice: str,
    speed: float,
    backend: str,
    model_version: str,
    chapters: list[tuple[int, str]],
    output_format: str = "mp3",
) -> JobInfo:
    """Queue a render. ``chapters`` is (index, title) for included chapters."""
    job_id = uuid.uuid4().hex[:12]
    now = _now()

    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO jobs (id, book_id, status, voice, speed, backend,"
            " model_version, chapters_total, output_format, created_at, updated_at)"
            " VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                job_id,
                book_id,
                voice,
                speed,
                backend,
                model_version,
                len(chapters),
                output_format,
                now,
                now,
            ),
        )
        conn.executemany(
            "INSERT INTO job_chapters (job_id, chapter_index, title, status)"
            " VALUES (?, ?, ?, 'pending')",
            [(job_id, index, title) for index, title in chapters],
        )
    return get_job(job_id)


def get_job(job_id: str) -> JobInfo:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFound(job_id)
        return _job_from_row(row, _chapters_for(conn, job_id))


def list_jobs(book_id: str | None = None, limit: int = 50) -> list[JobInfo]:
    query = "SELECT * FROM jobs"
    params: tuple = ()
    if book_id:
        query += " WHERE book_id = ?"
        params = (book_id,)
    query += " ORDER BY created_at DESC LIMIT ?"
    params += (limit,)

    with db.connect() as conn:
        rows = conn.execute(query, params).fetchall()
        return [_job_from_row(r, _chapters_for(conn, r["id"])) for r in rows]


def active_job_for_book(book_id: str) -> JobInfo | None:
    """A book may have at most one job in flight, so the UI can say so."""
    with db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE book_id = ? AND status IN"
            " ('queued', 'running', 'cancelling') ORDER BY created_at DESC LIMIT 1",
            (book_id,),
        ).fetchone()
        if row is None:
            return None
        return _job_from_row(row, _chapters_for(conn, row["id"]))


# ---------------------------------------------------------------------------
# Worker-side operations
# ---------------------------------------------------------------------------


def claim_next_job() -> JobInfo | None:
    """Atomically take the oldest queued job.

    The UPDATE ... WHERE id = (SELECT ...) is what makes this safe with more
    than one worker: SQLite serialises the write, so exactly one claim wins.
    """
    with db.transaction() as conn:
        row = conn.execute(
            "UPDATE jobs SET status = 'running', started_at = ?, updated_at = ?"
            " WHERE id = ("
            "   SELECT id FROM jobs WHERE status = 'queued'"
            "   ORDER BY created_at LIMIT 1"
            " ) RETURNING id",
            (_now(), _now()),
        ).fetchone()
        job_id = row["id"] if row else None

    return get_job(job_id) if job_id else None


def update_progress(
    job_id: str,
    *,
    chunks_done: int | None = None,
    chunks_total: int | None = None,
    chapters_done: int | None = None,
    cache_hits: int | None = None,
    audio_seconds: float | None = None,
    current_title: str | None = None,
    stage: str | None = None,
    artifact_path: str | None = None,
    artifact_bytes: int | None = None,
) -> None:
    fields: dict[str, object] = {
        "chunks_done": chunks_done,
        "chunks_total": chunks_total,
        "chapters_done": chapters_done,
        "cache_hits": cache_hits,
        "audio_seconds": audio_seconds,
        "current_title": current_title,
        "stage": stage,
        "artifact_path": artifact_path,
        "artifact_bytes": artifact_bytes,
    }
    assignments = {k: v for k, v in fields.items() if v is not None}
    if not assignments:
        return

    clause = ", ".join(f"{k} = ?" for k in assignments)
    with db.transaction() as conn:
        conn.execute(
            f"UPDATE jobs SET {clause}, updated_at = ? WHERE id = ?",
            (*assignments.values(), _now(), job_id),
        )


def update_chapter(
    job_id: str,
    chapter_index: int,
    *,
    status: str | None = None,
    chunks_total: int | None = None,
    chunks_done: int | None = None,
    audio_seconds: float | None = None,
    path: str | None = None,
    gain_db: float | None = None,
    error: str | None = None,
) -> None:
    fields = {
        "status": status,
        "chunks_total": chunks_total,
        "chunks_done": chunks_done,
        "audio_seconds": audio_seconds,
        "path": path,
        "gain_db": gain_db,
        "error": error,
    }
    assignments = {k: v for k, v in fields.items() if v is not None}
    if not assignments:
        return

    clause = ", ".join(f"{k} = ?" for k in assignments)
    with db.transaction() as conn:
        conn.execute(
            f"UPDATE job_chapters SET {clause} WHERE job_id = ? AND chapter_index = ?",
            (*assignments.values(), job_id, chapter_index),
        )


def finish_job(job_id: str, status: str, error: str | None = None) -> None:
    with db.transaction() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, error = ?, finished_at = ?, updated_at = ?,"
            " current_title = NULL WHERE id = ?",
            (status, error, _now(), _now(), job_id),
        )


def read_status(job_id: str) -> str | None:
    """Cheap status probe, used by the worker to notice cancellation."""
    with db.connect() as conn:
        row = conn.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return row["status"] if row else None


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------


def request_cancel(job_id: str) -> JobInfo:
    """Ask a job to stop.

    A queued job is cancelled outright. A running one is only *asked*: the
    worker is mid-synthesis and must notice between chunks, so it moves to
    'cancelling' and the worker completes the transition.
    """
    with db.transaction() as conn:
        row = conn.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFound(job_id)
        if row["status"] in TERMINAL_STATUSES:
            return get_job(job_id)

        new_status = "cancelled" if row["status"] == "queued" else "cancelling"
        finished = _now() if new_status == "cancelled" else None
        conn.execute(
            "UPDATE jobs SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            (new_status, finished, _now(), job_id),
        )
    return get_job(job_id)


def requeue(job_id: str) -> None:
    """Put a running job back on the queue.

    Used when the worker is shutting down: the job was neither cancelled nor
    finished, so leaving it 'running' with no worker alive would show it as
    in-progress forever. Requeuing costs almost nothing because every chunk
    already synthesized is in the cache.
    """
    with db.transaction() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'queued', started_at = NULL, current_title = NULL,"
            " stage = NULL, updated_at = ? WHERE id = ? AND status IN ('running', 'cancelling')",
            (_now(), job_id),
        )


def reclaim_orphaned_jobs() -> int:
    """Requeue jobs a dead worker left marked running.

    Called at worker startup. Safe because the chunk cache makes a restart
    nearly free -- everything already synthesized is still on disk.
    """
    with db.transaction() as conn:
        cursor = conn.execute(
            "UPDATE jobs SET status = 'queued', started_at = NULL, updated_at = ?"
            " WHERE status IN ('running', 'cancelling')",
            (_now(),),
        )
        return cursor.rowcount


def delete_jobs_for_book(book_id: str) -> None:
    with db.transaction() as conn:
        conn.execute("DELETE FROM jobs WHERE book_id = ?", (book_id,))
