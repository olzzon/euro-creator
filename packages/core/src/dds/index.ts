/**
 * DDS writing.
 *
 * Supported formats:
 *
 * - `dxt5` (BC3) -- block compression with a full 8-bit alpha channel. The
 *   default, and what every stock paint job mask uses: the alpha channel
 *   carries the airbrush mask, and metallic masks for some shaders.
 * - `dxt1` (BC1) -- block compression, no alpha. Half the size; only for
 *   fully opaque masks.
 * - `raw` (A8R8G8B8) -- uncompressed. Eight times the size of BC3 and slow for
 *   the game to stream, but free of block artefacts, which settles the
 *   question of whether banding came from compression.
 */

import { assertRgba, type RgbaImage } from "../image.js";
import { encodeBlocks, decodeBlocks } from "./blocks.js";
import {
  buildDdsHeader,
  DDS_HEADER_BYTES,
  readDdsHeader,
  surfaceSize,
  type DdsFormat,
  type DdsInfo,
} from "./header.js";
import { buildMipmaps } from "./mipmap.js";

export { DDS_FORMATS, isDdsFormat, readDdsHeader, surfaceSize } from "./header.js";
export type { DdsFormat, DdsInfo } from "./header.js";
export { buildMipmaps } from "./mipmap.js";
export { encodeBlocks, decodeBlocks } from "./blocks.js";

export interface EncodeDdsOptions {
  format?: DdsFormat;
  mipmaps?: boolean;
}

function encodeSurface(image: RgbaImage, format: DdsFormat): Uint8Array {
  if (format === "raw") {
    // A8R8G8B8 is little endian, so byte order on disk is B, G, R, A.
    const out = new Uint8Array(image.data.length);
    for (let i = 0; i < image.data.length; i += 4) {
      out[i] = image.data[i + 2]!;
      out[i + 1] = image.data[i + 1]!;
      out[i + 2] = image.data[i]!;
      out[i + 3] = image.data[i + 3]!;
    }
    return out;
  }
  return encodeBlocks(image.data, image.width, image.height, format);
}

/** Encode an RGBA image as a complete DDS file. */
export function encodeDds(image: RgbaImage, options: EncodeDdsOptions = {}): Buffer {
  assertRgba(image);
  const format = options.format ?? "dxt5";
  const mipmaps = options.mipmaps ?? true;

  const levels = mipmaps ? buildMipmaps(image) : [image];
  const parts: Uint8Array[] = [buildDdsHeader(image.width, image.height, levels.length, format)];
  for (const level of levels) parts.push(encodeSurface(level, format));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)), total);
}

/** Decode the top mip level of a DDS back to RGBA. */
export function decodeDds(data: Buffer): RgbaImage & { info: DdsInfo } {
  const info = readDdsHeader(data);
  const body = data.subarray(DDS_HEADER_BYTES);
  let pixels: Uint8Array;

  if (info.format === "raw") {
    pixels = new Uint8Array(info.width * info.height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = body[i + 2]!;
      pixels[i + 1] = body[i + 1]!;
      pixels[i + 2] = body[i]!;
      pixels[i + 3] = body[i + 3]!;
    }
  } else {
    const size = surfaceSize(info.width, info.height, info.format);
    pixels = decodeBlocks(body.subarray(0, size), info.width, info.height, info.format);
  }

  return { width: info.width, height: info.height, data: pixels, info };
}
