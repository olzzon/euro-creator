import { makeAutoObservable, runInAction } from "mobx";

import { api, watchJob, type Job } from "../api";
import type { RootStore } from "./RootStore";

/**
 * Tracks running jobs and streams their progress.
 *
 * Builds and Blender runs take seconds to minutes, so the UI follows them over
 * server-sent events rather than polling. A stream that drops falls back to a
 * single fetch so the final state is never lost.
 */
export class JobStore {
  byId = new Map<string, Job>();
  private closers = new Map<string, () => void>();

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get(id: string | null): Job | undefined {
    return id ? this.byId.get(id) : undefined;
  }

  get active(): Job[] {
    return [...this.byId.values()].filter((job) => job.state === "queued" || job.state === "running");
  }

  /** Start following a job; resolves when it reaches a terminal state. */
  watch(job: Job, onFinished?: (job: Job) => void): void {
    runInAction(() => this.byId.set(job.id, job));
    this.closers.get(job.id)?.();

    const finish = (final: Job): void => {
      this.closers.get(final.id)?.();
      this.closers.delete(final.id);
      if (final.state === "failed" && final.error) this.root.notify(final.error.message, "error");
      onFinished?.(final);
    };

    const close = watchJob(job.id, (update) => {
      runInAction(() => this.byId.set(update.id, update));
      if (update.state !== "queued" && update.state !== "running") finish(update);
    });
    this.closers.set(job.id, close);

    // Safety net: if the stream never connects, settle the job by polling once.
    window.setTimeout(() => void this.reconcile(job.id, finish), 2000);
  }

  private async reconcile(id: string, finish: (job: Job) => void): Promise<void> {
    const current = this.byId.get(id);
    if (current && current.state !== "queued" && current.state !== "running") return;
    if (!this.closers.has(id)) return;
    try {
      const job = await api.getJob(id);
      runInAction(() => this.byId.set(job.id, job));
      if (job.state !== "queued" && job.state !== "running") finish(job);
      else window.setTimeout(() => void this.reconcile(id, finish), 2000);
    } catch {
      /* the job may have been pruned; leave the last known state */
    }
  }

  async cancel(id: string): Promise<void> {
    await this.root.guard(() => api.cancelJob(id));
  }

  dispose(): void {
    for (const close of this.closers.values()) close();
    this.closers.clear();
  }
}
