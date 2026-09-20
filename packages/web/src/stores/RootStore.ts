import { makeAutoObservable, runInAction } from "mobx";

import { api, ApiError, type SystemInfo } from "../api";
import { JobStore } from "./JobStore";
import { ProjectStore } from "./ProjectStore";
import { UploadStore } from "./UploadStore";
import { VehicleStore } from "./VehicleStore";

export type View = "trucks" | "skins" | "builds";

/**
 * Composition root.
 *
 * One store per resource, plus the cross-cutting bits (current view, toast
 * messages, system status). Views read observables and call actions; nothing
 * in a component talks to `api` directly except for image URLs.
 */
export class RootStore {
  view: View = "trucks";
  system: SystemInfo | null = null;
  /** Transient messages, newest last. Errors stay until dismissed. */
  notices: { id: number; kind: "error" | "info"; message: string }[] = [];

  readonly uploads = new UploadStore(this);
  readonly vehicles = new VehicleStore(this);
  readonly projects = new ProjectStore(this);
  readonly jobs = new JobStore(this);

  private noticeSeq = 0;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
    this.restoreViewFromHash();
    window.addEventListener("hashchange", this.restoreViewFromHash);
  }

  async init(): Promise<void> {
    await Promise.all([this.refreshSystem(), this.vehicles.load(), this.projects.load()]);
  }

  async refreshSystem(): Promise<void> {
    const system = await api.system();
    runInAction(() => {
      this.system = system;
    });
  }

  setView(view: View): void {
    this.view = view;
    window.location.hash = view;
  }

  private restoreViewFromHash(): void {
    const hash = window.location.hash.replace("#", "");
    if (hash === "trucks" || hash === "skins" || hash === "builds") this.view = hash;
  }

  notify(message: string, kind: "error" | "info" = "info"): void {
    const id = ++this.noticeSeq;
    this.notices.push({ id, kind, message });
    if (kind === "info") setTimeout(() => this.dismiss(id), 4000);
  }

  dismiss(id: number): void {
    this.notices = this.notices.filter((notice) => notice.id !== id);
  }

  /**
   * Run an action, surfacing any server message to the user.
   *
   * Every API error carries a message written to be read by a modder, so the
   * default handling is to show it rather than log it.
   */
  async guard<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error);
      this.notify(message, "error");
      return undefined;
    }
  }
}
