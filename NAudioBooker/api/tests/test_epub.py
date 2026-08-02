"""Parser and cleaner behaviour against the EPUB variations that occur in the wild."""

from __future__ import annotations

import zipfile

import pytest
from conftest import EpubBuilder, nav_doc, ncx_doc, nested_nav_doc, paragraphs, xhtml

from naudiobooker.epub import EpubError, build_chapters, open_epub
from naudiobooker.epub.cleaner import extract_paragraphs


def load(path):
    pkg, zf = open_epub(path)
    try:
        return pkg, build_chapters(pkg, zf.read)
    finally:
        zf.close()


# --------------------------------------------------------------------------
# Navigation sources
# --------------------------------------------------------------------------


def test_epub3_nav_supplies_titles(tmp_epub):
    b = EpubBuilder()
    b.add_doc("c1", "c1.xhtml", paragraphs(3))
    b.add_doc("c2", "c2.xhtml", paragraphs(3))
    b.nav = nav_doc([("c1.xhtml", "Opening Moves"), ("c2.xhtml", "The Reply")])

    pkg, chapters = load(tmp_epub(b))

    assert pkg.metadata.title == "Test Book"
    assert pkg.metadata.authors == ("A. Writer",)
    assert not pkg.toc_synthesised
    assert [c.title for c in chapters] == ["Opening Moves", "The Reply"]


def test_falls_back_to_ncx_when_no_nav(tmp_epub):
    b = EpubBuilder()
    b.add_doc("c1", "c1.xhtml", paragraphs(3))
    b.add_doc("c2", "c2.xhtml", paragraphs(3))
    b.ncx = ncx_doc([("c1.xhtml", "First"), ("c2.xhtml", "Second")])

    pkg, chapters = load(tmp_epub(b))

    assert not pkg.toc_synthesised
    assert [c.title for c in chapters] == ["First", "Second"]


def test_nav_is_preferred_over_ncx(tmp_epub):
    b = EpubBuilder()
    b.add_doc("c1", "c1.xhtml", paragraphs(3))
    b.nav = nav_doc([("c1.xhtml", "From Nav")])
    b.ncx = ncx_doc([("c1.xhtml", "From NCX")])

    _, chapters = load(tmp_epub(b))

    assert [c.title for c in chapters] == ["From Nav"]


def test_synthesises_toc_when_book_has_none(tmp_epub):
    b = EpubBuilder()
    b.add_doc("c1", "chapter-one.xhtml", paragraphs(3))
    b.add_doc("c2", "chapter-two.xhtml", paragraphs(3))

    pkg, chapters = load(tmp_epub(b))

    assert pkg.toc_synthesised
    assert len(chapters) == 2
    # Titles come from the documents' own markup, or failing that the filename.
    assert chapters[0].title


def test_synthesised_toc_uses_heading_when_present(tmp_epub):
    b = EpubBuilder()
    b.add_doc("c1", "c1.xhtml", "<h1>A Real Heading</h1>" + paragraphs(3))

    _, chapters = load(tmp_epub(b))

    assert chapters[0].title == "A Real Heading"


def test_title_falls_back_to_styled_paragraph_without_headings(tmp_epub):
    """Tor's EPUBs style chapter titles as <p class="Chap-Title-ct">, no <h1>."""
    b = EpubBuilder()
    b.add_doc(
        "c1",
        "c1.xhtml",
        '<p class="Chap-Title-ct">Styled Title</p>' + paragraphs(3),
    )

    _, chapters = load(tmp_epub(b))

    assert chapters[0].title == "Styled Title"


# --------------------------------------------------------------------------
# Spine / TOC reconciliation
# --------------------------------------------------------------------------


