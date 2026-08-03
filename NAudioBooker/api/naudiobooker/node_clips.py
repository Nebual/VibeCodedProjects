"""Reference clips cached on a synthesis node.

Content-addressed and disposable. The node is not the owner of these -- the
primary host is -- so this is a cache that can be wiped at any time and will
refill itself. That is why there is no index and no metadata: the filename is
the hash, and the hash is the whole identity.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from .config import get_settings


class ClipRejected(Exception):
    """The uploaded bytes do not match the hash they were filed under."""


def clip_dir() -> Path:
    return get_settings().data_dir / "node-clips"


def path_for(ref_hash: str) -> Path:
    # Reject anything that is not a plain hex digest before it reaches the
    # filesystem: this value arrives over HTTP and is used as a filename.
    if not ref_hash or len(ref_hash) > 128 or not all(c in "0123456789abcdef" for c in ref_hash):
        raise ClipRejected("reference hash must be a hex digest")
    return clip_dir() / f"{ref_hash}.wav"


def has(ref_hash: str) -> bool:
    try:
        return path_for(ref_hash).is_file()
    except ClipRejected:
        return False


def store(ref_hash: str, data: bytes) -> Path:
    """Save an uploaded clip under its hash.

    The bytes are verified against the name they were given. Without that a
    caller could file one recording under another's hash, and every cached
    chunk keyed on that hash would silently be the wrong voice -- for as long
    as the cache lived.
    """
    destination = path_for(ref_hash)

    actual = hashlib.sha256(data).hexdigest()
    if actual != ref_hash:
        raise ClipRejected(f"content hash {actual[:12]} does not match the name {ref_hash[:12]}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, destination)
    return destination
