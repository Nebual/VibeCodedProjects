"""Chunker behaviour.

Chunk boundaries are audible, so these tests care about *where* text is cut at
least as much as whether it fits.
"""

from __future__ import annotations

import pytest

from naudiobooker.text import chunk_paragraphs, split_sentences

# --------------------------------------------------------------------------
# Sentence splitting
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("One. Two. Three.", 3),
        ("Dr. Smith went to St. Mary's. He arrived.", 2),
        ("J. R. R. Tolkien wrote it. Many read it.", 2),
        ("Meet me at 5 p.m. sharp. Do not be late.", 2),
        ("She paused ... then spoke. It ended.", 2),
        ("No terminal punctuation here", 1),
        ("Wait! Stop! Now?", 3),
        ("", 0),
    ],
)
def test_sentence_counts(text: str, expected: int) -> None:
    assert len(split_sentences(text)) == expected


def test_closing_quote_stays_with_its_sentence() -> None:
    assert split_sentences('"Stop," she said. He stopped.') == [
        '"Stop," she said.',
        "He stopped.",
    ]


def test_abbreviation_does_not_end_a_sentence() -> None:
    assert split_sentences("The dept. handles it.") == ["The dept. handles it."]


# --------------------------------------------------------------------------
# Chunking
# --------------------------------------------------------------------------


def test_chunks_never_exceed_the_limit() -> None:
    paragraph = " ".join(f"This is sentence number {n}." for n in range(60))

    chunks = chunk_paragraphs([paragraph], max_chars=120)

    assert chunks
    assert all(len(c.text) <= 120 for c in chunks)


def test_chunks_never_span_paragraphs() -> None:
    chunks = chunk_paragraphs(["First para.", "Second para."], max_chars=500)

    assert [c.text for c in chunks] == ["First para.", "Second para."]
    assert [c.paragraph_index for c in chunks] == [0, 1]
    assert all(c.ends_paragraph for c in chunks)


def test_only_the_last_chunk_of_a_paragraph_ends_it() -> None:
    paragraph = " ".join(f"Sentence {n} is here." for n in range(20))

    chunks = chunk_paragraphs([paragraph], max_chars=60)

    assert len(chunks) > 1
    assert [c.ends_paragraph for c in chunks] == [False] * (len(chunks) - 1) + [True]


def test_no_text_is_lost_or_duplicated() -> None:
    paragraphs = [
        "The first paragraph has several sentences. Here is another one. And a third.",
        "A short second.",
        " ".join(f"Filler sentence {n}." for n in range(30)),
    ]

    chunks = chunk_paragraphs(paragraphs, max_chars=100)

    original = " ".join(paragraphs).split()
    produced = " ".join(c.text for c in chunks).split()
    assert produced == original


def test_a_sentence_longer_than_the_limit_breaks_at_punctuation() -> None:
    sentence = (
        "The road went on and on; it climbed past the mill, "
        "turned sharply at the bridge: and then it stopped."
    )

    chunks = chunk_paragraphs([sentence], max_chars=60)

    assert all(len(c.text) <= 60 for c in chunks)
    # The pause markers survive rather than being stripped at the split.
    assert any(c.text.rstrip().endswith((";", ":", ",")) for c in chunks)


def test_unpunctuated_run_falls_back_to_word_boundaries() -> None:
    text = " ".join(["word"] * 200)

    chunks = chunk_paragraphs([text], max_chars=50)

    assert all(len(c.text) <= 50 for c in chunks)
    assert all(" word" in c.text or c.text == "word" for c in chunks)
    # Never mid-word.
    assert all(not c.text.startswith("ord") for c in chunks)


def test_empty_paragraphs_produce_nothing() -> None:
    assert chunk_paragraphs(["", "   "], max_chars=100) == []


def test_invalid_limit_is_rejected() -> None:
    with pytest.raises(ValueError):
        chunk_paragraphs(["text"], max_chars=0)
