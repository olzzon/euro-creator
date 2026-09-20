import numpy as np
import pytest

from eurocreator.archive import list_archive, pack_scs
from eurocreator.template import part_colour, render_template


def square_dump():
    """Two UV islands in different parts: one in each half of the square."""
    uv = np.array(
        [
            [0.05, 0.55], [0.45, 0.55], [0.45, 0.95], [0.05, 0.95],
            [0.55, 0.05], [0.95, 0.05], [0.95, 0.45], [0.55, 0.45],
        ],
        dtype=np.float32,
    )
    return {
        "uv": uv,
        "poly_start": np.array([0, 4], np.int32),
        "poly_count": np.array([4, 4], np.int32),
        "poly_group": np.array([0, 1], np.int32),
        "groups": ["cabin", "chassis"],
    }


def test_islands_land_where_the_uvs_say():
    image = render_template(square_dump(), size=(100, 100))
    pixels = np.asarray(image)
    # V is flipped going into image space: v=0.55..0.95 is the TOP of the image.
    assert pixels[10:40, 10:40, 3].max() > 0, "first island missing from the top-left"
    assert pixels[60:90, 60:90, 3].max() > 0, "second island missing from the bottom-right"
    # The unused quadrants stay transparent so the artist can paint underneath.
    assert pixels[60:90, 10:40, 3].max() == 0


def test_parts_are_drawn_in_distinguishable_colours():
    image = np.asarray(render_template(square_dump(), size=(100, 100)))
    first = image[25, 25, :3]
    second = image[75, 75, :3]
    assert int(np.abs(first.astype(int) - second.astype(int)).sum()) > 60


def test_only_groups_filters():
    image = np.asarray(render_template(square_dump(), size=(100, 100), only_groups=["cabin"]))
    assert image[10:40, 10:40, 3].max() > 0
    assert image[60:90, 60:90, 3].max() == 0


def test_part_colours_are_spread_apart():
    colours = [part_colour(i, 8) for i in range(8)]
    assert len(set(colours)) == 8


def test_pack_is_stored_and_skips_editor_leftovers(tmp_path):
    root = tmp_path / "mod"
    (root / "def").mkdir(parents=True)
    (root / "manifest.sii").write_text("SiiNunit\n{\n}\n")
    (root / "def" / "x.sii").write_text("x")
    (root / ".DS_Store").write_text("junk")
    (root / "art.psd").write_text("huge")

    archive = pack_scs(root, tmp_path / "mod.scs")
    names = list_archive(archive)
    assert set(names) == {"manifest.sii", "def/x.sii"}


def test_pack_refuses_an_empty_folder(tmp_path):
    (tmp_path / "empty").mkdir()
    with pytest.raises(ValueError, match="nothing to pack"):
        pack_scs(tmp_path / "empty", tmp_path / "out.scs")
