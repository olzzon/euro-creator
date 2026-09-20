"""The vehicle a paintjob targets.

A vehicle description tells the builder three things the game needs and the
texture alone cannot supply:

* the ``def/vehicle/truck/<path>/`` the paintjob definitions must land in;
* which cabin variants exist, and whether each needs its own mask (SCS trucks
  unwrap different cabins onto the same template; most mod trucks do not);
* which painted accessories exist, so a ``simple_paint_job_data`` override can
  point each one at its own mask.

These can be written by hand for a truck that already exists in the game, or
generated from a ``.blend`` by ``euro-creator inspect``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

import yaml

from .errors import ConfigError
from .naming import to_asset_name, to_display_name

__all__ = ["Cabin", "AccessoryGroup", "Vehicle"]

VEHICLE_TYPES = ("truck", "trailer_owned")


@dataclass
class Cabin:
    """One cabin variant offered by the truck."""

    key: str
    display_name: str
    # Accessory unit names of the cabin(s) this entry covers. Several cabins
    # can share one mask -- they then all appear as suitable_for[] entries.
    units: List[str]

    @property
    def texture_name(self) -> str:
        return to_asset_name(self.display_name)


@dataclass
class AccessoryGroup:
    """A set of painted accessories that share one mask, e.g. every sun visor."""

    label: str
    units: List[str]

    @property
    def texture_name(self) -> str:
        return to_asset_name(self.label)


@dataclass
class Vehicle:
    path: str
    name: str
    game: str = "ets2"
    type: str = "truck"
    author: str = "SCS"
    is_mod: bool = False
    # True when the truck's paintjob UVs live on the third UV layer (the
    # mirrored layout). Must match how the model was exported, or the livery
    # lands on the wrong side of the cab.
    alternate_uvset: bool = False
    # True when each cabin has its own UV layout and therefore its own mask.
    separate_paintjobs: bool = False
    cabins: List[Cabin] = field(default_factory=list)
    accessories: List[AccessoryGroup] = field(default_factory=list)
    template_size: Tuple[int, int] = (4096, 4096)
    # The Blender UV layer the paintjob is unwrapped on; informational, carried
    # through from `inspect` so `template` and `build` agree.
    paint_uv_layer: Optional[str] = None

    # ---------------------------------------------------------------- paths

    @property
    def asset_dir(self) -> str:
        """Folder name under ``vehicle/<type>/upgrade/paintjob/<skin>/``.

        Mod trucks get the author appended, matching the convention the
        template packs for mod trucks already use.
        """
        base = to_asset_name(self.name)
        return f"{base} [{to_asset_name(self.author)}]" if self.is_mod else base

    @property
    def def_dir(self) -> str:
        return f"def/vehicle/{self.type}/{self.path}/paint_job"

    @property
    def uses_accessories(self) -> bool:
        return bool(self.accessories)

    def texture_dir(self, skin_asset_name: str) -> str:
        return f"vehicle/{self.type}/upgrade/paintjob/{skin_asset_name}/{self.asset_dir}"

    # ------------------------------------------------------------ mask list

    def main_texture_name(self) -> str:
        """Name of the single, whole-vehicle mask when cabins share a layout."""
        if self.type == "trailer_owned":
            return to_asset_name(self.name)
        return "Cabin" if self.uses_accessories else to_asset_name(self.name)

    # ---------------------------------------------------------------- io

    @classmethod
    def from_dict(cls, data: Mapping[str, Any], source: str = "<dict>") -> "Vehicle":
        def require(key: str) -> Any:
            if key not in data or data[key] in (None, ""):
                raise ConfigError(f"{source}: vehicle is missing required field '{key}'")
            return data[key]

        veh_type = str(data.get("type", "truck"))
        if veh_type not in VEHICLE_TYPES:
            raise ConfigError(
                f"{source}: vehicle type must be one of {VEHICLE_TYPES}, got {veh_type!r}"
            )

        cabins: List[Cabin] = []
        for key, entry in (data.get("cabins") or {}).items():
            if isinstance(entry, str):
                entry = {"name": entry}
            units = entry.get("units") or entry.get("unit")
            if isinstance(units, str):
                units = [units]
            if not units:
                raise ConfigError(
                    f"{source}: cabin '{key}' has no 'units' -- this is the cabin "
                    f"accessory unit name, e.g. 'highline' for "
                    f"highline.{data.get('path', '<path>')}.cabin"
                )
            cabins.append(
                Cabin(
                    key=str(key),
                    display_name=to_display_name(entry.get("name", f"Cabin {key}")),
                    units=[str(u) for u in units],
                )
            )

        accessories: List[AccessoryGroup] = []
        for label, units in (data.get("accessories") or {}).items():
            if isinstance(units, str):
                units = [units]
            if not units:
                continue
            accessories.append(
                AccessoryGroup(label=to_display_name(str(label)), units=[str(u) for u in units])
            )

        size = data.get("template_size", [4096, 4096])
        if isinstance(size, int):
            size = [size, size]
        if len(size) != 2:
            raise ConfigError(f"{source}: template_size must be [width, height]")

        vehicle = cls(
            path=str(require("path")),
            name=to_display_name(str(require("name"))),
            game=str(data.get("game", "ets2")),
            type=veh_type,
            author=to_display_name(str(data.get("author", "SCS"))),
            is_mod=bool(data.get("mod", False)),
            alternate_uvset=bool(data.get("alternate_uvset", False)),
            separate_paintjobs=bool(data.get("separate_paintjobs", False)),
            cabins=cabins,
            accessories=accessories,
            template_size=(int(size[0]), int(size[1])),
            paint_uv_layer=data.get("paint_uv_layer") or None,
        )
        if vehicle.separate_paintjobs and not vehicle.cabins:
            raise ConfigError(
                f"{source}: separate_paintjobs is set but no cabins are listed, "
                f"so there is nothing to make separate masks for"
            )
        return vehicle

    @classmethod
    def load(cls, path: Path) -> "Vehicle":
        path = Path(path)
        if not path.is_file():
            raise ConfigError(f"vehicle file not found: {path}")
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            raise ConfigError(f"{path}: invalid YAML -- {exc}") from exc
        if not isinstance(data, Mapping):
            raise ConfigError(f"{path}: expected a mapping at the top level")
        return cls.from_dict(data.get("vehicle", data), source=str(path))

    def to_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "path": self.path,
            "name": self.name,
            "game": self.game,
            "type": self.type,
            "author": self.author,
            "mod": self.is_mod,
            "alternate_uvset": self.alternate_uvset,
            "separate_paintjobs": self.separate_paintjobs,
            "template_size": list(self.template_size),
        }
        if self.paint_uv_layer:
            data["paint_uv_layer"] = self.paint_uv_layer
        if self.cabins:
            data["cabins"] = {
                cab.key: {"name": cab.display_name, "units": cab.units} for cab in self.cabins
            }
        if self.accessories:
            data["accessories"] = {acc.label: acc.units for acc in self.accessories}
        return data

    def save(self, path: Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            yaml.safe_dump({"vehicle": self.to_dict()}, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )
        return path
