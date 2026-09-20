/**
 * Job queue.
 *
 * Builds and Blender runs take seconds to minutes, so they cannot sit inside a
 * request. This is a single-worker in-process queue: enough for one Mac mini,
 * and behind an interface narrow enough that swapping in BullMQ later touches
 * only this file.
 *
 * Running one job at a time is deliberate. Both kinds of work are CPU- or
 * memory-hungry (a 4K mask is 64 MB of pixels before compression), and a
 * queue of two would make both slower rather than either faster.
 */

import { EventEmitter } from "node:events";

import { newId } from "./storage.js";

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobProgress {
  readonly at: string;
  readonly message: string;
  /** 0..1 when the work has a known extent, otherwise null. */
  readonly fraction: number | null;
}

export interface Job<T = unknown> {
  readonly id: string;
  readonly kind: string;
  state: JobState;
  readonly created: string;
  started: string | null;
  finished: string | null;
  progress: JobProgress[];
  result: T | null;
  error: { message: string; name: string } | null;
}

export interface JobContext {
  readonly id: string;
  report(message: string, fraction?: number): void;
  /** Throws if the job was cancelled, so long tasks can bail between steps. */
  throwIfCancelled(): void;
}

type JobRunner<T> = (context: JobContext) => Promise<T>;

interface QueueEntry {
  job: Job;
  run: JobRunner<unknown>;
}

export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly pending: QueueEntry[] = [];
  private readonly cancelled = new Set<string>();
  private active: string | null = null;
  readonly events = new EventEmitter();

  constructor(private readonly keep = 100) {
    // Many SSE clients can watch the same job; the default cap of 10 is low.
    this.events.setMaxListeners(0);
  }

  submit<T>(kind: string, run: JobRunner<T>): Job<T> {
    const job: Job<T> = {
      id: newId(),
      kind,
      state: "queued",
      created: new Date().toISOString(),
      started: null,
      finished: null,
      progress: [],
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job as Job);
    this.pending.push({ job: job as Job, run: run as JobRunner<unknown> });
    this.emit(job as Job);
    queueMicrotask(() => void this.drain());
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(kind?: string): Job[] {
    const all = [...this.jobs.values()];
    return (kind ? all.filter((job) => job.kind === kind) : all).sort((a, b) =>
      a.created < b.created ? 1 : -1,
    );
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state === "succeeded" || job.state === "failed") return false;
    this.cancelled.add(id);
    if (job.state === "queued") {
      const index = this.pending.findIndex((entry) => entry.job.id === id);
      if (index >= 0) this.pending.splice(index, 1);
      this.finish(job, "cancelled", null, null);
    }
    return true;
  }

  private emit(job: Job): void {
    this.events.emit("update", job);
    this.events.emit(`update:${job.id}`, job);
  }

  private finish(job: Job, state: JobState, result: unknown, error: Error | null): void {
    job.state = state;
    job.finished = new Date().toISOString();
    job.result = result ?? null;
    job.error = error ? { message: error.message, name: error.name } : null;
    this.emit(job);
    this.prune();
  }

  /** Keep finished jobs bounded; a long-lived service would grow without it. */
  private prune(): void {
    const finished = [...this.jobs.values()]
      .filter((job) => job.finished !== null)
      .sort((a, b) => (a.finished! < b.finished! ? 1 : -1));
    for (const job of finished.slice(this.keep)) this.jobs.delete(job.id);
  }

  private async drain(): Promise<void> {
    if (this.active !== null) return;
    const entry = this.pending.shift();
    if (!entry) return;

    const { job, run } = entry;
    this.active = job.id;
    job.state = "running";
    job.started = new Date().toISOString();
    this.emit(job);

    const context: JobContext = {
      id: job.id,
      report: (message, fraction) => {
        job.progress.push({
          at: new Date().toISOString(),
          message,
          fraction: fraction ?? null,
        });
        this.emit(job);
      },
      throwIfCancelled: () => {
        if (this.cancelled.has(job.id)) throw new JobCancelled(job.id);
      },
    };

    try {
      const result = await run(context);
      if (this.cancelled.has(job.id)) this.finish(job, "cancelled", null, null);
      else this.finish(job, "succeeded", result, null);
    } catch (error) {
      if (error instanceof JobCancelled) this.finish(job, "cancelled", null, null);
      else this.finish(job, "failed", null, error as Error);
    } finally {
      this.cancelled.delete(job.id);
      this.active = null;
      void this.drain();
    }
  }
}

export class JobCancelled extends Error {
  constructor(id: string) {
    super(`job ${id} was cancelled`);
    this.name = "JobCancelled";
  }
}
