/**
 * Packaging a mod as a `.scs` archive.
 *
 * A `.scs` is a plain zip renamed. The game's loader handles deflate, but
 * stored (uncompressed) entries are what SCS ship and what avoids the
 * sporadic "mod fails to load" reports around deflated archives, so stored is
 * the default. Paths inside the archive always use forward slashes and are
 * relative to the mod root with no leading slash.
 */

import { ZipFile } from "yazl";

export interface ModFile {
  /** Archive-relative path, forward slashes, no leading slash. */
  readonly path: string;
  readonly data: Buffer;
}

/** Editor leftovers and OS metadata that must never end up inside a shipped mod. */
const EXCLUDE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const EXCLUDE_SUFFIXES = [".blend1", ".blend2", ".xcf", ".kra", ".psd"];

export function shouldInclude(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  if (EXCLUDE_NAMES.has(name) || name.startsWith("._")) return false;
  return !EXCLUDE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));
}

export interface PackOptions {
  /** Deflate instead of store. Off by default; see the module note. */
  compress?: boolean;
}

export async function packScs(files: readonly ModFile[], options: PackOptions = {}): Promise<Buffer> {
  const included = files.filter((file) => shouldInclude(file.path));
  if (included.length === 0) throw new Error("nothing to pack: no files to write into the archive");

  const seen = new Set<string>();
  for (const file of included) {
    const normalised = normaliseArchivePath(file.path);
    if (seen.has(normalised.toLowerCase())) {
      // The game's virtual filesystem is case-insensitive, so two entries
      // differing only in case shadow each other unpredictably.
      throw new Error(`duplicate archive entry: ${file.path}`);
    }
    seen.add(normalised.toLowerCase());
  }

  const zip = new ZipFile();
  // Sorted so an unchanged mod packs to identical bytes every time, which
  // makes "did anything actually change?" answerable with a checksum.
  for (const file of [...included].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    zip.addBuffer(file.data, normaliseArchivePath(file.path), {
      compress: options.compress ?? false,
      mtime: new Date(0),
    });
  }
  zip.end();

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export function normaliseArchivePath(path: string): string {
  const normalised = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (normalised.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`archive path must not contain '.' or '..': ${path}`);
  }
  return normalised;
}

// --------------------------------------------------------------------------
// reading
// --------------------------------------------------------------------------

import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface ArchiveEntry {
  readonly path: string;
  readonly bytes: number;
  readonly compressed: boolean;
}

/**
 * A `.scs` opened for reading.
 *
 * Reading back what we wrote is what makes verification possible: a mod is
 * only correct if every TOBJ and every `paint_job_mask` resolves to a file
 * that is really in the archive, and that is a property of the archive, not of
 * the build that produced it.
 *
 * The central directory is parsed once on construction; the archive itself
 * stays as one buffer and entries are sliced out of it on demand.
 */
export class ScsArchive {
  private readonly index = new Map<string, { entry: ArchiveEntry; localOffset: number }>();

  constructor(private readonly data: Buffer) {
    const eocd = findEocd(data);
    const count = data.readUInt16LE(eocd + 10);
    let offset = data.readUInt32LE(eocd + 16);

    for (let i = 0; i < count; i += 1) {
      if (offset + 46 > data.length || data.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
        throw new Error("corrupt .scs: bad central directory entry");
      }
      const method = data.readUInt16LE(offset + 10);
      const uncompressed = data.readUInt32LE(offset + 24);
      const nameLength = data.readUInt16LE(offset + 28);
      const extraLength = data.readUInt16LE(offset + 30);
      const commentLength = data.readUInt16LE(offset + 32);
      const localOffset = data.readUInt32LE(offset + 42);
      const path = data.toString("utf8", offset + 46, offset + 46 + nameLength);
      this.index.set(path.toLowerCase(), {
        entry: { path, bytes: uncompressed, compressed: method !== 0 },
        localOffset,
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  entries(): ArchiveEntry[] {
    return [...this.index.values()].map((value) => value.entry).sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  has(path: string): boolean {
    return this.index.has(normaliseArchivePath(path).toLowerCase());
  }

  /** Read one entry's bytes. */
  read(path: string): Buffer {
    const found = this.index.get(normaliseArchivePath(path).toLowerCase());
    if (!found) throw new Error(`no such entry in archive: ${path}`);
    const { localOffset } = found;

    if (this.data.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error("corrupt .scs: bad local file header");
    }
    const method = this.data.readUInt16LE(localOffset + 8);
    const compressedSize = this.data.readUInt32LE(localOffset + 18);
    const uncompressedSize = this.data.readUInt32LE(localOffset + 22);
    const nameLength = this.data.readUInt16LE(localOffset + 26);
    const extraLength = this.data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + nameLength + extraLength;
    const raw = this.data.subarray(start, start + compressedSize);

    if (method === 0) return Buffer.from(raw);
    if (method === 8) {
      const inflated = inflateRawSync(raw);
      if (inflated.length !== uncompressedSize) {
        throw new Error(`corrupt .scs: ${path} inflated to the wrong size`);
      }
      return inflated;
    }
    throw new Error(`unsupported zip compression method ${method} for ${path}`);
  }
}

function findEocd(data: Buffer): number {
  if (data.length < 22) throw new Error("not a .scs archive: too short");
  // The end-of-central-directory record sits in the last 64 KiB, after an
  // optional comment of up to 65535 bytes.
  const start = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= start; i -= 1) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("not a .scs archive: no zip end-of-central-directory record");
}
