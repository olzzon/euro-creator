"""Loading and checking the artwork that goes into a paintjob."""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple

import numpy as np
from PIL import Image

from .errors import TextureError

__all__ = ["load_rgba", "make_icon", "blank_rgba", "describe"]

# Paintjob masks are sampled as ordinary textures, so a non-power-of-two size
# costs mip quality and VRAM. 4096 is the usual template size.
_POT = {2 ** n for n in range(2, 15)}

ICON_SIZE = (256, 64)


def load_rgba(
    path: Path,
    *,
    expect_size: Optional[Tuple[int, int]] = None,
    resize_to: Optional[Tuple[int, int]] = None,
) -> np.ndarray:
    """Load an image as an ``HxWx4`` uint8 array.

    Any format Pillow reads works -- PNG, TGA, DDS, TIFF. ``expect_size`` is a
    ``(width, height)`` the image must already match; ``resize_to`` resamples
    instead. Passing neither leaves the image as it is.
    """
    path = Path(path)
    if not path.is_file():
        raise TextureError(f"texture not found: {path}")
    try:
        with Image.open(path) as handle:
            image = handle.convert("RGBA")
    except Exception as exc:  # Pillow raises a wide range of types here
        raise TextureError(f"could not read {path}: {exc}") from exc

    if expect_size is not None and image.size != tuple(expect_size):
        raise TextureError(
            f"{path.name} is {image.size[0]}x{image.size[1]}, "
            f"but this vehicle's template is {expect_size[0]}x{expect_size[1]}. "
            f"Paint on the exported template so the UV layout lines up."
        )
    if resize_to is not None and image.size != tuple(resize_to):
        image = image.resize(tuple(resize_to), Image.LANCZOS)

    return np.asarray(image, dtype=np.uint8)


def describe(image: np.ndarray) -> str:
    height, width = image.shape[:2]
    note = ""
    if width not in _POT or height not in _POT:
        note = "  (not a power of two -- mipmaps and VRAM use will suffer)"
    return f"{width}x{height}{note}"


def blank_rgba(width: int, height: int, colour=(0, 0, 0, 0)) -> np.ndarray:
    """A fully transparent (by default) surface.

    A paintjob mask with zero alpha shows the truck's base colour untouched, so
    this is the correct placeholder for an accessory the skin does not cover.
    """
    image = np.empty((height, width, 4), dtype=np.uint8)
    image[:, :] = colour
    return image


def make_icon(source: Optional[Path]) -> np.ndarray:
    """Produce the 256x64 shop icon.

    The dealer UI draws paintjob icons at a 4:1 aspect. A source image is
    letterboxed into that box rather than stretched, because a squashed logo is
    the single most common cosmetic bug in hand-built skin mods.
    """
    width, height = ICON_SIZE
    canvas = Image.new("RGBA", ICON_SIZE, (0, 0, 0, 0))
    if source is None:
        return np.asarray(canvas, dtype=np.uint8)

    source = Path(source)
    if not source.is_file():
        raise TextureError(f"icon image not found: {source}")
    with Image.open(source) as handle:
        art = handle.convert("RGBA")
    art.thumbnail(ICON_SIZE, Image.LANCZOS)
    canvas.paste(art, ((width - art.width) // 2, (height - art.height) // 2))
    return np.asarray(canvas, dtype=np.uint8)
