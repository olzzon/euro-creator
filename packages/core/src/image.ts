/**
 * The one image representation the whole pipeline passes around: tightly
 * packed 8-bit RGBA, row-major, top-left origin. Everything that reads a file
 * (PNG, TGA, whatever) normalises to this, and everything that writes one
 * consumes it.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, RGBA order. */
  readonly data: Uint8Array;
}

export function createImage(width: number, height: number, fill?: readonly [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  if (fill) {
    const [r, g, b, a] = fill;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

export function assertRgba(image: RgbaImage): void {
  const expected = image.width * image.height * 4;
  if (image.width <= 0 || image.height <= 0) {
    throw new Error(`image has a zero dimension: ${image.width}x${image.height}`);
  }
  if (image.data.length !== expected) {
    throw new Error(`image data is ${image.data.length} bytes, expected ${expected} for ${image.width}x${image.height} RGBA`);
  }
}

const POWERS_OF_TWO = new Set(Array.from({ length: 13 }, (_, i) => 2 ** (i + 2)));

export function isPowerOfTwo(value: number): boolean {
  return POWERS_OF_TWO.has(value);
}

/** Human summary used in build logs and the API's texture report. */
export function describeImage(image: RgbaImage): string {
  const pot = isPowerOfTwo(image.width) && isPowerOfTwo(image.height);
  return `${image.width}x${image.height}${pot ? "" : "  (not a power of two -- mipmaps and VRAM use will suffer)"}`;
}

/** Nearest-neighbour-free box resample. Used only to fix a mismatched mask on request. */
export function resizeImage(image: RgbaImage, width: number, height: number): RgbaImage {
  if (image.width === width && image.height === height) return image;
  const out = new Uint8Array(width * height * 4);
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * xRatio)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let src = (sy * image.width + x0) * 4;
        for (let sx = x0; sx < x1; sx += 1, src += 4) {
          r += image.data[src]!;
          g += image.data[src + 1]!;
          b += image.data[src + 2]!;
          a += image.data[src + 3]!;
          n += 1;
        }
      }
      const dst = (y * width + x) * 4;
      out[dst] = Math.round(r / n);
      out[dst + 1] = Math.round(g / n);
      out[dst + 2] = Math.round(b / n);
      out[dst + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}
