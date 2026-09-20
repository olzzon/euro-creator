import { makeAutoObservable, runInAction, toJS } from "mobx";

import { api, type Job, type VehicleInput, type VehicleRecord } from "../api";
import type { RootStore } from "./RootStore";

export function emptyVehicle(): VehicleInput {
  return {
    path: "",
    name: "",
    game: "ets2",
    type: "truck",
    author: "you",
    mod: true,
    alternate_uvset: false,
    separate_paintjobs: false,
    template_size: [4096, 4096],
    cabins: {},
    accessories: {},
  };
}

/**
 * Trucks a skin can target.
 *
 * A vehicle is edited as a draft first and only sent on save, so a half-typed
 * accessory unit name never reaches the server's validator and never produces
 * an error the user did not ask for.
 */
export class VehicleStore {
  byId = new Map<string, VehicleRecord>();
  selectedId: string | null = null;
  draft: VehicleInput | null = null;
  saving = false;
  importJobId: string | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get all(): VehicleRecord[] {
    return [...this.byId.values()].sort((a, b) => (a.updated < b.updated ? 1 : -1));
  }

  get selected(): VehicleRecord | undefined {
    return this.selectedId ? this.byId.get(this.selectedId) : undefined;
  }

  get importJob(): Job | undefined {
    return this.root.jobs.get(this.importJobId);
  }

  /** True when the draft differs from what is stored. */
  get dirty(): boolean {
    if (!this.draft) return false;
    const stored = this.selected?.vehicle;
    return JSON.stringify(stored ?? {}) !== JSON.stringify(toJS(this.draft));
  }

  async load(): Promise<void> {
    const result = await this.root.guard(() => api.listVehicles());
    if (!result) return;
    runInAction(() => {
      this.byId.clear();
      for (const vehicle of result.vehicles) this.byId.set(vehicle.id, vehicle);
      if (this.selectedId && !this.byId.has(this.selectedId)) this.selectedId = null;
    });
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.draft = id ? structuredClone(toJS(this.byId.get(id)!.vehicle)) : null;
  }

  startNew(): void {
    this.selectedId = null;
    this.draft = emptyVehicle();
  }

  /** Mutate one field of the draft. */
  edit<K extends keyof VehicleInput>(key: K, value: VehicleInput[K]): void {
    if (this.draft) this.draft[key] = value;
  }

  addCabin(): void {
    if (!this.draft) return;
    const cabins = { ...(this.draft.cabins ?? {}) };
    // Cabin keys are the letters SCS use: a, b, c ... then anything free.
    const key = "abcdefgh".split("").find((letter) => !(letter in cabins)) ?? `c${Object.keys(cabins).length}`;
    cabins[key] = { name: `Cabin ${key.toUpperCase()}`, units: [] };
    this.draft.cabins = cabins;
  }

  updateCabin(key: string, patch: { name?: string; units?: string[] }): void {
    if (!this.draft?.cabins?.[key]) return;
    this.draft.cabins = { ...this.draft.cabins, [key]: { ...this.draft.cabins[key], ...patch } };
  }

  removeCabin(key: string): void {
    if (!this.draft?.cabins) return;
    const { [key]: _removed, ...rest } = this.draft.cabins;
    this.draft.cabins = rest;
  }

  addAccessory(label: string): void {
    if (!this.draft || !label.trim()) return;
    this.draft.accessories = { ...(this.draft.accessories ?? {}), [label.trim()]: [] };
  }

  updateAccessory(label: string, units: string[]): void {
    if (!this.draft?.accessories) return;
    this.draft.accessories = { ...this.draft.accessories, [label]: units };
  }

  removeAccessory(label: string): void {
    if (!this.draft?.accessories) return;
    const { [label]: _removed, ...rest } = this.draft.accessories;
    this.draft.accessories = rest;
  }

  async save(): Promise<void> {
    if (!this.draft) return;
    this.saving = true;
    const payload = structuredClone(toJS(this.draft));
    const saved = await this.root.guard(() =>
      this.selectedId ? api.updateVehicle(this.selectedId, payload) : api.createVehicle(payload),
    );
    runInAction(() => {
      this.saving = false;
      if (saved) {
        this.byId.set(saved.id, saved);
        this.selectedId = saved.id;
        this.draft = structuredClone(toJS(saved.vehicle));
        this.root.notify(`Saved ${saved.vehicle.name || "truck"}`);
      }
    });
  }

  async remove(id: string): Promise<void> {
    const done = await this.root.guard(async () => {
      await api.deleteVehicle(id);
      return true;
    });
    if (!done) return;
    runInAction(() => {
      this.byId.delete(id);
      if (this.selectedId === id) this.select(null);
    });
  }

  /** Upload a .blend and have Blender draft a vehicle plus a paint template. */
  async importBlend(file: File, size: number): Promise<void> {
    const [upload] = await this.root.uploads.upload([file]);
    if (!upload) return;
    const started = await this.root.guard(() => api.importBlend(upload.id, size));
    if (!started) return;

    runInAction(() => {
      this.importJobId = started.job.id;
    });
    this.root.jobs.watch(started.job, (job) => {
      if (job.state !== "succeeded") return;
      const record = job.result as VehicleRecord;
      runInAction(() => {
        this.byId.set(record.id, record);
        this.select(record.id);
        this.importJobId = null;
      });
      this.root.notify(`Imported ${record.vehicle.name} -- fill in cabins and accessories next`);
    });
  }
}
