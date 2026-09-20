"""Name handling.

Three different kinds of name show up in a mod and mixing them up is the most
common reason a paintjob silently fails to appear:

``display``   what the player reads in the shop -- any UTF-8 text.
``unit``      the SII unit / file name -- lowercase ASCII, ``[a-z0-9_]`` only.
``asset``     a path segment inside the archive -- ASCII, spaces allowed.

The game's SII parser accepts a fairly narrow character set for unit names, so
anything we derive is forced into it rather than trusted.
"""

from __future__ import annotations

import re
import unicodedata

__all__ = ["to_unit_name", "to_asset_name", "to_display_name", "is_unit_name"]

_UNIT_RE = re.compile(r"^[a-z_][a-z0-9_]*$")

# Characters that would break an SII string literal or a path inside the archive.
_ILLEGAL_ASSET = set('<>:"/\\|?*')

# Transliterations worth spelling out; everything else falls back to NFKD
# stripping, which turns e.g. "é" into "e" and drops what it cannot map.
_TRANSLITERATE = {
    "æ": "ae", "ø": "oe", "å": "aa",
    "Æ": "Ae", "Ø": "Oe", "Å": "Aa",
    "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
    "Ä": "Ae", "Ö": "Oe", "Ü": "Ue",
}


def _to_ascii(text: str) -> str:
    for src, dst in _TRANSLITERATE.items():
        text = text.replace(src, dst)
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).encode(
        "ascii", "ignore"
    ).decode("ascii")


def to_unit_name(text: str) -> str:
    """Fold arbitrary text into a legal SII unit name.

    >>> to_unit_name("Olzzon's Nordic Livery")
    'olzzon_s_nordic_livery'
    """
    ascii_text = _to_ascii(text).lower()
    unit = re.sub(r"[^a-z0-9]+", "_", ascii_text).strip("_")
    unit = re.sub(r"_{2,}", "_", unit)
    if not unit:
        raise ValueError(f"{text!r} contains no characters usable in a unit name")
    if unit[0].isdigit():
        unit = "_" + unit
    return unit


def to_asset_name(text: str) -> str:
    """Fold arbitrary text into a name safe as a path segment in the archive.

    Spaces and mixed case survive -- SCS use both in their own archives -- but
    anything that would break a path or an SII string is replaced.
    """
    ascii_text = _to_ascii(text)
    cleaned = "".join("_" if ch in _ILLEGAL_ASSET else ch for ch in ascii_text)
    cleaned = "".join(ch for ch in cleaned if ch.isprintable())
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" .")
    if not cleaned:
        raise ValueError(f"{text!r} contains no characters usable in a file name")
    return cleaned


def to_display_name(text: str) -> str:
    """Clean text for an in-game label: collapse whitespace, drop SII-breaking quotes."""
    cleaned = text.replace('"', "'").replace("\\", "/")
    return re.sub(r"\s+", " ", cleaned).strip()


def is_unit_name(text: str) -> bool:
    return bool(_UNIT_RE.match(text))
