import { makeAutoObservable, runInAction, toJS } from "mobx";

import {
  api,
  type BuildRecord,
  type Job,
  type ProjectInput,
  type ProjectRecord,
  type VehicleInput,
} from "../api";
import type { RootStore } from "./RootStore";

export function emptyProject(vehicle: VehicleInput): ProjectInput {
  return {
    mod: { name: "", author: "", version: "1.0", description: "" },
    skin: { name: "", price: 12000, unlock: 0, airbrush: true },
    vehicle,
    textures: { main: null, cabins: {}, accessories: {} },
    output: { dds_format: "dxt5", mipmaps: true, compress: false },
  };
}

/**
 * Skins, and the builds they produce.
 *
 * The vehicle is copied into the project rather than referenced, so editing a
 * truck later cannot silently change what an old skin builds into.
 */
export class ProjectStore {
  byId = new Map<string, ProjectRecord>();
  builds: BuildRecord[] = [];
  selectedId: string | null = null;
  draft: ProjectInput | null = null;
  draftVehicleId: string | null = null;
  saving = false;
  buildJobId: string | null = null;
  lastBuild: BuildRecord | null = null;
  resizeMismatched = false;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get all(): ProjectRecord[] {
    return [...this.byId.values()].sort((a, b) => (a.updated < b.updated ? 1 : -1));
  }

  get selected(): ProjectRecord | undefined {
    return this.selectedId ? this.byId.get(this.selectedId) : undefined;
  }

  get buildJob(): Job | undefined {
    return this.root.jobs.get(this.buildJobId);
  }

  get building(): boolean {
    const job = this.buildJob;
    return job?.state === "queued" || job?.state === "running";
  }

  get dirty(): boolean {
    if (!this.draft) return false;
    return JSON.stringify(this.selected?.project ?? {}) !== JSON.stringify(toJS(this.draft));
  }

  /** Builds of the currently selected project, newest first. */
  get selectedBuilds(): BuildRecord[] {
    return this.builds.filter((build) => build.projectId === this.selectedId);
  }

  async load(): Promise<void> {
    const [projects, builds] = await Promise.all([
      this.root.guard(() => api.listProjects()),
      this.root.guard(() => api.listBuilds()),
    ]);
    runInAction(() => {
      if (projects) {
        this.byId.clear();
        for (const project of projects.projects) this.byId.set(project.id, project);
      }
      if (builds) this.builds = builds.builds;
    });
  }

  select(id: string | null): void {
    this.selectedId = id;
    const record = id ? this.byId.get(id) : undefined;
    this.draft = record ? structuredClone(toJS(record.project)) : null;
    this.draftVehicleId = record?.vehicleId ?? null;
    this.lastBuild = this.builds.find((build) => build.projectId === id) ?? null;
    this.buildJobId = null;
  }

  startNew(vehicleId: string): void {
    const vehicle = this.root.vehicles.byId.get(vehicleId);
    if (!vehicle) return;
    this.selectedId = null;
    this.draft = emptyProject(structuredClone(toJS(vehicle.vehicle)));
    this.draftVehicleId = vehicleId;
    this.lastBuild = null;
    this.buildJobId = null;
  }

  editMod<K extends keyof ProjectInput["mod"]>(key: K, value: ProjectInput["mod"][K]): void {
    if (this.draft) this.draft.mod = { ...this.draft.mod, [key]: value };
  }

  editSkin<K extends keyof ProjectInput["skin"]>(key: K, value: ProjectInput["skin"][K]): void {
    if (this.draft) this.draft.skin = { ...this.draft.skin, [key]: value };
  }

  editOutput<K extends keyof NonNullable<ProjectInput["output"]>>(
    key: K,
    value: NonNullable<ProjectInput["output"]>[K],
  ): void {
    if (this.draft) this.draft.output = { ...this.draft.output, [key]: value };
  }

  setMainTexture(uploadId: string | null): void {
    if (this.draft) this.draft.textures = { ...this.draft.textures, main: uploadId };
  }

  setCabinTexture(key: string, uploadId: string | null): void {
    if (!this.draft) return;
    const cabins = { ...(this.draft.textures?.cabins ?? {}) };
    if (uploadId) cabins[key] = uploadId;
    else delete cabins[key];
    this.draft.textures = { ...this.draft.textures, cabins };
  }

  setAccessoryTexture(label: string, uploadId: string | null): void {
    if (!this.draft) return;
    const accessories = { ...(this.draft.textures?.accessories ?? {}) };
    if (uploadId) accessories[label] = uploadId;
    else delete accessories[label];
    this.draft.textures = { ...this.draft.textures, accessories };
  }

  /** Pull the newest definition of the truck this skin was made for. */
  refreshVehicle(): void {
    if (!this.draft || !this.draftVehicleId) return;
    const vehicle = this.root.vehicles.byId.get(this.draftVehicleId);
    if (!vehicle) return;
    this.draft.vehicle = structuredClone(toJS(vehicle.vehicle));
    this.root.notify("Updated this skin's copy of the truck definition");
  }

  async save(): Promise<ProjectRecord | undefined> {
    if (!this.draft) return undefined;
    this.saving = true;
    const payload = structuredClone(toJS(this.draft));
    const vehicleId = this.draftVehicleId ?? undefined;
    const saved = await this.root.guard(() =>
      this.selectedId
        ? api.updateProject(this.selectedId, payload, vehicleId)
        : api.createProject(payload, vehicleId),
    );
    runInAction(() => {
      this.saving = false;
      if (saved) {
        this.byId.set(saved.id, saved);
        this.selectedId = saved.id;
        this.draft = structuredClone(toJS(saved.project));
      }
    });
    return saved;
  }

  async remove(id: string): Promise<void> {
    const done = await this.root.guard(async () => {
      await api.deleteProject(id);
      return true;
    });
    if (!done) return;
    runInAction(() => {
      this.byId.delete(id);
      if (this.selectedId === id) this.select(null);
    });
  }

  /** Save any pending edits, then build. Building a stale draft is never what is wanted. */
  async build(): Promise<void> {
    const saved = this.dirty || !this.selectedId ? await this.save() : this.selected;
    if (!saved) return;

    const started = await this.root.guard(() => api.build(saved.id, this.resizeMismatched));
    if (!started) return;

    runInAction(() => {
      this.buildJobId = started.job.id;
    });
    this.root.jobs.watch(started.job, (job) => {
      if (job.state !== "succeeded") return;
      const build = job.result as BuildRecord;
      runInAction(() => {
        this.lastBuild = build;
        this.builds = [build, ...this.builds];
      });
      if (!build.verify.ok) {
        this.root.notify(`Built, but verification found ${build.verify.issues.length} problem(s)`, "error");
      }
    });
  }
}
