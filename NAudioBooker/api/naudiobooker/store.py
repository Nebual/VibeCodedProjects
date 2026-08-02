"""Filesystem-backed storage for books and their extracted text.

Deliberately not a database yet. Phase 1 only needs to persist a parse result
and a set of include flags, and a directory per book keeps the extracted text
inspectable with an editor while the parser is still being tuned. Phase 3
introduces SQLite for job state; this module is the seam where book records
would move across.

Layout::

    data/books/<id>/
        source.epub      the uploaded file, kept for re-parsing and re-rendering
        book.json        metadata and the chapter list
        cover.<ext>      extracted cover image, if the book has one
        text/000.txt     extracted paragraphs, blank-line separated
"""

from __future__ import annotations

import os
import posixpath
import shutil
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

from .config import get_settings
from .epub import EpubError, build_chapters, open_epub
from .models import BookDetail, BookSummary, ChapterInfo, ChapterText

_BOOK_JSON = "book.json"
_TEXT_DIR = "text"

# Guards read-modify-write of book.json. Inclusion toggles from the review UI
# arrive in bursts, and FastAPI runs sync endpoints on a threadpool, so two
# writes can genuinely overlap.
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class BookNotFound(Exception):
    pass


def _lock_for(book_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(book_id, threading.Lock())


def _book_dir(book_id: str) -> Path:
    return get_settings().books_dir / book_id


def _write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _save(detail: BookDetail) -> None:
    _write_atomic(
        _book_dir(detail.id) / _BOOK_JSON,
        detail.model_dump_json(indent=2).encode(),
    )


def load_book(book_id: str) -> BookDetail:
    path = _book_dir(book_id) / _BOOK_JSON
    try:
        return BookDetail.model_validate_json(path.read_bytes())
    except FileNotFoundError as exc:
        raise BookNotFound(book_id) from exc


def list_books() -> list[BookSummary]:
    books_dir = get_settings().books_dir
    if not books_dir.exists():
        return []

    summaries: list[BookSummary] = []
    for entry in books_dir.iterdir():
        if not entry.is_dir():
            continue
        try:
            summaries.append(BookSummary.model_validate(load_book(entry.name).model_dump()))
        except (BookNotFound, ValueError):
            # A half-written or hand-mangled directory should not take down the
            # whole library listing.
            continue
    summaries.sort(key=lambda b: b.created_at, reverse=True)
    return summaries


def _store_cover(pkg, zf, dest_dir: Path) -> bool:
    if not pkg.cover_href:
        return False
    try:
        data = zf.read(pkg.cover_href)
    except KeyError:
        return False
    ext = posixpath.splitext(pkg.cover_href)[1].lower() or ".jpg"
    (dest_dir / f"cover{ext}").write_bytes(data)
    return True


def cover_file(book_id: str) -> Path | None:
    directory = _book_dir(book_id)
    if not directory.exists():
        return None
    for candidate in sorted(directory.glob("cover.*")):
        return candidate
    return None


def create_book(epub_bytes: bytes, filename: str) -> BookDetail:
    """Parse an uploaded EPUB and persist it. Raises EpubError if unusable."""
    book_id = uuid.uuid4().hex[:12]
    directory = _book_dir(book_id)
    (directory / _TEXT_DIR).mkdir(parents=True, exist_ok=True)

    source = directory / "source.epub"
    source.write_bytes(epub_bytes)

    try:
        pkg, zf = open_epub(source)
    except EpubError:
        shutil.rmtree(directory, ignore_errors=True)
        raise

    try:
        drafts = build_chapters(pkg, zf.read)
        if not drafts:
            raise EpubError("no readable text found in this EPUB")
        has_cover = _store_cover(pkg, zf, directory)
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    finally:
        zf.close()

    chapters: list[ChapterInfo] = []
    for draft in drafts:
        (directory / _TEXT_DIR / f"{draft.index:03d}.txt").write_text(
            "\n\n".join(draft.paragraphs), encoding="utf-8"
        )
        chapters.append(
            ChapterInfo(
                index=draft.index,
                title=draft.title,
                section=draft.section,
                include=draft.include,
                skip_reason=draft.skip_reason,
                word_count=draft.word_count,
                sources=[s.href for s in draft.segments],
            )
        )

    detail = BookDetail(
        id=book_id,
        title=pkg.metadata.title,
        authors=list(pkg.metadata.authors),
        language=pkg.metadata.language,
        identifier=pkg.metadata.identifier,
        publisher=pkg.metadata.publisher,
        has_cover=has_cover,
        created_at=datetime.now(UTC),
        source_filename=filename,
        toc_synthesised=pkg.toc_synthesised,
        chapter_count=len(chapters),
        included_words=sum(c.word_count for c in chapters if c.include),
        chapters=chapters,
    )
    _save(detail)
    return detail


def chapter_text(book_id: str, index: int, *, max_paragraphs: int | None = None) -> ChapterText:
    """Extracted paragraphs for one chapter.

    ``max_paragraphs`` exists for callers that only want the opening -- the
    voice sampler pulls the first few paragraphs of three chapters at once, and
    a full chapter is tens of kilobytes of JSON it would immediately discard.
    """
    detail = load_book(book_id)
    chapter = next((c for c in detail.chapters if c.index == index), None)
    if chapter is None:
        raise BookNotFound(f"{book_id}/{index}")

    path = _book_dir(book_id) / _TEXT_DIR / f"{index:03d}.txt"
    raw = path.read_text(encoding="utf-8") if path.exists() else ""
    paragraphs = [p for p in raw.split("\n\n") if p.strip()]
    if max_paragraphs is not None:
        paragraphs = paragraphs[:max_paragraphs]
    return ChapterText(
        index=index,
        title=chapter.title,
        paragraphs=paragraphs,
    )


def set_included(book_id: str, indices: list[int], include: bool) -> BookDetail:
    with _lock_for(book_id):
        detail = load_book(book_id)
        wanted = set(indices)
        for chapter in detail.chapters:
            if chapter.index in wanted:
                chapter.include = include
                if include:
                    # The reason described why we skipped it by default; once
                    # the user opts in, keeping it would just be confusing.
                    chapter.skip_reason = None
        detail.included_words = sum(c.word_count for c in detail.chapters if c.include)
        _save(detail)
        return detail


def delete_book(book_id: str) -> None:
    directory = _book_dir(book_id)
    if not directory.exists():
        raise BookNotFound(book_id)
    shutil.rmtree(directory, ignore_errors=True)
