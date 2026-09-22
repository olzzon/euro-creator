/**
 * The Blender half of the pipeline, against a real Blender.
 *
 * Skipped when no Blender is installed, so the suite still runs on a machine
 * that only builds skins. On the host that serves this app, Blender is there
 * and these run.
 *
 * The fixture is built without SCS Blender Tools, which means this also covers
 * the fallback that reads SCS data straight out of the .blend's ID properties
 * — the path taken on any Blender newer than 3.6, where the addon cannot load.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeUvDump, renderTemplate } from "@euro-creator/core";

import { checkBlender, findBlender, runBlenderScript } from "../src/blender.js";
import { loadConfig } from "../src/config.js";
import { JobQueue } from "../src/jobs.js";
import { FsStorage } from "../src/storage.js";
import { Workspace } from "../src/workspace.js";
import type { VehicleRecord } from "../src/records.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolved at module scope, not in beforeAll: `describe.skipIf` is evaluated
 * while tests are being collected, which happens before any hook runs.
 */
const blender = await findBlender(null).catch(() => null);
const root = await mkdtemp(join(tmpdir(), "euro-creator-blender-"));

function run(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(blender!, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
}

describe.skipIf(blender === null)("Blender integration", () => {
  it("reports the installed version and whether SCS Blender Tools can load", async () => {
    const status = await checkBlender(null, { fresh: true });
    expect(status.available).toBe(true);
    expect(status.version?.length).toBeGreaterThan(0);
    // Anything past 3.6 is usable but flagged, because the addon will not load.
    if (status.version && status.version[0]! > 3) expect(status.supported).toBe(false);
  }, 60_000);

  it("extracts SCS structure and paint-job UVs from a .blend", async () => {
    const blendPath = join(root, "truck.blend");
    const uvPath = join(root, "uv.bin");
    expect(await run([
      "--background", "--factory-startup",
      "--python", join(HERE, "fixtures", "make_truck.py"),
      "--", blendPath,
    ])).toBe(0);

    const payload = await runBlenderScript<{
      roots: Array<{
        name: string;
        parts: string[];
        variants: Array<{ name: string; parts: string[] }>;
        paintMaterials: Array<{ effect: string; altUvset: boolean; uvLayer: string }>;
        altUvset: boolean;
        mixedUvset: boolean;
        materialCount: number;
      }>;
      uvDump: { polygons: number; groups: string[] };
    }>("extract.py", { blendFile: blendPath, scriptArgs: ["--uv-out", uvPath] });

    const scsRoot = payload.roots[0]!;
    expect(scsRoot.name).toBe("Scania 142 Torpedo");
    expect(scsRoot.parts).toEqual(["cabin", "chassis", "sunshield"]);
    // The day cab leaves the sun visor out; the topline includes it.
    expect(scsRoot.variants.find((v) => v.name === "day_cab")?.parts).toEqual(["cabin", "chassis"]);
    expect(scsRoot.variants.find((v) => v.name === "topline")?.parts).toHaveLength(3);

    // Four materials in the file, three of them truckpaint: the glass is skipped.
    expect(scsRoot.materialCount).toBe(4);
    expect(scsRoot.paintMaterials).toHaveLength(3);
    expect(scsRoot.altUvset).toBe(true);
    expect(scsRoot.mixedUvset).toBe(false);
    // .altuv means the mask is sampled through the third UV layer.
    for (const material of scsRoot.paintMaterials) expect(material.uvLayer).toBe("paintjob_alt");

    // ...and the dump must carry that layer's coordinates, not another's.
    const dump = decodeUvDump(await readFile(uvPath));
    expect(dump.groups.sort()).toEqual(["cabin", "chassis", "sunshield"]);
    expect(dump.polyStart).toHaveLength(3);
    const us = [...dump.uv].filter((_, i) => i % 2 === 0);
    expect(Math.min(...us)).toBeCloseTo(0.05, 3);
    expect(Math.max(...us)).toBeCloseTo(0.45, 3);

    const template = renderTemplate(dump, { size: 256 });
    const painted = [...template.data].filter((_, i) => i % 4 === 3).filter((a) => a > 0).length;
    expect(painted).toBeGreaterThan(0);
  }, 180_000);

  it("drafts a vehicle and a template through the workspace", async () => {
    const blendPath = join(root, "truck2.blend");
    expect(await run([
      "--background", "--factory-startup",
      "--python", join(HERE, "fixtures", "make_truck.py"),
      "--", blendPath,
    ])).toBe(0);

    const workspaceDir = join(root, "ws");
    const storage = new FsStorage(workspaceDir);
    await storage.init();
    const workspace = new Workspace(
      loadConfig({ workspace: workspaceDir, serveWeb: false, logLevel: "silent" }),
      storage,
      new JobQueue(),
    );

    const upload = await workspace.saveUpload("truck.blend", await readFile(blendPath));
    expect(upload.kind).toBe("blend");

    const job = workspace.startBlendImport(upload.id, { size: 512 });
    const record = await new Promise<VehicleRecord>((resolve, reject) => {
      workspace.queue.events.on(`update:${job.id}`, (updated) => {
        if (updated.state === "succeeded") resolve(updated.result as VehicleRecord);
        if (updated.state === "failed") reject(new Error(updated.error?.message ?? "failed"));
      });
    });

    expect(record.vehicle.name).toBe("Scania 142 Torpedo");
    // "Scania 142 Torpedo" -> the dotted shape SCS use for def paths.
    expect(record.vehicle.path).toBe("scania.142.torpedo");
    expect(record.vehicle.alternate_uvset).toBe(true);
    expect(record.vehicle.paint_uv_layer).toBe("paintjob_alt");
    expect(record.template?.groups.sort()).toEqual(["cabin", "chassis", "sunshield"]);
    expect(record.source?.scsToolsLoaded).toBeDefined();

    const png = await workspace.vehicleTemplate(record.id, "paint_template.png");
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }, 180_000);
});

describe("Blender path resolution", () => {
  it("never silently substitutes another Blender for a configured one", async () => {
    // Falling back here is how you end up running 5.x, where SCS Blender Tools
    // cannot load, after explicitly configuring 3.6.
    await expect(findBlender("/definitely/not/blender/anywhere")).rejects.toThrow(
      /configured as '\/definitely\/not\/blender\/anywhere'/,
    );
    await expect(findBlender("/definitely/not/blender/anywhere")).rejects.toThrow(/EC_BLENDER/);
  });

  it("reports the supported version when there is nothing to find", async () => {
    const status = await checkBlender("/definitely/not/blender/anywhere", { fresh: true });
    expect(status.available).toBe(false);
    expect(status.message).toMatch(/nothing executable is there/);
  });
});
