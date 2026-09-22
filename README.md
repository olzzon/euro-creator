# euro-creator

A web service that turns a Blender truck and a painted texture into an
installable ETS2/ATS paint job mod.

Making a skin by hand means keeping four things in sync that nothing checks for
you: the UV layout in Blender, the DDS masks, the TOBJ files that point at
them, and the SII definitions that point at the TOBJs. Get one path wrong and
the paint job either does not appear at the dealer or appears untextured, and
the only clue is a line in `game.log.txt`.

euro-creator generates all four from one project, then reads the finished
`.scs` back and verifies that every reference resolves.

```
┌── Trucks ──────────┐   ┌── Skins ───────────┐   ┌── Builds ──────────┐
│ drop a .blend      │   │ drop your artwork  │   │ download .scs      │
│ → paint template   │ → │ → per-mask slots   │ → │ mask previews      │
│ → draft definition │   │ → build            │   │ generated SII      │
└────────────────────┘   └────────────────────┘   └────────────────────┘
```

A two-cabin 4096×4096 build — four masks, shop icon, definitions, packing and
verification — takes about **1.3 seconds**.

## Architecture

| Package | What it is |
| --- | --- |
| `packages/core` | Pure TypeScript: BC1/BC3 encoder, DDS, TOBJ, SII, TGA, zip read/write, the mod builder, the UV-template rasteriser, and mod verification. No HTTP, no filesystem. |
| `packages/server` | Fastify API, job queue with SSE progress, workspace storage, and the Blender subprocess runner. |
| `packages/web` | React + MobX single-page app, served by the API in production. |

The one piece of Python left is `packages/server/src/blender/extract.py`, and it
stays: Blender's scripting API is Python, so anything that reads a `.blend`
runs inside Blender. Everything else — including the whole original Python
implementation this was ported from — is gone; it survives in git at `513ee77`
and as the frozen fixtures described in `packages/core/test/fixtures/README.md`.

**No SCS Conversion Tools.** They are Windows-only, and they are the reason the
normal pipeline cannot run on a Mac. The DDS encoder here writes BC3 directly,
so the whole skin pipeline runs wherever Node does.

## Running it

Intended deployment: this service and Blender 3.6 on the same Mac mini,
reachable from whatever machine you paint on.

```bash
npm install
npm run build
npm run serve          # http://<mac-mini>:5174
```

For development, the API and Vite run side by side with a proxy:

```bash
npm run dev            # API on 5174, UI on 5173
```

### Configuration

All optional; the defaults suit a dedicated Mac mini.

| Variable | Default | Notes |
| --- | --- | --- |
| `EC_HOST` | `0.0.0.0` | Binds to every interface, because the point is reaching it from your LAN. |
| `EC_PORT` | `5174` | |
| `EC_WORKSPACE` | `~/euro-creator` | Uploads, trucks, skins and builds. |
| `EC_BLENDER` | *(searched)* | Path to the executable. On macOS that is **inside** the `.app`: `/Applications/Blender 3.6/Blender.app/Contents/MacOS/Blender`. Set it and it is authoritative — a wrong path is an error, never a silent fall back to some other Blender. |
| `EC_MAX_UPLOAD_MB` | `1024` | A detailed truck's `.blend` gets large. |
| `EC_KEEP_BUILDS` | `50` | Older builds are pruned; each 4K one is tens of MB. |
| `EC_BLENDER_TIMEOUT_S` | `600` | |

### Blender

SCS Blender Tools supports **Blender 3.6 LTS** and no newer — 4.x removed the
`bgl` module the addon imports, so it cannot load at all. Install 3.6 on the
Mac mini and point `EC_BLENDER` at it. The header badge in the UI shows which
version the server found and whether it is supported.

Without Blender the service still runs: you can define trucks by hand and build
skins. Only `.blend` import and template rendering need it.

`.blend` files are opened with `--disable-autoexec`, because a `.blend` can
carry Python in drivers and handlers and this service accepts uploads.

## The workflow

