import { observer } from "mobx-react-lite";

import { api } from "../api";
import { useStore } from "../store";
import { Dropzone, formatBytes } from "./ui";

/**
 * One texture slot: drop a file, or pick something already uploaded.
 *
 * The slot shows the image's dimensions against the template size, because a
 * mismatch is the single most common reason a build fails, and seeing
 * "2048x2048" next to "needs 4096x4096" answers it before the build runs.
 */
export const TexturePicker = observer(function TexturePicker({
  label,
  hint,
  uploadId,
  expect,
  onPick,
}: {
  label: string;
  hint?: string;
  uploadId: string | null | undefined;
  /** `[width, height]` the mask must match, when there is one. */
  expect?: readonly [number, number];
  onPick: (uploadId: string | null) => void;
}) {
  const store = useStore();
  const upload = store.uploads.get(uploadId);
  const mismatch =
    upload?.image && expect && (upload.image.width !== expect[0] || upload.image.height !== expect[1]);

  return (
    <div className="texture-slot">
      <div className="texture-slot-head">
        <strong>{label}</strong>
        {upload ? (
          <button className="link" onClick={() => onPick(null)}>
            clear
          </button>
        ) : null}
      </div>
      {hint ? <p className="field-hint">{hint}</p> : null}

      {upload ? (
        <div className="texture-preview">
          <img src={api.uploadPreviewUrl(upload.id, 256)} alt={upload.filename} />
          <div>
            <div className="mono small">{upload.filename}</div>
            <div className="small dim">{formatBytes(upload.bytes)}</div>
            {upload.image ? (
              <div className={mismatch ? "small warn" : "small dim"}>
                {upload.image.width}×{upload.image.height}
                {mismatch ? ` — template needs ${expect![0]}×${expect![1]}` : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <Dropzone
          accept="image/png,image/jpeg,image/tiff,.tga,.dds"
          label="Drop a PNG, TGA or DDS"
          busy={store.uploads.uploading > 0}
          onFiles={async (files) => {
            const [uploaded] = await store.uploads.upload(files.slice(0, 1));
            if (uploaded) onPick(uploaded.id);
          }}
        />
      )}

      {store.uploads.images.length > 0 ? (
        <select
          className="input small"
          value={uploadId ?? ""}
          onChange={(event) => onPick(event.target.value || null)}
        >
          <option value="">— reuse an upload —</option>
          {store.uploads.images.map((image) => (
            <option key={image.id} value={image.id}>
              {image.filename}
              {image.image ? ` (${image.image.width}×${image.image.height})` : ""}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
});
