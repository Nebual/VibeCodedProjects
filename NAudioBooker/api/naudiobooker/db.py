"""SQLite storage for render jobs.

The API process and the worker process are separate, and SQLite in WAL mode is
what keeps them coordinated: readers never block the writer, so the API can
serve progress while a render is hammering the database.

A connection is opened per operation rather than pooled. SQLite connections are
cheap, and per-operation connections sidestep the thread-affinity rules that
make a shared handle a liability across FastAPI's threadpool and the worker.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .config import get_settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT PRIMARY KEY,
    book_id         TEXT NOT NULL,
    status          TEXT NOT NULL,
    voice           TEXT NOT NULL,
    speed           REAL NOT NULL,
    backend         TEXT NOT NULL,
    model_version   TEXT NOT NULL,
    chapters_total  INTEGER NOT NULL DEFAULT 0,
    chapters_done   INTEGER NOT NULL DEFAULT 0,
    chunks_total    INTEGER NOT NULL DEFAULT 0,
    chunks_done     INTEGER NOT NULL DEFAULT 0,
    cache_hits      INTEGER NOT NULL DEFAULT 0,
    audio_seconds   REAL NOT NULL DEFAULT 0,
    current_title   TEXT,
    stage           TEXT,
    output_format   TEXT NOT NULL DEFAULT 'mp3',
    model           TEXT NOT NULL DEFAULT 'kokoro',
    voice_ref       TEXT,
    options         TEXT NOT NULL DEFAULT '{}',
    artifact_path   TEXT,
    artifact_bytes  INTEGER,
    error           TEXT,
    created_at      TEXT NOT NULL,
    started_at      TEXT,
    finished_at     TEXT,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS jobs_by_book ON jobs (book_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_chapters (
    job_id          TEXT NOT NULL,
    chapter_index   INTEGER NOT NULL,
    title           TEXT NOT NULL,
    status          TEXT NOT NULL,
    chunks_total    INTEGER NOT NULL DEFAULT 0,
    chunks_done     INTEGER NOT NULL DEFAULT 0,
    audio_seconds   REAL NOT NULL DEFAULT 0,
    path            TEXT,
    gain_db         REAL,
    error           TEXT,
    PRIMARY KEY (job_id, chapter_index),
    FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
);
"""


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    # WAL lets the API read progress while the worker writes it. Without it the
    # two processes would serialise and the UI would stall behind every update.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


@contextmanager
def connect(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    conn = _connect(path or get_settings().db_path)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """Write transaction. IMMEDIATE so two writers fail fast rather than
    deadlocking halfway through."""
    conn = _connect(path or get_settings().db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


#: Columns added after the first schema shipped. SQLite cannot add a column
#: conditionally, and a full migration framework is overkill for a single-user
#: self-hosted app, so missing columns are added one at a time at startup.
_ADDED_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "jobs": [
        ("stage", "TEXT"),
        ("output_format", "TEXT NOT NULL DEFAULT 'mp3'"),
        ("artifact_path", "TEXT"),
        ("artifact_bytes", "INTEGER"),
        ("model", "TEXT NOT NULL DEFAULT 'kokoro'"),
        # The cloned voice's clip hash. Recorded so a finished job says which
        # recording produced it, and so the cache key can be reconstructed.
        ("voice_ref", "TEXT"),
        # Per-request tuning, as a JSON object. Stored rather than derived
        # because the worker rebuilds the cache key from it long after the
        # request that chose it has gone.
        ("options", "TEXT NOT NULL DEFAULT '{}'"),
    ],
    "job_chapters": [
        ("gain_db", "REAL"),
    ],
}


def _apply_column_migrations(conn: sqlite3.Connection) -> None:
    for table, columns in _ADDED_COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, spec in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {spec}")


def init_db(path: Path | None = None) -> None:
    with connect(path) as conn:
        conn.executescript(SCHEMA)
        _apply_column_migrations(conn)
