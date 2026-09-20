/**
 * Workspace storage.
 *
 * An interface rather than direct `fs` calls so that moving to S3/R2 later is
 * a new implementation rather than a rewrite -- the reason the local-first
 * shape was chosen in the first place.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface StoredObject {
  readonly key: string;
  readonly bytes: number;
  readonly modified: Date;
}

export interface Storage {
  put(key: string, data: Buffer): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  has(key: string): Promise<boolean>;
  stat(key: string): Promise<StoredObject | null>;
  stream(key: string): Promise<ReadStream>;
  list(prefix: string): Promise<StoredObject[]>;
  /** Immediate subdirectory names under `prefix`. Records are one directory each. */
  listDirs(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
  putJson<T>(key: string, value: T): Promise<void>;
  getJson<T>(key: string): Promise<T>;
}

export class FsStorage implements Storage {
  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /**
   * Map a key to a path, refusing anything that would escape the workspace.
   * Keys come from URLs, so this is the boundary that matters.
   */
  private pathFor(key: string): string {
    if (key.includes("\0")) throw new Error("invalid key");
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`key escapes the workspace: ${key}`);
    }
    return target;
  }

  async put(key: string, data: Buffer): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return { key, bytes: data.length, modified: new Date() };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async has(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<StoredObject | null> {
    try {
      const info = await stat(this.pathFor(key));
      if (!info.isFile()) return null;
      return { key, bytes: info.size, modified: info.mtime };
    } catch {
      return null;
    }
  }

  async stream(key: string): Promise<ReadStream> {
    const path = this.pathFor(key);
    await stat(path);
    return createReadStream(path);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const dir = this.pathFor(prefix);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: StoredObject[] = [];
    for (const entry of entries) {
      const info = await this.stat(join(prefix, entry));
      if (info) out.push(info);
    }
    return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  async listDirs(prefix: string): Promise<string[]> {
    try {
      const entries = await readdir(this.pathFor(prefix), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { recursive: true, force: true });
  }

  async putJson<T>(key: string, value: T): Promise<void> {
    await this.put(key, Buffer.from(JSON.stringify(value, null, 2), "utf8"));
  }

  async getJson<T>(key: string): Promise<T> {
    return JSON.parse((await this.get(key)).toString("utf8")) as T;
  }
}

export function newId(): string {
  return randomUUID();
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
