"""EPUB container, package document (OPF) and navigation parsing.

Every XPath here matches on ``local-name()`` rather than a bound namespace
prefix. Real-world EPUBs are careless about namespace declarations -- OPF files
that omit the IDPF namespace, NCX files using a stale DAISY URI, and XHTML
served without the XHTML namespace are all common -- and a prefix-bound query
silently returns nothing on those files rather than failing loudly.
"""

from __future__ import annotations

import posixpath
import zipfile
from dataclasses import dataclass
from urllib.parse import unquote

from lxml import etree

CONTAINER_PATH = "META-INF/container.xml"

# Parser that tolerates the malformed markup that ships in real books.
_XML = etree.XMLParser(recover=True, resolve_entities=False, no_network=True)


class EpubError(Exception):
    """The file could not be read as an EPUB."""


@dataclass(frozen=True)
class ManifestItem:
    id: str
    href: str  # zip path, already resolved against the OPF directory
    media_type: str
    properties: frozenset[str]


@dataclass(frozen=True)
class SpineItem:
    idref: str
    href: str
    linear: bool


@dataclass(frozen=True)
class TocEntry:
    label: str
    href: str  # zip path of the target document, fragment stripped
    fragment: str | None
    depth: int


@dataclass(frozen=True)
class Metadata:
    title: str
    authors: tuple[str, ...]
    language: str | None
    identifier: str | None
    publisher: str | None


@dataclass
class EpubPackage:
    metadata: Metadata
    manifest: dict[str, ManifestItem]
    spine: list[SpineItem]
    toc: list[TocEntry]
    cover_href: str | None
    #: True when the table of contents had to be synthesised from the spine
    #: because the book shipped without a usable nav document or NCX.
    toc_synthesised: bool


def _text(nodes: list) -> str | None:
    for n in nodes:
        value = (n.text or "").strip()
        if value:
            return value
    return None


def _resolve(base_dir: str, href: str) -> str:
    """Resolve an href against a directory inside the zip."""
    path = unquote(href.split("#", 1)[0])
    joined = posixpath.join(base_dir, path) if base_dir else path
    return posixpath.normpath(joined)


def _split_fragment(href: str) -> tuple[str, str | None]:
    raw, _, fragment = href.partition("#")
    return unquote(raw), unquote(fragment) if fragment else None


class _Zip:
    """Zip wrapper with a case-insensitive fallback for href lookups.

    Some EPUBs reference ``Text/chapter1.xhtml`` while storing
    ``text/chapter1.xhtml``. Readers tolerate it, so we do too.
    """

    def __init__(self, zf: zipfile.ZipFile) -> None:
        self._zf = zf
        self._names = {name.lower(): name for name in zf.namelist()}

    def read(self, path: str) -> bytes:
        try:
            return self._zf.read(path)
        except KeyError:
            actual = self._names.get(path.lower())
            if actual is None:
                raise
            return self._zf.read(actual)

    def exists(self, path: str) -> bool:
        return path.lower() in self._names


def _parse_opf_path(zf: _Zip) -> str:
    try:
        root = etree.fromstring(zf.read(CONTAINER_PATH), _XML)
    except (KeyError, etree.XMLSyntaxError) as exc:
        raise EpubError("missing or unreadable META-INF/container.xml") from exc

    paths = root.xpath("//*[local-name()='rootfile']/@full-path")
    if not paths:
        raise EpubError("container.xml declares no rootfile")
    return unquote(str(paths[0]))


def _parse_metadata(root: etree._Element) -> Metadata:
    meta = root.xpath("//*[local-name()='metadata']")
    scope = meta[0] if meta else root

    title = _text(scope.xpath("./*[local-name()='title']")) or "Untitled"
    authors = tuple(
        value
        for value in ((n.text or "").strip() for n in scope.xpath("./*[local-name()='creator']"))
        if value
    )
    return Metadata(
        title=title,
        authors=authors,
        language=_text(scope.xpath("./*[local-name()='language']")),
        identifier=_text(scope.xpath("./*[local-name()='identifier']")),
        publisher=_text(scope.xpath("./*[local-name()='publisher']")),
    )


def _parse_manifest(root: etree._Element, opf_dir: str) -> dict[str, ManifestItem]:
    items: dict[str, ManifestItem] = {}
    for node in root.xpath("//*[local-name()='manifest']/*[local-name()='item']"):
        item_id = node.get("id")
        href = node.get("href")
        if not item_id or not href:
            continue
        items[item_id] = ManifestItem(
            id=item_id,
            href=_resolve(opf_dir, href),
            media_type=node.get("media-type", ""),
            properties=frozenset((node.get("properties") or "").split()),
        )
    return items


def _parse_spine(
    root: etree._Element, manifest: dict[str, ManifestItem]
) -> tuple[list[SpineItem], str | None]:
    spine_nodes = root.xpath("//*[local-name()='spine']")
    if not spine_nodes:
        raise EpubError("package document has no spine")

    ncx_id = spine_nodes[0].get("toc")
    spine: list[SpineItem] = []
    for node in spine_nodes[0].xpath("./*[local-name()='itemref']"):
        idref = node.get("idref")
        item = manifest.get(idref or "")
        if item is None:
            continue
        spine.append(
            SpineItem(
                idref=item.id,
                href=item.href,
                # linear="no" marks content readers reach only by explicit
                # navigation (pop-up notes, alternate tables of contents).
                linear=(node.get("linear") or "yes").lower() != "no",
            )
        )
    if not spine:
        raise EpubError("spine references no manifest items")
    return spine, ncx_id


