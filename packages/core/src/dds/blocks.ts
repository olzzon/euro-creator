/**
 * BC1 / BC3 block compression.
 *
 * SCS' own Conversion Tools do TGA -> DDS, but they are Windows-only, which
 * makes the whole pipeline unusable elsewhere. The game only ever reads the
 * finished DDS, so it is produced directly here.
 *
 * The colour endpoints are fitted by bounding box with an inset, then refined
 * by two least-squares passes against the indices chosen so far -- the same
 * shape as stb_dxt's `RefineBlock`. Bounding box alone bands visibly on the
 * smooth gradients liveries are full of; two passes gets mean error on a
 * gradient down to about one 8-bit level.
 *
 * Everything works on preallocated scratch arrays: a 4096x4096 mask is a
 * million blocks, and allocating per block dominates the run time otherwise.
 */

const REFINE_PASSES = 2;

/** Ramp weights for the four palette slots: c0, c1, 2/3, 1/3. */
const INDEX_WEIGHT = [1, 0, 2 / 3, 1 / 3] as const;

function quantise565(r: number, g: number, b: number): number {
  const qr = Math.min(31, Math.max(0, Math.round((r * 31) / 255)));
  const qg = Math.min(63, Math.max(0, Math.round((g * 63) / 255)));
  const qb = Math.min(31, Math.max(0, Math.round((b * 31) / 255)));
  return (qr << 11) | (qg << 5) | qb;
}

/** Expand RGB565 the way the hardware does, by bit replication. */
function expand565(packed: number, out: Float64Array, offset: number): void {
  const r = (packed >> 11) & 0x1f;
  const g = (packed >> 5) & 0x3f;
  const b = packed & 0x1f;
  out[offset] = (r << 3) | (r >> 2);
  out[offset + 1] = (g << 2) | (g >> 4);
  out[offset + 2] = (b << 3) | (b >> 2);
}

/** Per-encoder scratch. One instance is reused across every block of a surface. */
class Scratch {
  readonly rgb = new Float64Array(16 * 3);
  readonly alpha = new Uint8Array(16);
  readonly indices = new Uint8Array(16);
  readonly palette = new Float64Array(4 * 3);
  readonly endpoints = new Float64Array(2 * 3);
}

/**
 * Read one 4x4 block out of an RGBA surface into scratch.
 *
 * Blocks that hang off the right or bottom edge repeat the last real pixel
 * rather than reading black, so a non-multiple-of-4 texture does not get dark
 * fringes along those edges.
 */
function gatherBlock(
  data: Uint8Array,
  width: number,
  height: number,
  blockX: number,
  blockY: number,
  scratch: Scratch,
): void {
  for (let row = 0; row < 4; row += 1) {
    const y = Math.min(height - 1, blockY * 4 + row);
    for (let col = 0; col < 4; col += 1) {
      const x = Math.min(width - 1, blockX * 4 + col);
      const src = (y * width + x) * 4;
      const dst = row * 4 + col;
      scratch.rgb[dst * 3] = data[src]!;
      scratch.rgb[dst * 3 + 1] = data[src + 1]!;
      scratch.rgb[dst * 3 + 2] = data[src + 2]!;
      scratch.alpha[dst] = data[src + 3]!;
    }
  }
}

/** Nearest palette entry for each of the 16 pixels; returns the summed squared error. */
function selectIndices(scratch: Scratch): number {
  const { rgb, palette, indices } = scratch;
  let total = 0;
  for (let i = 0; i < 16; i += 1) {
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    let best = 0;
    let bestError = Infinity;
    for (let p = 0; p < 4; p += 1) {
      const dr = r - palette[p * 3]!;
      const dg = g - palette[p * 3 + 1]!;
      const db = b - palette[p * 3 + 2]!;
      const error = dr * dr + dg * dg + db * db;
      if (error < bestError) {
        bestError = error;
        best = p;
      }
    }
    indices[i] = best;
    total += bestError;
  }
  return total;
}

function fillPalette(scratch: Scratch, c0: number, c1: number): void {
  const { palette } = scratch;
  expand565(c0, palette, 0);
  expand565(c1, palette, 3);
  for (let ch = 0; ch < 3; ch += 1) {
    const a = palette[ch]!;
    const b = palette[3 + ch]!;
    palette[6 + ch] = (2 * a + b) / 3;
    palette[9 + ch] = (a + 2 * b) / 3;
  }
}

/**
 * Encode the 8 colour bytes of a BC1/BC3 block.
 *
 * Always emits 4-colour mode (c0 > c1). BC3 carries alpha separately, so the
 * 3-colour-plus-transparent mode is never useful here, and a block that
 * accidentally lands on c0 == c1 would be read as transparent by the hardware.
 */
