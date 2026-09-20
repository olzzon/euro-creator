/** End-to-end: a project in, a loadable .scs out. */
import { describe, expect, it } from "vitest";

import { packScs, ScsArchive, type ModFile } from "../src/archive.js";
import { buildMod, type BuildOptions } from "../src/build.js";
import { decodeImage, encodePng } from "../src/codecs.js";
import { ConfigError, TextureError } from "../src/errors.js";
import { createImage } from "../src/image.js";
import { parseProject, type ProjectInput } from "../src/project.js";
import { readTobjPath } from "../src/tobj.js";
import { verifyArchive, verifyFiles } from "../src/verify.js";

const VEHICLE: ProjectInput["vehicle"] = {
  path: "olzzon.scania142",
  name: "Scania 142",
  author: "olzzon",
  mod: true,
  separate_paintjobs: false,
  template_size: [64, 64],
  cabins: { a: { name: "Topline", units: ["topline"] } },
  accessories: { "Sun Visor": ["sunshld.stock"], "Rear Bumper": ["r_bumper.stock_p"] },
};

async function artwork(size = 64): Promise<Buffer> {
  return encodePng(createImage(size, size, [20, 60, 200, 255]));
}

/** Resolver backed by a plain map, standing in for disk or object storage. */
function makeOptions(textures: Record<string, Buffer>): BuildOptions {
  return {
    resolveTexture: async (ref) => {
      const data = textures[ref];
      if (!data) throw new TextureError(`texture not found: ${ref}`);
      return { data, filename: ref };
    },
    decodeImage,
  };
}

function project(overrides: Partial<ProjectInput> = {}): ReturnType<typeof parseProject> {
  return parseProject({
    mod: { name: "Nordic Livery", author: "olzzon", version: "1.2" },
    skin: { name: "Nordic", price: 9500 },
    vehicle: VEHICLE,
    textures: { main: "main.png" },
    ...overrides,
  });
}