### 1. Trucks

Drop a `.blend` in the Trucks tab. The server runs Blender headless, finds
every material using a `truckpaint` shader, reads the UV layer that material
samples the paint job mask on, and rasterises those islands into a transparent
PNG — tinted per SCS part, with a per-part filter, so you can find which island
is the sun visor.

This is what makes skinning a *custom* truck possible at all: for an SCS truck
you can download a community template; for your own model nobody has one.

It also drafts the vehicle definition and fills in the field that is easiest to
get wrong by hand: `alternate_uvset`, true when the painted materials use the
`truckpaint.altuv` flavour. Set it wrong and the livery lands on the wrong side
of the cab. If the model *mixes* the two flavours, the UI says so rather than
silently picking one.

Two things Blender cannot tell you, which you fill in yourself:

- **cabins** — the cabin accessory unit names, which become
  `suitable_for[]: "<unit>.<path>.cabin"`;
- **accessories** — the painted accessory unit names that get their own mask.

Those come from the truck's own `def/vehicle/truck/<path>/` files. Copy them
from the unpacked `base.scs` or from the truck mod. Scania S and R are seeded
as filled-in examples.

### 2. Skins

Pick a truck and the editor asks for exactly the masks that truck needs: one
shared mask, or one per cabin when it unwraps them separately, plus an optional
mask per accessory group. Each slot shows the image's dimensions against the
template size, so a 2048 mask on a 4096 truck is visible before you build.

Accessory groups you leave empty get a 16×16 transparent mask, so with airbrush
on the accessory keeps the player's chosen base colour instead of showing the
cabin's texture stretched over it.

### 3. Builds

The result view shows three things a downloaded `.scs` cannot:

- **Masks** — decoded back out of the archive, so it is what the game will
  sample, not your source artwork. This is where you find out whether BC3
  compression hurt a gradient.
- **Files** — the generated SII, readable in place.
- **Report** — every TOBJ target and every `paint_job_mask` reference, checked
  against the packed archive.

Then copy the `.scs` into your mod folder:

| OS | |
| --- | --- |
| macOS | `~/Library/Application Support/Euro Truck Simulator 2/mod/` |
| Windows | `Documents\Euro Truck Simulator 2\mod\` |
| Linux | `~/.local/share/Euro Truck Simulator 2/mod/` |

## What gets generated

```
manifest.sii                                       mod manager entry
versions.sii
Mod_Manager_Image.jpg / Mod_Manager_Description.txt
material/ui/accessory/Nordic Icon.dds|.tobj        shop icon
material/ui/accessory/nordic_icon.mat
def/vehicle/truck/<path>/paint_job/
    nordic_settings.sui                            shared attributes
    nordic.sii                                     accessory_paint_job_data
    accessory/nordic.sii                           simple_paint_job_data overrides
vehicle/truck/upgrade/paintjob/Nordic/<Truck>/
    Cabin.dds|.tobj, Sun Visor.dds|.tobj           the masks
```

## API

The UI is a client of a plain REST API; the same calls work from a script.

```
GET    /api/system                      Blender status, workspace, counts
POST   /api/uploads                     multipart; returns ids + dimensions
GET    /api/uploads/:id/preview.png

GET    /api/vehicles                    CRUD on truck definitions
POST   /api/vehicles/from-blend         { uploadId, size } -> job
GET    /api/vehicles/:id/template.png
GET    /api/vehicles/:id/template/:part.png

GET    /api/projects                    CRUD on skins
POST   /api/projects/:id/build          -> job

GET    /api/jobs/:id                    state + progress log
GET    /api/jobs/:id/events             server-sent events
POST   /api/jobs/:id/cancel