function encodeColourBlock(scratch: Scratch, out: Uint8Array, offset: number): void {
  const { rgb, endpoints } = scratch;

  let loR = 255, loG = 255, loB = 255;
  let hiR = 0, hiG = 0, hiB = 0;
  for (let i = 0; i < 16; i += 1) {
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    if (r < loR) loR = r;
    if (g < loG) loG = g;
    if (b < loB) loB = b;
    if (r > hiR) hiR = r;
    if (g > hiG) hiG = g;
    if (b > hiB) hiB = b;
  }

  // Inset the bounding box, as stb_dxt does: the extremes are the ramp's
  // endpoints, so pulling them in slightly lowers average error across the block.
  const insetR = (hiR - loR) / 16;
  const insetG = (hiG - loG) / 16;
  const insetB = (hiB - loB) / 16;
  let hiQ = quantise565(hiR - insetR, hiG - insetG, hiB - insetB);
  let loQ = quantise565(loR + insetR, loG + insetG, loB + insetB);

  for (let pass = 0; pass < REFINE_PASSES; pass += 1) {
    fillPalette(scratch, hiQ, loQ);
    selectIndices(scratch);

    // Least-squares refit of both endpoints with the indices held fixed.
    let a11 = 0, a22 = 0, a12 = 0;
    endpoints.fill(0);
    for (let i = 0; i < 16; i += 1) {
      const w = INDEX_WEIGHT[scratch.indices[i]!]!;
      const iw = 1 - w;
      a11 += w * w;
      a22 += iw * iw;
      a12 += w * iw;
      for (let ch = 0; ch < 3; ch += 1) {
        const value = rgb[i * 3 + ch]!;
        endpoints[ch] = endpoints[ch]! + w * value;
        endpoints[3 + ch] = endpoints[3 + ch]! + iw * value;
      }
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) <= 1e-6) break; // degenerate: keep the bounding-box fit
    const newHi = [0, 0, 0];
    const newLo = [0, 0, 0];
    for (let ch = 0; ch < 3; ch += 1) {
      newHi[ch] = (a22 * endpoints[ch]! - a12 * endpoints[3 + ch]!) / det;
      newLo[ch] = (a11 * endpoints[3 + ch]! - a12 * endpoints[ch]!) / det;
    }
    hiQ = quantise565(newHi[0]!, newHi[1]!, newHi[2]!);
    loQ = quantise565(newLo[0]!, newLo[1]!, newLo[2]!);
  }

  // 4-colour mode requires c0 > c1. Ordering first and selecting once is
  // cheaper than swapping endpoints and remapping every index afterwards.
  let c0 = hiQ;
  let c1 = loQ;
  if (c0 <= c1) {
    c0 = loQ;
    c1 = hiQ;
  }
  if (c0 === c1) {
    // A flat block would otherwise encode as 3-colour + transparent.
    if (c1 > 0) c1 -= 1;
    else c0 += 1;
  }

  fillPalette(scratch, c0, c1);
  selectIndices(scratch);

  out[offset] = c0 & 0xff;
  out[offset + 1] = (c0 >> 8) & 0xff;
  out[offset + 2] = c1 & 0xff;
  out[offset + 3] = (c1 >> 8) & 0xff;
  for (let byte = 0; byte < 4; byte += 1) {
    const base = byte * 4;
    out[offset + 4 + byte] =
      scratch.indices[base]! |
      (scratch.indices[base + 1]! << 2) |
      (scratch.indices[base + 2]! << 4) |
      (scratch.indices[base + 3]! << 6);
  }
}

/**
 * Encode the 8 alpha bytes of a BC3 block (the BC4 layout).
 *
 * Always uses the 8-value interpolation mode, so a0 is the maximum and a1 the
 * minimum. Palette order is a0, a1, then six interpolants, which is why the
 * ramp position `k` has to be remapped rather than used directly.
 */
function encodeAlphaBlock(scratch: Scratch, out: Uint8Array, offset: number): void {
  const { alpha } = scratch;
  let aMax = 0;
  let aMin = 255;
  for (let i = 0; i < 16; i += 1) {
    const a = alpha[i]!;
    if (a > aMax) aMax = a;
    if (a < aMin) aMin = a;
  }

  out[offset] = aMax;
  out[offset + 1] = aMin;

  const span = aMax - aMin;
  if (span === 0) {
    // Every pixel maps to index 0 (= a0), so the index bits are all zero.
    out.fill(0, offset + 2, offset + 8);
    return;
  }

  // Two 24-bit halves rather than a 48-bit value, to stay in 32-bit integer
  // arithmetic instead of reaching for BigInt.
  let low = 0;
  let high = 0;
  for (let i = 0; i < 16; i += 1) {
    const k = Math.min(7, Math.max(0, Math.round(((alpha[i]! - aMin) * 7) / span)));
    const index = k === 7 ? 0 : k === 0 ? 1 : 8 - k;
    if (i < 8) low |= index << (i * 3);
    else high |= index << ((i - 8) * 3);
  }
  out[offset + 2] = low & 0xff;
  out[offset + 3] = (low >> 8) & 0xff;
  out[offset + 4] = (low >> 16) & 0xff;
  out[offset + 5] = high & 0xff;
  out[offset + 6] = (high >> 8) & 0xff;
  out[offset + 7] = (high >> 16) & 0xff;
}

