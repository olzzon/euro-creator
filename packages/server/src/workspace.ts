/**
 * The application's domain services.
 *
 * Everything the HTTP layer does goes through here, so the routes stay thin
 * and the same operations are reachable from a CLI or a test without a server.
 */

import { basename } from "node:path";

import {
  buildMod,
  decodeImage,
  decodeUvDump,
  encodeDds,
  encodePng,
  packScs,
  parseProject,
  renderTemplate,
  resample,
  ScsArchive,
  TextureError,
  NotFoundError,
  Vehicle,
  verifyArchive,
  type ModFile,
  type ProjectInput,
  type VehicleInput,
} from "@euro-creator/core";

import { runBlenderScript } from "./blender.js";
import type { Config } from "./config.js";
import { JobQueue, type Job, type JobContext } from "./jobs.js";
import type { BlendRoot, BuildRecord, ProjectRecord, UploadRecord, VehicleRecord } from "./records.js";
import { FsStorage, newId, sha256 } from "./storage.js";

const MAX_PREVIEW = 1024;

export class Workspace {
  constructor(
    readonly config: Config,
    readonly storage: FsStorage,
    readonly queue: JobQueue,
  ) {}

  // ---------------------------------------------------------------- uploads

  async saveUpload(filename: string, data: Buffer): Promise<UploadRecord> {
    const id = newId();
    const safeName = basename(filename).slice(0, 200) || "upload";
    const kind = safeName.toLowerCase().endsWith(".blend")
      ? "blend"
      : await isImage(data, safeName)
        ? "image"
        : "other";

    let image: UploadRecord["image"];
    if (kind === "image") {
      const decoded = await decodeImage(data, safeName);
      image = { width: decoded.width, height: decoded.height };
    }

    const record: UploadRecord = {
      id,
      filename: safeName,
      bytes: data.length,
      sha256: sha256(data),
      uploaded: new Date().toISOString(),
      kind,
      ...(image ? { image } : {}),
    };
    await this.storage.put(`uploads/${id}/data`, data);
    await this.storage.putJson(`uploads/${id}/meta.json`, record);
    return record;
  }

  async getUploadRecord(id: string): Promise<UploadRecord> {
    try {
      return await this.storage.getJson<UploadRecord>(`uploads/${id}/meta.json`);
    } catch {
      throw new NotFoundError(`no upload ${id}`);
    }
  }

  async getUploadData(id: string): Promise<Buffer> {
    await this.getUploadRecord(id);
    return this.storage.get(`uploads/${id}/data`);
  }

  async listUploads(): Promise<UploadRecord[]> {
    return this.loadAll<UploadRecord>("uploads", "meta.json");
  }

  /**
   * A downscaled PNG of an uploaded image.
   *
   * A 4096x4096 mask is tens of megabytes; the browser only ever needs a
   * thumbnail, and sending the original would make the UI unusable over a LAN.
   */
  async uploadPreview(id: string, maxSize = MAX_PREVIEW): Promise<Buffer> {
    const record = await this.getUploadRecord(id);
    if (record.kind !== "image") throw new TextureError(`upload ${id} is not an image`);
    const image = await decodeImage(await this.getUploadData(id), record.filename);
    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    const preview =
      scale < 1
        ? await resample(image, Math.round(image.width * scale), Math.round(image.height * scale))
        : image;
    return encodePng(preview);
  }

  // --------------------------------------------------------------- vehicles

  async listVehicles(): Promise<VehicleRecord[]> {
    return this.loadAll<VehicleRecord>("vehicles", "vehicle.json");
  }

  async getVehicle(id: string): Promise<VehicleRecord> {
    try {
      return await this.storage.getJson<VehicleRecord>(`vehicles/${id}/vehicle.json`);
    } catch {
      throw new NotFoundError(`no vehicle ${id}`);
    }
  }

  async createVehicle(input: VehicleInput): Promise<VehicleRecord> {
    Vehicle.parse(input); // reject an unusable definition before it is stored
    const now = new Date().toISOString();
    const record: VehicleRecord = { id: newId(), created: now, updated: now, vehicle: input };
    await this.storage.putJson(`vehicles/${record.id}/vehicle.json`, record);
    return record;
  }

  async updateVehicle(id: string, input: VehicleInput): Promise<VehicleRecord> {
    const existing = await this.getVehicle(id);
    Vehicle.parse(input);
    const record: VehicleRecord = { ...existing, vehicle: input, updated: new Date().toISOString() };
    await this.storage.putJson(`vehicles/${id}/vehicle.json`, record);
    return record;
  }

  async deleteVehicle(id: string): Promise<void> {
    await this.getVehicle(id);
    await this.storage.remove(`vehicles/${id}`);
  }

  async vehicleTemplate(id: string, file: "paint_template.png" | "legend.png"): Promise<Buffer> {
    const record = await this.getVehicle(id);
    if (!record.template) throw new NotFoundError(`vehicle ${id} has no rendered template`);
    return this.storage.get(`vehicles/${id}/${file}`);
  }

