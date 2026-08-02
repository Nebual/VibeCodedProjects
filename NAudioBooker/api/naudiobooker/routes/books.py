"""Book upload and chapter review endpoints.

These handlers are deliberately sync (``def``, not ``async def``): parsing an
EPUB is CPU-bound and takes hundreds of milliseconds on a large book. FastAPI
runs sync handlers on a threadpool, so a slow parse does not stall the event
loop and block every other request.
"""

from __future__ import annotations

import mimetypes
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from .. import jobs as job_queue
from .. import store
from ..epub import EpubError
from ..models import (
    BookDetail,
    BookSummary,
    BulkChapterUpdate,
    ChapterText,
    ChapterUpdate,
)

router = APIRouter(prefix="/books", tags=["books"])

#: Generous enough for an illustrated technical book, low enough that a
#: mistaken upload cannot fill the disk.
MAX_UPLOAD_BYTES = 200 * 1024 * 1024


def _get_or_404(book_id: str) -> BookDetail:
    try:
        return store.load_book(book_id)
    except store.BookNotFound:
        raise HTTPException(status_code=404, detail="Book not found") from None


@router.get("", response_model=list[BookSummary])
def list_books() -> list[BookSummary]:
    return store.list_books()


@router.post("", response_model=BookDetail, status_code=201)
def upload_book(file: Annotated[UploadFile, File()]) -> BookDetail:
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"EPUB exceeds the {MAX_UPLOAD_BYTES // 1024 // 1024} MB limit",
        )
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        return store.create_book(data, file.filename or "book.epub")
    except EpubError as exc:
        # The file is readable but not a usable book -- tell the user which,
        # rather than returning a generic 500.
        raise HTTPException(status_code=400, detail=f"Could not read EPUB: {exc}") from exc


@router.get("/{book_id}", response_model=BookDetail)
def get_book(book_id: str) -> BookDetail:
    return _get_or_404(book_id)


@router.delete("/{book_id}", status_code=204)
def delete_book(book_id: str) -> None:
    try:
        store.delete_book(book_id)
    except store.BookNotFound:
        raise HTTPException(status_code=404, detail="Book not found") from None
    # Job rows outlive the directory otherwise, and would resurface as
    # phantom entries in the job list.
    job_queue.delete_jobs_for_book(book_id)


@router.get("/{book_id}/cover")
def get_cover(book_id: str) -> FileResponse:
    _get_or_404(book_id)
    path = store.cover_file(book_id)
    if path is None:
        raise HTTPException(status_code=404, detail="This book has no cover")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type)


@router.get("/{book_id}/chapters/{index}/text", response_model=ChapterText)
def get_chapter_text(
    book_id: str,
    index: int,
    paragraphs: Annotated[
        int | None,
        Query(ge=1, description="Return only the first N paragraphs."),
    ] = None,
) -> ChapterText:
    _get_or_404(book_id)
    try:
        return store.chapter_text(book_id, index, max_paragraphs=paragraphs)
    except store.BookNotFound:
        raise HTTPException(status_code=404, detail="Chapter not found") from None


@router.patch("/{book_id}/chapters/{index}", response_model=BookDetail)
def update_chapter(book_id: str, index: int, update: ChapterUpdate) -> BookDetail:
    detail = _get_or_404(book_id)
    if not any(c.index == index for c in detail.chapters):
        raise HTTPException(status_code=404, detail="Chapter not found")
    return store.set_included(book_id, [index], update.include)


@router.patch("/{book_id}/chapters", response_model=BookDetail)
def update_chapters(book_id: str, update: BulkChapterUpdate) -> BookDetail:
    _get_or_404(book_id)
    return store.set_included(book_id, update.indices, update.include)
