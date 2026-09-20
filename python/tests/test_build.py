"""End-to-end: a project file in, a loadable .scs out."""

import zipfile

import numpy as np
import pytest
from PIL import Image

from eurocreator.build import build
from eurocreator.errors import ConfigError
from eurocreator.project import Project
from eurocreator.tobj import read_tobj_path

VEHICLE = {
    "path": "olzzon.scania142",
    "name": "Scania 142",
    "author": "olzzon",
    "mod": True,
    "separate_paintjobs": False,
    "template_size": [64, 64],
    "cabins": {"a": {"name": "Topline", "units": ["topline"]}},
    "accessories": {"Sun Visor": ["sunshld.stock"], "Rear Bumper": ["r_bumper.stock_p"]},
}


def write_art(directory, name, size=64):
    path = directory / name
    array = np.zeros((size, size, 4), np.uint8)
    array[..., 2] = 200
    array[..., 3] = 255
    Image.fromarray(array).save(path)
    return path


@pytest.fixture
def project(tmp_path):
    write_art(tmp_path, "main.png")
    return Project.from_dict(
        {
            "mod": {"name": "Nordic Livery", "author": "olzzon", "version": "1.2"},
            "skin": {"name": "Nordic", "price": 9500},
            "vehicle": VEHICLE,
            "textures": {"main": "main.png"},
            "output": {"dir": str(tmp_path / "dist")},
        },
        base_dir=tmp_path,
    )


def test_builds_a_complete_tree(project):
    result = build(project)
    names = {p.relative_to(result.tree_dir).as_posix() for p in result.files}
    assert "manifest.sii" in names
    assert "versions.sii" in names
    assert "def/vehicle/truck/olzzon.scania142/paint_job/nordic.sii" in names
    assert "def/vehicle/truck/olzzon.scania142/paint_job/nordic_settings.sui" in names
    assert "def/vehicle/truck/olzzon.scania142/paint_job/accessory/nordic.sii" in names
    assert "material/ui/accessory/nordic_icon.mat" in names


def test_every_tobj_points_at_a_dds_that_exists_in_the_archive(project):
    """The one failure mode that is silent in game and loud in game.log.txt."""
    result = build(project)
    with zipfile.ZipFile(result.archive) as archive:
        entries = set(archive.namelist())
        tobjs = [n for n in entries if n.endswith(".tobj")]
        assert tobjs
        for name in tobjs:
            target = read_tobj_path(archive.read(name))
            assert target.lstrip("/") in entries, f"{name} points at missing {target}"


def test_every_sii_mask_reference_resolves(project):
    result = build(project)
    with zipfile.ZipFile(result.archive) as archive:
        entries = set(archive.namelist())
        referenced = []
        for name in archive.namelist():
            if not name.endswith(".sii"):
                continue
            for line in archive.read(name).decode().splitlines():
                if "paint_job_mask" in line:
                    referenced.append(line.split('"')[1])
        assert referenced
        for target in referenced:
            assert target.lstrip("/") in entries, f"missing mask {target}"


def test_accessory_overrides_cover_every_group(project):
    result = build(project)
    text = (
        result.tree_dir
        / "def/vehicle/truck/olzzon.scania142/paint_job/accessory/nordic.sii"
    ).read_text()
    assert text.count("simple_paint_job_data") == 2
    assert '"sunshld.stock"' in text and '"r_bumper.stock_p"' in text


def test_separate_paintjobs_produce_one_sii_and_one_mask_per_cabin(tmp_path):
    write_art(tmp_path, "main.png")
    vehicle = dict(VEHICLE, separate_paintjobs=True, cabins={
        "a": {"name": "Topline", "units": ["topline"]},
        "b": {"name": "Sleeper", "units": ["sleeper", "sleeper_lo"]},
    })
    project = Project.from_dict(
        {
            "mod": {"name": "N", "author": "o"},
            "skin": {"name": "Nordic"},
            "vehicle": vehicle,
            "textures": {"main": "main.png"},
            "output": {"dir": str(tmp_path / "dist")},
        },
        base_dir=tmp_path,
    )
    result = build(project, pack=False)
    names = {p.relative_to(result.tree_dir).as_posix() for p in result.files}
    base = "def/vehicle/truck/olzzon.scania142/paint_job"
    assert f"{base}/nordic_a.sii" in names and f"{base}/nordic_b.sii" in names
    sleeper = (result.tree_dir / base / "nordic_b.sii").read_text()
    # Both units that share the Sleeper mask must be offered the paint job.
    assert '"sleeper.olzzon.scania142.cabin"' in sleeper
    assert '"sleeper_lo.olzzon.scania142.cabin"' in sleeper


def test_alternate_uvset_reaches_the_settings_file(tmp_path):
    write_art(tmp_path, "main.png")
    project = Project.from_dict(
        {
            "mod": {"name": "N", "author": "o"},
            "skin": {"name": "Nordic"},
            "vehicle": dict(VEHICLE, alternate_uvset=True),
            "textures": {"main": "main.png"},
            "output": {"dir": str(tmp_path / "dist")},
        },
        base_dir=tmp_path,
    )
    result = build(project, pack=False)
    settings = (
        result.tree_dir
        / "def/vehicle/truck/olzzon.scania142/paint_job/nordic_settings.sui"
    ).read_text()
    assert "alternate_uvset: true" in settings
    assert any("(alt uvset)" in name for name, _ in result.masks)


def test_mask_of_the_wrong_size_is_refused(tmp_path):
    write_art(tmp_path, "main.png", size=32)
    project = Project.from_dict(
        {
            "mod": {"name": "N", "author": "o"},
            "skin": {"name": "Nordic"},
            "vehicle": VEHICLE,
            "textures": {"main": "main.png"},
            "output": {"dir": str(tmp_path / "dist")},
        },
        base_dir=tmp_path,
    )
    with pytest.raises(Exception) as excinfo:
        build(project, pack=False)
    assert "template" in str(excinfo.value)
    # ...unless the artist explicitly asks for a resample.
    assert build(project, pack=False, resize_mismatched=True).warnings


def test_unknown_accessory_is_caught_in_the_project_not_in_game(tmp_path):
    write_art(tmp_path, "main.png")
    with pytest.raises(ConfigError, match="Chrome Stack"):
        Project.from_dict(
            {
                "mod": {"name": "N", "author": "o"},
                "skin": {"name": "Nordic"},
                "vehicle": VEHICLE,
                "textures": {"main": "main.png", "accessories": {"Chrome Stack": "main.png"}},
            },
            base_dir=tmp_path,
        )


def test_combined_paintjob_omits_suitable_for(tmp_path):
    """One mask for every cabin: an absent suitable_for[] means 'all cabins'."""
    write_art(tmp_path, "main.png")
    vehicle = dict(VEHICLE, cabins={
        "a": {"name": "Topline", "units": ["topline"]},
        "b": {"name": "Sleeper", "units": ["sleeper"]},
    })
    project = Project.from_dict(
        {
            "mod": {"name": "N", "author": "o"},
            "skin": {"name": "Nordic"},
            "vehicle": vehicle,
            "textures": {"main": "main.png"},
            "output": {"dir": str(tmp_path / "dist")},
        },
        base_dir=tmp_path,
    )
    result = build(project, pack=False)
    sii = (
        result.tree_dir / "def/vehicle/truck/olzzon.scania142/paint_job/nordic.sii"
    ).read_text()
    assert "suitable_for" not in sii
    assert sii.count("accessory_paint_job_data") == 1
