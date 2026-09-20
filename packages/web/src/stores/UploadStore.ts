import { makeAutoObservable, runInAction } from "mobx";

import { api, type UploadRecord } from "../api";
import type { RootStore } from "./RootStore";

/**
 * Uploaded artwork and .blend files.
 *
 * Kept in one place because the same upload can be a project's main mask and
 * another project's accessory mask; the server stores bytes once, keyed by id.
 */
export class UploadStore {
  byId = new Map<string, UploadRecord>();
  uploading = 0;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get all(): UploadRecord[] {
    return [...this.byId.values()].sort((a, b) => (a.uploaded < b.uploaded ? 1 : -1));
  }

  get images(): UploadRecord[] {
    return this.all.filter((upload) => upload.kind === "image");
  }

  get(id: string | null | undefined): UploadRecord | undefined {
    return id ? this.byId.get(id) : undefined;
  }

  async load(): Promise<void> {
    const { uploads } = await api.listUploads();
    runInAction(() => {
      for (const upload of uploads) this.byId.set(upload.id, upload);
    });
  }

  /** Upload files and return the records, so a caller can wire one straight into a slot. */
  async upload(files: File[]): Promise<UploadRecord[]> {
    if (files.length === 0) return [];
    this.uploading += files.length;
    try {
      const result = await this.root.guard(() => api.upload(files));
      if (!result) return [];
      runInAction(() => {
        for (const upload of result.uploads) this.byId.set(upload.id, upload);
      });
      return result.uploads;
    } finally {
      runInAction(() => {
        this.uploading -= files.length;
      });
    }
  }
}