describe("buildMod", () => {
  it("produces a complete mod tree", async () => {
    const result = await buildMod(project(), makeOptions({ "main.png": await artwork() }));
    const paths = new Set(result.files.map((f) => f.path));
    expect(paths).toContain("manifest.sii");
    expect(paths).toContain("versions.sii");
    expect(paths).toContain("def/vehicle/truck/olzzon.scania142/paint_job/nordic.sii");
    expect(paths).toContain("def/vehicle/truck/olzzon.scania142/paint_job/nordic_settings.sui");
    expect(paths).toContain("def/vehicle/truck/olzzon.scania142/paint_job/accessory/nordic.sii");
    expect(paths).toContain("material/ui/accessory/nordic_icon.mat");
    expect(result.archiveName).toBe("olzzon_nordic_livery.scs");
  });

  it("points every TOBJ at a DDS that is actually in the archive", async () => {
    // The one failure mode that is silent in game and loud in game.log.txt.
    const result = await buildMod(project(), makeOptions({ "main.png": await artwork() }));
    const paths = new Set(result.files.map((f) => `/${f.path}`));
    const tobjs = result.files.filter((f) => f.path.endsWith(".tobj"));
    expect(tobjs.length).toBeGreaterThan(0);
    for (const tobj of tobjs) {
      expect(paths, `${tobj.path} points at a missing DDS`).toContain(readTobjPath(tobj.data));
    }
  });

  it("resolves every paint_job_mask reference in the SII files", async () => {
    const result = await buildMod(project(), makeOptions({ "main.png": await artwork() }));
    const paths = new Set(result.files.map((f) => `/${f.path}`));
    const referenced: string[] = [];
    for (const file of result.files) {
      if (!file.path.endsWith(".sii")) continue;
      for (const line of file.data.toString("utf8").split("\n")) {
        if (line.includes("paint_job_mask")) referenced.push(line.split('"')[1]!);
      }
    }
    expect(referenced.length).toBeGreaterThan(0);
    for (const target of referenced) expect(paths).toContain(target);
  });

  it("covers every accessory group with an override", async () => {
    const result = await buildMod(project(), makeOptions({ "main.png": await artwork() }));
    const sii = result.files
      .find((f) => f.path.endsWith("paint_job/accessory/nordic.sii"))!
      .data.toString("utf8");
    expect(sii.match(/simple_paint_job_data/g)).toHaveLength(2);
    expect(sii).toContain('"sunshld.stock"');
    expect(sii).toContain('"r_bumper.stock_p"');
  });

  it("gives unpainted accessories a transparent placeholder, not the cabin mask", async () => {
    const result = await buildMod(project(), makeOptions({ "main.png": await artwork() }));
    const placeholders = result.masks.filter((m) => m.source === "placeholder");
    expect(placeholders.map((m) => m.name).sort()).toEqual(["Rear Bumper", "Sun Visor"]);
    // 16x16 with a mip chain: a few hundred bytes, not megabytes.
    for (const mask of placeholders) expect(mask.bytes).toBeLessThan(2000);
  });

  it("omits suitable_for[] for a combined paint job", async () => {
    // One mask for every cabin: an absent suitable_for[] means "all cabins".
    const result = await buildMod(
      project({
        vehicle: {
          ...VEHICLE,
          cabins: { a: { name: "Topline", units: ["topline"] }, b: { name: "Sleeper", units: ["sleeper"] } },
        },
      }),
      makeOptions({ "main.png": await artwork() }),
    );
    const sii = result.files
      .find((f) => f.path.endsWith("paint_job/nordic.sii"))!
      .data.toString("utf8");
    expect(sii).not.toContain("suitable_for");
  });

  it("writes one SII and one mask per cabin when cabins are unwrapped separately", async () => {
    const result = await buildMod(
      project({
        vehicle: {
          ...VEHICLE,
          separate_paintjobs: true,
          cabins: {
            a: { name: "Topline", units: ["topline"] },
            b: { name: "Sleeper", units: ["sleeper", "sleeper_lo"] },
          },
        },
      }),
      makeOptions({ "main.png": await artwork() }),
    );
    const paths = new Set(result.files.map((f) => f.path));
    const base = "def/vehicle/truck/olzzon.scania142/paint_job";
    expect(paths).toContain(`${base}/nordic_a.sii`);
    expect(paths).toContain(`${base}/nordic_b.sii`);
    const sleeper = result.files.find((f) => f.path === `${base}/nordic_b.sii`)!.data.toString("utf8");
    // Both units sharing the Sleeper mask must be offered the paint job.
    expect(sleeper).toContain('"sleeper.olzzon.scania142.cabin"');
    expect(sleeper).toContain('"sleeper_lo.olzzon.scania142.cabin"');
  });

  it("carries alternate_uvset into the settings and the mask name", async () => {
    const result = await buildMod(
      project({ vehicle: { ...VEHICLE, alternate_uvset: true } }),
      makeOptions({ "main.png": await artwork() }),
    );
    const settings = result.files
      .find((f) => f.path.endsWith("nordic_settings.sui"))!
      .data.toString("utf8");
    expect(settings).toContain("alternate_uvset: true");
    expect(result.masks.some((m) => m.name.includes("(alt uvset)"))).toBe(true);
  });

  it("refuses a mask that does not match the template, unless asked to resize", async () => {
    const textures = { "main.png": await artwork(32) };
    await expect(buildMod(project(), makeOptions(textures))).rejects.toThrow(/template/);

    const resized = await buildMod(project(), { ...makeOptions(textures), resizeMismatched: true });
    expect(resized.warnings).toHaveLength(1);
    expect(resized.warnings[0]).toMatch(/resampled/);
  });
});