GET    /api/builds/:id
GET    /api/builds/:id/mod.scs
GET    /api/builds/:id/file?path=…      one entry out of the archive
GET    /api/builds/:id/preview.png?path=…   a DDS decoded to PNG
```

Long work goes through the job queue rather than the request. The queue runs
one job at a time on purpose: both kinds of work are CPU- and memory-hungry —
a 4K mask is 64 MB of pixels before compression — and a queue of two would make
both slower rather than either faster.

## Notes on the formats

- **`.scs`** is a zip. Entries are *stored*, not deflated, matching SCS' own
  archives, and written in sorted order with a fixed timestamp so an unchanged
  mod packs to identical bytes.
- **`.tobj`** is a 48-byte binary header then the archive-absolute DDS path,
  ASCII, no terminator. The header emitted here is byte-for-byte the pattern
  shipped by SCS' own paint job textures, and a test asserts it stays that way.
- **`.dds`** is written directly: BC3 with full alpha by default, endpoints
  fitted by bounding box plus two least-squares refinement passes. Mean error
  on a gradient is about one 8-bit level. `raw` writes uncompressed A8R8G8B8 —
  eight times larger, but it settles whether banding came from compression.
- **TGA** is decoded in-house (uncompressed and RLE, 24/32-bit, both origin
  flags), because libvips does not read it and SCS' pipeline uses it
  throughout.
- **SII strings** cannot contain a double quote; the writer throws rather than
  emitting a file the parser silently truncates.

## Development

```bash
npm test          # 66 tests across core and server
npm run typecheck
```

The tests cover:

- the TOBJ header against bytes from shipped mods;
- DDS output against frozen golden files, and decoded back to check
  compression quality — see `packages/core/test/fixtures/README.md` for where
  those bytes came from and why they are never regenerated;
- the UV-dump binary format against a fixture written by Python's `struct`, so
  the cross-language contract with `blender/extract.py` cannot drift;
- a full build asserting every TOBJ and every `paint_job_mask` resolves inside
  the packed archive;
- the HTTP API end to end: upload → truck → skin → build → download → verify;
- the Blender half against a real Blender, from a synthetic `.blend` built by
  `packages/server/test/fixtures/make_truck.py`: SCS root, parts, variants,
  which materials are truckpaint, which UV layer `.altuv` selects, and the
  dump surviving the trip into TypeScript. Skipped when no Blender is
  installed, so the suite still runs on a machine that only builds skins.

Because that fixture is built without SCS Blender Tools, those tests also cover
the fallback that reads SCS data straight out of the `.blend`'s ID properties —
the path taken on any Blender newer than 3.6, where the addon cannot load. It
is how the import was verified here, on Blender 5.2.

### Where to extend

- **More concurrency**: `JobQueue` in `packages/server/src/jobs.ts` is the only
  thing that would change to move to BullMQ or worker threads.
- **Remote storage**: `Storage` in `packages/server/src/storage.ts` is an
  interface; `FsStorage` is one implementation.
- **Auth**: there is none. The service assumes a trusted LAN. Anything exposed
  beyond that needs a gate in front of `createApp`.

## Troubleshooting

Turn on the console before anything else — in
`Documents/Euro Truck Simulator 2/config.cfg`:

```
uset g_console "1"
uset g_developer "1"
```

Then read `game.log.txt`.

| Symptom | Usually |
| --- | --- |
| Not at the dealer at all | the truck's def path is wrong, or it uses per-cabin paint jobs and no cabin matched `suitable_for[]` |
| Appears, but untextured | a TOBJ points at a missing DDS — the build report checks this, hand edits do not |
| Livery mirrored or on the wrong side | `alternate_uvset` disagrees with the shader flavour on the model |
| Squashed logo in the shop | the icon source was not 4:1; euro-creator letterboxes rather than stretching |

## References

- [SCS Modding Wiki — Blender Tools supported shaders](https://modding.scssoft.com/wiki/Documentation/Tools/SCS_Blender_Tools/Supported_shaders)
- [SCSSoftware/BlenderTools](https://github.com/SCSSoftware/BlenderTools)
- [Carsmaniac/paintjob-packer](https://github.com/Carsmaniac/paintjob-packer) (MIT) — the reference for the paint job definition layout and the TOBJ header bytes

MIT licensed.
