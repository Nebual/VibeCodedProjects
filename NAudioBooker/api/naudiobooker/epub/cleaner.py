"""Turn a chapter's XHTML into narratable paragraphs.

Two jobs: drop everything that should not be spoken (navigation, page-number
markers, footnote references, figures), and flatten what remains into
block-level paragraphs in reading order.
"""

from __future__ import annotations

import codecs
import re

from lxml import etree, html

# Elements whose text is never narration.
_DROP_TAGS = frozenset(
    {"script", "style", "nav", "header", "footer", "figure", "svg", "img", "form"}
)

# epub:type values marking content a reader reaches only deliberately.
_DROP_EPUB_TYPES = frozenset(
    {
        "footnote",
        "footnotes",
        "endnote",
        "endnotes",
        "rearnote",
        "rearnotes",
        "note",
        "noteref",
        "pagebreak",
        "page-list",
        "toc",
        "landmarks",
    }
)

# Block-level elements that can hold a paragraph of narration.
_BLOCK_TAGS = frozenset(
    {
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "dd",
        "dt",
        "blockquote",
        "pre",
        "td",
        "th",
        "caption",
        "div",
    }
)

_HEADING_TAGS = ("h1", "h2", "h3", "h4", "h5", "h6")

# Class names publishers use for chapter titles, checked when a book has no
# real heading elements. Tor's EPUBs, for instance, style chapter titles as
# <p class="Chap-Title-ct"> with no <h1> anywhere in the file.
_TITLE_CLASS_HINT = re.compile(r"chap|title|head", re.IGNORECASE)

_WHITESPACE = re.compile(r"\s+")
_HAS_ALNUM = re.compile(r"\w", re.UNICODE)


def _localname(el) -> str:
    tag = el.tag
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].lower()


def _epub_types(el) -> set[str]:
    """Collect epub:type / role values, however the parser spelled the attribute.

    lxml's HTML parser does not process namespaces, so ``epub:type`` arrives as
    a literal attribute name with the prefix intact, while the XML parser gives
    ``{http://www.idpf.org/2007/ops}type``. Strip both forms -- matching only
    one of them silently disables footnote and page-break filtering on half the
    books out there.
    """
    values: set[str] = set()
    for name, value in el.attrib.items():
        key = name.rsplit("}", 1)[-1].rsplit(":", 1)[-1].lower()
        if key in ("type", "role"):
            values.update(v.strip().lower().removeprefix("doc-") for v in value.split())
    return values


def _should_drop(el) -> bool:
    name = _localname(el)
    if name in _DROP_TAGS:
        return True
    if _epub_types(el) & _DROP_EPUB_TYPES:
        return True
    if el.get("hidden") is not None:
        return True
    # A <sup> wrapping a link is a footnote marker in practice, even when the
    # book never declares epub:type="noteref".
    return name == "sup" and bool(el.xpath(".//*[local-name()='a']"))


_XML_DECL = re.compile(r"^\s*<\?xml[^>]*\?>", re.IGNORECASE)
_CHARSET = re.compile(rb"""charset=["']?([\w.-]+)""", re.IGNORECASE)


