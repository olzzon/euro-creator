"""Runs *inside* Blender. Reads an SCS truck and reports what a skin needs.

Invoked by the service as::

    blender --background --factory-startup --addons io_scs_tools --disable-autoexec \
        truck.blend --python extract.py -- [--uv-out layout.bin] [--root NAME]

Two jobs:

1. Describe the vehicle -- SCS Root, parts, variants, and every material using
   a ``truckpaint`` shader, which is exactly the set of surfaces a paint job
   can land on. Printed as JSON between markers for the parent process.
2. Optionally dump the paint job UV polygons to a flat binary so the service
   can rasterise a paint template in Node, where it has an image library.

Property access is deliberately defensive. SCS Blender Tools registers
``scs_props`` as a PropertyGroup, but if the addon is missing or failed to load
(it does not work on Blender 4.x) the same data is still readable from the raw
ID properties stored in the .blend. Every read tries both.
"""

import json
import struct
import sys
import traceback

import bpy

RESULT_BEGIN = "<<<EURO_CREATOR_JSON>>>"
RESULT_END = "<<<END_EURO_CREATOR_JSON>>>"

TRUCKPAINT = "truckpaint"
ALT_UV_FLAVOUR = ".altuv"

UV_DUMP_MAGIC = b"EUVD"
UV_DUMP_VERSION = 1

# Polygon vertex counts and group indices are stored as u16 in the dump.
MAX_U16 = 0xFFFF


# --------------------------------------------------------------------------
# property access
# --------------------------------------------------------------------------

def scs_prop(datablock, name, default=None):
    """Read one ``scs_props`` field, via the addon or the raw ID property."""
    group = getattr(datablock, "scs_props", None)
    if group is not None:
        value = getattr(group, name, None)
        if value not in (None, ""):
            return value
    raw = datablock.get("scs_props")
    if raw is not None and hasattr(raw, "get"):
        value = raw.get(name)
        if value not in (None, ""):
            return value
    return default


def scs_collection(datablock, name):
    """Read an inventory collection as a list of ``{"name", "item"}``."""
    collection = getattr(datablock, name, None)
    if collection is not None and len(collection) > 0:
        return [{"name": item.name, "item": item} for item in collection]
    raw = datablock.get(name)
    if raw is None:
        return []
    out = []
    for item in raw:
        try:
            out.append({"name": item["name"], "item": item})
        except (KeyError, TypeError):
            continue
    return out


def is_scs_root(obj):
    return obj.type == "EMPTY" and scs_prop(obj, "empty_object_type", "") == "SCS_Root"


def descendants(root):
    stack = list(root.children)
    while stack:
        obj = stack.pop()
        stack.extend(obj.children)
        yield obj


# --------------------------------------------------------------------------
# inspection
# --------------------------------------------------------------------------

def paint_uv_layer_for(material, mesh):
    """Which UV layer this truckpaint material samples the paint job mask on.

    The addon stores it in ``shader_texture_paintjob_uv``. Failing that, fall
    back to the layout convention: UV0 is the base/AO unwrap, UV1 the paint
    job, UV2 the mirrored alternate set used when the shader carries ``.altuv``.
    """
    group = getattr(material, "scs_props", None)
    mapping = getattr(group, "shader_texture_paintjob_uv", None) if group else None
    if mapping:
        for entry in mapping:
            value = getattr(entry, "value", "")
            if value:
                return value

    effect = str(scs_prop(material, "mat_effect_name", "") or "")
    layers = [layer.name for layer in mesh.uv_layers]
    wanted = 2 if ALT_UV_FLAVOUR in effect else 1
    if len(layers) > wanted:
        return layers[wanted]
    return layers[-1] if layers else None


def paint_slots(mesh):
    """Material slot indices on this mesh that use a truckpaint shader."""
    return {
        index
        for index, slot in enumerate(mesh.materials)
        if slot is not None and TRUCKPAINT in str(scs_prop(slot, "mat_effect_name", "") or "")
    }


def inspect_root(root):
    parts = [entry["name"] for entry in scs_collection(root, "scs_object_part_inventory")]

    variants = []
    for entry in scs_collection(root, "scs_object_variant_inventory"):
        item = entry["item"]
        inclusion = getattr(item, "parts", None)
        if inclusion is None and hasattr(item, "get"):
            inclusion = item.get("parts")
        included = []
        if inclusion is not None:
            for index, part_entry in enumerate(inclusion):
                if index >= len(parts):
                    break
                flag = getattr(part_entry, "include", None)
                if flag is None and hasattr(part_entry, "get"):
                    flag = part_entry.get("include")
                if flag:
                    included.append(parts[index])
        variants.append({"name": entry["name"], "parts": included})

    paint_materials = {}
    paint_objects = []
    material_names = set()

    for obj in descendants(root):
        if obj.type != "MESH" or obj.data is None:
            continue
        mesh = obj.data
        for slot in mesh.materials:
            if slot is not None:
                material_names.add(slot.name)

        slots = paint_slots(mesh)
        if not slots:
            continue
        for index in sorted(slots):
            slot = mesh.materials[index]
            if slot.name not in paint_materials:
                effect = str(scs_prop(slot, "mat_effect_name", "") or "")
                paint_materials[slot.name] = {
                    "name": slot.name,
                    "effect": effect,
                    "altUvset": ALT_UV_FLAVOUR in effect,
                    "uvLayer": paint_uv_layer_for(slot, mesh),
                }
        paint_objects.append(
            {
                "object": obj.name,
                "part": str(scs_prop(obj, "scs_part", "defaultpart")),
                "uvLayers": [layer.name for layer in mesh.uv_layers],
                "polygons": len(mesh.polygons),
            }
        )

    materials = list(paint_materials.values())
    return {
        "name": root.name,
        "parts": parts,
        "variants": variants,
        "paintMaterials": materials,
        "paintObjects": paint_objects,
        "materialCount": len(material_names),
        # A truck is an alt-uvset truck when its painted surfaces were exported
        # with the .altuv flavour. Mixing the two is a modelling error, so it is
        # reported rather than silently resolved one way.
        "altUvset": bool(materials) and all(m["altUvset"] for m in materials),
        "mixedUvset": bool(materials)
        and any(m["altUvset"] for m in materials)
        and not all(m["altUvset"] for m in materials),
    }


