/**
 * Reading and writing the image formats a skinner actually has on disk.
 *
 * sharp (libvips) covers PNG, JPEG, TIFF and WebP. It does not read TGA,
 * which SCS' own pipeline uses throughout, and it does not read DDS, which is
 * what we produce -- so both are handled here.
 */

import sharp from "sharp";

import { decodeDds } from "./dds/index.js";
import { TextureError } from "./errors.js";
import { assertRgba, type RgbaImage } from "./image.js";

export type ImageFormat = "png" | "jpeg" | "tga" | "dds" | "unknown";

/** Identify by magic bytes; extensions lie, especially on files from asset packs. */
export function sniffFormat(data: Buffer, filename?: string): ImageFormat {
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47) return "png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8) return "jpeg";
  if (data.length >= 4 && data.toString("ascii", 0, 4) === "DDS ") return "dds";
  // TGA has no magic number. Fall back to the extension, and to the v2 footer
  // that modern writers append.
  if (data.length >= 18) {
    const footer = data.length >= 26 ? data.toString("ascii", data.length - 18, data.length - 8) : "";
    if (footer === "TRUEVISION" || filename?.toLowerCase().endsWith(".tga")) return "tga";
  }
  return "unknown";
}

/** Decode any supported image to RGBA. */
export async function decodeImage(data: Buffer, filename?: string): Promise<RgbaImage> {
  const format = sniffFormat(data, filename);
  if (format === "dds") return decodeDds(data);
  if (format === "tga") return decodeTga(data);

  try {
    const { data: pixels, info } = await sharp(data)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8Array(pixels) };
  } catch (error) {
    throw new TextureError(
      `could not read ${filename ?? "image"}: ${(error as Error).message}. ` +
        `Supported: PNG, JPEG, TIFF, WebP, TGA, DDS.`,
    );
  }
}

export async function encodePng(image: RgbaImage): Promise<Buffer> {
  assertRgba(image);
  return sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

export async function encodeJpeg(image: RgbaImage, quality = 90): Promise<Buffer> {
  assertRgba(image);
  return sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .flatten({ background: { r: 28, g: 30, b: 34 } })
    .jpeg({ quality })
    .toBuffer();
}

/** High-quality resample, used for icons and for `--resize` on a mismatched mask. */
export async function resample(image: RgbaImage, width: number, height: number): Promise<RgbaImage> {
  assertRgba(image);
  if (image.width === width && image.height === height) return image;
  const { data, info } = await sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** Fit inside a box without distorting, centred on a transparent canvas. */
export async function letterbox(image: RgbaImage, width: number, height: number): Promise<RgbaImage> {
  assertRgba(image);
  const { data, info } = await sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .resize(width, height, {
      fit: "contain",
      kernel: "lanczos3",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

// --------------------------------------------------------------------------
// TGA
// --------------------------------------------------------------------------

/**
 * Decode a Targa file.
 *
 * Covers the two variants that matter for SCS work: uncompressed and
 * RLE-compressed true-colour, 24 or 32 bits per pixel. Both origin flags are
 * honoured -- TGA defaults to bottom-up, and getting that wrong flips a
 * livery vertically, which is a confusing bug to chase in game.
 */
export function decodeTga(data: Buffer): RgbaImage {
  if (data.length < 18) throw new TextureError("not a TGA file: too short");

  const idLength = data.readUInt8(0);
  const colourMapType = data.readUInt8(1);
  const imageType = data.readUInt8(2);
  const width = data.readUInt16LE(12);
  const height = data.readUInt16LE(14);
  const bpp = data.readUInt8(16);
  const descriptor = data.readUInt8(17);
  const topDown = (descriptor & 0x20) !== 0;

  if (colourMapType !== 0 || (imageType !== 2 && imageType !== 10)) {
    throw new TextureError(
      `unsupported TGA type ${imageType}: only uncompressed (2) and RLE (10) true-colour are supported. ` +
        `Re-export as 24- or 32-bit TGA without a colour map, or as PNG.`,
    );
  }
  if (bpp !== 24 && bpp !== 32) {
    throw new TextureError(`unsupported TGA depth ${bpp}: expected 24 or 32 bits per pixel`);
  }
  if (width <= 0 || height <= 0) throw new TextureError("TGA reports a zero dimension");

  const bytesPerPixel = bpp / 8;
  const pixels = new Uint8Array(width * height * 4);
  let src = 18 + idLength;
  let written = 0;
  const total = width * height;

  const writePixel = (offset: number): void => {
    // TGA stores BGR(A).
    const dst = written * 4;
    pixels[dst] = data[offset + 2]!;
    pixels[dst + 1] = data[offset + 1]!;
    pixels[dst + 2] = data[offset]!;
    pixels[dst + 3] = bytesPerPixel === 4 ? data[offset + 3]! : 255;
    written += 1;
  };

  if (imageType === 2) {
    if (data.length < src + total * bytesPerPixel) throw new TextureError("truncated TGA");
    for (let i = 0; i < total; i += 1) writePixel(src + i * bytesPerPixel);
  } else {
    while (written < total) {
      if (src >= data.length) throw new TextureError("truncated TGA (RLE stream ended early)");
      const packet = data.readUInt8(src);
      src += 1;
      const count = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        // Run: one pixel repeated.
        const at = written * 4;
        writePixel(src);
        src += bytesPerPixel;
        for (let i = 1; i < count && written < total; i += 1) {
          pixels.copyWithin(written * 4, at, at + 4);
          written += 1;
        }
      } else {
        for (let i = 0; i < count && written < total; i += 1) {
          writePixel(src);
          src += bytesPerPixel;
        }
      }
    }
  }

  if (!topDown) {
    // Flip vertically into a fresh buffer; rows are contiguous so this is a
    // handful of large copies rather than a per-pixel loop.
    const flipped = new Uint8Array(pixels.length);
    const stride = width * 4;
    for (let y = 0; y < height; y += 1) {
      flipped.set(pixels.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
    }
    return { width, height, data: flipped };
  }
  return { width, height, data: pixels };
}
