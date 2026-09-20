import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeTga, sniffFormat } from "../src/codecs.js";
import { isUnitName, toAssetName, toDisplayName, toUnitName } from "../src/naming.js";
import { SiiFile, SiiUnit } from "../src/sii.js";
import { buildTobj } from "../src/tobj.js";
import { decodeUvDump } from "../src/uvdump.js";
import { partColour, renderTemplate } from "../src/template.js";

describe("naming", () => {
  it.each([
    ["Nordic", "nordic"],
    ["Olzzon's Nordic Livery", "olzzon_s_nordic_livery"],
    ["Blå Himmel", "blaa_himmel"],
    ["Grün & Weiß", "gruen_weiss"],
    ["  spaced  out  ", "spaced_out"],
    ["142", "_142"],
  ])("folds %j into a legal unit name", (input, expected) => {
    expect(toUnitName(input)).toBe(expected);
    expect(isUnitName(toUnitName(input))).toBe(true);
  });

  it("keeps spaces in asset names but drops path breakers", () => {
    expect(toAssetName("Cabin A (High Roof)")).toBe("Cabin A (High Roof)");
    expect(toAssetName("bad/name:here?")).toBe("bad_name_here_");
  });

  it("replaces quotes that would break an SII string", () => {
    expect(toDisplayName('He said "hi"')).toBe("He said 'hi'");
  });

  it("refuses text with nothing usable left", () => {
    expect(() => toUnitName("???")).toThrow();
  });
});

describe("SII", () => {
  it("puts @include at column zero", () => {
    // Indenting it makes the parser treat the line as an attribute and fail
    // the whole unit.
    const unit = new SiiUnit("x", "y").include("s.sui");
    expect(new SiiFile(unit).render()).toContain('\n@include "s.sui"');
  });

  it("formats floats the way the game's parser expects", () => {
    const unit = new SiiUnit("x", "y").set("base_color", [0.02, 0.5, 1]);
    expect(unit.render()).toContain("base_color: (0.02, 0.5, 1)");
  });

  it("refuses a quote rather than silently truncating the file", () => {
    expect(() => new SiiUnit("x", "y").set("name", 'He said "hi"')).toThrow();
  });
});

describe("TOBJ guard rails", () => {
  it.each([
    "vehicle/truck/x.dds",
    "/vehicle/truck/x.tga",
    "/vehicle/bilæn.dds",
  ])("rejects %j", (bad) => {
    expect(() => buildTobj(bad)).toThrow();
  });
});

