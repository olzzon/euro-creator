"""DDS writing, including a vectorised BC1/BC3 encoder.

SCS' own Conversion Tools do TGA -> DDS, but they are Windows-only, which makes
the whole pipeline unusable on macOS and Linux. The game only ever reads the
finished DDS, so we produce it directly.

Supported formats:

``dxt5`` (BC3)
    Block compression with a full 8-bit alpha channel. The default, and what
    every stock paintjob mask uses -- the alpha channel carries the airbrush
    mask and metallic masks for some shaders.
``dxt1`` (BC1)
    Block compression, no alpha. Half the size; only for fully opaque masks.
``raw`` (A8R8G8B8)
    Uncompressed. 8x the size of BC3 and slow for the game to stream, but it
    has no block artefacts -- worth it when a livery has fine gradients and you
    are testing whether banding comes from compression.
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import Iterator, List, Sequence

import numpy as np

__all__ = ["FORMATS", "encode_dds", "write_dds", "build_mipmaps"]

FORMATS = ("dxt5", "dxt1", "raw")

_DDS_MAGIC = b"DDS "
_HEADER_SIZE = 124

_DDSD_CAPS = 0x1
_DDSD_HEIGHT = 0x2
_DDSD_WIDTH = 0x4
_DDSD_PITCH = 0x8
_DDSD_PIXELFORMAT = 0x1000
_DDSD_MIPMAPCOUNT = 0x20000
_DDSD_LINEARSIZE = 0x80000

_DDPF_ALPHAPIXELS = 0x1
_DDPF_FOURCC = 0x4
_DDPF_RGB = 0x40

_DDSCAPS_COMPLEX = 0x8
_DDSCAPS_TEXTURE = 0x1000
_DDSCAPS_MIPMAP = 0x400000

# Blocks per chunk when encoding. 65536 blocks is ~12 MB of float32 working set,
# which keeps a 4096x4096 texture well inside cache-friendly memory.
_CHUNK_BLOCKS = 1 << 16


# --------------------------------------------------------------------------
# header
# --------------------------------------------------------------------------

def _build_header(width: int, height: int, mip_count: int, fmt: str) -> bytes:
    flags = _DDSD_CAPS | _DDSD_HEIGHT | _DDSD_WIDTH | _DDSD_PIXELFORMAT
    caps = _DDSCAPS_TEXTURE
    if mip_count > 1:
        flags |= _DDSD_MIPMAPCOUNT
        caps |= _DDSCAPS_COMPLEX | _DDSCAPS_MIPMAP

    if fmt == "raw":
        flags |= _DDSD_PITCH
        pitch_or_linear = width * 4
        pf = struct.pack(
            "<2I4s5I",
            32,
            _DDPF_RGB | _DDPF_ALPHAPIXELS,
            b"\x00\x00\x00\x00",
            32,
            0x00FF0000,  # R
            0x0000FF00,  # G
            0x000000FF,  # B
            0xFF000000,  # A
        )
    else:
        flags |= _DDSD_LINEARSIZE
        pitch_or_linear = _surface_size(width, height, fmt)
        fourcc = b"DXT1" if fmt == "dxt1" else b"DXT5"
        pf = struct.pack("<2I4s5I", 32, _DDPF_FOURCC, fourcc, 0, 0, 0, 0, 0)

    header = struct.pack(
        "<7I",
        _HEADER_SIZE,
        flags,
        height,
        width,
        pitch_or_linear,
        0,  # depth
        mip_count,
    )
    header += b"\x00" * 44  # reserved1[11]
    header += pf
    header += struct.pack("<5I", caps, 0, 0, 0, 0)
    assert len(header) == _HEADER_SIZE, len(header)
    return _DDS_MAGIC + header


def _surface_size(width: int, height: int, fmt: str) -> int:
    if fmt == "raw":
        return width * height * 4
    block_bytes = 8 if fmt == "dxt1" else 16
    return max(1, (width + 3) // 4) * max(1, (height + 3) // 4) * block_bytes


# --------------------------------------------------------------------------
# mipmaps
# --------------------------------------------------------------------------

def build_mipmaps(image: np.ndarray) -> List[np.ndarray]:
    """Return ``[image, half, quarter, ...]`` down to 1x1, box-filtered.

    Alpha is *not* premultiplied: a paintjob mask's alpha is a mask, not
    coverage, so averaging it independently of RGB is what we want.
    """
    levels = [image]
    current = image
    while current.shape[0] > 1 or current.shape[1] > 1:
        h, w = current.shape[:2]
        # Pad an odd dimension by repeating the last row/column so the 2x2 box
        # filter stays exact rather than dropping a pixel.
        if h % 2:
            current = np.concatenate([current, current[-1:]], axis=0)
            h += 1
        if w % 2:
            current = np.concatenate([current, current[:, -1:]], axis=1)
            w += 1
        acc = current.astype(np.uint16).reshape(h // 2, 2, w // 2, 2, current.shape[2])
        current = (acc.sum(axis=(1, 3)) // 4).astype(np.uint8)
        levels.append(current)
    return levels


# --------------------------------------------------------------------------
# BC3 / BC1 encoding
# --------------------------------------------------------------------------

def _to_blocks(image: np.ndarray) -> np.ndarray:
    """Reshape HxWx4 into (nblocks, 16, 4), padding to a multiple of 4.

    Padding repeats edge pixels rather than filling with black, so the border
    blocks of a non-multiple-of-4 texture do not bleed dark edges.
    """
    h, w = image.shape[:2]
    pad_h = (-h) % 4
    pad_w = (-w) % 4
    if pad_h or pad_w:
        image = np.pad(image, ((0, pad_h), (0, pad_w), (0, 0)), mode="edge")
        h, w = image.shape[:2]
    blocks = image.reshape(h // 4, 4, w // 4, 4, image.shape[2])
    blocks = blocks.transpose(0, 2, 1, 3, 4)
    return np.ascontiguousarray(blocks).reshape(-1, 16, image.shape[2])


def _encode_alpha(alpha: np.ndarray) -> np.ndarray:
    """BC4-style alpha blocks. ``alpha`` is (n, 16) uint8, returns (n, 8) uint8."""
    n = alpha.shape[0]
    a_max = alpha.max(axis=1).astype(np.int32)
    a_min = alpha.min(axis=1).astype(np.int32)

    span = a_max - a_min
    flat = span == 0

    # k in 0..7 along the ramp from a_min (k=0) to a_max (k=7).
    safe_span = np.where(flat, 1, span)
    k = np.rint((alpha.astype(np.float32) - a_min[:, None]) * 7.0 / safe_span[:, None])
    k = np.clip(k, 0, 7).astype(np.uint8)

    # Palette order is a0, a1, then six interpolants, so remap:
    #   k == 7 -> 0 (a0 = a_max), k == 0 -> 1 (a1 = a_min), else 8 - k.
    idx = np.where(k == 7, 0, np.where(k == 0, 1, 8 - k.astype(np.int32))).astype(np.uint64)
    idx[flat] = 0

    # Pack 16 x 3-bit indices into 48 bits, little endian.
    shifts = (np.arange(16, dtype=np.uint64) * np.uint64(3))
    packed = (idx << shifts[None, :]).sum(axis=1, dtype=np.uint64)

    out = np.empty((n, 8), dtype=np.uint8)
    out[:, 0] = a_max.astype(np.uint8)
    out[:, 1] = a_min.astype(np.uint8)
    for byte in range(6):
        out[:, 2 + byte] = ((packed >> np.uint64(8 * byte)) & np.uint64(0xFF)).astype(np.uint8)
    return out


def _quantise_565(rgb: np.ndarray) -> np.ndarray:
    """(n, 3) float -> (n,) uint16 in RGB565."""
    r = np.clip(np.rint(rgb[:, 0] * 31.0 / 255.0), 0, 31).astype(np.uint32)
    g = np.clip(np.rint(rgb[:, 1] * 63.0 / 255.0), 0, 63).astype(np.uint32)
    b = np.clip(np.rint(rgb[:, 2] * 31.0 / 255.0), 0, 31).astype(np.uint32)
    return ((r << 11) | (g << 5) | b).astype(np.uint16)


def _expand_565(packed: np.ndarray) -> np.ndarray:
    """(n,) uint16 -> (n, 3) float32 in 0..255, matching hardware bit-replication."""
    p = packed.astype(np.uint32)
    r = (p >> 11) & 0x1F
    g = (p >> 5) & 0x3F
    b = p & 0x1F
    out = np.empty((packed.shape[0], 3), dtype=np.float32)
    out[:, 0] = (r << 3) | (r >> 2)
    out[:, 1] = (g << 2) | (g >> 4)
    out[:, 2] = (b << 3) | (b >> 2)
    return out


def _select_indices(rgb: np.ndarray, c0: np.ndarray, c1: np.ndarray) -> np.ndarray:
    """Nearest of the 4-colour palette for each pixel. ``rgb`` is (n, 16, 3)."""
    palette = np.stack(
        [c0, c1, (2.0 * c0 + c1) / 3.0, (c0 + 2.0 * c1) / 3.0], axis=1
    )  # (n, 4, 3)
    diff = rgb[:, :, None, :] - palette[:, None, :, :]  # (n, 16, 4, 3)
    return np.argmin((diff * diff).sum(axis=3), axis=2).astype(np.uint32)


def _encode_colour(rgb: np.ndarray, refine_passes: int = 2) -> np.ndarray:
    """4-colour BC1 colour blocks. ``rgb`` is (n, 16, 3) uint8, returns (n, 8) uint8."""
    n = rgb.shape[0]
    rgbf = rgb.astype(np.float32)

    lo = rgbf.min(axis=1)
    hi = rgbf.max(axis=1)
    # Inset the bounding box, as stb_dxt does: the extremes are endpoints of the
    # ramp, so pulling them in slightly lowers average error across the block.
    inset = (hi - lo) / 16.0
    hi_q = _quantise_565(hi - inset)
    lo_q = _quantise_565(lo + inset)

    for _ in range(max(0, refine_passes)):
        c_hi = _expand_565(hi_q)
        c_lo = _expand_565(lo_q)
        idx = _select_indices(rgbf, c_hi, c_lo)
        # Least-squares refit of the two endpoints given fixed indices: each
        # index maps to a weight along the ramp (1, 0, 2/3, 1/3).
        weight = np.choose(idx, [1.0, 0.0, 2.0 / 3.0, 1.0 / 3.0]).astype(np.float32)
        w = weight[:, :, None]
        one_minus = 1.0 - w
        a11 = (w * w).sum(axis=1)
        a22 = (one_minus * one_minus).sum(axis=1)
        a12 = (w * one_minus).sum(axis=1)
        b1 = (w * rgbf).sum(axis=1)
        b2 = (one_minus * rgbf).sum(axis=1)
        det = a11 * a22 - a12 * a12
        ok = np.abs(det) > 1e-6
        safe_det = np.where(ok, det, 1.0)
        new_hi = (a22 * b1 - a12 * b2) / safe_det
        new_lo = (a11 * b2 - a12 * b1) / safe_det
        hi_q = np.where(ok[:, 0], _quantise_565(new_hi), hi_q)
        lo_q = np.where(ok[:, 0], _quantise_565(new_lo), lo_q)

    # 4-colour mode requires c0 > c1; swapping endpoints also swaps indices
    # 0<->1 and 2<->3, so it is cheaper to order first and select once.
    swap = hi_q <= lo_q
    c0_q = np.where(swap, lo_q, hi_q)
    c1_q = np.where(swap, hi_q, lo_q)
    # A degenerate block (single colour) can still land on c0 == c1, which the
    # hardware reads as 3-colour+transparent mode. Nudge c1 down one blue step.
    degenerate = c0_q == c1_q
    c1_q = np.where(degenerate & (c1_q > 0), c1_q - 1, c1_q)
    c0_q = np.where(degenerate & (c1_q == c0_q), c0_q + 1, c0_q)

    idx = _select_indices(rgbf, _expand_565(c0_q), _expand_565(c1_q))
    packed = (idx.astype(np.uint32) << (np.arange(16, dtype=np.uint32) * 2)[None, :]).sum(
        axis=1, dtype=np.uint32
    )

    out = np.empty((n, 8), dtype=np.uint8)
    out[:, 0] = (c0_q & 0xFF).astype(np.uint8)
    out[:, 1] = (c0_q >> 8).astype(np.uint8)
    out[:, 2] = (c1_q & 0xFF).astype(np.uint8)
    out[:, 3] = (c1_q >> 8).astype(np.uint8)
    for byte in range(4):
        out[:, 4 + byte] = ((packed >> (8 * byte)) & 0xFF).astype(np.uint8)
    return out


def _encode_surface(image: np.ndarray, fmt: str) -> bytes:
    if fmt == "raw":
        # A8R8G8B8, little endian, so byte order on disk is B, G, R, A.
        bgra = image[:, :, [2, 1, 0, 3]]
        return np.ascontiguousarray(bgra).tobytes()

    blocks = _to_blocks(image)
    pieces: List[bytes] = []
    for start in range(0, blocks.shape[0], _CHUNK_BLOCKS):
        chunk = blocks[start : start + _CHUNK_BLOCKS]
        colour = _encode_colour(chunk[:, :, :3])
        if fmt == "dxt1":
            pieces.append(colour.tobytes())
        else:
            alpha = _encode_alpha(chunk[:, :, 3])
            pieces.append(np.concatenate([alpha, colour], axis=1).tobytes())
    return b"".join(pieces)


# --------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------

def encode_dds(image: np.ndarray, fmt: str = "dxt5", mipmaps: bool = True) -> bytes:
    """Encode an ``HxWx4`` uint8 RGBA array as a complete DDS file."""
    if fmt not in FORMATS:
        raise ValueError(f"unknown DDS format {fmt!r}, expected one of {FORMATS}")
    if image.ndim != 3 or image.shape[2] != 4 or image.dtype != np.uint8:
        raise ValueError(
            f"expected an HxWx4 uint8 RGBA array, got shape {image.shape} dtype {image.dtype}"
        )

    height, width = image.shape[:2]
    levels = build_mipmaps(image) if mipmaps else [image]
    body = b"".join(_encode_surface(level, fmt) for level in levels)
    return _build_header(width, height, len(levels), fmt) + body


def write_dds(out_path: Path, image: np.ndarray, fmt: str = "dxt5", mipmaps: bool = True) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(encode_dds(image, fmt=fmt, mipmaps=mipmaps))
    return out_path
