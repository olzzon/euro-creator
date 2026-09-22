/**
 * Driving Blender headlessly.
 *
 * Everything that reads a `.blend` runs inside Blender as a subprocess; there
 * is no way to get mesh and UV data out of one without it. The helper script
 * talks back over a JSON payload printed between markers, because Blender
 * writes plenty of unrelated chatter to stdout.
 *
 * Deployment assumption: Blender is installed on the same machine as this
 * service (a Mac mini), so this spawns it directly rather than reaching for a
 * container.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { BlenderError } from "@euro-creator/core";

const RESULT_BEGIN = "<<<EURO_CREATOR_JSON>>>";
const RESULT_END = "<<<END_EURO_CREATOR_JSON>>>";

/**
 * SCS Blender Tools' last officially supported Blender. 4.x removed the `bgl`
 * module the addon still imports, so a newer Blender cannot load it at all.
 */
export const SUPPORTED_BLENDER = [3, 6] as const;

export const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "blender");

const CANDIDATES = [
  "/Applications/Blender 3.6/Blender.app/Contents/MacOS/Blender",
  "/Applications/Blender3.6/Blender.app/Contents/MacOS/Blender",
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "/Applications/Blender/Blender.app/Contents/MacOS/Blender",
  "/usr/local/bin/blender",
  "/opt/homebrew/bin/blender",
  "/usr/bin/blender",
  "/snap/bin/blender",
  "C:\\Program Files\\Blender Foundation\\Blender 3.6\\blender.exe",
];

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const MACOS_HINT =
  "on macOS the executable is inside the .app, e.g. " +
  "'/Applications/Blender 3.6/Blender.app/Contents/MacOS/Blender'";

export async function findBlender(explicit?: string | null): Promise<string> {
  // An explicitly configured path is never fallen back from. Quietly using a
  // different Blender than the one that was asked for is how you end up on
  // 4.x or 5.x, where SCS Blender Tools cannot load, without knowing why.
  const configured = explicit ?? process.env.EC_BLENDER ?? null;
  if (configured !== null && configured !== "") {
    if (await isExecutable(configured)) return configured;
    throw new BlenderError(
      `Blender was configured as '${configured}', but nothing executable is there. ` +
        `Fix the path or unset EC_BLENDER to search the usual locations -- ${MACOS_HINT}.`,
    );
  }

  for (const candidate of CANDIDATES) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new BlenderError(
    "Blender not found. Install Blender 3.6 LTS (the newest release SCS Blender Tools " +
      `supports) on this machine, then set EC_BLENDER to its executable -- ${MACOS_HINT}.`,
  );
}

export interface BlenderStatus {
  readonly available: boolean;
  readonly path: string | null;
  readonly version: readonly number[] | null;
  readonly supported: boolean;
  readonly message: string;
}

/**
 * Cached result of the last probe.
 *
 * Probing means spawning `blender --version`, and the UI asks for system
 * status on every page load. Blender does not appear or change version while
 * the service is running, so a short TTL turns a per-request subprocess into
 * one per minute. `checkBlender(path, { fresh: true })` forces a re-probe for
 * the case that matters: someone has just installed it.
 */
let cachedStatus: { key: string; at: number; status: BlenderStatus } | null = null;
const STATUS_TTL_MS = 60_000;

export async function checkBlender(
  explicit?: string | null,
  options: { fresh?: boolean } = {},
): Promise<BlenderStatus> {
  const key = explicit ?? "";
  if (!options.fresh && cachedStatus && cachedStatus.key === key) {
    if (Date.now() - cachedStatus.at < STATUS_TTL_MS) return cachedStatus.status;
  }
  const status = await probeBlender(explicit);
  cachedStatus = { key, at: Date.now(), status };
  return status;
}