def _find_cover(root: etree._Element, manifest: dict[str, ManifestItem]) -> str | None:
    # EPUB 3: a manifest item flagged cover-image.
    for item in manifest.values():
        if "cover-image" in item.properties:
            return item.href

    # EPUB 2: <meta name="cover" content="<manifest id>"/>.
    for node in root.xpath("//*[local-name()='meta'][@name='cover']"):
        item = manifest.get(node.get("content") or "")
        if item is not None:
            return item.href

    # Last resort: an image whose id or filename says "cover".
    for item in manifest.values():
        if item.media_type.startswith("image/") and "cover" in item.id.lower():
            return item.href
    return None


def _parse_nav_doc(data: bytes, base_dir: str) -> list[TocEntry]:
    """Parse an EPUB 3 navigation document."""
    root = etree.fromstring(data, _XML)
    if root is None:
        return []

    navs = root.xpath("//*[local-name()='nav'][@*[local-name()='type']='toc']")
    # A nav document without an explicit epub:type="toc" is malformed but
    # common; fall back to the first nav element.
    if not navs:
        navs = root.xpath("//*[local-name()='nav']")
    if not navs:
        return []

    entries: list[TocEntry] = []
    for anchor in navs[0].xpath(".//*[local-name()='a']"):
        href = anchor.get("href")
        if not href:
            continue
        label = " ".join("".join(anchor.itertext()).split())
        if not label:
            continue
        target, fragment = _split_fragment(href)
        depth = len(anchor.xpath("ancestor::*[local-name()='ol']")) - 1
        entries.append(
            TocEntry(
                label=label,
                href=_resolve(base_dir, target),
                fragment=fragment,
                depth=max(depth, 0),
            )
        )
    return entries


def _parse_ncx(data: bytes, base_dir: str) -> list[TocEntry]:
    """Parse an EPUB 2 NCX table of contents."""
    root = etree.fromstring(data, _XML)
    if root is None:
        return []

    entries: list[TocEntry] = []
    for point in root.xpath("//*[local-name()='navMap']//*[local-name()='navPoint']"):
        src = point.xpath("./*[local-name()='content']/@src")
        if not src:
            continue
        label = (
            " ".join("".join(point.xpath("./*[local-name()='navLabel']")[0].itertext()).split())
            if point.xpath("./*[local-name()='navLabel']")
            else ""
        )
        if not label:
            continue
        target, fragment = _split_fragment(str(src[0]))
        depth = len(point.xpath("ancestor::*[local-name()='navPoint']"))
        entries.append(
            TocEntry(
                label=label,
                href=_resolve(base_dir, target),
                fragment=fragment,
                depth=depth,
            )
        )
    return entries


def _read_toc(
    zf: _Zip, manifest: dict[str, ManifestItem], ncx_id: str | None, opf_dir: str
) -> list[TocEntry]:
    nav_items = [i for i in manifest.values() if "nav" in i.properties]
    if nav_items:
        item = nav_items[0]
        try:
            entries = _parse_nav_doc(zf.read(item.href), posixpath.dirname(item.href))
        except (KeyError, etree.XMLSyntaxError):
            entries = []
        if entries:
            return entries

    candidates = [manifest[ncx_id]] if ncx_id and ncx_id in manifest else []
    candidates += [i for i in manifest.values() if i.media_type == "application/x-dtbncx+xml"]
    for item in candidates:
        try:
            entries = _parse_ncx(zf.read(item.href), posixpath.dirname(item.href))
        except (KeyError, etree.XMLSyntaxError):
            continue
        if entries:
            return entries
    return []


def open_epub(path) -> tuple[EpubPackage, zipfile.ZipFile]:
    """Parse an EPUB's structure.

    Returns the parsed package alongside the open :class:`zipfile.ZipFile`, so
    callers can read document bodies without reopening the archive. The caller
    owns the handle and must close it.
    """
    try:
        raw = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        raise EpubError("file is not a zip archive") from exc

    try:
        zf = _Zip(raw)
        opf_path = _parse_opf_path(zf)
        opf_dir = posixpath.dirname(opf_path)

        try:
            root = etree.fromstring(zf.read(opf_path), _XML)
        except KeyError as exc:
            raise EpubError(f"package document {opf_path!r} is missing") from exc
        if root is None:
            raise EpubError(f"package document {opf_path!r} is unparseable")

        manifest = _parse_manifest(root, opf_dir)
        spine, ncx_id = _parse_spine(root, manifest)
        toc = _read_toc(zf, manifest, ncx_id, opf_dir)

        synthesised = not toc
        if synthesised:
            # No usable navigation. Fall back to one entry per linear spine
            # document so the book is still convertible; the review UI is where
            # the user fixes up the resulting titles.
            toc = [
                TocEntry(
                    label=posixpath.splitext(posixpath.basename(item.href))[0],
                    href=item.href,
                    fragment=None,
                    depth=0,
                )
                for item in spine
                if item.linear
            ]

        return (
            EpubPackage(
                metadata=_parse_metadata(root),
                manifest=manifest,
                spine=spine,
                toc=toc,
                cover_href=_find_cover(root, manifest),
                toc_synthesised=synthesised,
            ),
            raw,
        )
    except Exception:
        raw.close()
        raise