# --------------------------------------------------------------------------
# UV dump
# --------------------------------------------------------------------------

def dump_uvs(root, out_path):
    """Write paint job UV polygons to ``out_path``.

    Format (little endian), matching packages/core/src/uvdump.ts::

        "EUVD", u32 version, u32 polygons, u32 loops, u32 groups,
        groups x (u16 length + utf-8 name),
        polygons x u32 start, polygons x u16 count, polygons x u16 group,
        loops x (f32 u, f32 v)
    """
    groups = []
    group_index = {}
    starts = []
    counts = []
    group_ids = []
    uvs = []
    cursor = 0
    skipped_ngons = 0

    for obj in descendants(root):
        if obj.type != "MESH" or obj.data is None:
            continue
        mesh = obj.data
        slots = paint_slots(mesh)
        if not slots or not mesh.uv_layers:
            continue

        layer_name = None
        for index in sorted(slots):
            layer_name = paint_uv_layer_for(mesh.materials[index], mesh)
            if layer_name:
                break
        layer = mesh.uv_layers.get(layer_name) if layer_name else None
        if layer is None:
            continue

        part = str(scs_prop(obj, "scs_part", "defaultpart"))
        if part not in group_index:
            group_index[part] = len(groups)
            groups.append(part)
        gid = group_index[part]
        if gid > MAX_U16:
            raise RuntimeError("more than 65535 SCS parts in one model")

        uv_data = layer.data
        for polygon in mesh.polygons:
            if polygon.material_index not in slots:
                continue
            total = polygon.loop_total
            if total > MAX_U16:
                skipped_ngons += 1
                continue
            start = polygon.loop_start
            for loop in range(start, start + total):
                u, v = uv_data[loop].uv
                uvs.append(u)
                uvs.append(v)
            starts.append(cursor)
            counts.append(total)
            group_ids.append(gid)
            cursor += total

    if not starts:
        raise RuntimeError(
            "no truckpaint geometry found -- assign an eut2.truckpaint shader to the "
            "painted surfaces before exporting a template"
        )

    with open(out_path, "wb") as handle:
        handle.write(UV_DUMP_MAGIC)
        handle.write(struct.pack("<III", UV_DUMP_VERSION, len(starts), cursor))
        handle.write(struct.pack("<I", len(groups)))
        for name in groups:
            encoded = name.encode("utf-8")[:MAX_U16]
            handle.write(struct.pack("<H", len(encoded)))
            handle.write(encoded)
        handle.write(struct.pack("<%dI" % len(starts), *starts))
        handle.write(struct.pack("<%dH" % len(counts), *counts))
        handle.write(struct.pack("<%dH" % len(group_ids), *group_ids))
        handle.write(struct.pack("<%df" % len(uvs), *uvs))

    return {
        "polygons": len(starts),
        "loops": cursor,
        "groups": groups,
        "skippedNgons": skipped_ngons,
    }


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    uv_out = None
    root_name = None
    for index, arg in enumerate(argv):
        if arg == "--uv-out" and index + 1 < len(argv):
            uv_out = argv[index + 1]
        elif arg == "--root" and index + 1 < len(argv):
            root_name = argv[index + 1]

    roots = [obj for obj in bpy.data.objects if is_scs_root(obj)]
    if not roots:
        raise RuntimeError(
            "no SCS Root Object in this .blend. Every exportable SCS model sits under "
            "one (Add > Empty, then set SCS Object Type to 'SCS Root')."
        )

    if root_name:
        matching = [obj for obj in roots if obj.name == root_name]
        if not matching:
            raise RuntimeError(
                "no SCS Root named %r; found: %s"
                % (root_name, ", ".join(obj.name for obj in roots))
            )
        roots = matching

    result = {
        "blendFile": bpy.data.filepath,
        "blenderVersion": list(bpy.app.version),
        "scsTools": "io_scs_tools" in bpy.context.preferences.addons,
        "roots": [inspect_root(root) for root in roots],
    }
    if uv_out:
        result["uvDump"] = dump_uvs(roots[0], uv_out)
    return result


if __name__ == "__main__":
    try:
        payload = main()
    except Exception as exc:  # reported to the parent process, not as a traceback dump
        payload = {"error": "%s: %s" % (type(exc).__name__, exc)}
        traceback.print_exc()
    print(RESULT_BEGIN)
    print(json.dumps(payload, indent=1, default=str))
    print(RESULT_END)