describe("TGA", () => {
  /** Minimal uncompressed 32-bit TGA, bottom-up (the format's default). */
  function tga(width: number, height: number, pixels: number[][], topDown = false): Buffer {
    const header = Buffer.alloc(18);
    header.writeUInt8(2, 2);
    header.writeUInt16LE(width, 12);
    header.writeUInt16LE(height, 14);
    header.writeUInt8(32, 16);
    header.writeUInt8(topDown ? 0x20 : 0, 17);
    const body = Buffer.alloc(width * height * 4);
    pixels.forEach(([r, g, b, a], i) => {
      body[i * 4] = b!;
      body[i * 4 + 1] = g!;
      body[i * 4 + 2] = r!;
      body[i * 4 + 3] = a!;
    });
    return Buffer.concat([header, body]);
  }

  it("reads BGRA and flips bottom-up rows", () => {
    // Two rows: the file stores the bottom row first.
    const data = tga(1, 2, [[10, 20, 30, 255], [40, 50, 60, 128]]);
    const image = decodeTga(data);
    expect(image.width).toBe(1);
    expect(image.height).toBe(2);
    // Top row of the image is the second row in the file.
    expect([...image.data.slice(0, 4)]).toEqual([40, 50, 60, 128]);
    expect([...image.data.slice(4, 8)]).toEqual([10, 20, 30, 255]);
  });

  it("honours the top-down descriptor bit", () => {
    const image = decodeTga(tga(1, 2, [[10, 20, 30, 255], [40, 50, 60, 128]], true));
    expect([...image.data.slice(0, 4)]).toEqual([10, 20, 30, 255]);
  });

  it("explains an unsupported variant instead of producing garbage", () => {
    const header = Buffer.alloc(18);
    header.writeUInt8(1, 1); // colour-mapped
    header.writeUInt8(1, 2);
    expect(() => decodeTga(header)).toThrow(/colour map|unsupported/i);
  });

  it("identifies formats by magic, not extension", () => {
    expect(sniffFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe("png");
    expect(sniffFormat(Buffer.from("DDS 1234"))).toBe("dds");
    expect(sniffFormat(Buffer.alloc(32), "skin.TGA")).toBe("tga");
  });
});

describe("UV template", () => {
  /** Two islands in different parts: top-left and bottom-right of the square. */
  function dump(): Parameters<typeof renderTemplate>[0] {
    return {
      groups: ["cabin", "chassis"],
      polyStart: new Uint32Array([0, 4]),
      polyCount: new Uint16Array([4, 4]),
      polyGroup: new Uint16Array([0, 1]),
      uv: new Float32Array([
        0.05, 0.55, 0.45, 0.55, 0.45, 0.95, 0.05, 0.95,
        0.55, 0.05, 0.95, 0.05, 0.95, 0.45, 0.55, 0.45,
      ]),
    };
  }

  const alphaAt = (image: { width: number; data: Uint8Array }, x: number, y: number) =>
    image.data[(y * image.width + x) * 4 + 3]!;

  it("lands islands where the UVs say, with V flipped into image space", () => {
    const image = renderTemplate(dump(), { size: 100 });
    // v = 0.55..0.95 is the TOP of the image.
    expect(alphaAt(image, 25, 25)).toBeGreaterThan(0);
    expect(alphaAt(image, 75, 75)).toBeGreaterThan(0);
    // Unused quadrants stay transparent so the artist can paint underneath.
    expect(alphaAt(image, 25, 75)).toBe(0);
  });

  it("gives each part a distinguishable colour", () => {
    const image = renderTemplate(dump(), { size: 100 });
    const px = (x: number, y: number) => {
      const i = (y * image.width + x) * 4;
      return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
    };
    const delta = px(25, 25).reduce((sum, v, i) => sum + Math.abs(v - px(75, 75)[i]!), 0);
    expect(delta).toBeGreaterThan(30);
  });

  it("filters to a single part", () => {
    const image = renderTemplate(dump(), { size: 100, onlyGroups: ["cabin"] });
    expect(alphaAt(image, 25, 25)).toBeGreaterThan(0);
    expect(alphaAt(image, 75, 75)).toBe(0);
  });

  it("spreads part colours apart", () => {
    const colours = Array.from({ length: 8 }, (_, i) => partColour(i).join(","));
    expect(new Set(colours).size).toBe(8);
  });
});

describe("UV dump", () => {
  it("rejects anything that is not a dump", () => {
    expect(() => decodeUvDump(Buffer.from("not a dump at all....."))).toThrow(/UV dump/);
  });
});

describe("UV dump binary contract with the Blender helper", () => {
  // The fixture was written by Python's struct module using the same packing
  // as blender/extract.py, so this test guards the cross-language format.
  const dump = decodeUvDump(
    readFileSync(fileURLToPath(new URL("./fixtures/sample.uvdump", import.meta.url))),
  );

  it("reads group names, polygon table and UVs", () => {
    expect(dump.groups).toEqual(["cabin", "chassis", "sun visor"]);
    expect([...dump.polyStart]).toEqual([0, 4, 7]);
    expect([...dump.polyCount]).toEqual([4, 3, 5]);
    expect([...dump.polyGroup]).toEqual([0, 1, 2]);
    expect(dump.uv).toHaveLength(24);
    expect(dump.uv[0]).toBeCloseTo(0.05, 5);
    expect(dump.uv[1]).toBeCloseTo(0.55, 5);
    expect(dump.uv[23]).toBeCloseTo(0.3, 5);
  });

  it("renders without reading past the end of any polygon", () => {
    const image = renderTemplate(dump, { size: 64 });
    expect(image.width).toBe(64);
    const painted = [...image.data].filter((_, i) => i % 4 === 3).some((a) => a > 0);
    expect(painted).toBe(true);
  });
});
