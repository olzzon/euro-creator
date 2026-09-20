/**
 * The paint-job UV dump written by the Blender helper.
 *
 * A truck cab can carry hundreds of thousands of polygons, so JSON is both too
 * slow to parse and too large to move around. This is a flat binary instead:
 *
 * ```
 * "EUVD"          magic
 * u32             version (1)
 * u32             polygon count
 * u32             loop count (total UV pairs)
 * u32             group count
 * group count x   u16 byte length + UTF-8 name
 * polygon count x u32 start index into the UV array
 * polygon count x u16 vertex count
 * polygon count x u16 group index
 * loop count x    f32 u, f32 v
 * ```
 *
 * Groups are SCS part names, which is what makes a 4096x4096 wireframe
 * readable: the cab, the chassis and the accessories separate visually instead
 * of merging into one grey mess.
 */

const MAGIC = "EUVD";
export const UV_DUMP_VERSION = 1;

export interface UvDump {
  readonly groups: readonly string[];
  readonly polyStart: Uint32Array;
  readonly polyCount: Uint16Array;
  readonly polyGroup: Uint16Array;
  /** Interleaved u, v pairs in UV space (0..1, origin bottom-left). */
  readonly uv: Float32Array;
}

export function decodeUvDump(data: Buffer): UvDump {
  if (data.length < 20 || data.toString("ascii", 0, 4) !== MAGIC) {
    throw new Error("not a euro-creator UV dump");
  }
  const version = data.readUInt32LE(4);
  if (version !== UV_DUMP_VERSION) {
    throw new Error(`UV dump version ${version} is not supported (expected ${UV_DUMP_VERSION})`);
  }

  const polygons = data.readUInt32LE(8);
  const loops = data.readUInt32LE(12);
  const groupCount = data.readUInt32LE(16);

  let offset = 20;
  const groups: string[] = [];
  for (let i = 0; i < groupCount; i += 1) {
    const length = data.readUInt16LE(offset);
    offset += 2;
    groups.push(data.toString("utf8", offset, offset + length));
    offset += length;
  }

  const polyStart = new Uint32Array(polygons);
  for (let i = 0; i < polygons; i += 1, offset += 4) polyStart[i] = data.readUInt32LE(offset);
  const polyCount = new Uint16Array(polygons);
  for (let i = 0; i < polygons; i += 1, offset += 2) polyCount[i] = data.readUInt16LE(offset);
  const polyGroup = new Uint16Array(polygons);
  for (let i = 0; i < polygons; i += 1, offset += 2) polyGroup[i] = data.readUInt16LE(offset);

  const uv = new Float32Array(loops * 2);
  for (let i = 0; i < loops * 2; i += 1, offset += 4) uv[i] = data.readFloatLE(offset);

  return { groups, polyStart, polyCount, polyGroup, uv };
}

export function uvDumpStats(dump: UvDump): { polygons: number; groups: number; loops: number } {
  return { polygons: dump.polyStart.length, groups: dump.groups.length, loops: dump.uv.length / 2 };
}
