"""The TOBJ header is checked against bytes taken from shipped mods."""

import binascii

import pytest

from eurocreator.tobj import TOBJ_HEADER_SIZE, build_tobj, read_tobj_path

# The 40 bytes preceding the path-length field, as emitted by SCS' own paintjob
# textures. If this ever changes, the game stops loading the texture.
SHIPPED_PREFIX = (
    "010ab170000000000000000000000000000000000100020002000303030002020001000000010000"
)


def test_header_matches_shipped_bytes():
    data = build_tobj("/material/ui/accessory/Nordic Icon.dds")
    assert binascii.hexlify(data[:40]).decode() == SHIPPED_PREFIX


def test_path_is_length_prefixed_at_0x28_and_starts_at_0x30():
    path = "/vehicle/truck/upgrade/paintjob/Nordic/Scania S/Cabin.dds"
    data = build_tobj(path)
    assert int.from_bytes(data[0x28:0x2C], "little") == len(path)
    assert data[TOBJ_HEADER_SIZE:].decode("ascii") == path
    assert read_tobj_path(data) == path


def test_no_nul_terminator():
    data = build_tobj("/a/b.dds")
    assert not data.endswith(b"\x00")


def test_clamp_changes_only_the_address_bytes():
    repeat = build_tobj("/a/b.dds")
    clamp = build_tobj("/a/b.dds", clamp=True)
    assert clamp[0x1A:0x1D] == b"\x00\x00\x00"
    assert repeat[0x1A:0x1D] == b"\x03\x03\x03"
    assert repeat[:0x1A] == clamp[:0x1A] and repeat[0x1D:] == clamp[0x1D:]


@pytest.mark.parametrize(
    "bad", ["vehicle/truck/x.dds", "/vehicle/truck/x.tga", "/vehicle/bilæn.dds"]
)
def test_rejects_paths_the_game_cannot_resolve(bad):
    with pytest.raises(ValueError):
        build_tobj(bad)
