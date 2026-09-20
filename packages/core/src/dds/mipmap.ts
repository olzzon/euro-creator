import type { RgbaImage } from "../image.js";

/**
 * Build the mip chain down to 1x1, box-filtered.
 *
 * Alpha is *not* premultiplied: a paint job mask's alpha is a mask, not
 * coverage, so averaging it independently of RGB is what we want.
 *
 * An odd dimension repeats its last row or column before halving, so the 2x2
 * box stays exact rather than dropping a pixel off the edge.
 */
export function buildMipmaps(image: RgbaImage): RgbaImage[] {
  const levels: RgbaImage[] = [image];
  let current = image;

  while (current.width > 1 || current.height > 1) {
    const srcW = current.width;
    const srcH = current.height;
    const padW = srcW % 2 === 1 ? srcW + 1 : srcW;
    const padH = srcH % 2 === 1 ? srcH + 1 : srcH;
    const outW = padW / 2;
    const outH = padH / 2;
    const out = new Uint8Array(outW * outH * 4);

    for (let y = 0; y < outH; y += 1) {
      const y0 = Math.min(srcH - 1, y * 2);
      const y1 = Math.min(srcH - 1, y * 2 + 1);
      for (let x = 0; x < outW; x += 1) {
        const x0 = Math.min(srcW - 1, x * 2);
        const x1 = Math.min(srcW - 1, x * 2 + 1);
        const a = (y0 * srcW + x0) * 4;
        const b = (y0 * srcW + x1) * 4;
        const c = (y1 * srcW + x0) * 4;
        const d = (y1 * srcW + x1) * 4;
        const dst = (y * outW + x) * 4;
        for (let ch = 0; ch < 4; ch += 1) {
          // Integer division, matching the reference implementation: the sum
          // of four bytes never overflows, and truncation keeps the chain
          // reproducible across platforms.
          out[dst + ch] =
            (current.data[a + ch]! + current.data[b + ch]! + current.data[c + ch]! + current.data[d + ch]!) >> 2;
        }
      }
    }

    current = { width: outW, height: outH, data: out };
    levels.push(current);
  }
  return levels;
}
