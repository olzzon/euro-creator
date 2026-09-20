"""Packaging a mod folder as a ``.scs`` archive.

A ``.scs`` is a plain zip renamed. The game's own loader handles deflate, but
stored (uncompressed) entries are what SCS ship and what avoids the sporadic
"mod fails to load" reports around deflated archives, so stored is the default.
Paths inside the archive always use forward slashes and are stored relative to
the mod root with no leading slash.
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import List

__all__ = ["pack_scs", "list_archive"]

# Editor leftovers and OS metadata that must never end up inside a shipped mod.
_EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
_EXCLUDE_SUFFIXES = {".blend1", ".blend2", ".xcf", ".kra", ".psd"}


def _should_include(path: Path) -> bool:
    if path.name in _EXCLUDE_NAMES or path.name.startswith("._"):
        return False
    if path.suffix.lower() in _EXCLUDE_SUFFIXES:
        return False
    return True


def pack_scs(source_dir: Path, out_path: Path, *, compress: bool = False) -> Path:
    """Zip ``source_dir`` into ``out_path``, returning the archive path."""
    source_dir = Path(source_dir)
    out_path = Path(out_path)
    if not source_dir.is_dir():
        raise NotADirectoryError(f"mod folder does not exist: {source_dir}")

    files = sorted(p for p in source_dir.rglob("*") if p.is_file() and _should_include(p))
    if not files:
        raise ValueError(f"nothing to pack: {source_dir} contains no files")

    method = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", method) as archive:
        for file in files:
            archive.write(file, file.relative_to(source_dir).as_posix())
    return out_path


def list_archive(path: Path) -> List[str]:
    with zipfile.ZipFile(path) as archive:
        return archive.namelist()
