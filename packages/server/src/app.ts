/**
 * HTTP API.
 *
 * Routes stay thin: parse, call a Workspace method, serialise. Anything that
 * takes longer than a request goes through the job queue and is watched over
 * `GET /api/jobs/:id/events`.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import { EuroCreatorError, projectSchema, vehicleSchema } from "@euro-creator/core";
import { z } from "zod";

import { checkBlender } from "./blender.js";
import type { Config } from "./config.js";
import type { JobQueue } from "./jobs.js";
import type { Workspace } from "./workspace.js";

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

export async function createApp(workspace: Workspace, config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // A 4096x4096 PNG mask is routinely 30-60 MB.
    bodyLimit: config.maxUploadBytes,
  });

  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 8 },
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof EuroCreatorError) {
      return reply.status(error.status).send({ error: error.name, message: error.message });
    }
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]!;
      return reply.status(400).send({
        error: "ValidationError",
        message: `${issue.path.join(".") || "body"} ${issue.message}`,
        issues: error.issues,
      });
    }
    app.log.error(error);
    const status = error.statusCode ?? 500;
    return reply.status(status).send({
      error: status >= 500 ? "InternalError" : "BadRequest",
      // Never leak an internal message; a 4xx from Fastify is safe to show.
      message: status >= 500 ? "internal error" : error.message,
    });
  });

  registerSystemRoutes(app, workspace, config);
  registerUploadRoutes(app, workspace);
  registerVehicleRoutes(app, workspace);
  registerProjectRoutes(app, workspace);
  registerBuildRoutes(app, workspace);
  registerJobRoutes(app, workspace.queue);

  if (config.serveWeb) {
    try {
      await app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
      // Client-side routing: anything that is not an API call falls through to
      // the app shell.
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/")) {
          return reply.status(404).send({ error: "NotFound", message: `no route ${request.url}` });
        }
        return reply.sendFile("index.html");
      });
    } catch {
      app.log.warn(`web UI not built (${WEB_DIST}); serving the API only`);
    }
  }

  return app;
}

// --------------------------------------------------------------------------
// system
// --------------------------------------------------------------------------

function registerSystemRoutes(app: FastifyInstance, workspace: Workspace, config: Config): void {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/system", async () => {
    const blender = await checkBlender(config.blenderPath);
    return {
      workspace: config.workspace,
      keepBuilds: config.keepBuilds,
      maxUploadBytes: config.maxUploadBytes,
      blender,
      // The one thing a user cannot see from the browser but needs to know.
      modFolderHint: modFolderHint(),
      counts: {
        vehicles: (await workspace.listVehicles()).length,
        projects: (await workspace.listProjects()).length,
        builds: (await workspace.listBuilds()).length,
      },
    };
  });
}

function modFolderHint(): string {
  if (process.platform === "darwin") return "~/Library/Application Support/Euro Truck Simulator 2/mod/";
  if (process.platform === "win32") return "Documents\\Euro Truck Simulator 2\\mod\\";
  return "~/.local/share/Euro Truck Simulator 2/mod/";
}

// --------------------------------------------------------------------------
// uploads
// --------------------------------------------------------------------------

function registerUploadRoutes(app: FastifyInstance, workspace: Workspace): void {
  app.post("/api/uploads", async (request) => {
    const files = request.files();
    const saved = [];
    for await (const part of files) {
      saved.push(await workspace.saveUpload(part.filename, await part.toBuffer()));
    }
    if (saved.length === 0) {
      return { uploads: [], message: "no files in the request" };
    }
    return { uploads: saved };
  });

  app.get("/api/uploads", async () => ({ uploads: await workspace.listUploads() }));

  app.get<{ Params: { id: string } }>("/api/uploads/:id", async (request) => {
    return workspace.getUploadRecord(request.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { size?: string } }>(
    "/api/uploads/:id/preview.png",
    async (request, reply) => {
      const size = clampSize(request.query.size);
      const png = await workspace.uploadPreview(request.params.id, size);
      return sendImage(reply, png);
    },
  );
}

// --------------------------------------------------------------------------
// vehicles
// --------------------------------------------------------------------------

function registerVehicleRoutes(app: FastifyInstance, workspace: Workspace): void {
  app.get("/api/vehicles", async () => ({ vehicles: await workspace.listVehicles() }));

  app.get<{ Params: { id: string } }>("/api/vehicles/:id", async (request) =>
    workspace.getVehicle(request.params.id),
  );

  app.post("/api/vehicles", async (request, reply) => {
    const body = z.object({ vehicle: vehicleSchema }).parse(request.body);
    reply.status(201);
    return workspace.createVehicle(body.vehicle);
  });

  app.put<{ Params: { id: string } }>("/api/vehicles/:id", async (request) => {
    const body = z.object({ vehicle: vehicleSchema }).parse(request.body);
    return workspace.updateVehicle(request.params.id, body.vehicle);
  });

  app.delete<{ Params: { id: string } }>("/api/vehicles/:id", async (request, reply) => {
    await workspace.deleteVehicle(request.params.id);
    return reply.status(204).send();
  });

  /** Import a .blend that was already uploaded: drafts a vehicle and a template. */
  app.post("/api/vehicles/from-blend", async (request, reply) => {
    const body = z
      .object({
        uploadId: z.string().min(1),
        size: z.number().int().min(256).max(8192).default(4096),
        root: z.string().optional(),
      })
      .parse(request.body);
    const job = workspace.startBlendImport(body.uploadId, {
      size: body.size,
      ...(body.root ? { root: body.root } : {}),
    });
    reply.status(202);
    return { job };
  });

  app.get<{ Params: { id: string } }>("/api/vehicles/:id/template.png", async (request, reply) =>
    sendImage(reply, await workspace.vehicleTemplate(request.params.id, "paint_template.png")),
  );

  app.get<{ Params: { id: string; part: string } }>(
    "/api/vehicles/:id/template/:part.png",
    async (request, reply) =>
      sendImage(reply, await workspace.vehiclePartTemplate(request.params.id, request.params.part)),
  );
}

