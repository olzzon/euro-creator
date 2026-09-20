/**
 * TOBJ (texture object) writer.
 *
 * A `.tobj` is the indirection the game reads instead of a `.dds`: a 48-byte
 * binary header holding sampler state, followed by the archive-absolute path
 * to the DDS, ASCII, with no terminator.
 *
 * The header emitted here is byte-for-byte the pattern shipped by SCS' own
 * paint job textures, so it is known-good for a 2D, mipmapped,
 * repeat-addressed, sRGB texture -- which is what every paint job mask and
 * shop icon is:
 *
 * ```
 * 0x00  u32    0x70B10A01   version magic
 * 0x04  u32[4] 0            reserved
 * 0x14  u16    1            unknown
 * 0x16  u16    2            texture type: 2D
 * 0x18  u16    2            unknown
 * 0x1A  u8     3            addr_u   3 = repeat, 0 = clamp_to_edge
 * 0x1B  u8     3            addr_v
 * 0x1C  u8     3            addr_w
 * 0x1D  u8[11] 00 02 02 00 01 00 00 00 01 00 00
 *                           filter / bias / flag block
 * 0x28  u32    len(path)
 * 0x2C  u32    0            reserved
 * 0x30  ...    path bytes
 * ```
 *
 * Only the addressing mode is exposed. The remaining bytes in the 0x1D block
 * are filter, bias and compression flags whose individual meanings are not
 * reliably documented outside SCS; rather than guess and risk a texture that
 * loads wrong, the shipped values are kept verbatim.
 */

export const TOBJ_MAGIC = 0x70b10a01;
export const TOBJ_HEADER_SIZE = 0x30;

const ADDR_REPEAT = 3;
const ADDR_CLAMP = 0;
const ADDR_OFFSET = 0x1a;

const TEMPLATE = Buffer.from(
  "010ab170" +
    "00000000000000000000000000000000" + // reserved 0x04..0x13
    "0100" + // unknown
    "0200" + // texture type: 2D
    "0200" + // unknown
    "030303" + // addr_u / addr_v / addr_w
    "0002020001000000010000", // filter / bias / flags
  "hex",
);

export interface TobjOptions {
  /**
   * Clamp instead of repeat. Use for a texture that must not tile at its
   * edges -- shop icons, and airbrush masks that do not fill the UV square.
   */
  clamp?: boolean;
}

/**
 * Build the bytes of a `.tobj` pointing at `ddsPath`.
 *
 * `ddsPath` is the path *inside the archive* and must be absolute, e.g.
 * `/vehicle/truck/upgrade/paintjob/Nordic/Scania S/Cabin.dds`.
 */
export function buildTobj(ddsPath: string, options: TobjOptions = {}): Buffer {
  if (!ddsPath.startsWith("/")) {
    throw new Error(`TOBJ target must be an archive-absolute path starting with '/', got ${JSON.stringify(ddsPath)}`);
  }
  if (!ddsPath.toLowerCase().endsWith(".dds")) {
    throw new Error(`TOBJ target must be a .dds file, got ${JSON.stringify(ddsPath)}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(ddsPath)) {
    throw new Error(`TOBJ target must be ASCII, got ${JSON.stringify(ddsPath)}`);
  }

  const path = Buffer.from(ddsPath, "ascii");
  const header = Buffer.from(TEMPLATE);
  if (options.clamp) header.fill(ADDR_CLAMP, ADDR_OFFSET, ADDR_OFFSET + 3);
  else header.fill(ADDR_REPEAT, ADDR_OFFSET, ADDR_OFFSET + 3);

  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(path.length, 0);
  return Buffer.concat([header, tail, path], TOBJ_HEADER_SIZE + path.length);
}

/** Extract the DDS path from TOBJ bytes. Used by the tests and by mod validation. */
export function readTobjPath(data: Buffer): string {
  if (data.length < TOBJ_HEADER_SIZE) throw new Error("not a TOBJ file: too short");
  const magic = data.readUInt32LE(0);
  if (magic !== TOBJ_MAGIC) {
    throw new Error(`not a TOBJ file: bad magic 0x${magic.toString(16).toUpperCase()}`);
  }
  const length = data.readUInt32LE(0x28);
  return data.subarray(TOBJ_HEADER_SIZE, TOBJ_HEADER_SIZE + length).toString("ascii");
}
