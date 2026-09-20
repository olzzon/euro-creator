/**
 * Name handling.
 *
 * Three different kinds of name show up in a mod, and mixing them up is the
 * most common reason a paint job silently fails to appear:
 *
 * - `unit`    the SII unit / file name -- lowercase ASCII, `[a-z0-9_]` only.
 * - `asset`   a path segment inside the archive -- ASCII, spaces allowed.
 * - `display` what the player reads in the shop -- any UTF-8 text.
 *
 * The game's SII parser accepts a narrow character set for unit names, so
 * anything derived from user input is forced into it rather than trusted.
 */

const UNIT_RE = /^[a-z_][a-z0-9_]*$/;

/** Characters that would break an SII string literal or an archive path. */
const ILLEGAL_ASSET = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

/**
 * Transliterations worth spelling out. Everything else falls back to NFD
 * stripping, which turns "é" into "e" and drops what it cannot map.
 */
const TRANSLITERATE: ReadonlyArray<readonly [RegExp, string]> = [
  [/æ/g, "ae"], [/ø/g, "oe"], [/å/g, "aa"],
  [/Æ/g, "Ae"], [/Ø/g, "Oe"], [/Å/g, "Aa"],
  [/ä/g, "ae"], [/ö/g, "oe"], [/ü/g, "ue"], [/ß/g, "ss"],
  [/Ä/g, "Ae"], [/Ö/g, "Oe"], [/Ü/g, "Ue"],
];

function toAscii(text: string): string {
  let result = text;
  for (const [pattern, replacement] of TRANSLITERATE) result = result.replace(pattern, replacement);
  return result
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7F]/g, "");
}

/**
 * Fold arbitrary text into a legal SII unit name.
 *
 * @example toUnitName("Olzzon's Nordic Livery") === "olzzon_s_nordic_livery"
 */
export function toUnitName(text: string): string {
  const ascii = toAscii(text).toLowerCase();
  let unit = ascii.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/_{2,}/g, "_");
  if (unit === "") throw new Error(`${JSON.stringify(text)} contains no characters usable in a unit name`);
  if (/^[0-9]/.test(unit)) unit = `_${unit}`;
  return unit;
}

/**
 * Fold arbitrary text into a name safe as a path segment in the archive.
 *
 * Spaces and mixed case survive -- SCS use both in their own archives -- but
 * anything that would break a path or an SII string is replaced.
 */
export function toAssetName(text: string): string {
  const cleaned = Array.from(toAscii(text))
    .map((ch) => (ILLEGAL_ASSET.has(ch) ? "_" : ch))
    // eslint-disable-next-line no-control-regex
    .filter((ch) => !/[\x00-\x1F\x7F]/.test(ch))
    .join("")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (cleaned === "") throw new Error(`${JSON.stringify(text)} contains no characters usable in a file name`);
  return cleaned;
}

/** Clean text for an in-game label: collapse whitespace, drop SII-breaking quotes. */
export function toDisplayName(text: string): string {
  return text.replace(/"/g, "'").replace(/\\/g, "/").replace(/\s+/g, " ").trim();
}

export function isUnitName(text: string): boolean {
  return UNIT_RE.test(text);
}