def test_fragments_split_one_file_into_several_chapters(tmp_epub):
    body = (
        '<p id="a">alpha</p>'
        + paragraphs(2, "alpha")
        + '<p id="b">beta</p>'
        + paragraphs(2, "beta")
    )
    b = EpubBuilder()
    b.add_doc("all", "all.xhtml", body)
    b.nav = nav_doc([("all.xhtml#a", "Part A"), ("all.xhtml#b", "Part B")])

    _, chapters = load(tmp_epub(b))

    assert [c.title for c in chapters] == ["Part A", "Part B"]
    assert all("alpha" in p for p in chapters[0].paragraphs)
    assert all("beta" in p for p in chapters[1].paragraphs)


def test_chapter_spanning_multiple_spine_documents(tmp_epub):
    b = EpubBuilder()
    b.add_doc("c1a", "c1a.xhtml", paragraphs(2, "first"))
    b.add_doc("c1b", "c1b.xhtml", paragraphs(2, "first"))
    b.add_doc("c2", "c2.xhtml", paragraphs(2, "second"))
    # Only two TOC entries, so chapter one must absorb both of its documents.
    b.nav = nav_doc([("c1a.xhtml", "One"), ("c2.xhtml", "Two")])

    _, chapters = load(tmp_epub(b))

    assert len(chapters) == 2
    assert len(chapters[0].segments) == 2
    assert chapters[0].word_count == 80


def test_spine_documents_before_the_first_toc_entry_are_kept(tmp_epub):
    b = EpubBuilder()
    b.add_doc("fore", "foreword.xhtml", paragraphs(3, "foreword"))
    b.add_doc("c1", "c1.xhtml", paragraphs(3))
    b.nav = nav_doc([("c1.xhtml", "Chapter One")])

    _, chapters = load(tmp_epub(b))

    assert len(chapters) == 2
    assert chapters[1].title == "Chapter One"


def test_nested_nav_splits_at_leaves_not_parts(tmp_epub):
    """A book divided into parts should yield chapters, not a few huge parts."""
    b = EpubBuilder()
    b.add_doc("p1", "p1.xhtml", paragraphs(2, "partone"))
    b.add_doc("c1", "c1.xhtml", paragraphs(3, "chapone"))
    b.add_doc("c2", "c2.xhtml", paragraphs(3, "chaptwo"))
    b.nav = nested_nav_doc(
        [("p1.xhtml", "Part One", [("c1.xhtml", "Chapter 1"), ("c2.xhtml", "Chapter 2")])]
    )

    _, chapters = load(tmp_epub(b))

    titles = [c.title for c in chapters]
    assert "Chapter 1" in titles and "Chapter 2" in titles
    assert "Part One" not in titles
    # The part label is retained for context rather than discarded.
    assert chapters[-1].section == "Part One"


def test_non_linear_spine_items_are_excluded_by_default(tmp_epub):
    b = EpubBuilder()
    b.add_doc("notes", "notes.xhtml", paragraphs(3, "note"), linear=False)
    b.add_doc("c1", "c1.xhtml", paragraphs(3))
    b.nav = nav_doc([("c1.xhtml", "Chapter One")])

    _, chapters = load(tmp_epub(b))

    notes = next(c for c in chapters if "note" in c.paragraphs[0])
    assert not notes.include
    assert notes.skip_reason


def test_out_of_order_nav_is_sorted_by_spine_position(tmp_epub):
    b = EpubBuilder()
    b.add_doc("c1", "c1.xhtml", paragraphs(2, "first"))
    b.add_doc("c2", "c2.xhtml", paragraphs(2, "second"))
    b.nav = nav_doc([("c2.xhtml", "Two"), ("c1.xhtml", "One")])

    _, chapters = load(tmp_epub(b))

    assert [c.title for c in chapters] == ["One", "Two"]


# --------------------------------------------------------------------------
# Inclusion defaults
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "label",
    [
        "Cover",
        "Title Page",
        "Copyright",
        "Table of Contents",
        "About the Author",
        "Also by Someone",
        "Newsletter Sign-up",
    ],
)
def test_front_and_back_matter_excluded_by_default(tmp_epub, label):
    b = EpubBuilder()
    b.add_doc("m", "matter.xhtml", paragraphs(3, "matter"))
    b.add_doc("c1", "c1.xhtml", paragraphs(5))
    b.nav = nav_doc([("matter.xhtml", label), ("c1.xhtml", "Chapter One")])

    _, chapters = load(tmp_epub(b))

    matter = next(c for c in chapters if c.title == label)
    assert not matter.include
    assert matter.skip_reason
    assert next(c for c in chapters if c.title == "Chapter One").include


