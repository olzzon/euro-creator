"""Writer for SII definition files.

SII is SCS' plain-text unit format. The game's parser is unforgiving about a
few things that are easy to get wrong by hand, and this module makes them
impossible: unit names are validated, strings are escaped, arrays use the
``key[]:`` form, and files are written with the exact ``SiiNunit`` wrapper.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, List, Mapping, Sequence, Union

from .naming import is_unit_name

__all__ = ["SiiUnit", "SiiFile", "write_sui"]

Value = Union[str, int, float, bool, Sequence[float]]


def _format_value(value: Value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:g}"
    if isinstance(value, (tuple, list)):
        return "(" + ", ".join(f"{float(v):g}" for v in value) + ")"
    # Strings: the parser has no escape for a literal quote, so reject rather
    # than emit a file that silently truncates.
    text = str(value)
    if '"' in text:
        raise ValueError(f"SII string values cannot contain a double quote: {text!r}")
    return f'"{text}"'


class SiiUnit:
    """One ``class_name : unit_name { ... }`` block."""

    def __init__(self, class_name: str, unit_name: str):
        self.class_name = class_name
        self.unit_name = unit_name
        self._lines: List[str] = []

    def set(self, key: str, value: Value) -> "SiiUnit":
        self._lines.append(f"\t{key}: {_format_value(value)}")
        return self

    def append(self, key: str, value: Value) -> "SiiUnit":
        """Add one entry to an array attribute, i.e. ``key[]: value``."""
        self._lines.append(f"\t{key}[]: {_format_value(value)}")
        return self

    def extend(self, key: str, values: Iterable[Value]) -> "SiiUnit":
        for value in values:
            self.append(key, value)
        return self

    def include(self, sui_name: str) -> "SiiUnit":
        """Pull in a shared ``.sui`` fragment.

        ``@include`` must sit at column zero -- indenting it makes the parser
        treat the line as an attribute and fail the whole unit.
        """
        self._lines.append(f'@include "{sui_name}"')
        return self

    def blank(self) -> "SiiUnit":
        self._lines.append("")
        return self

    def render(self) -> str:
        head = f"{self.class_name}: {self.unit_name}\n{{\n"
        return head + "\n".join(self._lines) + "\n}\n"


class SiiFile:
    """A ``SiiNunit { ... }`` document holding one or more units."""

    def __init__(self, *units: SiiUnit):
        self.units: List[SiiUnit] = list(units)

    def add(self, unit: SiiUnit) -> SiiUnit:
        self.units.append(unit)
        return unit

    def render(self) -> str:
        body = "\n".join(unit.render() for unit in self.units)
        return "SiiNunit\n{\n" + body + "}\n"

    def write(self, path: Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.render(), encoding="utf-8")
        return path


def write_sui(path: Path, attributes: Mapping[str, Value]) -> Path:
    """Write a ``.sui`` fragment: bare indented attributes, no unit wrapper."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"\t{key}: {_format_value(value)}" for key, value in attributes.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path
