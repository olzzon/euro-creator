"""Runs *inside* Blender. Reads an SCS truck and reports what a skin needs.

Invoked as::

    blender --background truck.blend --python extract.py -- [--uv-out layout.npz]

Two jobs:

1. Describe the vehicle -- SCS Root, parts, variants, and every material using
   a ``truckpaint`` shader, which is exactly the set of surfaces a paintjob can
   land on. Printed as JSON between markers for the parent process.
2. Optionally dump the paintjob UV polygons to a ``.npz`` so euro-creator can
   rasterise a paint template outside Blender, where Pillow is available.

Property access is deliberately defensive. SCS Blender Tools registers
``scs_props`` as a PropertyGroup, but if the addon is missing or failed to load
(it does not work on Blender 4.x) the same data is still readable from the raw
ID properties stored in the .blend. Every read tries both.
"""

import json
import sys
import traceback

import bpy

try:
    import numpy as np
except ImportError:  # pragma: no cover - Blender ships numpy
    np = None

RESULT_BEGIN = "<<<EURO_CREATOR_JSON>>>"
RESULT_END = "<<<END_EURO_CREATOR_JSON>>>"

TRUCKPAINT = "truckpaint"
ALT_UV_FLAVOUR = ".altuv"


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
    if isinstance(raw, dict) or hasattr(raw, "get"):
        value = raw.get(name)
        if value not in (None, ""):
            return value
    return default


def scs_collection(datablock, name):
    """Read an inventory collection as a list of dicts."""
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
    """Which UV layer this truckpaint material samples the paintjob mask on.

    The addon stores it in ``shader_texture_paintjob_uv``. Failing that, fall
    back to the layout convention: UV0 is the base/AO unwrap, UV1 the paintjob,
    UV2 the mirrored alternate set used when the shader carries ``.altuv``.
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
    all_materials = set()

    for obj in descendants(root):
        if obj.type != "MESH" or obj.data is None:
            continue
        mesh = obj.data
        object_paint_slots = []
        for slot_index, slot in enumerate(mesh.materials):
            if slot is None:
                continue
            effect = str(scs_prop(slot, "mat_effect_name", "") or "")
            all_materials.add(slot.name)
            if TRUCKPAINT not in effect:
                continue
            object_paint_slots.append(slot_index)
            if slot.name not in paint_materials:
                paint_materials[slot.name] = {
                    "name": slot.name,
                    "effect": effect,
                    "alt_uvset": ALT_UV_FLAVOUR in effect,
                    "uv_layer": paint_uv_layer_for(slot, mesh),
                }
        if object_paint_slots:
            paint_objects.append(
                {
                    "object": obj.name,
                    "part": str(scs_prop(obj, "scs_part", "defaultpart")),
                    "slots": object_paint_slots,
                    "uv_layers": [layer.name for layer in mesh.uv_layers],
                    "polygons": len(mesh.polygons),
                }
            )

    materials = list(paint_materials.values())
    return {
        "name": root.name,
        "parts": parts,
        "variants": variants,
        "paint_materials": materials,
        "paint_objects": paint_objects,
        "material_count": len(all_materials),
        # A truck is an alt-uvset truck when its painted surfaces were exported
        # with the .altuv flavour; mixing the two is a modelling error, so
        # report it rather than silently picking one.
        "alt_uvset": bool(materials) and all(m["alt_uvset"] for m in materials),
        "mixed_uvset": bool(materials)
        and any(m["alt_uvset"] for m in materials)
        and not all(m["alt_uvset"] for m in materials),
    }


# --------------------------------------------------------------------------
# UV dump
# --------------------------------------------------------------------------

def dump_uvs(root, out_path):
    """Write paintjob UV polygons to ``out_path`` as a .npz.

    Arrays: ``uv`` (n, 2) float32 in UV space, ``poly_start``/``poly_count``
    indexing into it, and ``poly_group`` indexing ``groups``.
    """
    if np is None:
        raise RuntimeError("numpy is unavailable inside this Blender build")

    uv_chunks = []
    starts = []
    counts = []
    group_ids = []
    groups = []
    group_index = {}
    cursor = 0

    for obj in descendants(root):
        if obj.type != "MESH" or obj.data is None:
            continue
        mesh = obj.data
        paint_slots = {
            index
            for index, slot in enumerate(mesh.materials)
            if slot is not None
            and TRUCKPAINT in str(scs_prop(slot, "mat_effect_name", "") or "")
        }
        if not paint_slots or not mesh.uv_layers:
            continue

        layer_name = None
        for index in sorted(paint_slots):
            layer_name = paint_uv_layer_for(mesh.materials[index], mesh)
            if layer_name:
                break
        layer = mesh.uv_layers.get(layer_name) if layer_name else None
        if layer is None:
            continue

        loop_uv = np.empty(len(mesh.loops) * 2, dtype=np.float32)
        layer.data.foreach_get("uv", loop_uv)
        loop_uv = loop_uv.reshape(-1, 2)

        poly_count = len(mesh.polygons)
        loop_start = np.empty(poly_count, dtype=np.int32)
        loop_total = np.empty(poly_count, dtype=np.int32)
        material_index = np.empty(poly_count, dtype=np.int32)
        mesh.polygons.foreach_get("loop_start", loop_start)
        mesh.polygons.foreach_get("loop_total", loop_total)
        mesh.polygons.foreach_get("material_index", material_index)

        keep = np.isin(material_index, list(paint_slots))
        if not keep.any():
            continue

        part = str(scs_prop(obj, "scs_part", "defaultpart"))
        if part not in group_index:
            group_index[part] = len(groups)
            groups.append(part)
        gid = group_index[part]

        for start, total in zip(loop_start[keep], loop_total[keep]):
            uv_chunks.append(loop_uv[start : start + total])
            starts.append(cursor)
            counts.append(int(total))
            group_ids.append(gid)
            cursor += int(total)

    if not uv_chunks:
        raise RuntimeError(
            "no truckpaint geometry found -- assign an eut2.truckpaint shader "
            "to the painted surfaces before exporting a template"
        )

    np.savez_compressed(
        out_path,
        uv=np.concatenate(uv_chunks).astype(np.float32),
        poly_start=np.asarray(starts, dtype=np.int32),
        poly_count=np.asarray(counts, dtype=np.int32),
        poly_group=np.asarray(group_ids, dtype=np.int32),
        groups=np.asarray(groups, dtype=object),
    )
    return {"polygons": len(starts), "groups": groups, "path": str(out_path)}


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
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
            "no SCS Root Object in this .blend. Every exportable SCS model sits "
            "under one (Add > Empty, then set SCS Object Type to 'SCS Root')."
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
        "blend_file": bpy.data.filepath,
        "blender_version": list(bpy.app.version),
        "scs_tools": "io_scs_tools" in bpy.context.preferences.addons,
        "roots": [inspect_root(root) for root in roots],
    }
    if uv_out:
        result["uv_dump"] = dump_uvs(roots[0], uv_out)
    return result


if __name__ == "__main__":
    try:
        payload = main()
    except Exception as exc:  # reported to the parent process, not a traceback dump
        payload = {"error": "%s: %s" % (type(exc).__name__, exc)}
        traceback.print_exc()
    print(RESULT_BEGIN)
    print(json.dumps(payload, indent=1, default=str))
    print(RESULT_END)