def test_very_short_sections_are_excluded(tmp_epub):
    b = EpubBuilder()
    b.add_doc("d", "d.xhtml", "<p>For my parents.</p>")
    b.add_doc("c1", "c1.xhtml", paragraphs(5))
    b.nav = nav_doc([("d.xhtml", "Dedication"), ("c1.xhtml", "Chapter One")])

    _, chapters = load(tmp_epub(b))

    dedication = next(c for c in chapters if c.title == "Dedication")
    assert not dedication.include
    assert dedication.skip_reason == "too short to be a chapter"


def test_chapters_with_no_text_are_dropped(tmp_epub):
    b = EpubBuilder()
    b.add_doc("img", "img.xhtml", '<div><img src="x.jpg" alt=""/></div>')
    b.add_doc("c1", "c1.xhtml", paragraphs(3))
    b.nav = nav_doc([("img.xhtml", "Frontispiece"), ("c1.xhtml", "Chapter One")])

    _, chapters = load(tmp_epub(b))

    assert [c.title for c in chapters] == ["Chapter One"]


# --------------------------------------------------------------------------
# Converter artefacts (Calibre and friends)
# --------------------------------------------------------------------------


def test_oversized_multi_document_chapter_is_split_at_document_boundaries(tmp_epub):
    """Calibre splits by file size, leaving one TOC entry over the whole book."""
    b = EpubBuilder()
    # Three documents of 9,000 words each under a single "Begin Reading" entry.
    for n in range(3):
        b.add_doc(f"d{n}", f"book_split_{n:03d}.html", paragraphs(450, f"seg{n}"))
    b.add_doc("back", "back.xhtml", paragraphs(3, "backmatter"))
    b.nav = nav_doc([("book_split_000.html", "Begin Reading"), ("back.xhtml", "Afterword")])

    _, chapters = load(tmp_epub(b))

    begin = [c for c in chapters if c.title.startswith("Begin Reading")]
    assert [c.title for c in begin] == [
        "Begin Reading (1 of 3)",
        "Begin Reading (2 of 3)",
        "Begin Reading (3 of 3)",
    ]
    assert all(len(c.segments) == 1 for c in begin)
    # No text is lost or duplicated by the split.
    assert sum(c.word_count for c in begin) == 27_000


def test_multi_document_chapter_under_the_limit_is_left_whole(tmp_epub):
    b = EpubBuilder()
    b.add_doc("a", "a.xhtml", paragraphs(50, "alpha"))
    b.add_doc("bb", "b.xhtml", paragraphs(50, "alpha"))
    b.add_doc("c", "c.xhtml", paragraphs(50, "gamma"))
    b.nav = nav_doc([("a.xhtml", "One"), ("c.xhtml", "Two")])

    _, chapters = load(tmp_epub(b))

    assert [c.title for c in chapters] == ["One", "Two"]
    assert len(chapters[0].segments) == 2


def test_long_single_document_chapter_is_never_split(tmp_epub):
    """There is no defensible cut point inside one document."""
    b = EpubBuilder()
    b.add_doc("big", "big.xhtml", paragraphs(2000, "word"))
    b.nav = nav_doc([("big.xhtml", "The Long One")])

    _, chapters = load(tmp_epub(b))

    assert len(chapters) == 1
    assert chapters[0].word_count == 40_000


def test_converter_filename_yields_a_title_from_the_opening_words(tmp_epub):
    b = EpubBuilder()
    b.add_doc("f", "book_split_004.html", "<p>Acknowledgments</p>" + paragraphs(5))
    b.add_doc("c1", "c1.xhtml", paragraphs(5))
    b.nav = nav_doc([("c1.xhtml", "Chapter One")])

    _, chapters = load(tmp_epub(b))

    assert chapters[0].title == "Acknowledgments"


