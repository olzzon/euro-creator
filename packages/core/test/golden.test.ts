/**
 * The TypeScript port is checked against byte-exact output captured from the
 * Python implementation that was verified first. Fixtures live in
 * test/fixtures and were produced by python/ -- see README.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeDds, encodeDds } from "../src/dds/index.js";
import { buildDdsHeader, DDS_HEADER_BYTES, readDdsHeader } from "../src/dds/header.js";
import { buildTobj, readTobjPath } from "../src/tobj.js";
import { SiiFile, SiiUnit } from "../src/sii.js";
import type { RgbaImage } from "../src/image.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

/** The same deterministic gradient the Python fixtures were generated from. */
function gradient(size = 64): RgbaImage {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      data[i] = Math.floor((x * 255) / (size - 1));
      data[i + 1] = Math.floor((y * 255) / (size - 1));
      data[i + 2] = 40;
      // numpy's linspace(..., dtype=uint8) truncates rather than rounds.
      data[i + 3] = Math.floor((x * 255) / (size - 1));
      if (y >= 16 && y < 48 && x >= 16 && x < 48) {
        data[i] = 220;
        data[i + 1] = 30;
        data[i + 2] = 30;
      }
    }
  }
  return { width: size, height: size, data };
}

describe("TOBJ matches the reference byte for byte", () => {
  it("icon tobj (clamped)", () => {
    expect(buildTobj("/material/ui/accessory/Nordic Icon.dds", { clamp: true })).toEqual(
      fixture("icon.tobj"),
    );
  });

  it("mask tobj (repeat)", () => {
    expect(buildTobj("/vehicle/truck/upgrade/paintjob/Nordic/Scania S/Cabin.dds")).toEqual(
      fixture("mask.tobj"),
    );
  });

  it("round-trips its path", () => {
    expect(readTobjPath(fixture("mask.tobj"))).toBe(
      "/vehicle/truck/upgrade/paintjob/Nordic/Scania S/Cabin.dds",
    );
  });
});

describe("SII matches the reference byte for byte", () => {
  it("paint job unit", () => {
    const unit = new SiiUnit("accessory_paint_job_data", "nordic_a.scania.s_2016.paint_job");
    unit.include("nordic_settings.sui");
    unit.extend("suitable_for", ["highline.scania.s_2016.cabin", "normal.scania.s_2016.cabin"]);
    unit.set("paint_job_mask", "/vehicle/truck/upgrade/paintjob/Nordic/Scania S/Cabin.tobj");
    expect(new SiiFile(unit).render()).toBe(fixture("paintjob.sii").toString("utf8"));
  });

  it("manifest", () => {
    const unit = new SiiUnit("mod_package", ".package_name");
    unit.set("package_version", "1.0").set("display_name", "Nordic Livery").set("author", "olzzon");
    unit.blank().append("category", "paint_job").blank();
    unit.set("icon", "Mod_Manager_Image.jpg").set("description_file", "Mod_Manager_Description.txt");
    expect(new SiiFile(unit).render()).toBe(fixture("manifest.sii").toString("utf8"));
  });
});

describe("DDS", () => {
  it("reproduces the source image the fixtures were built from", () => {
    expect(Buffer.from(gradient().data)).toEqual(fixture("gradient.raw"));
  });

  it.each(["dxt5", "dxt1", "raw"] as const)("header for %s is byte-identical", (format) => {
    const ours = encodeDds(gradient(), { format });
    const theirs = fixture(`gradient.${format}.dds`);
    expect(ours.subarray(0, DDS_HEADER_BYTES)).toEqual(theirs.subarray(0, DDS_HEADER_BYTES));
    expect(ours.length).toBe(theirs.length);
  });

  it("raw output is byte-identical", () => {
    expect(encodeDds(gradient(), { format: "raw" })).toEqual(fixture("gradient.raw.dds"));
  });

  it.each(["dxt5", "dxt1"] as const)(
    "%s decodes to the same picture as the reference encoder",
    (format) => {
      const ours = decodeDds(encodeDds(gradient(), { format }));
      const theirs = decodeDds(fixture(`gradient.${format}.dds`));
      let sum = 0;
      let worst = 0;
      for (let i = 0; i < ours.data.length; i += 1) {
        const delta = Math.abs(ours.data[i]! - theirs.data[i]!);
        sum += delta;
        if (delta > worst) worst = delta;
      }
      // Float32 in numpy versus float64 here shifts a few endpoint fits, so
      // bit-for-bit equality is not the bar; visual equivalence is.
      expect(sum / ours.data.length).toBeLessThan(0.5);
      expect(worst).toBeLessThan(24);
    },
  );
});
