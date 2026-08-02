"""Reconcile the spine and the table of contents into narratable chapters.

The spine is authoritative for *order* and for what content exists; the TOC is
authoritative for *titles* and for where chapters begin. Neither alone is
enough:

- The TOC routinely omits real content (covers, inter-chapter ad cards).
- The spine has no titles, and a publisher may split one chapter across
  several files or pack several chapters into one file behind fragments.
"""

from __future__ import annotations

import posixpath
import re
from collections.abc import Callable
from dataclasses import dataclass, field, replace

from .cleaner import count_words, extract_paragraphs, guess_title
from .parser import EpubPackage

# Matched against both the TOC label and the filename. These are the sections a
# listener does not want read aloud; the review UI can re-enable any of them.
_SKIP = re.compile(
    r"""
      ^\s*(title|praise|backlist|epigraph|half[\s-]*title|frontmatter|teaser)\s*$
    | ^\s*(illustrations?|list\s+of\s+illustrations?)\s*$
    | ^\s*(cover|copyright|colophon|index)\b
    | \b(title\s*page|table\s*of\s*contents|contents|toc)\b
    | \b(also\s+by|(books|novels)\s+by|about\s+the\s+(author|publisher))\b
    | \b(advertisement|ad\s*card|backad)\b
    | \b(newsletter|sign[\s-]*up|praise\s+for|excerpt\s+from|backlist)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Filenames produced by conversion tools rather than chosen by a publisher.
# Calibre in particular emits "<book>_split_014.html" and "index_split_000.html",
# splitting on file size rather than chapter boundaries.
_CONVERTER_FILENAME = re.compile(
    r"(split[_\s-]?\d+ | ^part\d{3,}$ | ^index$ | ^\d+$ | ^page[_\s-]?\d+$)",
    re.IGNORECASE | re.VERBOSE,
)

#: A chapter spanning several spine documents and running longer than this is
#: almost always a conversion artefact rather than a real chapter -- a
#: size-based split with one TOC entry ("Begin Reading") covering all of it.
#: Splitting it back apart at document boundaries is arbitrary, but far better
#: than a single ten-hour track. Chapters inside one document are never split,
#: however long, because there is no defensible place to cut.
MAX_WORDS_BEFORE_SPLIT = 20_000

#: Sections shorter than this are half-title pages, dedications, epigraphs and
#: illustration lists rather than chapters. They are excluded by default but
#: still listed with a reason, so re-including one is a single click.
MIN_CHAPTER_WORDS = 25

#: Fraction of chapters a lone section label must cover before it is treated as
#: a wrapper around the whole book rather than a real division within it.
_SECTION_NOISE_COVERAGE = 0.8


@dataclass
class Segment:
    """A contiguous run of one spine document contributing to a chapter."""

    href: str
    start_anchor: str | None = None
    end_anchor: str | None = None


@dataclass
class ChapterDraft:
    index: int
    title: str
    section: str | None
    segments: list[Segment]
    include: bool
    skip_reason: str | None
    paragraphs: list[str] = field(default_factory=list)

    @property
    def word_count(self) -> int:
        return count_words(self.paragraphs)


@dataclass
class _Boundary:
    label: str
    spine_pos: int
    fragment: str | None
    section: str | None


def _skip_reason(label: str, href: str) -> str | None:
    if _SKIP.search(label):
        return "looks like front/back matter"

    stem = posixpath.splitext(posixpath.basename(href))[0]
    # A converter-generated filename carries no meaning, and guessing from it
    # actively misfires: Calibre names ordinary chapters "index_split_007",
    # which the front-matter pattern would read as an index.
    if _CONVERTER_FILENAME.search(stem):
        return None
    if _SKIP.search(stem.replace("_", " ").replace("-", " ")):
        return "filename looks like front/back matter"
    return None


def _boundaries(pkg: EpubPackage) -> list[_Boundary]:
    """TOC entries that start a chapter, in reading order.

    Entries with children (typically "Part One") are treated as section labels
    rather than chapter boundaries: splitting a book at its parts would produce
    a handful of enormous files instead of one file per chapter.
    """
    spine_pos = {}
    for i, item in enumerate(pkg.spine):
        spine_pos.setdefault(item.href, i)

    located = [(entry, spine_pos[entry.href]) for entry in pkg.toc if entry.href in spine_pos]
    # Stable sort keeps within-file fragment order while repairing a nav
    # document whose entries are out of spine order.
    located.sort(key=lambda pair: pair[1])

    boundaries: list[_Boundary] = []
    seen: set[tuple[str, str | None]] = set()
    section_stack: list[tuple[int, str]] = []

    for i, (entry, pos) in enumerate(located):
        has_children = i + 1 < len(located) and located[i + 1][0].depth > entry.depth

        while section_stack and section_stack[-1][0] >= entry.depth:
            section_stack.pop()

        if has_children:
            section_stack.append((entry.depth, entry.label))
            continue

        key = (entry.href, entry.fragment)
        if key in seen:
            continue
        seen.add(key)

        boundaries.append(
            _Boundary(
                label=entry.label,
                spine_pos=pos,
                fragment=entry.fragment,
                section=section_stack[-1][1] if section_stack else None,
            )
        )

    return boundaries


def _segments_for(pkg: EpubPackage, start: _Boundary, following: _Boundary | None) -> list[Segment]:
    if following is None:
        last_pos = len(pkg.spine) - 1
        end_anchor = None
    elif following.fragment:
        # The next chapter begins partway through a shared document, so this
        # chapter includes that document up to the anchor.
        last_pos = following.spine_pos
        end_anchor = following.fragment
    else:
        last_pos = following.spine_pos - 1
        end_anchor = None

    segments: list[Segment] = []
    for pos in range(start.spine_pos, last_pos + 1):
        item = pkg.spine[pos]
        # linear="no" content is reachable only by explicit navigation; it is
        # not part of the read-through.
        if not item.linear and pos != start.spine_pos:
            continue
        segments.append(
            Segment(
                href=item.href,
                start_anchor=start.fragment if pos == start.spine_pos else None,
                end_anchor=end_anchor if pos == last_pos else None,
            )
        )
    return segments


def _extract(
    read: Callable[[str], bytes], segments: list[Segment]
) -> list[tuple[Segment, list[str]]]:
    """Extract each segment, discarding those that yield no text.

    Kept per segment rather than concatenated so an oversized chapter can be
    split back apart at document boundaries without re-reading the archive.

    Empty segments are routine rather than exceptional: when consecutive
    chapters each anchor at the top of their own file, every chapter picks up a
    zero-length tail of the next file. Keeping them would misreport how many
    documents a chapter spans.
    """
    pieces: list[tuple[Segment, list[str]]] = []
    for seg in segments:
        try:
            data = read(seg.href)
        except KeyError:
            continue
        found = extract_paragraphs(data, seg.start_anchor, seg.end_anchor)
        if found:
            pieces.append((seg, found))
    return pieces


def _snippet(text: str, limit: int = 60) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0] + "…"


def _orphan_title(read: Callable[[str], bytes], href: str) -> str:
    """Title for a section the table of contents does not name."""
    try:
        data = read(href)
    except KeyError:
        data = None

    if data is not None:
        guessed = guess_title(data)
        if guessed:
            return guessed

    stem = posixpath.splitext(posixpath.basename(href))[0]
    if data is not None and _CONVERTER_FILENAME.search(stem):
        # "The_Way_of_Kings_split_007" tells a listener nothing. The opening
        # words of the section make a far more useful label.
        opening = extract_paragraphs(data)
        if opening:
            return _snippet(opening[0])
    return stem.replace("_", " ").replace("-", " ").strip().title() or "Untitled"


def build_chapters(pkg: EpubPackage, read: Callable[[str], bytes]) -> list[ChapterDraft]:
    """Split a parsed EPUB into chapters with their extracted text."""
    boundaries = _boundaries(pkg)
    drafts: list[ChapterDraft] = []

    # Spine documents sitting before the first TOC entry are real content the
    # navigation forgot -- usually the cover, sometimes a foreword. Give each
    # its own entry so it can be toggled individually.
    leading = boundaries[0].spine_pos if boundaries else len(pkg.spine)
    for pos in range(leading):
        item = pkg.spine[pos]
        title = _orphan_title(read, item.href)
        reason = _skip_reason(title, item.href) or (
            None if item.linear else "not part of the linear reading order"
        )
        drafts.append(
            ChapterDraft(
                index=0,
                title=title,
                section=None,
                segments=[Segment(href=item.href)],
                include=reason is None,
                skip_reason=reason,
            )
        )

    for i, boundary in enumerate(boundaries):
        following = boundaries[i + 1] if i + 1 < len(boundaries) else None
        segments = _segments_for(pkg, boundary, following)
        if not segments:
            continue
        # A synthesised TOC labels entries with the filename, which makes for
        # miserable track titles. The document's own heading is far better when
        # it has one.
        title = _orphan_title(read, segments[0].href) if pkg.toc_synthesised else boundary.label
        reason = _skip_reason(title, segments[0].href)
        drafts.append(
            ChapterDraft(
                index=0,
                title=title,
                section=boundary.section,
                segments=segments,
                include=reason is None,
                skip_reason=reason,
            )
        )

    final: list[ChapterDraft] = []
    for chapter in drafts:
        pieces = _extract(read, chapter.segments)
        # An empty chapter is a navigation artefact (a part-title page with no
        # prose, an anchor at the very end of a file). Never worth a track.
        if not pieces:
            continue

        total = sum(count_words(paras) for _, paras in pieces)
        if len(pieces) > 1 and total > MAX_WORDS_BEFORE_SPLIT:
            for n, (segment, paras) in enumerate(pieces, start=1):
                final.append(
                    replace(
                        chapter,
                        title=f"{chapter.title} ({n} of {len(pieces)})",
                        segments=[segment],
                        paragraphs=paras,
                    )
                )
        else:
            chapter.segments = [segment for segment, _ in pieces]
            chapter.paragraphs = [p for _, paras in pieces for p in paras]
            final.append(chapter)

    # A section label exists to divide the book. A single label covering nearly
    # every chapter divides nothing -- it is the series or imprint name
    # ("Warhammer 40,000") that the nav document wraps around the whole work.
    # A genuine "Part One" covering only some chapters is kept, which is why
    # this tests coverage rather than merely counting distinct labels.
    labelled = [c for c in final if c.section]
    if (
        final
        and len({c.section for c in labelled}) == 1
        and len(labelled) / len(final) >= _SECTION_NOISE_COVERAGE
    ):
        for chapter in final:
            chapter.section = None

    for i, chapter in enumerate(final):
        chapter.index = i
        if chapter.include and chapter.word_count < MIN_CHAPTER_WORDS:
            chapter.include = False
            chapter.skip_reason = "too short to be a chapter"

    return final
