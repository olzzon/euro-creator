"""Rasterising a paint template from dumped UV polygons.

The template is the thing that makes a skin paintable: a transparent PNG the
size of the final mask, with every painted surface's UV island drawn on it, so
an artist can see where the door, the roof and the sun visor land before
painting a single pixel.

Islands are tinted per SCS part, which is what makes a 4096x4096 wireframe
readable -- the cab, the chassis and the accessories separate visually instead
of merging into one grey mess.
"""

from __future__ import annotations

import colorsys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image, ImageDraw

__all__ = ["render_template", "load_uv_dump", "part_colour"]

# Drawn on transparency so the artist can paint underneath and delete the
# template layer at the end.
_BACKGROUND = (0, 0, 0, 0)
_FILL_ALPHA = 28
_LINE_ALPHA = 190


def part_colour(index: int, total: int) -> Tuple[int, int, int]:
    """A distinct, evenly spread hue per part.

    The golden-ratio step keeps consecutive parts far apart in hue even when
    there are only three of them, which a naive ``index / total`` does not.
    """
    hue = (index * 0.61803398875) % 1.0
    lightness = 0.55 if index % 2 == 0 else 0.68
    r, g, b = colorsys.hls_to_rgb(hue, lightness, 0.85)
    return int(r * 255), int(g * 255), int(b * 255)


def load_uv_dump(path: Path) -> Dict[str, np.ndarray]:
    data = np.load(Path(path), allow_pickle=True)
    return {
        "uv": data["uv"],
        "poly_start": data["poly_start"],
        "poly_count": data["poly_count"],
        "poly_group": data["poly_group"],
        "groups": [str(name) for name in data["groups"]],
    }


def render_template(
    dump: Dict[str, np.ndarray],
    size: Tuple[int, int] = (4096, 4096),
    *,
    fill: bool = True,
    line_width: int = 1,
    only_groups: Optional[Sequence[str]] = None,
) -> Image.Image:
    """Draw the UV islands onto a transparent RGBA canvas."""
    width, height = size
    canvas = Image.new("RGBA", size, _BACKGROUND)
    draw = ImageDraw.Draw(canvas, "RGBA")

    uv = dump["uv"]
    groups: List[str] = list(dump["groups"])
    wanted = None if only_groups is None else {str(g) for g in only_groups}

    # UV origin is bottom-left in Blender and top-left in an image, so V is
    # flipped here -- getting this wrong mirrors the whole livery vertically.
    pixels = np.empty_like(uv)
    pixels[:, 0] = uv[:, 0] * width
    pixels[:, 1] = (1.0 - uv[:, 1]) * height

    colours = [part_colour(i, len(groups)) for i in range(len(groups))]

    for start, count, group in zip(dump["poly_start"], dump["poly_count"], dump["poly_group"]):
        if wanted is not None and groups[group] not in wanted:
            continue
        points = [tuple(p) for p in pixels[start : start + count]]
        if len(points) < 3:
            continue
        r, g, b = colours[group]
        if fill:
            draw.polygon(points, fill=(r, g, b, _FILL_ALPHA))
        draw.line(points + [points[0]], fill=(r, g, b, _LINE_ALPHA), width=line_width)

    return canvas


def render_legend(groups: Sequence[str], width: int = 512) -> Image.Image:
    """A small key mapping each colour back to its SCS part name."""
    row = 22
    canvas = Image.new("RGBA", (width, row * max(1, len(groups)) + 8), (24, 26, 30, 255))
    draw = ImageDraw.Draw(canvas)
    for index, name in enumerate(groups):
        y = 4 + index * row
        colour = part_colour(index, len(groups))
        draw.rectangle([8, y + 4, 28, y + row - 4], fill=colour + (255,))
        draw.text((38, y + 5), name, fill=(235, 235, 235, 255))
    return canvas
