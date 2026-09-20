/**
 * Checking a built mod before it reaches the game.
 *
 * Every problem found here is one that would otherwise appear as a line in
 * `game.log.txt` -- or worse, as a paint job that loads but renders
 * untextured, which logs nothing obvious at all.
 */

import { ScsArchive, type ModFile } from "./archive.js";
import { readTobjPath } from "./tobj.js";

export type IssueSeverity = "error" | "warning";

export interface VerifyIssue {
  readonly severity: IssueSeverity;
  /** The archive entry the problem is in. */
  readonly path: string;
  readonly message: string;
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly issues: readonly VerifyIssue[];
  readonly checked: {
    readonly files: number;
    readonly tobjs: number;
    readonly maskReferences: number;
  };
}

/** Verify an in-memory mod tree. */
export function verifyFiles(files: readonly ModFile[]): VerifyReport {
  const byPath = new Map(files.map((file) => [`/${file.path}`.toLowerCase(), file]));
  return verify(
    files.map((file) => file.path),
    (path) => byPath.get(`/${path}`.toLowerCase())?.data,
  );
}

/** Verify a packed `.scs`, which is what the game will actually read. */
export function verifyArchive(archive: Buffer | ScsArchive): VerifyReport {
  const scs = archive instanceof ScsArchive ? archive : new ScsArchive(archive);
  return verify(
    scs.entries().map((entry) => entry.path),
    (path) => {
      try {
        return scs.read(path);
      } catch {
        return undefined;
      }
    },
  );
}

function verify(paths: readonly string[], read: (path: string) => Buffer | undefined): VerifyReport {
  const present = new Set(paths.map((path) => `/${path}`.toLowerCase()));
  const issues: VerifyIssue[] = [];
  let tobjs = 0;
  let maskReferences = 0;

  const requireTarget = (from: string, target: string, kind: string): void => {
    if (!present.has(target.toLowerCase())) {
      issues.push({
        severity: "error",
        path: from,
        message: `${kind} points at ${target}, which is not in the archive`,
      });
    }
  };

  for (const path of paths) {
    if (path.toLowerCase().endsWith(".tobj")) {
      tobjs += 1;
      const data = read(path);
      if (!data) {
        issues.push({ severity: "error", path, message: "could not be read back" });
        continue;
      }
      try {
        requireTarget(path, readTobjPath(data), "TOBJ");
      } catch (error) {
        issues.push({ severity: "error", path, message: (error as Error).message });
      }
    } else if (path.toLowerCase().endsWith(".sii")) {
      const data = read(path);
      if (!data) continue;
      for (const line of data.toString("utf8").split("\n")) {
        const match = /\b(paint_job_mask|icon)\s*:\s*"([^"]+)"/.exec(line);
        if (!match) continue;
        if (match[1] === "paint_job_mask") {
          maskReferences += 1;
          requireTarget(path, match[2]!, "paint_job_mask");
        }
      }
    }
  }

  if (!present.has("/manifest.sii")) {
    issues.push({
      severity: "error",
      path: "manifest.sii",
      message: "missing -- the mod manager will not list this mod at all",
    });
  }
  if (tobjs === 0) {
    issues.push({ severity: "warning", path: "", message: "no TOBJ files: this mod has no textures" });
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
    checked: { files: paths.length, tobjs, maskReferences },
  };
}
