/**
 * DDS container header.
 *
 * Byte layout is fixed by the DirectDraw Surface spec; the flag combinations
 * here are the ones SCS' own textures use, which matters because the game's
 * loader is stricter than a general-purpose DDS reader.
 */

export const DDS_FORMATS = ["dxt5", "dxt1", "raw"] as const;
export type DdsFormat = (typeof DDS_FORMATS)[number];

export function isDdsFormat(value: string): value is DdsFormat {
  return (DDS_FORMATS as readonly string[]).includes(value);
}

const MAGIC = 0x20534444; // "DDS "
const HEADER_SIZE = 124;

const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSD_PITCH = 0x8;
const DDSD_PIXELFORMAT = 0x1000;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDSD_LINEARSIZE = 0x80000;

const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;

const DDSCAPS_COMPLEX = 0x8;
const DDSCAPS_TEXTURE = 0x1000;
const DDSCAPS_MIPMAP = 0x400000;

/** Bytes one mip level occupies on disk. */
export function surfaceSize(width: number, height: number, format: DdsFormat): number {
  if (format === "raw") return width * height * 4;
  const blockBytes = format === "dxt1" ? 8 : 16;
  return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * blockBytes;
}

export function buildDdsHeader(width: number, height: number, mipCount: number, format: DdsFormat): Buffer {
  const buffer = Buffer.alloc(4 + HEADER_SIZE);
  let flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
  let caps = DDSCAPS_TEXTURE;
  if (mipCount > 1) {
    flags |= DDSD_MIPMAPCOUNT;
    caps |= DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
  }

  let pitchOrLinear: number;
  if (format === "raw") {
    flags |= DDSD_PITCH;
    pitchOrLinear = width * 4;
  } else {
    flags |= DDSD_LINEARSIZE;
    pitchOrLinear = surfaceSize(width, height, format);
  }

  buffer.writeUInt32LE(MAGIC, 0);
  buffer.writeUInt32LE(HEADER_SIZE, 4);
  buffer.writeUInt32LE(flags, 8);
  buffer.writeUInt32LE(height, 12);
  buffer.writeUInt32LE(width, 16);
  buffer.writeUInt32LE(pitchOrLinear, 20);
  buffer.writeUInt32LE(0, 24); // depth
  buffer.writeUInt32LE(mipCount, 28);
  // 32..75 reserved1[11], left zero

  const pf = 76;
  buffer.writeUInt32LE(32, pf); // pixel format size
  if (format === "raw") {
    // A8R8G8B8: little endian, so byte order on disk is B, G, R, A.
    buffer.writeUInt32LE(DDPF_RGB | DDPF_ALPHAPIXELS, pf + 4);
    buffer.writeUInt32LE(0, pf + 8); // fourCC
    buffer.writeUInt32LE(32, pf + 12); // bit count
    buffer.writeUInt32LE(0x00ff0000, pf + 16); // R
    buffer.writeUInt32LE(0x0000ff00, pf + 20); // G
    buffer.writeUInt32LE(0x000000ff, pf + 24); // B
    buffer.writeUInt32LE(0xff000000, pf + 28); // A
  } else {
    buffer.writeUInt32LE(DDPF_FOURCC, pf + 4);
    buffer.write(format === "dxt1" ? "DXT1" : "DXT5", pf + 8, 4, "ascii");
  }

  buffer.writeUInt32LE(caps, pf + 32);
  return buffer;
}

export interface DdsInfo {
  width: number;
  height: number;
  mipCount: number;
  format: DdsFormat;
}

/** Parse enough of a DDS header to decode it again. Used by tests and previews. */
export function readDdsHeader(data: Buffer): DdsInfo {
  if (data.length < 4 + HEADER_SIZE || data.readUInt32LE(0) !== MAGIC) {
    throw new Error("not a DDS file");
  }
  const height = data.readUInt32LE(12);
  const width = data.readUInt32LE(16);
  const mipCount = Math.max(1, data.readUInt32LE(28));
  const pfFlags = data.readUInt32LE(80);
  let format: DdsFormat;
  if (pfFlags & DDPF_FOURCC) {
    const fourCC = data.toString("ascii", 84, 88);
    if (fourCC === "DXT1") format = "dxt1";
    else if (fourCC === "DXT5") format = "dxt5";
    else throw new Error(`unsupported DDS fourCC ${fourCC}`);
  } else {
    format = "raw";
  }
  return { width, height, mipCount, format };
}

export const DDS_HEADER_BYTES = 4 + HEADER_SIZE;
