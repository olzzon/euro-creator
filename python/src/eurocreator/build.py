"""Assembling the mod tree and packing it into a ``.scs``.

The layout produced here mirrors what the game expects, and what SCS' own
archives look like::

    manifest.sii                                  mod manager entry
    versions.sii
    Mod_Manager_Image.jpg
    Mod_Manager_Description.txt
    material/ui/accessory/<Skin> Icon.dds|.tobj   shop icon
    material/ui/accessory/<skin>_icon.mat
    def/vehicle/truck/<path>/paint_job/
        <skin>_settings.sui                       shared attributes
        <skin>.sii                                accessory_paint_job_data
        accessory/<skin>.sii                      simple_paint_job_data overrides
    vehicle/truck/upgrade/paintjob/<Skin>/<Truck>/
        Cabin.dds|.tobj, <Accessory>.dds|.tobj    the masks themselves

The ``def`` side and the ``vehicle`` side are joined only by string paths, so
every path is built once, here, and reused for both the SII text and the file
it points at. That is the single thing that makes hand-built skins fail.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

from . import __version__
from .archive import pack_scs
from .dds import write_dds
from .errors import TextureError
from .imaging import blank_rgba, load_rgba, make_icon
from .project import Project
from .sii import SiiFile, SiiUnit, write_sui
from .tobj import write_tobj
from .vehicle import Vehicle

__all__ = ["BuildResult", "build"]

MOD_IMAGE_SIZE = (276, 162)

# Masks for accessories the skin does not cover. Fully transparent, so with
# airbrush on the accessory simply keeps the player's base colour. 16x16 keeps
# the archive small -- the game scales the mask across the UVs regardless.
_PLACEHOLDER_SIZE = (16, 16)

Logger = Callable[[str], None]


@dataclass
class BuildResult:
    tree_dir: Path
    archive: Optional[Path] = None
    files: List[Path] = field(default_factory=list)
    masks: List[Tuple[str, str]] = field(default_factory=list)  # (label, archive path)
    warnings: List[str] = field(default_factory=list)

    @property
    def total_bytes(self) -> int:
        return sum(f.stat().st_size for f in self.files if f.is_file())


def build(
    project: Project,
    *,
    pack: bool = True,
    resize_mismatched: bool = False,
    log: Optional[Logger] = None,
) -> BuildResult:
    """Build ``project`` into a mod tree, and optionally a ``.scs`` archive."""
    say: Logger = log or (lambda _msg: None)

    vehicle = project.vehicle
    skin = project.skin
    out_dir = Path(project.output.directory)
    tree_dir = out_dir / f"{project.mod.unit_name}_tree"
    if tree_dir.exists():
        shutil.rmtree(tree_dir)
    tree_dir.mkdir(parents=True, exist_ok=True)

    result = BuildResult(tree_dir=tree_dir)

    def record(path: Path) -> Path:
        result.files.append(path)
        return path

    def write_mask(name: str, image: np.ndarray) -> str:
        """Write ``<name>.dds`` + ``<name>.tobj`` and return the TOBJ archive path."""
        rel_dir = vehicle.texture_dir(skin.asset_name)
        dds_archive_path = f"/{rel_dir}/{name}.dds"
        record(
            write_dds(
                tree_dir / rel_dir / f"{name}.dds",
                image,
                fmt=project.output.dds_format,
                mipmaps=project.output.mipmaps,
            )
        )
        record(write_tobj(tree_dir / rel_dir / f"{name}.tobj", dds_archive_path))
        result.masks.append((name, f"/{rel_dir}/{name}.tobj"))
        return f"/{rel_dir}/{name}.tobj"

    def load_mask(path: Path, label: str) -> np.ndarray:
        try:
            return load_rgba(path, expect_size=vehicle.template_size)
        except TextureError:
            if not resize_mismatched:
                raise
            image = load_rgba(path, resize_to=vehicle.template_size)
            result.warnings.append(
                f"{label}: resampled {Path(path).name} to "
                f"{vehicle.template_size[0]}x{vehicle.template_size[1]}"
            )
            return image

    # ------------------------------------------------------------ loose files
    say("writing mod metadata")
    _write_manifest(tree_dir, project, record)
    _write_versions(tree_dir, record)
    _write_description(tree_dir, project, record)
    _write_mod_image(tree_dir, project, record)

    # ------------------------------------------------------------- shop icon
    say("writing shop icon")
    _write_shop_icon(tree_dir, project, record)

    # -------------------------------------------------------- shared settings
    settings_name = f"{skin.unit_name}_settings.sui"
    settings: Dict[str, object] = {
        "name": skin.name,
        "price": skin.price,
        "unlock": skin.unlock,
        "airbrush": skin.airbrush,
        "icon": f"{skin.unit_name}_icon",
    }
    if skin.base_color is not None:
        settings["base_color"] = skin.base_color
    if vehicle.alternate_uvset:
        # Tells the game to sample the mask through the vehicle's mirrored UV
        # layer. It must match how the model was exported (truckpaint.altuv).
        settings["alternate_uvset"] = True
    record(write_sui(tree_dir / vehicle.def_dir / settings_name, settings))

    # ------------------------------------------------------- masks + def files
    accessory_masks = _build_accessory_masks(project, write_mask, say)

    if vehicle.separate_paintjobs:
        say(f"building {len(vehicle.cabins)} per-cabin paintjob(s)")
        for cabin in vehicle.cabins:
            source = project.cabin_textures.get(cabin.key) or project.main_texture
            image = load_mask(source, f"cabin {cabin.key}")
            mask_name = _with_alt_uv_suffix(cabin.texture_name, vehicle)
            mask_path = write_mask(mask_name, image)

            paintjob_unit = f"{skin.unit_name}_{cabin.key}"
            _write_paintjob_sii(
                tree_dir, vehicle, paintjob_unit, settings_name, mask_path,
                suitable_for=cabin.units, record=record,
            )
            if accessory_masks:
                _write_accessory_sii(tree_dir, vehicle, paintjob_unit, accessory_masks, record)
    else:
        say("building single whole-vehicle paintjob")
        image = load_mask(project.main_texture, "main")
        mask_name = _with_alt_uv_suffix(vehicle.main_texture_name(), vehicle)
        mask_path = write_mask(mask_name, image)

        # No suitable_for[]: one mask covers every cabin, and an omitted list
        # means "all of them". Enumerating cabins here would only create a way
        # to miss one and have the paint job quietly vanish from that cab.
        _write_paintjob_sii(
            tree_dir, vehicle, skin.unit_name, settings_name, mask_path,
            suitable_for=[], record=record,
        )
        if accessory_masks:
            _write_accessory_sii(tree_dir, vehicle, skin.unit_name, accessory_masks, record)

    # ------------------------------------------------------------------ pack
    if pack:
        archive = out_dir / f"{project.mod.unit_name}.scs"
        say(f"packing {archive.name}")
        result.archive = pack_scs(tree_dir, archive, compress=project.output.compress)

    if not project.output.keep_tree and result.archive is not None:
        shutil.rmtree(tree_dir)

    return result


# --------------------------------------------------------------------------
# pieces
# --------------------------------------------------------------------------

def _with_alt_uv_suffix(name: str, vehicle: Vehicle) -> str:
    """Mark alt-uvset masks in the file name.

    Purely a convention, but it matches the community template packs, so a
    mask file dropped in from one of those lands under the name expected here.
    """
    return f"{name} (alt uvset)" if vehicle.alternate_uvset else name


def _build_accessory_masks(project: Project, write_mask, say: Logger) -> List[Tuple[str, List[str]]]:
    """Write one mask per accessory group; returns ``[(tobj path, unit names)]``."""
    vehicle = project.vehicle
    if not vehicle.uses_accessories:
        return []

    say(f"building {len(vehicle.accessories)} accessory mask(s)")
    masks: List[Tuple[str, List[str]]] = []
    for group in vehicle.accessories:
        source = project.accessory_textures.get(group.label)
        if source is None:
            image = blank_rgba(*_PLACEHOLDER_SIZE)
        else:
            image = load_rgba(source)
        mask_path = write_mask(group.texture_name, image)
        masks.append((mask_path, group.units))
    return masks


def _write_paintjob_sii(
    tree_dir: Path,
    vehicle: Vehicle,
    paintjob_unit: str,
    settings_name: str,
    mask_path: str,
    *,
    suitable_for: List[str],
    record,
) -> Path:
    unit = SiiUnit(
        "accessory_paint_job_data", f"{paintjob_unit}.{vehicle.path}.paint_job"
    )
    unit.include(settings_name)
    for cabin_unit in suitable_for:
        unit.append("suitable_for", f"{cabin_unit}.{vehicle.path}.cabin")
    unit.set("paint_job_mask", mask_path)
    return record(
        SiiFile(unit).write(tree_dir / vehicle.def_dir / f"{paintjob_unit}.sii")
    )


def _write_accessory_sii(
    tree_dir: Path,
    vehicle: Vehicle,
    paintjob_unit: str,
    masks: List[Tuple[str, List[str]]],
    record,
) -> Path:
    """Overrides that point individual painted accessories at their own mask.

    The unit name ``.ovrN`` is an override slot on the paintjob above; the
    file must sit in ``paint_job/accessory/`` and share the paintjob's name for
    the game to associate the two.
    """
    sii = SiiFile()
    for index, (mask_path, units) in enumerate(masks):
        unit = SiiUnit("simple_paint_job_data", f".ovr{index}")
        unit.set("paint_job_mask", mask_path)
        unit.extend("acc_list", units)
        sii.add(unit)
    return record(
        sii.write(tree_dir / vehicle.def_dir / "accessory" / f"{paintjob_unit}.sii")
    )


def _write_manifest(tree_dir: Path, project: Project, record) -> Path:
    unit = SiiUnit("mod_package", ".package_name")
    unit.set("package_version", project.mod.version)
    unit.set("display_name", project.mod.name)
    unit.set("author", project.mod.author)
    unit.blank()
    unit.append("category", "paint_job")
    unit.blank()
    unit.set("icon", "Mod_Manager_Image.jpg")
    unit.set("description_file", "Mod_Manager_Description.txt")
    return record(SiiFile(unit).write(tree_dir / "manifest.sii"))


def _write_versions(tree_dir: Path, record) -> Path:
    unit = SiiUnit("package_version_info", ".universal")
    unit.set("package_name", "universal")
    return record(SiiFile(unit).write(tree_dir / "versions.sii"))


def _write_description(tree_dir: Path, project: Project, record) -> Path:
    vehicle = project.vehicle
    lines = []
    if project.mod.description:
        lines.append(project.mod.description)
        lines.append("")
    owner = "" if not vehicle.is_mod else f"{vehicle.author}'s "
    lines.append(f"Paint job for {owner}{vehicle.name}.")
    if vehicle.separate_paintjobs and vehicle.cabins:
        lines.append("")
        lines.append("Cabins supported:")
        lines.extend(f"- {cabin.display_name}" for cabin in vehicle.cabins)
    lines.append("")
    lines.append(f"Built with euro-creator {__version__}.")
    path = tree_dir / "Mod_Manager_Description.txt"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return record(path)


def _write_mod_image(tree_dir: Path, project: Project, record) -> Path:
    """The thumbnail shown in the in-game mod manager. Must be a JPEG."""
    canvas = Image.new("RGB", MOD_IMAGE_SIZE, (28, 30, 34))
    source = project.mod.icon or project.skin.icon
    if source is not None and Path(source).is_file():
        with Image.open(source) as handle:
            art = handle.convert("RGB")
        art.thumbnail(MOD_IMAGE_SIZE, Image.LANCZOS)
        canvas.paste(art, ((MOD_IMAGE_SIZE[0] - art.width) // 2,
                           (MOD_IMAGE_SIZE[1] - art.height) // 2))
    path = tree_dir / "Mod_Manager_Image.jpg"
    canvas.save(path, "JPEG", quality=90)
    return record(path)


def _write_shop_icon(tree_dir: Path, project: Project, record) -> None:
    skin = project.skin
    icon_dir = tree_dir / "material" / "ui" / "accessory"
    dds_name = f"{skin.asset_name} Icon.dds"
    archive_path = f"/material/ui/accessory/{dds_name}"

    record(write_dds(icon_dir / dds_name, make_icon(skin.icon), fmt="dxt5", mipmaps=True))
    # Clamped: the icon does not tile, and repeat addressing shows a seam on
    # the mip levels the UI picks at small sizes.
    record(write_tobj(icon_dir / f"{skin.asset_name} Icon.tobj", archive_path, clamp=True))

    mat_path = icon_dir / f"{skin.unit_name}_icon.mat"
    mat_path.write_text(
        'material: "ui"\n'
        "{\n"
        f'\ttexture: "{skin.asset_name} Icon.tobj"\n'
        '\ttexture_name: "texture"\n'
        "}\n",
        encoding="utf-8",
    )
    record(mat_path)
