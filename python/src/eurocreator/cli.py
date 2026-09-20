"""Command line interface."""

from __future__ import annotations

import argparse
import shutil
import sys
import textwrap
from pathlib import Path
from typing import List, Optional, Sequence

from . import __version__
from .errors import EuroCreatorError

# Heavy imports (numpy, Pillow) are deferred into the command functions so that
# `euro-creator --help` and `doctor` stay usable when a dependency is missing.


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _say(message: str) -> None:
    print(f"  {message}", file=sys.stderr)

def _heading(message: str) -> None:
    print(f"\n{message}", file=sys.stderr)


def _human(size: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{size:.1f} GB"


# --------------------------------------------------------------------------
# inspect
# --------------------------------------------------------------------------

def cmd_inspect(args: argparse.Namespace) -> int:
    from .blender import run_script
    from .naming import to_unit_name

    _heading(f"Reading {Path(args.blend).name} through Blender")
    payload = run_script(
        "extract.py", Path(args.blend), blender=args.blender, verbose=args.verbose
    )

    if not payload.get("scs_tools"):
        _say("note: SCS Blender Tools is not loaded; read the file's raw SCS properties instead")

    for root in payload["roots"]:
        _heading(f"SCS Root: {root['name']}")
        _say(f"parts     : {len(root['parts'])}  {', '.join(root['parts'][:8])}"
             + (" ..." if len(root["parts"]) > 8 else ""))
        _say(f"variants  : {', '.join(v['name'] for v in root['variants']) or 'none'}")
        _say(f"truckpaint materials: {len(root['paint_materials'])}")
        for material in root["paint_materials"]:
            _say(f"  - {material['name']}  [{material['effect']}]  uv={material['uv_layer']}")
        if root["mixed_uvset"]:
            _say("  WARNING: some truckpaint materials use .altuv and some do not.")
            _say("  Pick one for the whole vehicle, or the livery will be mirrored on part of it.")
        painted = sum(obj["polygons"] for obj in root["paint_objects"])
        _say(f"painted objects: {len(root['paint_objects'])} ({painted} polygons)")

    root = payload["roots"][0]
    if args.output:
        draft = _vehicle_draft(root, args, to_unit_name)
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(draft, encoding="utf-8")
        _heading(f"Wrote draft vehicle definition to {out}")
        _say("Fill in 'cabins' and 'accessories' from the truck's own def/ files")
        _say("before building -- those names come from the game, not from Blender.")
    return 0


def _vehicle_draft(root: dict, args: argparse.Namespace, to_unit_name) -> str:
    materials = root["paint_materials"]
    uv_layer = materials[0]["uv_layer"] if materials else ""
    vehicle_path = args.path or to_unit_name(root["name"]).replace("_", ".")
    size = args.size
    parts = "\n".join(f"#   {part}" for part in root["parts"]) or "#   (none)"
    variants = "\n".join(
        f"#   {v['name']}: {', '.join(v['parts']) or '(no parts)'}" for v in root["variants"]
    ) or "#   (none)"

    return textwrap.dedent(
        f"""\
        # Drafted by euro-creator {__version__} from {Path(args.blend).name}
        #
        # Parts found in the .blend:
        {parts}
        #
        # Variants found in the .blend:
        {variants}
        #
        # 'cabins' and 'accessories' below cannot be read from Blender: they are
        # the unit names the game uses, defined in the truck's own def/ files.
        # Open def/vehicle/truck/{vehicle_path}/ in the unpacked base.scs (or in
        # the truck mod) and copy the accessory unit names across.

        vehicle:
          path: {vehicle_path}
          name: {root['name']}
          game: ets2
          type: truck
          author: {args.author}
          mod: true
          # Detected from the truckpaint shader flavour on the painted materials.
          alternate_uvset: {str(root['alt_uvset']).lower()}
          paint_uv_layer: {uv_layer}
          template_size: [{size}, {size}]

          # Set true only if each cabin has its own UV layout, i.e. needs its own
          # mask. Most single-cab mod trucks leave this false.
          separate_paintjobs: false

          # cabins:
          #   a:
          #     name: Cabin A (Topline)
          #     units: [topline]      # -> suitable_for: "topline.{vehicle_path}.cabin"

          # Painted accessories. The key becomes the mask's file name; the list
          # holds the accessory unit names that share that mask.
          # accessories:
          #   Sun Visor: [sunshld.stock, sunshld.sunshld_01]
          #   Rear Bumper: [r_bumper.stock_p]
        """
    )


# --------------------------------------------------------------------------
# template
# --------------------------------------------------------------------------

def cmd_template(args: argparse.Namespace) -> int:
    import tempfile

    from .blender import run_script
    from .template import load_uv_dump, render_legend, render_template

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        dump_path = Path(tmp) / "uv.npz"
        _heading(f"Extracting paintjob UVs from {Path(args.blend).name}")
        payload = run_script(
            "extract.py",
            Path(args.blend),
            ["--uv-out", str(dump_path)] + (["--root", args.root] if args.root else []),
            blender=args.blender,
            verbose=args.verbose,
        )
        info = payload["uv_dump"]
        _say(f"{info['polygons']} polygons across {len(info['groups'])} part(s)")
        dump = load_uv_dump(dump_path)

    root = payload["roots"][0]
    _heading(f"Rendering {args.size}x{args.size} template")
    image = render_template(
        dump, size=(args.size, args.size), fill=not args.no_fill, line_width=args.line_width
    )
    template_path = out_dir / "paint_template.png"
    image.save(template_path)
    _say(f"{template_path}  ({_human(template_path.stat().st_size)})")

    legend_path = out_dir / "paint_template_legend.png"
    render_legend(dump["groups"]).save(legend_path)
    _say(f"{legend_path}")

    if args.per_part:
        parts_dir = out_dir / "parts"
        parts_dir.mkdir(exist_ok=True)
        for group in dump["groups"]:
            per = render_template(
                dump, size=(args.size, args.size), fill=not args.no_fill,
                line_width=args.line_width, only_groups=[group],
            )
            per.save(parts_dir / f"{group}.png")
        _say(f"{len(dump['groups'])} per-part templates in {parts_dir}")

    _heading("Next: paint on a layer under this template, export as PNG or TGA,")
    _say("then point textures.main at it in your project file and run 'build'.")
    if root["alt_uvset"]:
        _say("This truck uses the mirrored alternate UV set -- paint one side only.")
    return 0


# --------------------------------------------------------------------------
# init
# --------------------------------------------------------------------------

_PROJECT_TEMPLATE = """\
# euro-creator skin project
# Build with:  euro-creator build {filename}

mod:
  name: {display} Livery
  author: {author}
  version: "1.0"
  description: |
    {display} paint job.
  # icon: art/mod_image.png        # shown in the in-game mod manager

skin:
  name: {display}
  price: 12000
  unlock: 0
  # airbrush multiplies the mask onto the player's chosen base colour using the
  # mask's alpha. Leave it on unless the livery must be fully opaque.
  airbrush: true
  # base_color: [0.02, 0.02, 0.02]
  # icon: art/skin_icon.png        # shop thumbnail, letterboxed into 256x64

# Either a path to a vehicle definition, or an inline 'vehicle:' block.
vehicle: {vehicle}

textures:
  main: art/{slug}_main.png
  # cabins:
  #   a: art/{slug}_cab_a.png
  # accessories:
  #   Sun Visor: art/{slug}_visor.png

output:
  dir: dist
  dds_format: dxt5     # dxt5 | dxt1 | raw
  mipmaps: true
"""


def cmd_init(args: argparse.Namespace) -> int:
    from .naming import to_unit_name

    directory = Path(args.directory)
    directory.mkdir(parents=True, exist_ok=True)
    slug = to_unit_name(args.name)
    project_path = directory / f"{slug}.yaml"
    if project_path.exists() and not args.force:
        raise EuroCreatorError(f"{project_path} already exists (use --force to overwrite)")

    project_path.write_text(
        _PROJECT_TEMPLATE.format(
            filename=project_path.name,
            display=args.name,
            author=args.author,
            slug=slug,
            vehicle=args.vehicle or "vehicle.yaml",
        ),
        encoding="utf-8",
    )
    (directory / "art").mkdir(exist_ok=True)

    _heading(f"Created {project_path}")
    _say(f"Put your painted mask at {directory / 'art' / (slug + '_main.png')}")
    _say(f"Then:  euro-creator build {project_path}")
    return 0


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------

def cmd_build(args: argparse.Namespace) -> int:
    from .build import build
    from .project import Project

    project = Project.load(Path(args.project))
    if args.output:
        project.output.directory = Path(args.output)
    if args.format:
        project.output.dds_format = args.format

    vehicle = project.vehicle
    _heading(f"Building '{project.skin.name}' for {vehicle.name}")
    _say(f"def path  : {vehicle.def_dir}")
    _say(f"masks     : {vehicle.texture_dir(project.skin.asset_name)}")
    _say(f"format    : {project.output.dds_format}"
         f"{', mipmapped' if project.output.mipmaps else ', no mipmaps'}")

    result = build(
        project,
        pack=not args.no_pack,
        resize_mismatched=args.resize,
        log=_say,
    )

    _heading("Masks written")
    for name, path in result.masks:
        _say(f"{name:<28} {path}")

    for warning in result.warnings:
        _say(f"warning: {warning}")

    _heading("Done")
    _say(f"{len(result.files)} files, {_human(result.total_bytes)}")
    if result.archive:
        _say(f"archive : {result.archive}  ({_human(result.archive.stat().st_size)})")
        _say(f"install : copy it into {_mod_dir_hint()}")
    if project.output.keep_tree:
        _say(f"tree    : {result.tree_dir}")
    return 0


def _mod_dir_hint() -> str:
    if sys.platform == "darwin":
        return "~/Library/Application Support/Euro Truck Simulator 2/mod/"
    if sys.platform.startswith("win"):
        return "Documents\\Euro Truck Simulator 2\\mod\\"
    return "~/.local/share/Euro Truck Simulator 2/mod/"


# --------------------------------------------------------------------------
# pack / convert / doctor
# --------------------------------------------------------------------------

def cmd_pack(args: argparse.Namespace) -> int:
    from .archive import pack_scs

    source = Path(args.directory)
    out = Path(args.output) if args.output else source.with_suffix(".scs")
    archive = pack_scs(source, out, compress=args.compress)
    _heading(f"Packed {archive}  ({_human(archive.stat().st_size)})")
    _say(f"install: copy it into {_mod_dir_hint()}")
    return 0


def cmd_convert(args: argparse.Namespace) -> int:
    from .dds import write_dds
    from .imaging import load_rgba
    from .tobj import write_tobj

    image = load_rgba(Path(args.image))
    out = Path(args.output) if args.output else Path(args.image).with_suffix(".dds")
    write_dds(out, image, fmt=args.format, mipmaps=not args.no_mipmaps)
    _heading(f"Wrote {out}  ({_human(out.stat().st_size)}, {args.format})")
    if args.tobj:
        tobj_path = out.with_suffix(".tobj")
        write_tobj(tobj_path, args.tobj)
        _say(f"{tobj_path} -> {args.tobj}")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    _heading(f"euro-creator {__version__}  (python {sys.version.split()[0]})")

    ok = True
    for module in ("numpy", "PIL", "yaml"):
        try:
            __import__(module)
            _say(f"{module:<8} ok")
        except ImportError:
            ok = False
            _say(f"{module:<8} MISSING -- pip install -e .")

    from .blender import SUPPORTED_BLENDER, blender_version, find_blender

    try:
        executable = find_blender(args.blender)
    except EuroCreatorError as exc:
        _say(f"blender  not found")
        _say(f"         {exc}")
        _say("         (only 'inspect' and 'template' need it; 'build' does not)")
        return 0 if ok else 1

    version = blender_version(executable)
    printed = ".".join(str(v) for v in version) if version else "unknown version"
    _say(f"blender  {executable} ({printed})")
    if version and tuple(version[:2]) > SUPPORTED_BLENDER:
        _say(f"         WARNING: SCS Blender Tools supports up to "
             f"{SUPPORTED_BLENDER[0]}.{SUPPORTED_BLENDER[1]}; install 3.6 LTS "
             f"alongside and pass --blender to use it.")
    return 0 if ok else 1


# --------------------------------------------------------------------------
# parser
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="euro-creator",
        description="Build ETS2/ATS paintjob mods from a Blender truck and a painted texture.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """\
            typical run:
              euro-creator template truck.blend -o templates/   # what to paint on
              euro-creator inspect  truck.blend -o vehicle.yaml # draft definition
              euro-creator init "Nordic" --vehicle vehicle.yaml # project file
              euro-creator build    nordic.yaml                 # -> dist/*.scs
            """
        ),
    )
    parser.add_argument("--version", action="version", version=f"euro-creator {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_blender_flags(p: argparse.ArgumentParser) -> None:
        p.add_argument("--blender", help="path to the Blender executable")
        p.add_argument("-v", "--verbose", action="store_true", help="show Blender's own output")

    p_inspect = sub.add_parser("inspect", help="report a .blend's SCS structure and paint surfaces")
    p_inspect.add_argument("blend", help="the base .blend file")
    p_inspect.add_argument("-o", "--output", help="write a draft vehicle YAML here")
    p_inspect.add_argument("--path", help="in-game vehicle path, e.g. olzzon.scania142")
    p_inspect.add_argument("--author", default="you", help="mod author for the draft")
    p_inspect.add_argument("--size", type=int, default=4096, help="template size (default 4096)")
    add_blender_flags(p_inspect)
    p_inspect.set_defaults(func=cmd_inspect)

    p_template = sub.add_parser("template", help="render a paint template from the paintjob UVs")
    p_template.add_argument("blend", help="the base .blend file")
    p_template.add_argument("-o", "--output", default="templates", help="output directory")
    p_template.add_argument("--size", type=int, default=4096, help="template size (default 4096)")
    p_template.add_argument("--root", help="name of the SCS Root to use, if there are several")
    p_template.add_argument("--per-part", action="store_true", help="also write one PNG per part")
    p_template.add_argument("--no-fill", action="store_true", help="outlines only, no tinted fill")
    p_template.add_argument("--line-width", type=int, default=1)
    add_blender_flags(p_template)
    p_template.set_defaults(func=cmd_template)

    p_init = sub.add_parser("init", help="scaffold a skin project file")
    p_init.add_argument("name", help="the skin's in-game name, e.g. \"Nordic\"")
    p_init.add_argument("-d", "--directory", default=".", help="where to create it")
    p_init.add_argument("--author", default="you")
    p_init.add_argument("--vehicle", help="path to a vehicle YAML")
    p_init.add_argument("--force", action="store_true")
    p_init.set_defaults(func=cmd_init)

    p_build = sub.add_parser("build", help="build the mod and pack it as .scs")
    p_build.add_argument("project", help="the skin project YAML")
    p_build.add_argument("-o", "--output", help="override output.dir")
    p_build.add_argument("--format", choices=("dxt5", "dxt1", "raw"), help="override DDS format")
    p_build.add_argument("--no-pack", action="store_true", help="leave the tree unpacked")
    p_build.add_argument(
        "--resize", action="store_true",
        help="resample masks that do not match the template size instead of failing",
    )
    p_build.set_defaults(func=cmd_build)

    p_pack = sub.add_parser("pack", help="zip a mod folder into a .scs archive")
    p_pack.add_argument("directory")
    p_pack.add_argument("-o", "--output")
    p_pack.add_argument("--compress", action="store_true", help="deflate instead of store")
    p_pack.set_defaults(func=cmd_pack)

    p_convert = sub.add_parser("convert", help="convert an image to .dds (and optionally .tobj)")
    p_convert.add_argument("image")
    p_convert.add_argument("-o", "--output")
    p_convert.add_argument("--format", choices=("dxt5", "dxt1", "raw"), default="dxt5")
    p_convert.add_argument("--no-mipmaps", action="store_true")
    p_convert.add_argument("--tobj", help="archive-absolute .dds path to write a .tobj for")
    p_convert.set_defaults(func=cmd_convert)

    p_doctor = sub.add_parser("doctor", help="check the toolchain")
    p_doctor.add_argument("--blender")
    p_doctor.set_defaults(func=cmd_doctor)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except EuroCreatorError as exc:
        print(f"\neuro-creator: {exc}\n", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
