"""Driving Blender headlessly.

Everything that needs to read a ``.blend`` runs inside Blender as a subprocess;
there is no way to read mesh and UV data out of a ``.blend`` without it. The
scripts live in ``blender_scripts/`` and talk back over a JSON payload printed
between markers, because Blender writes plenty of unrelated chatter to stdout.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .errors import BlenderError

__all__ = ["find_blender", "blender_version", "run_script", "SCRIPTS_DIR"]

SCRIPTS_DIR = Path(__file__).parent / "blender_scripts"

RESULT_BEGIN = "<<<EURO_CREATOR_JSON>>>"
RESULT_END = "<<<END_EURO_CREATOR_JSON>>>"

# SCS Blender Tools' last officially supported Blender. 4.x removed the `bgl`
# module the addon still imports, so a newer Blender cannot load it at all.
SUPPORTED_BLENDER = (3, 6)

_CANDIDATES = [
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/Applications/Blender/Blender.app/Contents/MacOS/Blender",
    "/Applications/Blender 3.6/Blender.app/Contents/MacOS/Blender",
    r"C:\Program Files\Blender Foundation\Blender 3.6\blender.exe",
    "/usr/bin/blender",
    "/usr/local/bin/blender",
    "/snap/bin/blender",
]


def find_blender(explicit: Optional[str] = None) -> Path:
    """Locate a Blender executable.

    Checked in order: the ``--blender`` argument, ``$EURO_CREATOR_BLENDER``,
    ``PATH``, then the usual install locations per platform.
    """
    candidates: List[str] = []
    if explicit:
        candidates.append(explicit)
    env = os.environ.get("EURO_CREATOR_BLENDER")
    if env:
        candidates.append(env)
    on_path = shutil.which("blender")
    if on_path:
        candidates.append(on_path)
    candidates.extend(_CANDIDATES)

    for candidate in candidates:
        path = Path(candidate).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            return path

    raise BlenderError(
        "Blender not found. Install Blender 3.6 LTS (the newest release SCS "
        "Blender Tools supports), then either put it on your PATH or point at "
        "it with --blender /path/to/blender, or set $EURO_CREATOR_BLENDER."
    )


def blender_version(executable: Path) -> Optional[Sequence[int]]:
    try:
        output = subprocess.run(
            [str(executable), "--version"],
            capture_output=True, text=True, timeout=60, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"Blender\s+(\d+)\.(\d+)", output)
    return tuple(int(g) for g in match.groups()) if match else None


def run_script(
    script: str,
    blend_file: Optional[Path],
    script_args: Sequence[str] = (),
    *,
    blender: Optional[str] = None,
    verbose: bool = False,
) -> Dict[str, Any]:
    """Run ``blender_scripts/<script>`` in background Blender, return its JSON.

    ``blend_file`` is opened before the script runs; pass ``None`` to run
    against an empty scene.
    """
    executable = find_blender(blender)
    script_path = SCRIPTS_DIR / script
    if not script_path.is_file():
        raise BlenderError(f"internal error: missing helper script {script_path}")

    # --factory-startup keeps a user's startup file out of the way; --addons
    # then re-enables just the one we need. If SCS Blender Tools is not
    # installed Blender warns and carries on, and the helper script falls back
    # to reading the raw ID properties stored in the .blend.
    command: List[str] = [
        str(executable), "--background", "--factory-startup", "--addons", "io_scs_tools",
    ]
    if blend_file is not None:
        blend_path = Path(blend_file)
        if not blend_path.is_file():
            raise BlenderError(f".blend file not found: {blend_path}")
        command.append(str(blend_path))
    command += ["--python", str(script_path), "--"] + [str(a) for a in script_args]

    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as exc:
        raise BlenderError(f"could not run Blender at {executable}: {exc}") from exc

    if verbose:
        sys.stderr.write(completed.stdout)
        sys.stderr.write(completed.stderr)

    payload = _extract_payload(completed.stdout)
    if payload is None:
        version = blender_version(executable)
        hint = ""
        if version and tuple(version[:2]) > SUPPORTED_BLENDER:
            hint = (
                f"\nThis is Blender {version[0]}.{version[1]}. SCS Blender Tools "
                f"only supports up to {SUPPORTED_BLENDER[0]}.{SUPPORTED_BLENDER[1]}; "
                f"install 3.6 LTS alongside it and pass --blender."
            )
        raise BlenderError(
            f"Blender produced no result (exit code {completed.returncode}).{hint}\n"
            f"--- stderr ---\n{completed.stderr.strip()[-2000:]}"
        )

    if "error" in payload:
        raise BlenderError(payload["error"])
    return payload


def _extract_payload(stdout: str) -> Optional[Dict[str, Any]]:
    start = stdout.rfind(RESULT_BEGIN)
    if start == -1:
        return None
    end = stdout.find(RESULT_END, start)
    if end == -1:
        return None
    raw = stdout[start + len(RESULT_BEGIN) : end].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None
