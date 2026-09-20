import { observer } from "mobx-react-lite";

import type { Job } from "../api";
import { useStore } from "../store";

/**
 * Live progress for a job.
 *
 * The message log matters as much as the bar: a Blender run that is quiet for
 * forty seconds looks identical to a hung one without it.
 */
export const JobProgress = observer(function JobProgress({ job }: { job: Job }) {
  const store = useStore();
  const running = job.state === "queued" || job.state === "running";
  const fraction = [...job.progress].reverse().find((entry) => entry.fraction !== null)?.fraction ?? null;

  return (
    <div className={`job job-${job.state}`}>
      <div className="job-head">
        <span className={`badge badge-${job.state}`}>{job.state}</span>
        <span className="job-kind">{job.kind}</span>
        {running ? (
          <button className="link" onClick={() => void store.jobs.cancel(job.id)}>
            cancel
          </button>
        ) : null}
      </div>

      {running ? (
        <div className="progress">
          <div
            className={fraction === null ? "progress-bar indeterminate" : "progress-bar"}
            style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }}
          />
        </div>
      ) : null}

      <ol className="job-log">
        {job.progress.slice(-12).map((entry, index) => (
          <li key={`${entry.at}-${index}`}>{entry.message}</li>
        ))}
      </ol>

      {job.error ? <p className="job-error">{job.error.message}</p> : null}
    </div>
  );
});