async function probeBlender(explicit?: string | null): Promise<BlenderStatus> {
  let path: string;
  try {
    path = await findBlender(explicit);
  } catch (error) {
    return {
      available: false,
      path: null,
      version: null,
      supported: false,
      message: (error as Error).message,
    };
  }

  const version = await blenderVersion(path);
  const supported = version !== null && version[0] === SUPPORTED_BLENDER[0] && version[1] === SUPPORTED_BLENDER[1];
  let message = `Blender ${version?.join(".") ?? "(unknown version)"}`;
  if (version && !supported) {
    message +=
      version[0]! > SUPPORTED_BLENDER[0]
        ? ` -- SCS Blender Tools only supports ${SUPPORTED_BLENDER.join(".")}. ` +
          `Reading a .blend will fall back to its raw SCS properties, which works but ` +
          `misses anything the addon computes. Install 3.6 LTS alongside and point EC_BLENDER at it.`
        : ` -- older than the ${SUPPORTED_BLENDER.join(".")} SCS Blender Tools targets.`;
  }
  return { available: true, path, version, supported, message };
}

/**
 * Probing the version means a cold Blender start, which on a machine that is
 * also building a mod can take far longer than it does idle. Generous, because
 * the cost of being wrong is silently reporting "unknown version".
 */
const VERSION_PROBE_TIMEOUT_MS = 120_000;

export async function blenderVersion(path: string): Promise<number[] | null> {
  try {
    const { stdout } = await run(path, ["--version"], VERSION_PROBE_TIMEOUT_MS);
    const match = /Blender\s+(\d+)\.(\d+)/.exec(stdout);
    return match ? [Number(match[1]), Number(match[2])] : null;
  } catch {
    return null;
  }
}

export interface RunScriptOptions {
  blendFile?: string;
  scriptArgs?: readonly string[];
  blenderPath?: string | null;
  timeoutMs?: number;
  onOutput?: (line: string) => void;
}

/** Run a helper script in background Blender and return its JSON payload. */
export async function runBlenderScript<T = Record<string, unknown>>(
  script: string,
  options: RunScriptOptions = {},
): Promise<T> {
  const executable = await findBlender(options.blenderPath);
  const scriptPath = join(SCRIPTS_DIR, script);

  const args = [
    "--background",
    // Keep the operator's startup file out of the way, then re-enable just the
    // addon we need. If it is missing, Blender warns and carries on, and the
    // helper falls back to the raw ID properties stored in the .blend.
    "--factory-startup",
    "--addons",
    "io_scs_tools",
    // A .blend can carry Python in drivers and handlers. Nothing here needs it
    // to run, and this service accepts uploaded files.
    "--disable-autoexec",
  ];
  if (options.blendFile) args.push(options.blendFile);
  args.push("--python", scriptPath, "--", ...(options.scriptArgs ?? []));

  const { stdout, stderr, code } = await run(
    executable,
    args,
    options.timeoutMs ?? 600_000,
    options.onOutput,
  );

  const payload = extractPayload<T & { error?: string }>(stdout);
  if (payload === null) {
    const version = await blenderVersion(executable);
    const hint =
      version && version[0]! > SUPPORTED_BLENDER[0]
        ? `\nThis is Blender ${version.join(".")}. SCS Blender Tools only supports ` +
          `${SUPPORTED_BLENDER.join(".")}; install 3.6 LTS and set EC_BLENDER to it.`
        : "";
    throw new BlenderError(
      `Blender produced no result (exit code ${code}).${hint}\n` +
        `--- stderr ---\n${stderr.trim().slice(-2000)}`,
    );
  }
  if (payload.error) throw new BlenderError(payload.error);
  return payload;
}

function extractPayload<T>(stdout: string): T | null {
  const start = stdout.lastIndexOf(RESULT_BEGIN);
  if (start === -1) return null;
  const end = stdout.indexOf(RESULT_END, start);
  if (end === -1) return null;
  try {
    return JSON.parse(stdout.slice(start + RESULT_BEGIN.length, end).trim()) as T;
  } catch {
    return null;
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  onOutput?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new BlenderError(
          `Blender did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped. ` +
            `Raise EC_BLENDER_TIMEOUT_S if this truck is genuinely that large.`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (onOutput) for (const line of text.split("\n")) if (line.trim()) onOutput(line.trim());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BlenderError(`could not run Blender at ${executable}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
