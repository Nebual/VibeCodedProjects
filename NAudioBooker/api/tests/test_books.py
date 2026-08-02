"""Chapter text retrieval, including the partial reads the voice sampler uses."""

from __future__ import annotations

import pytest
from conftest import EpubBuilder, nav_doc, paragraphs
from fastapi.testclient import TestClient

from naudiobooker import store
from naudiobooker.config import Settings
from naudiobooker.db import init_db
from naudiobooker.main import create_app


@pytest.fixture
def env(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data", models_dir=tmp_path / "models")
    settings.ensure_dirs()
    init_db(settings.db_path)

    monkeypatch.setattr("naudiobooker.config.get_settings", lambda: settings)
    for module in ("naudiobooker.db", "naudiobooker.store"):
        monkeypatch.setattr(f"{module}.get_settings", lambda: settings, raising=False)
    return settings


@pytest.fixture
def book(env, tmp_path):
    b = EpubBuilder()
    b.add_doc("c1", "c1.xhtml", paragraphs(9, "alpha"))
    b.nav = nav_doc([("c1.xhtml", "Chapter One")])
    path = b.write(tmp_path / "book.epub")
    return store.create_book(path.read_bytes(), "book.epub")


def test_chapter_text_returns_every_paragraph_by_default(book) -> None:
    text = store.chapter_text(book.id, 0)
    assert len(text.paragraphs) == 9


def test_chapter_text_can_return_only_the_opening(book) -> None:
    text = store.chapter_text(book.id, 0, max_paragraphs=3)
    full = store.chapter_text(book.id, 0)

    assert text.paragraphs == full.paragraphs[:3]
    # The truncation must not change what the chapter claims to be, or the
    # sampler would label its passages with the wrong chapter.
    assert text.title == full.title
    assert text.index == full.index


def test_chapter_text_limit_larger_than_the_chapter_is_harmless(book) -> None:
    assert len(store.chapter_text(book.id, 0, max_paragraphs=500).paragraphs) == 9


def test_chapter_text_endpoint_honours_the_paragraph_limit(book) -> None:
    with TestClient(create_app()) as client:
        limited = client.get(f"/books/{book.id}/chapters/0/text?paragraphs=2")
        whole = client.get(f"/books/{book.id}/chapters/0/text")

    assert limited.status_code == 200
    assert len(limited.json()["paragraphs"]) == 2
    assert len(whole.json()["paragraphs"]) == 9


def test_chapter_text_endpoint_rejects_a_nonsense_limit(book) -> None:
    with TestClient(create_app()) as client:
        res = client.get(f"/books/{book.id}/chapters/0/text?paragraphs=0")

    assert res.status_code == 422