def _decode(data: bytes) -> str:
    """Decode a chapter document to text.

    Handing raw bytes to lxml lets it guess, and it guesses Latin-1 for files
    that declare their charset anywhere other than where it looks -- silently
    turning UTF-8 punctuation and non-breaking spaces into mojibake. EPUB
    mandates UTF-8 or UTF-16, so try those first and only fall back to a
    declared encoding if the mandated ones fail.
    """
    if data[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return data.decode("utf-16")
    if data.startswith(codecs.BOM_UTF8):
        data = data[len(codecs.BOM_UTF8) :]

    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass

    match = _CHARSET.search(data[:2048])
    if match:
        try:
            return data.decode(match.group(1).decode("ascii", "ignore"))
        except (LookupError, UnicodeDecodeError):
            pass
    return data.decode("utf-8", "replace")


def _parse(data: bytes):
    """Parse chapter XHTML leniently, returning the body element."""
    try:
        text = _decode(data)
        # lxml refuses a str that still carries an encoding declaration.
        root = html.fromstring(_XML_DECL.sub("", text, count=1))
    except (etree.XMLSyntaxError, etree.ParserError, ValueError):
        return None
    if root is None:
        return None
    bodies = root.xpath("//*[local-name()='body']")
    return bodies[0] if bodies else root


def _prune(body) -> None:
    for el in list(body.iter()):
        if el is body or not isinstance(el.tag, str):
            continue
        if _should_drop(el):
            # Keep the tail text: it belongs to the surrounding paragraph, not
            # to the element being removed.
            parent = el.getparent()
            if parent is not None:
                if el.tail:
                    previous = el.getprevious()
                    if previous is not None:
                        previous.tail = (previous.tail or "") + el.tail
                    else:
                        parent.text = (parent.text or "") + el.tail
                parent.remove(el)


def _clean_text(el) -> str:
    return _WHITESPACE.sub(" ", "".join(el.itertext())).strip()


def _leaf_blocks(body) -> list:
    """Block elements containing no nested block element.

    Taking only the leaves avoids emitting an outer <div> and then each of its
    child <p> elements, which would duplicate the entire chapter.
    """
    blocks = []
    for el in body.iter():
        if not isinstance(el.tag, str) or _localname(el) not in _BLOCK_TAGS:
            continue
        if any(
            _localname(child) in _BLOCK_TAGS
            for child in el.iterdescendants()
            if isinstance(child.tag, str)
        ):
            continue
        blocks.append(el)
    return blocks


def _positions(body) -> dict:
    return {el: i for i, el in enumerate(body.iter()) if isinstance(el.tag, str)}


def _anchor_position(body, positions: dict, anchor: str | None) -> int | None:
    if not anchor:
        return None
    for el in body.iter():
        if isinstance(el.tag, str) and (el.get("id") == anchor or el.get("name") == anchor):
            return positions.get(el)
    return None


def extract_paragraphs(
    data: bytes,
    start_anchor: str | None = None,
    end_anchor: str | None = None,
) -> list[str]:
    """Extract narratable paragraphs from one chapter document.

    ``start_anchor``/``end_anchor`` restrict extraction to the slice between two
    element ids, which is how a single XHTML file holding several TOC entries is
    split into separate chapters. A slice runs from the start anchor up to, but
    not including, the end anchor.
    """
    body = _parse(data)
    if body is None:
        return []
    _prune(body)

    positions = _positions(body)
    start = _anchor_position(body, positions, start_anchor)
    end = _anchor_position(body, positions, end_anchor)

    paragraphs: list[str] = []
    for block in _leaf_blocks(body):
        pos = positions.get(block)
        if pos is None:
            continue
        if start is not None and pos < start:
            continue
        if end is not None and pos >= end:
            continue

        text = _clean_text(block)
        if not text:
            continue
        # Page numbers and scene-break ornaments ("* * *", bullets). Neither
        # narrates sensibly.
        # TODO(phase 4): scene breaks should become a longer pause rather than
        # being discarded. The source EPUB is retained, so nothing is lost.
        if not _HAS_ALNUM.search(text):
            continue
        if text.isdigit():
            continue
        paragraphs.append(text)

    return paragraphs


def guess_title(data: bytes) -> str | None:
    """Best-effort chapter title from a document's own markup.

    Only used when the book has no usable table of contents; the nav document
    is always preferred when one exists.
    """
    body = _parse(data)
    if body is None:
        return None
    _prune(body)

    for tag in _HEADING_TAGS:
        for el in body.xpath(f"//*[local-name()='{tag}']"):
            text = _clean_text(el)
            if text:
                return text

    for el in body.iter():
        if not isinstance(el.tag, str) or _localname(el) not in _BLOCK_TAGS:
            continue
        classes = el.get("class") or ""
        if classes and _TITLE_CLASS_HINT.search(classes):
            text = _clean_text(el)
            if text:
                return text
    return None


def count_words(paragraphs: list[str]) -> int:
    return sum(len(p.split()) for p in paragraphs)
