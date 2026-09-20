/**
 * Thin typed wrapper over the API.
 *
 * Errors come back from the server as `{ error, message }`; this turns them
 * into a thrown `ApiError` carrying the message the server wrote, because
 * those messages are the product -- they are what tells a skinner that their
 * mask is 2048 wide when the template is 4096.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let kind = "HttpError";
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      if (body.message) message = body.message;
      if (body.error) kind = body.error;
    } catch {
      /* not JSON; keep the status line */
    }
    throw new ApiError(message, response.status, kind);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  system: () => request<SystemInfo>("/api/system"),

  listUploads: () => request<{ uploads: UploadRecord[] }>("/api/uploads"),
  upload: (files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("file", file);
    return request<{ uploads: UploadRecord[] }>("/api/uploads", { method: "POST", body: form });
  },
  uploadPreviewUrl: (id: string, size = 512) => `/api/uploads/${id}/preview.png?size=${size}`,

  listVehicles: () => request<{ vehicles: VehicleRecord[] }>("/api/vehicles"),
  getVehicle: (id: string) => request<VehicleRecord>(`/api/vehicles/${id}`),
  createVehicle: (vehicle: VehicleInput) => request<VehicleRecord>("/api/vehicles", json({ vehicle })),
  updateVehicle: (id: string, vehicle: VehicleInput) =>
    request<VehicleRecord>(`/api/vehicles/${id}`, { method: "PUT", body: JSON.stringify({ vehicle }) }),
  deleteVehicle: (id: string) => request<void>(`/api/vehicles/${id}`, { method: "DELETE" }),
  importBlend: (uploadId: string, size: number) =>
    request<{ job: Job }>("/api/vehicles/from-blend", json({ uploadId, size })),
  templateUrl: (id: string) => `/api/vehicles/${id}/template.png`,
  partTemplateUrl: (id: string, part: string) =>
    `/api/vehicles/${id}/template/${encodeURIComponent(part)}.png`,

  listProjects: () => request<{ projects: ProjectRecord[] }>("/api/projects"),
  createProject: (project: ProjectInput, vehicleId?: string) =>
    request<ProjectRecord>("/api/projects", json({ project, vehicleId })),
  updateProject: (id: string, project: ProjectInput, vehicleId?: string) =>
    request<ProjectRecord>(`/api/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify({ project, vehicleId }),
    }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
  build: (id: string, resizeMismatched: boolean) =>
    request<{ job: Job }>(`/api/projects/${id}/build`, json({ resizeMismatched })),

  listBuilds: () => request<{ builds: BuildRecord[] }>("/api/builds"),
  getBuild: (id: string) => request<BuildRecord>(`/api/builds/${id}`),
  downloadUrl: (id: string) => `/api/builds/${id}/mod.scs`,
  fileUrl: (id: string, path: string) => `/api/builds/${id}/file?path=${encodeURIComponent(path)}`,
  maskPreviewUrl: (id: string, path: string, size = 512) =>
    `/api/builds/${id}/preview.png?path=${encodeURIComponent(path)}&size=${size}`,
  fileText: (id: string, path: string) =>
    fetch(`/api/builds/${id}/file?path=${encodeURIComponent(path)}`).then((r) => r.text()),

  getJob: (id: string) => request<Job>(`/api/jobs/${id}`),
  cancelJob: (id: string) => request<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: "POST" }),
};

// --------------------------------------------------------------------------
// shapes mirrored from the server
// --------------------------------------------------------------------------

export interface SystemInfo {
  workspace: string;
  modFolderHint: string;
  blender: { available: boolean; path: string | null; version: number[] | null; supported: boolean; message: string };
  counts: { vehicles: number; projects: number; builds: number };
}

export interface UploadRecord {
  id: string;
  filename: string;
  bytes: number;
  uploaded: string;
  kind: "image" | "blend" | "other";
  image?: { width: number; height: number };
}

export interface CabinInput {
  name?: string;
  units?: string[];
}

export interface VehicleInput {
  path: string;
  name: string;
  game?: string;
  type?: "truck" | "trailer_owned";
  author?: string;
  mod?: boolean;
  alternate_uvset?: boolean;
  separate_paintjobs?: boolean;
  template_size?: [number, number];
  paint_uv_layer?: string | null;
  cabins?: Record<string, CabinInput>;
  accessories?: Record<string, string[]>;
}

export interface BlendRoot {
  name: string;
  parts: string[];
  variants: { name: string; parts: string[] }[];
  paintMaterials: { name: string; effect: string; altUvset: boolean; uvLayer: string | null }[];
  paintObjects: { object: string; part: string; polygons: number }[];
  altUvset: boolean;
  mixedUvset: boolean;
}

export interface VehicleRecord {
  id: string;
  created: string;
  updated: string;
  vehicle: VehicleInput;
  source?: {
    blendUploadId: string;
    blendFilename: string;
    roots: BlendRoot[];
    scsToolsLoaded: boolean;
    blenderVersion: number[];
  };
  template?: { size: number; polygons: number; groups: string[]; rendered: string };
}

export interface ProjectInput {
  mod: { name: string; author: string; version?: string; description?: string; icon?: string | null };
  skin: {
    name: string;
    price?: number;
    unlock?: number;
    airbrush?: boolean;
    base_color?: [number, number, number] | null;
    icon?: string | null;
  };
  vehicle: VehicleInput;
  textures?: { main?: string | null; cabins?: Record<string, string>; accessories?: Record<string, string> };
  output?: { dds_format?: "dxt5" | "dxt1" | "raw"; mipmaps?: boolean; compress?: boolean };
}

export interface ProjectRecord {
  id: string;
  created: string;
  updated: string;
  project: ProjectInput;
  vehicleId?: string;
}

export interface VerifyIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface BuildRecord {
  id: string;
  projectId: string;
  created: string;
  archiveName: string;
  archiveBytes: number;
  totalBytes: number;
  masks: { name: string; tobjPath: string; bytes: number; source: "painted" | "placeholder" }[];
  warnings: string[];
  verify: { ok: boolean; issues: VerifyIssue[]; checked: { files: number; tobjs: number; maskReferences: number } };
  files: { path: string; bytes: number }[];
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job<T = unknown> {
  id: string;
  kind: string;
  state: JobState;
  created: string;
  progress: { at: string; message: string; fraction: number | null }[];
  result: T | null;
  error: { message: string; name: string } | null;
}

/** Watch a job over SSE, calling back on every state change. */
export function watchJob(id: string, onUpdate: (job: Job) => void): () => void {
  const source = new EventSource(`/api/jobs/${id}/events`);
  source.onmessage = (event) => onUpdate(JSON.parse(event.data) as Job);
  source.addEventListener("done", () => source.close());
  // A failed stream is not fatal: the caller can still poll.
  source.onerror = () => source.close();
  return () => source.close();
}
