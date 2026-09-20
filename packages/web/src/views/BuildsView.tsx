import { observer } from "mobx-react-lite";

import { api } from "../api";
import { formatBytes } from "../components/ui";
import { useStore } from "../store";
import { BuildResult } from "./BuildResult";

/** Every build so far, newest first. Older ones are pruned by the server. */
export const BuildsView = observer(function BuildsView() {
  const store = useStore();
  const builds = store.projects.builds;

  if (builds.length === 0) {
    return (
      <div className="empty">
        <h3>Nothing built yet</h3>
        <p>Builds appear here once you have made a skin and pressed Build.</p>
      </div>
    );
  }

  return (
    <div className="single-pane">
      <div className="pane-head">
        <h2>Builds</h2>
        <span className="small dim">
          keeping the {builds.length} most recent · {formatBytes(builds.reduce((n, b) => n + b.archiveBytes, 0))}
        </span>
      </div>
      {builds.map((build) => {
        const project = store.projects.byId.get(build.projectId);
        return (
          <div key={build.id}>
            <p className="small dim">
              {new Date(build.created).toLocaleString()} ·{" "}
              {project?.project.skin.name ?? "(deleted skin)"} for{" "}
              {project?.project.vehicle.name ?? "?"} ·{" "}
              <a href={api.downloadUrl(build.id)} download>
                download
              </a>
            </p>
            <BuildResult build={build} />
          </div>
        );
      })}
    </div>
  );
});
