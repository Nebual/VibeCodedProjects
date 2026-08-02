"""API-facing models for books and chapters."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, computed_field

JobStatus = Literal["queued", "running", "cancelling", "cancelled", "done", "failed"]

#: Statuses from which a job will not move on its own.
TERMINAL_STATUSES: frozenset[str] = frozenset({"cancelled", "done", "failed"})

#: Narration rate used for duration estimates. Real speech lands between about
#: 140 and 160 wpm depending on voice and speed; this is only ever an estimate
#: shown in the UI, never used for synthesis.
WORDS_PER_MINUTE = 150


class ChapterInfo(BaseModel):
    index: int
    title: str
    section: str | None = None
    include: bool
    skip_reason: str | None = None
    word_count: int
    #: Zip paths this chapter's text came from. Useful when a parse looks wrong.
    sources: list[str] = Field(default_factory=list)

    @computed_field
    @property
    def est_seconds(self) -> float:
        return round(self.word_count / WORDS_PER_MINUTE * 60, 1)


class BookSummary(BaseModel):
    id: str
    title: str
    authors: list[str]
    has_cover: bool
    created_at: datetime
    chapter_count: int
    included_words: int

    @computed_field
    @property
    def est_seconds(self) -> float:
        return round(self.included_words / WORDS_PER_MINUTE * 60, 1)


class BookDetail(BookSummary):
    language: str | None = None
    identifier: str | None = None
    publisher: str | None = None
    source_filename: str
    #: True when the EPUB had no usable nav document or NCX and the chapter
    #: list was inferred from the spine. Titles are unreliable in that case, so
    #: the UI warns about it.
    toc_synthesised: bool = False
    chapters: list[ChapterInfo]

    @computed_field
    @property
    def total_words(self) -> int:
        return sum(c.word_count for c in self.chapters)


class VoiceInfo(BaseModel):
    id: str
    label: str
    language: str
    gender: str | None = None


class PreviewRequest(BaseModel):
    voice: str
    #: Empty means "use the built-in sample sentence".
    text: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


class NodeInfo(BaseModel):
    """What a remote synthesiser reports about itself."""

    available: bool
    detail: str
    backend: str
    model_version: str
    sample_rate: int
    max_chars: int
    #: False means the node accepts unauthenticated synthesis requests.
    authenticated: bool = False


class ChapterText(BaseModel):
    index: int
    title: str
    paragraphs: list[str]


OutputFormat = Literal["mp3", "m4b", "both"]


class RenderRequest(BaseModel):
    voice: str
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    output_format: OutputFormat = "mp3"


class JobChapterInfo(BaseModel):
    chapter_index: int
    title: str
    status: Literal["pending", "running", "done", "failed", "skipped"]
    chunks_total: int
    chunks_done: int
    audio_seconds: float
    gain_db: float | None = None
    error: str | None = None

    @computed_field
    @property
    def has_audio(self) -> bool:
        return self.status == "done" and self.audio_seconds > 0


class JobInfo(BaseModel):
    id: str
    book_id: str
    status: JobStatus
    voice: str
    speed: float
    backend: str
    model_version: str
    chapters_total: int
    chapters_done: int
    chunks_total: int
    chunks_done: int
    cache_hits: int
    audio_seconds: float
    current_title: str | None = None
    #: Coarse phase, so the UI can say "Encoding" once the progress bar is full.
    stage: str | None = None
    output_format: OutputFormat = "mp3"
    artifact_path: str | None = None
    artifact_bytes: int | None = None
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    chapters: list[JobChapterInfo] = Field(default_factory=list)

    @computed_field
    @property
    def progress(self) -> float:
        """Fraction complete, 0..1. Chunks rather than chapters, because
        chapter sizes vary by an order of magnitude within one book."""
        if self.chunks_total <= 0:
            return 1.0 if self.status in TERMINAL_STATUSES else 0.0
        return round(min(self.chunks_done / self.chunks_total, 1.0), 4)

    @computed_field
    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES


class ChapterUpdate(BaseModel):
    include: bool


class BulkChapterUpdate(BaseModel):
    """Set inclusion on many chapters at once.

    The review UI's "include all" / "exclude all" controls would otherwise fire
    one request per chapter and race each other on the stored book record.
    """

    indices: list[int]
    include: bool
