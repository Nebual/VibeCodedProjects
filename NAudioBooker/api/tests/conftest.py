"""Helpers for building synthetic EPUBs in tests.

Real books are the best test data, but they cannot cover the failure modes we
care about most -- an NCX-only EPUB 2, a missing table of contents, several
chapters packed into one file behind fragments. These builders make those cheap
to construct.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import pytest

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def xhtml(body: str) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops">'
        f"<head><title>t</title></head><body>{body}</body></html>"
    )


def paragraphs(count: int, word: str = "word") -> str:
    """A body with `count` paragraphs of twenty words each."""
    return "".join(f"<p>{' '.join([word] * 20)}</p>" for _ in range(count))


@dataclass
class EpubBuilder:
    title: str = "Test Book"
    author: str = "A. Writer"
    #: id -> (href, xhtml source)
    docs: dict[str, tuple[str, str]] = field(default_factory=dict)
    #: list of (idref, linear)
    spine: list[tuple[str, bool]] = field(default_factory=list)
    nav: str | None = None
    ncx: str | None = None
    extra_manifest: str = ""

    def add_doc(self, doc_id: str, href: str, body: str, *, linear: bool = True):
        self.docs[doc_id] = (href, xhtml(body))
        self.spine.append((doc_id, linear))
        return self

    def _opf(self) -> str:
        items = "".join(
            f'<item id="{i}" href="{href}" media-type="application/xhtml+xml"/>'
            for i, (href, _) in self.docs.items()
        )
        if self.nav is not None:
            items += (
                '<item id="nav" href="nav.xhtml" '
                'media-type="application/xhtml+xml" properties="nav"/>'
            )
        if self.ncx is not None:
            items += '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        items += self.extra_manifest

        refs = "".join(
            f'<itemref idref="{i}"{"" if linear else ' linear="no"'}/>' for i, linear in self.spine
        )
        toc_attr = ' toc="ncx"' if self.ncx is not None else ""
        return f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>{self.title}</dc:title>
    <dc:creator>{self.author}</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="pub-id">urn:uuid:test</dc:identifier>
  </metadata>
  <manifest>{items}</manifest>
  <spine{toc_attr}>{refs}</spine>
</package>
"""

    def write(self, path: Path) -> Path:
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("mimetype", "application/epub+zip")
            z.writestr("META-INF/container.xml", CONTAINER)
            z.writestr("OEBPS/package.opf", self._opf())
            for href, source in self.docs.values():
                z.writestr(f"OEBPS/{href}", source)
            if self.nav is not None:
                z.writestr("OEBPS/nav.xhtml", self.nav)
            if self.ncx is not None:
                z.writestr("OEBPS/toc.ncx", self.ncx)
        return path


def nav_doc(entries: list[tuple[str, str]]) -> str:
    """EPUB 3 nav document from (href, label) pairs."""
    items = "".join(f'<li><a href="{href}">{label}</a></li>' for href, label in entries)
    return xhtml(f'<nav epub:type="toc"><ol>{items}</ol></nav>')


def nested_nav_doc(tree: list[tuple[str, str, list[tuple[str, str]]]]) -> str:
    """Nav document with one level of nesting: (href, label, children)."""
    parts = []
    for href, label, children in tree:
        kids = "".join(f'<li><a href="{h}">{lbl}</a></li>' for h, lbl in children)
        inner = f"<ol>{kids}</ol>" if kids else ""
        parts.append(f'<li><a href="{href}">{label}</a>{inner}</li>')
    return xhtml(f'<nav epub:type="toc"><ol>{"".join(parts)}</ol></nav>')


def ncx_doc(entries: list[tuple[str, str]]) -> str:
    points = "".join(
        f'<navPoint id="n{i}" playOrder="{i}">'
        f"<navLabel><text>{label}</text></navLabel>"
        f'<content src="{href}"/></navPoint>'
        for i, (href, label) in enumerate(entries)
    )
    return f"""<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head/><docTitle><text>Test</text></docTitle>
  <navMap>{points}</navMap>
</ncx>
"""


@pytest.fixture
def tmp_epub(tmp_path):
    def _build(builder: EpubBuilder) -> Path:
        return builder.write(tmp_path / "test.epub")

    return _build