/** Compress one RGBA surface to BC1 or BC3 blocks. */
export function encodeBlocks(
  data: Uint8Array,
  width: number,
  height: number,
  format: "dxt1" | "dxt5",
): Uint8Array {
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  const blockBytes = format === "dxt1" ? 8 : 16;
  const out = new Uint8Array(blocksX * blocksY * blockBytes);
  const scratch = new Scratch();

  let offset = 0;
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      gatherBlock(data, width, height, bx, by, scratch);
      if (format === "dxt5") {
        encodeAlphaBlock(scratch, out, offset);
        encodeColourBlock(scratch, out, offset + 8);
      } else {
        encodeColourBlock(scratch, out, offset);
      }
      offset += blockBytes;
    }
  }
  return out;
}

/**
 * Decode BC1/BC3 blocks back to RGBA.
 *
 * Used by the tests to measure compression error, and by the server to render
 * a "this is what the game will actually show" preview -- the one question a
 * skinner cannot answer by looking at their source PNG.
 */
export function decodeBlocks(
  blocks: Uint8Array,
  width: number,
  height: number,
  format: "dxt1" | "dxt5",
): Uint8Array {
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  const blockBytes = format === "dxt1" ? 8 : 16;
  const out = new Uint8Array(width * height * 4);
  const palette = new Float64Array(4 * 3);
  const alphaRamp = new Float64Array(8);

  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      let offset = (by * blocksX + bx) * blockBytes;

      let hasAlphaRamp = false;
      let alphaLow = 0;
      let alphaHigh = 0;
      if (format === "dxt5") {
        const a0 = blocks[offset]!;
        const a1 = blocks[offset + 1]!;
        alphaRamp[0] = a0;
        alphaRamp[1] = a1;
        if (a0 > a1) {
          for (let i = 2; i < 8; i += 1) alphaRamp[i] = ((8 - i) * a0 + (i - 1) * a1) / 7;
        } else {
          for (let i = 2; i < 6; i += 1) alphaRamp[i] = ((6 - i) * a0 + (i - 1) * a1) / 5;
          alphaRamp[6] = 0;
          alphaRamp[7] = 255;
        }
        alphaLow = blocks[offset + 2]! | (blocks[offset + 3]! << 8) | (blocks[offset + 4]! << 16);
        alphaHigh = blocks[offset + 5]! | (blocks[offset + 6]! << 8) | (blocks[offset + 7]! << 16);
        hasAlphaRamp = true;
        offset += 8;
      }

      const c0 = blocks[offset]! | (blocks[offset + 1]! << 8);
      const c1 = blocks[offset + 2]! | (blocks[offset + 3]! << 8);
      expand565(c0, palette, 0);
      expand565(c1, palette, 3);
      const fourColour = c0 > c1 || format === "dxt5";
      for (let ch = 0; ch < 3; ch += 1) {
        const a = palette[ch]!;
        const b = palette[3 + ch]!;
        if (fourColour) {
          palette[6 + ch] = (2 * a + b) / 3;
          palette[9 + ch] = (a + 2 * b) / 3;
        } else {
          palette[6 + ch] = (a + b) / 2;
          palette[9 + ch] = 0;
        }
      }
      const colourBits =
        blocks[offset + 4]! | (blocks[offset + 5]! << 8) | (blocks[offset + 6]! << 16) | (blocks[offset + 7]! << 24);

      for (let row = 0; row < 4; row += 1) {
        const y = by * 4 + row;
        if (y >= height) break;
        for (let col = 0; col < 4; col += 1) {
          const x = bx * 4 + col;
          if (x >= width) continue;
          const i = row * 4 + col;
          const index = (colourBits >>> (i * 2)) & 0x3;
          const dst = (y * width + x) * 4;
          out[dst] = Math.round(palette[index * 3]!);
          out[dst + 1] = Math.round(palette[index * 3 + 1]!);
          out[dst + 2] = Math.round(palette[index * 3 + 2]!);
          if (hasAlphaRamp) {
            const bits = i < 8 ? alphaLow >>> (i * 3) : alphaHigh >>> ((i - 8) * 3);
            out[dst + 3] = Math.round(alphaRamp[bits & 0x7]!);
          } else {
            out[dst + 3] = !fourColour && index === 3 ? 0 : 255;
          }
        }
      }
    }
  }
  return out;
}
