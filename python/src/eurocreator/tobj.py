"""TOBJ (texture object) writer.

A ``.tobj`` is the indirection the game reads instead of a ``.dds``: a 48-byte
binary header holding sampler state, followed by the archive-absolute path to
the DDS, ASCII, with no terminator.

The header we emit is byte-for-byte the pattern shipped by SCS' own paintjob
textures and by every mod built with Paint Job Packer, so it is known-good for
a 2D, mipmapped, repeat-addressed, sRGB texture -- which is what every paintjob
mask and shop icon is::

    0x00  u32    0x70B10A01   version magic
    0x04  u32[4] 0            reserved
    0x14  u16    1            unknown
    0x16  u16    2            texture type: 2D
    0x18  u16    2            unknown
    0x1A  u8     3            addr_u   3 = repeat, 0 = clamp_to_edge
    0x1B  u8     3            addr_v
    0x1C  u8     3            addr_w
    0x1D  u8[11] 00 02 02 00 01 00 00 00 01 00 00
                              filter / bias / flag block
    0x28  u32    len(path)
    0x2C  u32    0            reserved
    0x30  ...    path bytes

Only the addressing mode is exposed as an option. The remaining bytes in the
0x1D block are filter, bias and compression flags whose individual meanings are
not reliably documented outside SCS; rather than guess and risk a texture that
loads wrong, we keep the shipped values verbatim.
"""

from __future__ import annotations

import struct
from pathlib import Path

__all__ = ["TOBJ_MAGIC", "TOBJ_HEADER_SIZE", "build_tobj", "write_tobj"]

TOBJ_MAGIC = 0x70B10A01
TOBJ_HEADER_SIZE = 0x30

ADDR_REPEAT = 3
ADDR_CLAMP = 0

_ADDR_OFFSET = 0x1A

# 0x00 .. 0x27 inclusive: everything before the path length field.
_TEMPLATE = bytes.fromhex(
    "010ab170"                  # magic
    "00000000000000000000000000000000"  # reserved (0x04..0x13)
    "0100"                      # unknown
    "0200"                      # texture type: 2D
    "0200"                      # unknown
    "030303"                    # addr_u / addr_v / addr_w
    "0002020001000000010000"    # filter / bias / flags
)
assert len(_TEMPLATE) == 0x28


def build_tobj(dds_path: str, *, clamp: bool = False) -> bytes:
    """Return the bytes of a ``.tobj`` pointing at ``dds_path``.

    ``dds_path`` is the path *inside the archive* and must be absolute, e.g.
    ``/vehicle/truck/upgrade/paintjob/nordic/Scania S/Cabin.dds``.

    Set ``clamp`` for a texture that must not tile at its edges -- shop icons
    and airbrush masks that do not cover the whole UV square.
    """
    if not dds_path.startswith("/"):
        raise ValueError(
            f"TOBJ target must be an archive-absolute path starting with '/', got {dds_path!r}"
        )
    if not dds_path.lower().endswith(".dds"):
        raise ValueError(f"TOBJ target must be a .dds file, got {dds_path!r}")
    try:
        encoded = dds_path.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError(f"TOBJ target must be ASCII, got {dds_path!r}") from exc

    header = bytearray(_TEMPLATE)
    if clamp:
        header[_ADDR_OFFSET : _ADDR_OFFSET + 3] = bytes([ADDR_CLAMP] * 3)

    return bytes(header) + struct.pack("<II", len(encoded), 0) + encoded


def read_tobj_path(data: bytes) -> str:
    """Extract the DDS path from TOBJ bytes. Used by the tests and ``inspect``."""
    if len(data) < TOBJ_HEADER_SIZE:
        raise ValueError("not a TOBJ file: too short")
    (magic,) = struct.unpack_from("<I", data, 0)
    if magic != TOBJ_MAGIC:
        raise ValueError(f"not a TOBJ file: bad magic 0x{magic:08X}")
    (length,) = struct.unpack_from("<I", data, 0x28)
    return data[TOBJ_HEADER_SIZE : TOBJ_HEADER_SIZE + length].decode("ascii")


def write_tobj(out_path: Path, dds_path: str, **kwargs) -> Path:
    """Write a ``.tobj`` file to disk, creating parent directories."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(build_tobj(dds_path, **kwargs))
    return out_path
