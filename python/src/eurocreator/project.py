"""The skin project file: one YAML that describes a whole mod.

Everything ``euro-creator build`` needs lives here, so a skin is reproducible
from source art and a text file rather than from a folder someone assembled by
hand. Paths inside it are resolved relative to the project file itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence

import yaml

from .dds import FORMATS
from .errors import ConfigError
from .naming import to_asset_name, to_display_name, to_unit_name
from .vehicle import Vehicle

__all__ = ["ModInfo", "SkinInfo", "OutputOptions", "Project"]


@dataclass
class ModInfo:
    name: str
    author: str
    version: str = "1.0"
    description: str = ""
    icon: Optional[Path] = None  # mod manager image, any Pillow-readable format

    @property
    def unit_name(self) -> str:
        return to_unit_name(f"{self.author}_{self.name}")


@dataclass
class SkinInfo:
    name: str
    price: int = 10000
    unlock: int = 0
    # airbrush: the mask is multiplied onto the base colour by its alpha, so
    # the player's chosen colour still shows through where alpha is low. This
    # is what nearly every livery wants; turn it off for an opaque wrap.
    airbrush: bool = True
    base_color: Optional[Sequence[float]] = None
    icon: Optional[Path] = None

    @property
    def unit_name(self) -> str:
        return to_unit_name(self.name)

    @property
    def asset_name(self) -> str:
        return to_asset_name(self.name)


@dataclass
class OutputOptions:
    directory: Path = Path("dist")
    dds_format: str = "dxt5"
    mipmaps: bool = True
    compress: bool = False
    # Keep the unpacked mod tree next to the .scs. Invaluable when reading
    # game.log.txt, which reports failures by in-archive path.
    keep_tree: bool = True


@dataclass
class Project:
    mod: ModInfo
    skin: SkinInfo
    vehicle: Vehicle
    main_texture: Optional[Path] = None
    cabin_textures: Dict[str, Path] = field(default_factory=dict)
    accessory_textures: Dict[str, Path] = field(default_factory=dict)
    output: OutputOptions = field(default_factory=OutputOptions)
    source_path: Optional[Path] = None

    # ------------------------------------------------------------------ io

    @classmethod
    def load(cls, path: Path) -> "Project":
        path = Path(path).resolve()
        if not path.is_file():
            raise ConfigError(f"project file not found: {path}")
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            raise ConfigError(f"{path}: invalid YAML -- {exc}") from exc
        if not isinstance(data, Mapping):
            raise ConfigError(f"{path}: expected a mapping at the top level")
        return cls.from_dict(data, base_dir=path.parent, source=str(path), source_path=path)

    @classmethod
    def from_dict(
        cls,
        data: Mapping[str, Any],
        *,
        base_dir: Path,
        source: str = "<dict>",
        source_path: Optional[Path] = None,
    ) -> "Project":
        base_dir = Path(base_dir)

        def resolve(value: Any) -> Optional[Path]:
            if value in (None, ""):
                return None
            candidate = Path(str(value)).expanduser()
            return candidate if candidate.is_absolute() else (base_dir / candidate)

        mod_data = data.get("mod")
        if not isinstance(mod_data, Mapping):
            raise ConfigError(f"{source}: missing 'mod:' section (name, author, version)")
        for key in ("name", "author"):
            if not mod_data.get(key):
                raise ConfigError(f"{source}: mod.{key} is required")
        mod = ModInfo(
            name=to_display_name(str(mod_data["name"])),
            author=to_display_name(str(mod_data["author"])),
            version=str(mod_data.get("version", "1.0")),
            description=str(mod_data.get("description", "")).strip(),
            icon=resolve(mod_data.get("icon")),
        )

        skin_data = data.get("skin")
        if not isinstance(skin_data, Mapping):
            raise ConfigError(f"{source}: missing 'skin:' section (name, price, ...)")
        if not skin_data.get("name"):
            raise ConfigError(f"{source}: skin.name is required")
        base_color = skin_data.get("base_color")
        if base_color is not None:
            if len(base_color) != 3:
                raise ConfigError(f"{source}: skin.base_color must be three values 0..1")
            base_color = [float(c) for c in base_color]
        skin = SkinInfo(
            name=to_display_name(str(skin_data["name"])),
            price=int(skin_data.get("price", 10000)),
            unlock=int(skin_data.get("unlock", 0)),
            airbrush=bool(skin_data.get("airbrush", True)),
            base_color=base_color,
            icon=resolve(skin_data.get("icon")),
        )

        vehicle_entry = data.get("vehicle")
        if isinstance(vehicle_entry, str):
            vehicle = Vehicle.load(resolve(vehicle_entry))
        elif isinstance(vehicle_entry, Mapping):
            vehicle = Vehicle.from_dict(vehicle_entry, source=source)
        else:
            raise ConfigError(
                f"{source}: 'vehicle:' must be either a path to a vehicle YAML "
                f"or an inline vehicle definition"
            )

        textures = data.get("textures") or {}
        if not isinstance(textures, Mapping):
            raise ConfigError(f"{source}: 'textures:' must be a mapping")
        cabin_textures = {
            str(key): resolve(value)
            for key, value in (textures.get("cabins") or {}).items()
        }
        accessory_textures = {
            str(key): resolve(value)
            for key, value in (textures.get("accessories") or {}).items()
        }

        out_data = data.get("output") or {}
        dds_format = str(out_data.get("dds_format", "dxt5")).lower()
        if dds_format not in FORMATS:
            raise ConfigError(
                f"{source}: output.dds_format must be one of {FORMATS}, got {dds_format!r}"
            )
        output = OutputOptions(
            directory=resolve(out_data.get("dir", "dist")) or (base_dir / "dist"),
            dds_format=dds_format,
            mipmaps=bool(out_data.get("mipmaps", True)),
            compress=bool(out_data.get("compress", False)),
            keep_tree=bool(out_data.get("keep_tree", True)),
        )

        project = cls(
            mod=mod,
            skin=skin,
            vehicle=vehicle,
            main_texture=resolve(textures.get("main")),
            cabin_textures=cabin_textures,
            accessory_textures=accessory_textures,
            output=output,
            source_path=source_path,
        )
        project.validate(source)
        return project

    # ------------------------------------------------------------ checking

    def validate(self, source: str = "<project>") -> None:
        """Catch the mistakes that otherwise surface as a silent no-op in game."""
        vehicle = self.vehicle

        if vehicle.separate_paintjobs:
            known = {cab.key for cab in vehicle.cabins}
            unknown = set(self.cabin_textures) - known
            if unknown:
                raise ConfigError(
                    f"{source}: textures.cabins refers to cabin(s) "
                    f"{sorted(unknown)} that this vehicle does not have. "
                    f"Known cabins: {sorted(known)}"
                )
            missing = [cab.key for cab in vehicle.cabins if cab.key not in self.cabin_textures]
            if missing and self.main_texture is None:
                raise ConfigError(
                    f"{source}: this vehicle unwraps each cabin separately, so cabin(s) "
                    f"{missing} need their own entry under textures.cabins -- or set "
                    f"textures.main as a fallback for the ones you have not painted."
                )
        elif self.main_texture is None:
            raise ConfigError(
                f"{source}: textures.main is required -- it is the mask painted on the "
                f"UV template exported by 'euro-creator template'."
            )

        known_accessories = {acc.label for acc in vehicle.accessories}
        unknown = set(self.accessory_textures) - known_accessories
        if unknown:
            raise ConfigError(
                f"{source}: textures.accessories refers to {sorted(unknown)}, which this "
                f"vehicle does not define. Known groups: {sorted(known_accessories) or 'none'}"
            )
