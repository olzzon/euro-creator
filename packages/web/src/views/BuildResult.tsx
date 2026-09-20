import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";

import { api, type BuildRecord } from "../api";
import { formatBytes } from "../components/ui";
import { useStore } from "../store";

/**
 * What came out of a build.
 *
 * Three things a skinner cannot get from a downloaded .scs: whether every
 * cross-reference resolves, what the masks look like after compression, and
 * what the generated SII actually says.
 */
export const BuildResult = observer(function BuildResult({ build }: { build: BuildRecord }) {
  const store = useStore();
  const [tab, setTab] = useState<"masks" | "files" | "report">("masks");

  return (
    <div className="panel">
      <div className="pane-head">
        <h3>
          {build.archiveName}{" "}
          <span className={build.verify.ok ? "badge badge-succeeded" : "badge badge-failed"}>
            {build.verify.ok ? "verified" : `${build.verify.issues.length} issue(s)`}
          </span>
        </h3>
        <a className="button primary" href={api.downloadUrl(build.id)} download>
          Download .scs ({formatBytes(build.archiveBytes)})
        </a>
      </div>

      <p className="small dim">
        Copy it into <code>{store.system?.modFolderHint ?? "your ETS2 mod folder"}</code> and enable it
        in the mod manager.
      </p>

      {build.warnings.map((warning) => (
        <p className="warn small" key={warning}>
          {warning}
        </p>
      ))}

      <div className="tabs">
        {(["masks", "files", "report"] as const).map((name) => (
          <button key={name} className={tab === name ? "tab active" : "tab"} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>

      {tab === "masks" ? <MaskGrid build={build} /> : null}
      {tab === "files" ? <FileTree build={build} /> : null}
      {tab === "report" ? <VerifyReport build={build} /> : null}
    </div>
  );
});

const MaskGrid = observer(function MaskGrid({ build }: { build: BuildRecord }) {
  return (
    <>
      <p className="small dim">
        Decoded back out of the archive, so this is what the game will sample — not the source artwork.
        The place to check whether compression hurt a gradient.
      </p>
      <div className="mask-grid">
        {build.masks.map((mask) => {
          const ddsPath = mask.tobjPath.replace(/^\//, "").replace(/\.tobj$/, ".dds");
          return (
            <figure key={mask.name} className="mask">
              <div className="checkerboard">
                <img src={api.maskPreviewUrl(build.id, ddsPath, 256)} alt={mask.name} loading="lazy" />
              </div>
              <figcaption>
                <strong>{mask.name}</strong>
                <span className="small dim">
                  {formatBytes(mask.bytes)}
                  {mask.source === "placeholder" ? " · placeholder" : ""}
                </span>
              </figcaption>
            </figure>
          );
        })}
      </div>
    </>
  );
});

const FileTree = observer(function FileTree({ build }: { build: BuildRecord }) {
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api.fileText(build.id, open).then((content) => {
      if (!cancelled) setText(content);
    });
    return () => {
      cancelled = true;
    };
  }, [build.id, open]);

  const isText = (path: string) => /\.(sii|sui|mat|txt)$/i.test(path);

  return (
    <>
      <p className="small dim">
        {build.files.length} files, {formatBytes(build.totalBytes)} before packing.
      </p>
      <ul className="file-list">
        {build.files.map((file) => (
          <li key={file.path}>
            <button
              className={open === file.path ? "file active" : "file"}
              disabled={!isText(file.path)}
              onClick={() => setOpen(open === file.path ? null : file.path)}
            >
              <span className="mono small">{file.path}</span>
              <span className="small dim">{formatBytes(file.bytes)}</span>
            </button>
          </li>
        ))}
      </ul>
      {open ? <pre className="code">{text}</pre> : null}
    </>
  );
});

const VerifyReport = observer(function VerifyReport({ build }: { build: BuildRecord }) {
  return (
    <>
      <p className="small dim">
        Checked {build.verify.checked.files} files: {build.verify.checked.tobjs} TOBJ targets and{" "}
        {build.verify.checked.maskReferences} paint_job_mask references, read back out of the packed
        archive.
      </p>
      {build.verify.issues.length === 0 ? (
        <p className="ok">
          Every texture reference resolves. If this paint job still does not show up in game, the cause
          is in the truck's own def files rather than in this mod.
        </p>
      ) : (
        <ul className="issue-list">
          {build.verify.issues.map((issue, index) => (
            <li key={index} className={issue.severity}>
              <span className="mono small">{issue.path || "(archive)"}</span>
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
});
