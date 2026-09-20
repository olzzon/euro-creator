/**
 * Rasterising a paint template from dumped UV polygons.
 *
 * The template is what makes a skin paintable: a transparent image the size of
 * the final mask, with every painted surface's UV island drawn on it, so an
 * artist can see where the door, the roof and the sun visor land before
 * painting a single pixel.
 *
 * Drawn here rather than by Blender's UV-layout exporter, which only handles
 * one object at a time -- a truck is dozens.
 */

import { createImage, type RgbaImage } from "./image.js";
import type { UvDump } from "./uvdump.js";

const FILL_ALPHA = 28;
const LINE_ALPHA = 190;

export interface TemplateOptions {
  size?: number;
  /** Tint the island interiors as well as outlining them. */
  fill?: boolean;
  lineWidth?: number;
  /** Restrict to these SCS part names. Used for the per-part sheets. */
  onlyGroups?: readonly string[];
}

/**
 * A distinct, evenly spread hue per part.
 *
 * The golden-ratio step keeps consecutive parts far apart in hue even when
 * there are only three of them, which a naive `index / total` does not.
 */
export function partColour(index: number): readonly [number, number, number] {
  const hue = (index * 0.618033988749895) % 1;
  const lightness = index % 2 === 0 ? 0.55 : 0.68;
  return hslToRgb(hue, 0.85, lightness);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h * 6) % 6;
  const table: ReadonlyArray<readonly [number, number, number]> = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = table[sector]!;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Draw the UV islands onto a transparent RGBA canvas. */
export function renderTemplate(dump: UvDump, options: TemplateOptions = {}): RgbaImage {
  const size = options.size ?? 4096;
  const fill = options.fill ?? true;
  const lineWidth = Math.max(1, options.lineWidth ?? 1);
  const wanted = options.onlyGroups ? new Set(options.onlyGroups) : null;

  const canvas = createImage(size, size, [0, 0, 0, 0]);
  const colours = dump.groups.map((_, index) => partColour(index));

  // Reused across polygons; a truck has far more polygons than vertices each.
  const xs: number[] = [];
  const ys: number[] = [];

  for (let poly = 0; poly < dump.polyStart.length; poly += 1) {
    const group = dump.polyGroup[poly]!;
    if (wanted && !wanted.has(dump.groups[group] ?? "")) continue;

    const start = dump.polyStart[poly]!;
    const count = dump.polyCount[poly]!;
    if (count < 3) continue;

    xs.length = 0;
    ys.length = 0;
    for (let i = 0; i < count; i += 1) {
      const u = dump.uv[(start + i) * 2]!;
      const v = dump.uv[(start + i) * 2 + 1]!;
      // UV origin is bottom-left in Blender and top-left in an image, so V is
      // flipped -- getting this wrong mirrors the whole livery vertically.
      xs.push(u * size);
      ys.push((1 - v) * size);
    }

    const colour = colours[group] ?? [255, 255, 255];
    if (fill) fillPolygon(canvas, xs, ys, colour, FILL_ALPHA);
    strokePolygon(canvas, xs, ys, colour, LINE_ALPHA, lineWidth);
  }

  return canvas;
}

/** Source-over composite of one pixel. */
function blend(canvas: RgbaImage, x: number, y: number, colour: readonly [number, number, number], alpha: number): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 4;
  const src = alpha / 255;
  const dstA = canvas.data[i + 3]! / 255;
  const outA = src + dstA * (1 - src);
  if (outA <= 0) return;
  for (let ch = 0; ch < 3; ch += 1) {
    const dst = canvas.data[i + ch]! / 255;
    canvas.data[i + ch] = Math.round(((colour[ch]! / 255) * src + dst * dstA * (1 - src)) / outA * 255);
  }
  canvas.data[i + 3] = Math.round(outA * 255);
}

/** Even-odd scanline fill. UV islands are simple polygons, so the rule is irrelevant. */
function fillPolygon(
  canvas: RgbaImage,
  xs: readonly number[],
  ys: readonly number[],
  colour: readonly [number, number, number],
  alpha: number,
): void {
  const n = xs.length;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const y of ys) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const yStart = Math.max(0, Math.ceil(minY));
  const yEnd = Math.min(canvas.height - 1, Math.floor(maxY));
  const crossings: number[] = [];

  for (let y = yStart; y <= yEnd; y += 1) {
    crossings.length = 0;
    const scan = y + 0.5;
    for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
      const y0 = ys[j]!;
      const y1 = ys[i]!;
      if (y0 === y1) continue;
      if (scan >= Math.min(y0, y1) && scan < Math.max(y0, y1)) {
        const t = (scan - y0) / (y1 - y0);
        crossings.push(xs[j]! + t * (xs[i]! - xs[j]!));
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(crossings[k]! - 0.5));
      const x1 = Math.min(canvas.width - 1, Math.floor(crossings[k + 1]! - 0.5));
      for (let x = x0; x <= x1; x += 1) blend(canvas, x, y, colour, alpha);
    }
  }
}

function strokePolygon(
  canvas: RgbaImage,
  xs: readonly number[],
  ys: readonly number[],
  colour: readonly [number, number, number],
  alpha: number,
  width: number,
): void {
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i, i += 1) {
    drawLine(canvas, xs[j]!, ys[j]!, xs[i]!, ys[i]!, colour, alpha, width);
  }
}

/** Bresenham, thickened by stamping a square when width > 1. */
function drawLine(
  canvas: RgbaImage,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  colour: readonly [number, number, number],
  alpha: number,
  width: number,
): void {
  let x0 = Math.round(ax);
  let y0 = Math.round(ay);
  const x1 = Math.round(bx);
  const y1 = Math.round(by);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  const half = Math.floor(width / 2);

  // A degenerate UV island can be enormous once scaled; cap the walk so one
  // broken polygon cannot stall a whole template render.
  const limit = (canvas.width + canvas.height) * 4;
  for (let step = 0; step <= limit; step += 1) {
    if (width === 1) blend(canvas, x0, y0, colour, alpha);
    else {
      for (let oy = -half; oy <= half; oy += 1) {
        for (let ox = -half; ox <= half; ox += 1) blend(canvas, x0 + ox, y0 + oy, colour, alpha);
      }
    }
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * error;
    if (e2 >= dy) {
      error += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      error += dx;
      y0 += sy;
    }
  }
}

/** A small key mapping each colour back to its SCS part name, drawn as swatches. */
export function renderLegend(groups: readonly string[]): RgbaImage {
  const rowHeight = 24;
  const width = 320;
  const canvas = createImage(width, Math.max(1, groups.length) * rowHeight + 8, [24, 26, 30, 255]);
  groups.forEach((_, index) => {
    const y = 4 + index * rowHeight;
    const colour = partColour(index);
    for (let row = y + 4; row < y + rowHeight - 4; row += 1) {
      for (let col = 8; col < 40; col += 1) blend(canvas, col, row, colour, 255);
    }
  });
  return canvas;
}