  /** Re-render the template for one part only, for the per-part sheets. */
  async vehiclePartTemplate(id: string, part: string): Promise<Buffer> {
    const record = await this.getVehicle(id);
    if (!record.template) throw new NotFoundError(`vehicle ${id} has no rendered template`);
    const dump = decodeUvDump(await this.storage.get(`vehicles/${id}/uv.bin`));
    if (!dump.groups.includes(part)) throw new NotFoundError(`vehicle ${id} has no part ${part}`);
    return encodePng(renderTemplate(dump, { size: record.template.size, onlyGroups: [part] }));
  }

  // ---------------------------------------------------------------- projects

  async listProjects(): Promise<ProjectRecord[]> {
    return this.loadAll<ProjectRecord>("projects", "project.json");
  }

  async getProject(id: string): Promise<ProjectRecord> {
    try {
      return await this.storage.getJson<ProjectRecord>(`projects/${id}/project.json`);
    } catch {
      throw new NotFoundError(`no project ${id}`);
    }
  }

  async createProject(input: ProjectInput, vehicleId?: string): Promise<ProjectRecord> {
    parseProject(input);
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id: newId(),
      created: now,
      updated: now,
      project: input,
      ...(vehicleId ? { vehicleId } : {}),
    };
    await this.storage.putJson(`projects/${record.id}/project.json`, record);
    return record;
  }

  async updateProject(id: string, input: ProjectInput, vehicleId?: string): Promise<ProjectRecord> {
    const existing = await this.getProject(id);
    parseProject(input);
    const record: ProjectRecord = {
      ...existing,
      project: input,
      updated: new Date().toISOString(),
      ...(vehicleId !== undefined ? { vehicleId } : {}),
    };
    await this.storage.putJson(`projects/${id}/project.json`, record);
    return record;
  }

  async deleteProject(id: string): Promise<void> {
    await this.getProject(id);
    await this.storage.remove(`projects/${id}`);
  }

  // ----------------------------------------------------------------- builds

  startBuild(projectId: string, options: { resizeMismatched?: boolean } = {}): Job {
    return this.queue.submit("build", async (context) => this.runBuild(projectId, options, context));
  }

  private async runBuild(
    projectId: string,
    options: { resizeMismatched?: boolean },
    context: JobContext,
  ): Promise<BuildRecord> {
    const record = await this.getProject(projectId);
    const project = parseProject(record.project, `project ${projectId}`);
    context.report(`building '${project.skin.name}' for ${project.vehicle.name}`, 0.05);

    const result = await buildMod(project, {
      resolveTexture: async (ref) => ({
        data: await this.getUploadData(ref),
        filename: (await this.getUploadRecord(ref)).filename,
      }),
      decodeImage,
      ...(options.resizeMismatched !== undefined
        ? { resizeMismatched: options.resizeMismatched }
        : {}),
      onProgress: (message) => context.report(message),
    });
    context.throwIfCancelled();

    context.report("packing .scs", 0.85);
    const archive = await packScs(result.files, { compress: project.output.compress });

    context.report("verifying cross-references", 0.95);
    const verify = verifyArchive(archive);

    const build: BuildRecord = {
      id: newId(),
      projectId,
      created: new Date().toISOString(),
      archiveName: result.archiveName,
      archiveBytes: archive.length,
      totalBytes: result.totalBytes,
      masks: result.masks,
      warnings: result.warnings,
      verify,
      files: result.files.map((file) => ({ path: file.path, bytes: file.data.length })),
    };

    await this.storage.put(`builds/${build.id}/mod.scs`, archive);
    await this.storage.putJson(`builds/${build.id}/build.json`, build);
    await this.pruneBuilds();

    context.report(
      verify.ok
        ? `done: ${result.archiveName} (${(archive.length / 1024 / 1024).toFixed(1)} MB)`
        : `done with ${verify.issues.length} issue(s) -- see the report`,
      1,
    );
    return build;
  }

  async getBuild(id: string): Promise<BuildRecord> {
    try {
      return await this.storage.getJson<BuildRecord>(`builds/${id}/build.json`);
    } catch {
      throw new NotFoundError(`no build ${id}`);
    }
  }

  async listBuilds(): Promise<BuildRecord[]> {
    return this.loadAll<BuildRecord>("builds", "build.json");
  }

  async getBuildArchive(id: string): Promise<Buffer> {
    await this.getBuild(id);
    return this.storage.get(`builds/${id}/mod.scs`);
  }

  /**
   * Decode one mask out of a finished build and return it as a PNG.
   *
   * This is the answer to "will compression ruin my gradient?" -- it shows
   * what the game will sample, not what the artist painted.
   */
  async buildMaskPreview(id: string, path: string, maxSize = MAX_PREVIEW): Promise<Buffer> {
    const archive = new ScsArchive(await this.getBuildArchive(id));
    if (!archive.has(path)) throw new NotFoundError(`build ${id} has no file ${path}`);
    if (!path.toLowerCase().endsWith(".dds")) throw new TextureError(`${path} is not a texture`);

    const { decodeDds } = await import("@euro-creator/core");
    const image = decodeDds(archive.read(path));
    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    const preview =
      scale < 1
        ? await resample(image, Math.round(image.width * scale), Math.round(image.height * scale))
        : image;
    return encodePng(preview);
  }

  async getBuildFile(id: string, path: string): Promise<Buffer> {
    const archive = new ScsArchive(await this.getBuildArchive(id));
    if (!archive.has(path)) throw new NotFoundError(`build ${id} has no file ${path}`);
    return archive.read(path);
  }

  private async pruneBuilds(): Promise<void> {
    const builds = await this.listBuilds();
    for (const build of builds.slice(this.config.keepBuilds)) {
      await this.storage.remove(`builds/${build.id}`);
    }
  }

  // ---------------------------------------------------------------- Blender

  /** Read an uploaded .blend, draft a vehicle from it, and render its template. */
  startBlendImport(uploadId: string, options: { size?: number; root?: string } = {}): Job {
    return this.queue.submit("blend-import", async (context) =>
      this.runBlendImport(uploadId, options, context),
    );
  }

  private async runBlendImport(
    uploadId: string,
    options: { size?: number; root?: string },
    context: JobContext,
  ): Promise<VehicleRecord> {
    const upload = await this.getUploadRecord(uploadId);
    if (upload.kind !== "blend") throw new TextureError(`upload ${uploadId} is not a .blend file`);
    const size = options.size ?? 4096;

    context.report(`opening ${upload.filename} in Blender`, 0.1);
    const blendPath = `${this.config.workspace}/uploads/${uploadId}/data`;
    const uvPath = `${this.config.workspace}/uploads/${uploadId}/uv.bin`;

    const payload = await runBlenderScript<{
      roots: BlendRoot[];
      scsTools: boolean;
      blenderVersion: number[];
      uvDump: { polygons: number; groups: string[] };
    }>("extract.py", {
      blendFile: blendPath,
      scriptArgs: ["--uv-out", uvPath, ...(options.root ? ["--root", options.root] : [])],
      blenderPath: this.config.blenderPath,
      timeoutMs: this.config.blenderTimeoutMs,
      onOutput: (line) => {
        // Blender is chatty; surface only the lines that mean something here.
        if (/error|warning|Traceback/i.test(line)) context.report(line);
      },
    });
    context.throwIfCancelled();

    const root = payload.roots[0];
    if (!root) throw new TextureError("Blender reported no SCS Root in this file");

    context.report(`rendering ${size}x${size} template from ${payload.uvDump.polygons} polygons`, 0.5);
    const dump = decodeUvDump(await this.storage.get(`uploads/${uploadId}/uv.bin`));
    const template = renderTemplate(dump, { size });
    context.throwIfCancelled();

    const draft: VehicleInput = {
      path: guessVehiclePath(root.name),
      name: root.name,
      game: "ets2",
      type: "truck",
      author: "you",
      mod: true,
      // Detected from the truckpaint shader flavour on the painted materials.
      alternate_uvset: root.altUvset,
      separate_paintjobs: false,
      template_size: [size, size],
      cabins: {},
      accessories: {},
      ...(root.paintMaterials[0]?.uvLayer ? { paint_uv_layer: root.paintMaterials[0].uvLayer } : {}),
    };

    const now = new Date().toISOString();
    const record: VehicleRecord = {
      id: newId(),
      created: now,
      updated: now,
      vehicle: draft,
      source: {
        blendUploadId: uploadId,
        blendFilename: upload.filename,
        roots: payload.roots,
        scsToolsLoaded: payload.scsTools,
        blenderVersion: payload.blenderVersion,
      },
      template: {
        size,
        polygons: payload.uvDump.polygons,
        groups: dump.groups,
        rendered: now,
      },
    };

    context.report("saving template", 0.9);
    await this.storage.put(`vehicles/${record.id}/paint_template.png`, await encodePng(template));
    await this.storage.put(`vehicles/${record.id}/uv.bin`, await this.storage.get(`uploads/${uploadId}/uv.bin`));
    await this.storage.putJson(`vehicles/${record.id}/vehicle.json`, record);
    context.report(`drafted '${root.name}' with ${dump.groups.length} part(s)`, 1);
    return record;
  }

  // ------------------------------------------------------------------ utils

  private async loadAll<T>(prefix: string, file: string): Promise<T[]> {
    const dirs = await this.storage.listDirs(prefix);
    const out: T[] = [];
    for (const dir of dirs) {
      try {
        out.push(await this.storage.getJson<T>(`${prefix}/${dir}/${file}`));
      } catch {
        // A half-written record should not break the whole listing.
      }
    }
    return out.sort((a, b) => ((a as { created?: string }).created! < (b as { created?: string }).created! ? 1 : -1));
  }
}

async function isImage(data: Buffer, filename: string): Promise<boolean> {
  try {
    await decodeImage(data, filename);
    return true;
  } catch {
    return false;
  }
}

/** `Scania 142 Torpedo` -> `scania.142.torpedo`, the shape SCS use for def paths. */
function guessVehiclePath(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
  return slug.length > 0 ? slug.join(".") : "my.truck";
}

/** Expose the mask preview helper's build result shape for the routes. */
export type { ModFile };
