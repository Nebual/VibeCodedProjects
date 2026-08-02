"""Split chapter text into pieces small enough to synthesize.

Chunk boundaries are audible. A cut mid-sentence produces a seam no crossfade
can hide, because the prosody either side was generated independently and the
intonation will not match. So the rule is: never split a sentence unless that
single sentence exceeds the backend's limit on its own, and then split it at
the strongest punctuation available.

Paragraph membership is carried through because it determines pacing. Phase 4
uses ``ends_paragraph`` to place a longer silence between paragraphs than
between sentences.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: Words that end in a period without ending a sentence. Splitting after these
#: is the single most common way naive sentence splitters mangle prose.
_ABBREVIATIONS = frozenset(
    # Grouped by kind and kept as prose rather than a list literal: this is a
    # word list that will keep growing, and one token per line would make it
    # unreadable. (ruff: SIM905 does not apply usefully here.)
    """
    mr mrs ms mx dr prof rev fr sr jr st mt messrs
    capt col gen lt maj sgt cmdr adm gov pres supt
    inc ltd co corp dept est univ assn bros
    vs etc al ca cf viz approx approxi
    jan feb mar apr jun jul aug sept sep oct nov dec
    mon tue tues wed thu thurs fri sat sun
    vol no pp fig figs ed eds trans repr
    """.split()  # noqa: SIM905
)

# A sentence ends at .!? plus any closing quotes or brackets, followed by
# whitespace. Whether it *really* ends there is decided by _is_boundary.
_CANDIDATE = re.compile(r"""([.!?]+)(["'’”)\]]*)(\s+)""")

# The token immediately before the punctuation.
_LAST_WORD = re.compile(r"([A-Za-zÀ-ɏ.]+)$")

# A single capital letter, i.e. an initial in "J. R. R. Tolkien".
_INITIAL = re.compile(r"^[A-Z]$")

# Punctuation to fall back on when one sentence is too long by itself, in
# descending order of how natural a pause it makes.
_FALLBACK_BREAKS = (";", ":", "—", ",")


@dataclass(frozen=True)
class Chunk:
    text: str
    #: Index into the paragraph list this chunk's text came from.
    paragraph_index: int
    #: True when this chunk finishes a paragraph, so a longer pause follows.
    ends_paragraph: bool


def _is_boundary(text: str, end_of_punct: int, after: str) -> bool:
    """Decide whether a candidate stop is a real sentence end."""
    before = text[:end_of_punct]

    # Ellipses inside a sentence ("she paused ... then spoke") are not stops.
    # A capital afterwards suggests it really was one.
    if before.endswith("..") and not after[:1].isupper():
        return False

    match = _LAST_WORD.search(before.rstrip(".!?"))
    if match:
        word = match.group(1).rstrip(".")
        if word.lower() in _ABBREVIATIONS:
            return False
        if _INITIAL.match(word):
            return False

    # A lowercase word after the stop means it was not one -- except after a
    # closing quote, where dialogue attribution legitimately continues
    # ("Stop!" he said.) and we still do not want to break.
    return not after[:1].islower()


def split_sentences(text: str) -> list[str]:
    """Split one paragraph into sentences."""
    text = text.strip()
    if not text:
        return []

    sentences: list[str] = []
    start = 0
    for match in _CANDIDATE.finditer(text):
        end = match.end(2)
        if not _is_boundary(text, end, text[match.end() :]):
            continue
        piece = text[start:end].strip()
        if piece:
            sentences.append(piece)
        start = match.end()

    tail = text[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


def _split_long_sentence(sentence: str, limit: int) -> list[str]:
    """Break a single over-long sentence at the least-bad place."""
    if len(sentence) <= limit:
        return [sentence]

    for mark in _FALLBACK_BREAKS:
        parts = [p.strip() for p in sentence.split(mark) if p.strip()]
        if len(parts) < 2:
            continue
        # Reattach the mark so the pause survives into the audio.
        rebuilt = [p + mark for p in parts[:-1]] + [parts[-1]]
        if all(len(p) <= limit for p in rebuilt):
            return _pack(rebuilt, limit)

    # No punctuation to lean on: a very long unpunctuated run. Break on
    # whitespace, which is audible but the least damaging option left.
    words, out, current = sentence.split(), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) > limit and current:
            out.append(current)
            current = word
        else:
            current = candidate
    if current:
        out.append(current)
    return out


def _pack(pieces: list[str], limit: int) -> list[str]:
    """Greedily combine pieces without exceeding the limit."""
    packed: list[str] = []
    current = ""
    for piece in pieces:
        candidate = f"{current} {piece}".strip()
        if current and len(candidate) > limit:
            packed.append(current)
            current = piece
        else:
            current = candidate
    if current:
        packed.append(current)
    return packed


def chunk_paragraphs(paragraphs: list[str], max_chars: int) -> list[Chunk]:
    """Turn a chapter's paragraphs into synthesis chunks.

    Chunks never span paragraphs. Merging across a paragraph break would lose
    the pause that break represents, and paragraph boundaries are the one
    structural signal the source text gives us for free.
    """
    if max_chars < 1:
        raise ValueError("max_chars must be positive")

    chunks: list[Chunk] = []
    for index, paragraph in enumerate(paragraphs):
        sentences: list[str] = []
        for sentence in split_sentences(paragraph):
            sentences.extend(_split_long_sentence(sentence, max_chars))

        packed = _pack(sentences, max_chars)
        for position, text in enumerate(packed):
            chunks.append(
                Chunk(
                    text=text,
                    paragraph_index=index,
                    ends_paragraph=position == len(packed) - 1,
                )
            )
    return chunks
