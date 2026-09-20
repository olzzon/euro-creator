/**
 * Runtime configuration.
 *
 * Defaults target the intended deployment: the service and Blender on one Mac
 * mini, reachable from the LAN. Every value is overridable by environment
 * variable so the same build runs on a laptop or behind a reverse proxy.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  readonly host: string;
  readonly port: number;
  /** Where uploads, vehicles, projects and builds are kept. */
  readonly workspace: string;
  /** Explicit Blender path; otherwise the usual locations are searched. */
  readonly blenderPath: string | null;
  /** Largest accepted upload. .blend files for a detailed truck get big. */
  readonly maxUploadBytes: number;
  /** Builds and Blender runs kept before the oldest are pruned. */
  readonly keepBuilds: number;
  readonly blenderTimeoutMs: number;
  /** Serve the built React app from the API process. */
  readonly serveWeb: boolean;
  readonly logLevel: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    // 0.0.0.0 by default: the point of putting this on a Mac mini is reaching
    // it from the machine you actually paint on.
    host: process.env.EC_HOST ?? "0.0.0.0",
    port: envInt("EC_PORT", 5174),
    workspace: resolve(process.env.EC_WORKSPACE ?? `${homedir()}/euro-creator`),
    blenderPath: process.env.EC_BLENDER ?? null,
    maxUploadBytes: envInt("EC_MAX_UPLOAD_MB", 1024) * 1024 * 1024,
    keepBuilds: envInt("EC_KEEP_BUILDS", 50),
    blenderTimeoutMs: envInt("EC_BLENDER_TIMEOUT_S", 600) * 1000,
    serveWeb: process.env.EC_SERVE_WEB !== "0",
    logLevel: process.env.EC_LOG_LEVEL ?? "info",
    ...overrides,
  };
}