describe("project validation", () => {
  it("catches an unknown accessory before the game does", () => {
    expect(() =>
      project({ textures: { main: "main.png", accessories: { "Chrome Stack": "x.png" } } }),
    ).toThrow(ConfigError);
  });

  it("requires a main texture when cabins share a layout", () => {
    expect(() => project({ textures: {} })).toThrow(/textures.main is required/);
  });

  it("rejects a cabin with no unit names", () => {
    expect(() =>
      project({ vehicle: { ...VEHICLE, cabins: { a: { name: "Topline" } } } }),
    ).toThrow(/has no 'units'/);
  });
});

describe("packScs", () => {
  it("stores entries uncompressed and deterministically", async () => {
    const files: ModFile[] = [
      { path: "def/x.sii", data: Buffer.from("x") },
      { path: "manifest.sii", data: Buffer.from("SiiNunit\n{\n}\n") },
    ];
    const first = await packScs(files);
    const second = await packScs([...files].reverse());
    expect(first.equals(second)).toBe(true);
    // Stored entries: compression method 0 in the local file header.
    expect(first.readUInt16LE(8)).toBe(0);
  });

  it("skips editor leftovers", async () => {
    const archive = await packScs([
      { path: "manifest.sii", data: Buffer.from("x") },
      { path: ".DS_Store", data: Buffer.from("junk") },
      { path: "art.psd", data: Buffer.from("huge") },
    ]);
    expect(archive.toString("latin1")).not.toContain(".DS_Store");
    expect(archive.toString("latin1")).not.toContain("art.psd");
  });

  it("refuses an empty archive and duplicate entries", async () => {
    await expect(packScs([])).rejects.toThrow(/nothing to pack/);
    await expect(
      packScs([
        { path: "a/B.sii", data: Buffer.from("1") },
        { path: "a/b.sii", data: Buffer.from("2") },
      ]),
    ).rejects.toThrow(/duplicate/);
  });
});

describe("verification", () => {
  it("passes a freshly built mod, in memory and after packing", async () => {
    const result = await buildMod(project(), makeOptions({ "main.png": await artwork() }));
    const inMemory = verifyFiles(result.files);
    expect(inMemory.issues).toEqual([]);
    expect(inMemory.ok).toBe(true);
    expect(inMemory.checked.tobjs).toBeGreaterThan(0);
    expect(inMemory.checked.maskReferences).toBeGreaterThan(0);

    const packed = verifyArchive(await packScs(result.files));
    expect(packed.ok).toBe(true);
    expect(packed.checked.files).toBe(inMemory.checked.files);
  });

  it("catches a TOBJ whose DDS was dropped from the archive", async () => {
    const result = await buildMod(project(), makeOptions({ "main.png": await artwork() }));
    const withoutDds = result.files.filter((f) => !f.path.endsWith("Sun Visor.dds"));
    const report = verifyFiles(withoutDds);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.message.includes("Sun Visor.dds"))).toBe(true);
  });

  it("catches a missing manifest", async () => {
    const result = await buildMod(project(), makeOptions({ "main.png": await artwork() }));
    const report = verifyFiles(result.files.filter((f) => f.path !== "manifest.sii"));
    expect(report.issues.some((i) => i.message.includes("mod manager"))).toBe(true);
  });

  it("round-trips entries through the archive reader", async () => {
    const result = await buildMod(project(), makeOptions({ "main.png": await artwork() }));
    const scs = new ScsArchive(await packScs(result.files));
    expect(scs.entries()).toHaveLength(result.files.length);
    const manifest = scs.read("manifest.sii").toString("utf8");
    expect(manifest).toBe(result.files.find((f) => f.path === "manifest.sii")!.data.toString("utf8"));
    expect(() => scs.read("nope.sii")).toThrow(/no such entry/);
  });

  it("reads deflated archives too, in case compress was turned on", async () => {
    const result = await buildMod(project(), makeOptions({ "main.png": await artwork() }));
    const scs = new ScsArchive(await packScs(result.files, { compress: true }));
    expect(scs.read("manifest.sii").toString("utf8")).toContain("mod_package");
    expect(verifyArchive(scs).ok).toBe(true);
  });
});
