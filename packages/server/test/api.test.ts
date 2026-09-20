/**
 * Exercises the whole service the way the browser does: upload artwork,
 * define a vehicle, create a project, build, download, verify.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { createImage, encodePng, ScsArchive, verifyArchive } from "@euro-creator/core";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { JobQueue } from "../src/jobs.js";
import { FsStorage } from "../src/storage.js";
import { Workspace } from "../src/workspace.js";

const VEHICLE = {
  path: "olzzon.scania142",
  name: "Scania 142",
  author: "olzzon",
  mod: true,
  template_size: [64, 64] as [number, number],
  cabins: { a: { name: "Topline", units: ["topline"] } },
  accessories: { "Sun Visor": ["sunshld.stock"] },
};

let app: FastifyInstance;
let workspace: Workspace;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "euro-creator-test-"));
  const config = loadConfig({ workspace: root, serveWeb: false, logLevel: "silent" });
  const storage = new FsStorage(root);
  await storage.init();
  workspace = new Workspace(config, storage, new JobQueue());
  app = await createApp(workspace, config);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

/** Upload a PNG through the real multipart route. */
async function uploadPng(name: string, size = 64): Promise<string> {
  const png = await encodePng(createImage(size, size, [20, 60, 200, 255]));
  const boundary = "----ectest";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  const json = response.json();
  expect(json.uploads[0].image).toEqual({ width: size, height: size });
  return json.uploads[0].id as string;
}

/** Poll a job to completion; the queue is in-process so this is quick. */
async function awaitJob(jobId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}` })).json();
    if (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled") return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("job did not finish");
}

describe("API", () => {
  it("reports system state, including that Blender is optional", async () => {
    const system = (await app.inject({ method: "GET", url: "/api/system" })).json();
    expect(system.workspace).toBe(root);
    expect(system.blender).toHaveProperty("available");
    expect(system.modFolderHint).toMatch(/mod/);
  });

  it("runs the whole flow from upload to a verified .scs", async () => {
    const uploadId = await uploadPng("nordic_main.png");

    const vehicle = (
      await app.inject({ method: "POST", url: "/api/vehicles", payload: { vehicle: VEHICLE } })
    ).json();
    expect(vehicle.id).toBeTruthy();

    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          vehicleId: vehicle.id,
          project: {
            mod: { name: "Nordic Livery", author: "olzzon" },
            skin: { name: "Nordic", price: 12000 },
            vehicle: VEHICLE,
            textures: { main: uploadId },
          },
        },
      })
    ).json();
    expect(project.id).toBeTruthy();

    const started = await app.inject({ method: "POST", url: `/api/projects/${project.id}/build` });
    expect(started.statusCode).toBe(202);
    const job = await awaitJob(started.json().job.id);
    expect(job.state, JSON.stringify(job.error)).toBe("succeeded");

    const build = job.result as { id: string; verify: { ok: boolean }; archiveName: string };
    expect(build.verify.ok).toBe(true);
    expect(build.archiveName).toBe("olzzon_nordic_livery.scs");

    const download = await app.inject({ method: "GET", url: `/api/builds/${build.id}/mod.scs` });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("olzzon_nordic_livery.scs");

    // The bytes the browser gets must be a valid, self-consistent mod.
    const archive = new ScsArchive(download.rawPayload);
    expect(verifyArchive(archive).ok).toBe(true);
    expect(archive.has("manifest.sii")).toBe(true);
    expect(archive.has("def/vehicle/truck/olzzon.scania142/paint_job/nordic.sii")).toBe(true);
  });

  it("serves a readable SII and a decoded mask preview from a build", async () => {
    const build = (await app.inject({ method: "GET", url: "/api/builds" })).json().builds[0];

    const sii = await app.inject({
      method: "GET",
      url: `/api/builds/${build.id}/file?path=${encodeURIComponent("manifest.sii")}`,
    });
    expect(sii.headers["content-type"]).toContain("text/plain");
    expect(sii.body).toContain("mod_package");

    const maskPath = build.files.find((f: { path: string }) => f.path.endsWith(".dds")).path;
    const preview = await app.inject({
      method: "GET",
      url: `/api/builds/${build.id}/preview.png?path=${encodeURIComponent(maskPath)}&size=128`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toBe("image/png");
    // PNG magic: proves the DDS was really decoded, not echoed back.
    expect(preview.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("streams job progress over SSE", async () => {
    const uploadId = await uploadPng("second.png");
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          project: {
            mod: { name: "Second", author: "olzzon" },
            skin: { name: "Second" },
            vehicle: VEHICLE,
            textures: { main: uploadId },
          },
        },
      })
    ).json();
    const jobId = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/build` })).json()
      .job.id;
    await awaitJob(jobId);

    // A finished job still replays its state, so the UI can attach late.
    const events = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/events` });
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).toContain('"state":"succeeded"');
    expect(events.body).toContain("event: done");
  });

  it("reports a bad project as a 400 with the reason, not a stack trace", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        project: {
          mod: { name: "X", author: "y" },
          skin: { name: "X" },
          vehicle: VEHICLE,
          textures: { accessories: { "Chrome Stack": "nope" } },
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/Chrome Stack|textures.main/);
  });

  it("fails a build with a readable message when the mask is the wrong size", async () => {
    const uploadId = await uploadPng("wrong_size.png", 32);
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          project: {
            mod: { name: "Wrong", author: "olzzon" },
            skin: { name: "Wrong" },
            vehicle: VEHICLE,
            textures: { main: uploadId },
          },
        },
      })
    ).json();
    const jobId = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/build` })).json()
      .job.id;
    const job = await awaitJob(jobId);
    expect(job.state).toBe("failed");
    expect((job.error as { message: string }).message).toMatch(/template is 64x64/);
  });

  it("404s unknown ids rather than 500ing", async () => {
    for (const url of ["/api/vehicles/nope", "/api/projects/nope", "/api/builds/nope", "/api/uploads/nope"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
  });

  it("refuses a workspace key that tries to escape the storage root", async () => {
    const storage = new FsStorage(root);
    await expect(storage.get("../../etc/passwd")).rejects.toThrow(/escapes the workspace/);
  });
});