// --------------------------------------------------------------------------
// projects
// --------------------------------------------------------------------------

function registerProjectRoutes(app: FastifyInstance, workspace: Workspace): void {
  const bodySchema = z.object({ project: projectSchema, vehicleId: z.string().optional() });

  app.get("/api/projects", async () => ({ projects: await workspace.listProjects() }));

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) =>
    workspace.getProject(request.params.id),
  );

  app.post("/api/projects", async (request, reply) => {
    const body = bodySchema.parse(request.body);
    reply.status(201);
    return workspace.createProject(body.project, body.vehicleId);
  });

  app.put<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    const body = bodySchema.parse(request.body);
    return workspace.updateProject(request.params.id, body.project, body.vehicleId);
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    await workspace.deleteProject(request.params.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/build", async (request, reply) => {
    const body = z
      .object({ resizeMismatched: z.boolean().default(false) })
      .parse(request.body ?? {});
    const job = workspace.startBuild(request.params.id, {
      resizeMismatched: body.resizeMismatched,
    });
    reply.status(202);
    return { job };
  });
}

// --------------------------------------------------------------------------
// builds
// --------------------------------------------------------------------------

function registerBuildRoutes(app: FastifyInstance, workspace: Workspace): void {
  app.get("/api/builds", async () => ({ builds: await workspace.listBuilds() }));

  app.get<{ Params: { id: string } }>("/api/builds/:id", async (request) =>
    workspace.getBuild(request.params.id),
  );

  app.get<{ Params: { id: string } }>("/api/builds/:id/mod.scs", async (request, reply) => {
    const build = await workspace.getBuild(request.params.id);
    const archive = await workspace.getBuildArchive(request.params.id);
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${build.archiveName}"`)
      .send(archive);
  });

  /** One file out of the archive, for inspecting generated SII by eye. */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/builds/:id/file",
    async (request, reply) => {
      const path = z.string().min(1).parse(request.query.path);
      const data = await workspace.getBuildFile(request.params.id, path);
      const isText = /\.(sii|sui|mat|txt)$/i.test(path);
      return reply
        .header("content-type", isText ? "text/plain; charset=utf-8" : "application/octet-stream")
        .send(data);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string; size?: string } }>(
    "/api/builds/:id/preview.png",
    async (request, reply) => {
      const path = z.string().min(1).parse(request.query.path);
      const png = await workspace.buildMaskPreview(request.params.id, path, clampSize(request.query.size));
      return sendImage(reply, png);
    },
  );
}

// --------------------------------------------------------------------------
// jobs
// --------------------------------------------------------------------------

function registerJobRoutes(app: FastifyInstance, queue: JobQueue): void {
  app.get<{ Querystring: { kind?: string } }>("/api/jobs", async (request) => ({
    jobs: queue.list(request.query.kind),
  }));

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = queue.get(request.params.id);
    if (!job) return reply.status(404).send({ error: "NotFound", message: `no job ${request.params.id}` });
    return job;
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request) => ({
    cancelled: queue.cancel(request.params.id),
  }));

  /**
   * Server-sent events for one job.
   *
   * SSE rather than websockets: the traffic is one-way, it survives a proxy
   * that does not know about upgrades, and the browser reconnects on its own.
   */
  app.get<{ Params: { id: string } }>("/api/jobs/:id/events", (request, reply) => {
    const job = queue.get(request.params.id);
    if (!job) {
      void reply.status(404).send({ error: "NotFound", message: `no job ${request.params.id}` });
      return;
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Without this, a proxy in front of the Mac mini may buffer the stream
      // and the UI shows nothing until the job finishes.
      "x-accel-buffering": "no",
    });

    const send = (payload: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send(job);

    const onUpdate = (updated: typeof job): void => {
      send(updated);
      if (updated.state !== "queued" && updated.state !== "running") {
        reply.raw.write("event: done\ndata: {}\n\n");
        reply.raw.end();
      }
    };

    queue.events.on(`update:${job.id}`, onUpdate);
    // Idle comment frames keep intermediaries from closing a quiet stream.
    const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);

    const cleanup = (): void => {
      clearInterval(keepAlive);
      queue.events.off(`update:${job.id}`, onUpdate);
    };
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);

    if (job.state !== "queued" && job.state !== "running") {
      reply.raw.write("event: done\ndata: {}\n\n");
      reply.raw.end();
    }
  });
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function clampSize(raw: string | undefined): number {
  const value = raw === undefined ? 1024 : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return 1024;
  return Math.min(4096, Math.max(64, value));
}

function sendImage(reply: FastifyReply, png: Buffer): FastifyReply {
  return reply
    .header("content-type", "image/png")
    // Previews are derived from immutable stored bytes, so they can be cached
    // hard; the URL changes when the underlying record does.
    .header("cache-control", "private, max-age=3600")
    .send(png);
}
