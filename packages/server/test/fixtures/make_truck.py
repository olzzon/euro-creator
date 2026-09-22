"""Build a synthetic SCS truck .blend, for the Blender integration test.

Run inside Blender:

    blender --background --factory-startup --python make_truck.py -- out.blend

SCS Blender Tools stores its data in ID properties on the datablock, so the
same structure can be written directly without the addon installed. That is
exactly the fallback path extract.py takes when the addon is missing or failed
to load, which is what this fixture exercises.

The three painted parts share one UV placement per layer, so the test can
assert which layer was chosen from the coordinates alone: layer 0 spans
0.05..0.95, layer 1 (paintjob) 0.05..0.70, layer 2 (paintjob_alt) 0.05..0.45.
A fourth, unpainted part proves non-truckpaint materials are excluded.
"""
import bpy

bpy.ops.wm.read_factory_settings(use_empty=True)

# --- SCS Root ---------------------------------------------------------------
root = bpy.data.objects.new("Scania 142 Torpedo", None)
root["scs_props"] = {"empty_object_type": "SCS_Root"}
root["scs_object_part_inventory"] = [{"name": n} for n in ("cabin", "chassis", "sunshield")]
root["scs_object_variant_inventory"] = [
    {"name": "day_cab", "parts": [{"include": 1}, {"include": 1}, {"include": 0}]},
    {"name": "topline", "parts": [{"include": 1}, {"include": 1}, {"include": 1}]},
]
bpy.context.collection.objects.link(root)


def make_part(name, part, effect, size, offset):
    mesh = bpy.data.meshes.new(name + "_mesh")
    verts = [(offset, 0, 0), (offset + size, 0, 0), (offset + size, size, 0), (offset, size, 0)]
    mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
    mesh.update()

    # Three UV layers: base/AO, paintjob, mirrored alternate -- the layout the
    # truckpaint shaders expect.
    for index, layer_name in enumerate(("UVMap", "paintjob", "paintjob_alt")):
        layer = mesh.uv_layers.new(name=layer_name)
        for loop_index, loop_uv in enumerate(layer.data):
            u, v = [(0, 0), (1, 0), (1, 1), (0, 1)][loop_index % 4]
            # Give each layer a distinguishable placement so picking the wrong
            # one is visible rather than subtle.
            scale = 0.9 - index * 0.25
            loop_uv.uv = (0.05 + u * scale, 0.05 + v * scale)

    material = bpy.data.materials.new(name + "_mat")
    material["scs_props"] = {"mat_effect_name": effect}
    mesh.materials.append(material)

    obj = bpy.data.objects.new(name, mesh)
    obj["scs_props"] = {"scs_part": part}
    obj.parent = root
    bpy.context.collection.objects.link(obj)
    return obj


make_part("cab_body", "cabin", "eut2.truckpaint.altuv", 1.0, 0.0)
make_part("chassis_side", "chassis", "eut2.truckpaint.altuv", 0.8, 2.0)
make_part("visor", "sunshield", "eut2.truckpaint.altuv", 0.4, 4.0)
# A non-painted part, to prove it is excluded from the template.
make_part("glass", "cabin", "eut2.glass", 0.5, 6.0)

import sys

out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "/tmp/truck.blend"
bpy.ops.wm.save_as_mainfile(filepath=out)
print("SAVED", len(bpy.data.objects), "objects ->", out)
