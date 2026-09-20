"""DDS output is validated by decoding it back with Pillow."""

import io

import numpy as np
import pytest
from PIL import Image

from eurocreator.dds import build_mipmaps, encode_dds


def gradient(size=64):
    yy, xx = np.mgrid[0:size, 0:size]
    image = np.empty((size, size, 4), np.uint8)
    image[..., 0] = xx * 255 // (size - 1)
    image[..., 1] = yy * 255 // (size - 1)
    image[..., 2] = 40
    image[..., 3] = 255
    image[16:48, 16:48, :3] = (220, 30, 30)
    return image


def decode(data):
    with Image.open(io.BytesIO(data)) as handle:
        return np.asarray(handle.convert("RGBA")).astype(np.int16)


@pytest.mark.parametrize("fmt", ["dxt5", "dxt1", "raw"])
def test_pillow_can_read_what_we_write(fmt):
    source = gradient()
    decoded = decode(encode_dds(source, fmt=fmt))
    assert decoded.shape == source.shape
    error = np.abs(decoded[..., :3] - source[..., :3].astype(np.int16))
    # Block compression of a smooth gradient should stay within a couple of
    # levels; anything worse means the endpoint fit has regressed.
    assert error.mean() < 3.0, f"{fmt} mean error {error.mean():.2f}"


def test_raw_is_lossless():
    source = gradient()
    assert np.array_equal(decode(encode_dds(source, fmt="raw")), source.astype(np.int16))


def test_dxt5_preserves_alpha():
    source = gradient()
    source[..., 3] = np.linspace(0, 255, source.shape[1], dtype=np.uint8)[None, :]
    decoded = decode(encode_dds(source, fmt="dxt5"))
    assert np.abs(decoded[..., 3] - source[..., 3].astype(np.int16)).max() <= 8


def test_flat_block_encodes_exactly():
    """A uniform colour must survive BC1's 4-colour mode without drift."""
    source = np.zeros((8, 8, 4), np.uint8)
    source[..., :3] = (72, 136, 200)
    source[..., 3] = 255
    decoded = decode(encode_dds(source, fmt="dxt5", mipmaps=False))
    # 565 quantisation is the only permitted loss here.
    assert np.abs(decoded[..., :3] - source[..., :3].astype(np.int16)).max() <= 4


def test_mipmap_chain_reaches_1x1():
    levels = build_mipmaps(gradient(64))
    assert [lvl.shape[:2] for lvl in levels] == [
        (64, 64), (32, 32), (16, 16), (8, 8), (4, 4), (2, 2), (1, 1)
    ]


def test_mipmap_count_is_written_to_the_header():
    data = encode_dds(gradient(64), fmt="dxt5")
    assert int.from_bytes(data[4 + 24 : 4 + 28], "little") == 7


def test_non_multiple_of_four_is_padded_not_truncated():
    source = gradient(64)[:50, :38]
    decoded = decode(encode_dds(source, fmt="dxt5", mipmaps=False))
    assert decoded.shape[:2] == (50, 38)