def test_calibre_index_split_filenames_are_not_read_as_an_index(tmp_epub):
    """Calibre names ordinary chapters index_split_NNN; they are not indexes."""
    b = EpubBuilder()
    b.add_doc("c1", "index_split_007.html", paragraphs(20, "story"))
    b.nav = nav_doc([("index_split_007.html", "Chapter Seven")])

    _, chapters = load(tmp_epub(b))

    assert chapters[0].include
    assert chapters[0].skip_reason is None


def test_section_wrapping_the_whole_book_is_dropped(tmp_epub):
    """A series name wrapping every chapter is noise, not a structural division."""
    b = EpubBuilder()
    b.add_doc("p", "p.xhtml", paragraphs(2, "imprint"))
    children = []
    for n in range(1, 10):
        b.add_doc(f"c{n}", f"c{n}.xhtml", paragraphs(5, f"ch{n}"))
        children.append((f"c{n}.xhtml", f"Chapter {n}"))
    b.nav = nested_nav_doc([("p.xhtml", "Warhammer 40,000", children)])

    _, chapters = load(tmp_epub(b))

    # 9 of 10 chapters carry the label, so it divides nothing.
    assert all(c.section is None for c in chapters)


# --------------------------------------------------------------------------
# Failure modes
# --------------------------------------------------------------------------


def test_non_zip_is_rejected(tmp_path):
    path = tmp_path / "bad.epub"
    path.write_bytes(b"definitely not a zip")

    with pytest.raises(EpubError, match="not a zip"):
        open_epub(path)


def test_zip_without_container_is_rejected(tmp_path):
    path = tmp_path / "bare.epub"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("hello.txt", "hi")

    with pytest.raises(EpubError, match="container.xml"):
        open_epub(path)


def test_missing_manifest_target_does_not_crash(tmp_epub):
    b = EpubBuilder()
    b.add_doc("c1", "c1.xhtml", paragraphs(3))
    b.nav = nav_doc([("c1.xhtml", "One"), ("ghost.xhtml", "Missing")])

    _, chapters = load(tmp_epub(b))

    assert [c.title for c in chapters] == ["One"]


# --------------------------------------------------------------------------
# Cleaner
# --------------------------------------------------------------------------


def test_cleaner_strips_non_narration():
    body = (
        "<nav><ol><li>skip me</li></ol></nav>"
        "<header>running head</header>"
        "<p>real prose here</p>"
        '<span epub:type="pagebreak" id="p12"/>'
        "<p>247</p>"
        "<p>* * *</p>"
        '<aside epub:type="footnote"><p>a footnote</p></aside>'
        "<footer>colophon</footer>"
    )
    result = extract_paragraphs(xhtml(body).encode())

    assert result == ["real prose here"]


def test_cleaner_removes_footnote_markers_but_keeps_the_sentence():
    body = '<p>Some claim<sup><a href="#fn1">1</a></sup> follows.</p>'

    assert extract_paragraphs(xhtml(body).encode()) == ["Some claim follows."]


def test_cleaner_does_not_duplicate_nested_blocks():
    body = "<div><p>one</p><p>two</p></div>"

    assert extract_paragraphs(xhtml(body).encode()) == ["one", "two"]


def test_cleaner_decodes_utf8_without_a_declaration():
    """A charset in an unexpected place must not send lxml to Latin-1."""
    source = (
        '<html xmlns="http://www.w3.org/1999/xhtml"><head>'
        '<meta content="text/html; charset=utf-8" http-equiv="default-style"/>'
        "</head><body><p>café — naïve quote “hi”</p></body></html>"
    )
    result = extract_paragraphs(source.encode("utf-8"))

    assert result == ["café — naïve quote “hi”"]
    assert "Â" not in result[0]


def test_cleaner_handles_utf16_with_bom():
    source = xhtml("<p>utf sixteen</p>")
    result = extract_paragraphs(source.encode("utf-16"))

    assert result == ["utf sixteen"]
