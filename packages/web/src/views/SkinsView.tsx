import { observer } from "mobx-react-lite";

import { JobProgress } from "../components/JobProgress";
import { TexturePicker } from "../components/TexturePicker";
import { Field, NumberInput, TextInput, Toggle } from "../components/ui";
import { useStore } from "../store";
import { BuildResult } from "./BuildResult";

/**
 * The skin editor: mod metadata, shop settings, and one texture slot per mask
 * the selected truck needs.
 *
 * Which slots appear is driven entirely by the truck definition, so a truck
 * with three separately-unwrapped cabins asks for three masks and a truck with
 * one asks for one. That is the thing that is easy to get wrong by hand.
 */
export const SkinsView = observer(function SkinsView() {
  const store = useStore();
  const { projects, vehicles } = store;
  const draft = projects.draft;

  return (
    <div className="split">
      <aside className="list-pane">
        <div className="pane-head">
          <h2>Skins</h2>
        </div>

        {vehicles.all.length === 0 ? (
          <p className="small dim">Add a truck first — a skin is always built for one.</p>
        ) : (
          <select
            className="input"
            value=""
            onChange={(event) => {
              if (event.target.value) projects.startNew(event.target.value);
            }}
          >
            <option value="">+ New skin for…</option>
            {vehicles.all.map((record) => (
              <option key={record.id} value={record.id}>
                {record.vehicle.name || record.vehicle.path}
              </option>
            ))}
          </select>
        )}

        <ul className="record-list">
          {projects.all.map((record) => (
            <li key={record.id}>
              <button
                className={record.id === projects.selectedId ? "record active" : "record"}
                onClick={() => projects.select(record.id)}
              >
                <strong>{record.project.skin.name || "(unnamed)"}</strong>
                <span className="small dim">{record.project.vehicle.name}</span>
                <span className="small dim">by {record.project.mod.author || "?"}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="editor-pane">
        {!draft ? (
          <div className="empty">
            <h3>No skin selected</h3>
            <p>Pick a truck above to start one, or choose an existing skin from the list.</p>
          </div>
        ) : (
          <>
            <div className="pane-head">
              <h2>{draft.skin.name || "New skin"}</h2>
              <div className="inline">
                {projects.selectedId ? (
                  <button
                    className="button small danger"
                    onClick={() => void projects.remove(projects.selectedId!)}
                  >
                    Delete
                  </button>
                ) : null}
                <button className="button small" disabled={!projects.dirty} onClick={() => void projects.save()}>
                  {projects.saving ? "Saving…" : "Save"}
                </button>
                <button className="button primary" disabled={projects.building} onClick={() => void projects.build()}>
                  {projects.building ? "Building…" : "Build .scs"}
                </button>
              </div>
            </div>

            <div className="panel">
              <div className="pane-head">
                <h3>Truck</h3>
                {projects.draftVehicleId ? (
                  <button className="link" onClick={projects.refreshVehicle}>
                    update from saved truck
                  </button>
                ) : null}
              </div>
              <p className="small dim">
                <strong>{draft.vehicle.name}</strong> · <code>{draft.vehicle.path}</code> ·{" "}
                {draft.vehicle.separate_paintjobs ? "per-cabin masks" : "one shared mask"}
                {draft.vehicle.alternate_uvset ? " · mirrored UV set" : ""}
              </p>
            </div>

            <div className="panel">
              <h3>Mod</h3>
              <div className="grid-2">
                <Field label="Mod name" hint="Shown in the in-game mod manager.">
                  <TextInput value={draft.mod.name} onChange={(value) => projects.editMod("name", value)} />
                </Field>
                <Field label="Author">
                  <TextInput value={draft.mod.author} onChange={(value) => projects.editMod("author", value)} />
                </Field>
                <Field label="Version">
                  <TextInput
                    value={draft.mod.version ?? "1.0"}
                    onChange={(value) => projects.editMod("version", value)}
                  />
                </Field>
              </div>
              <Field label="Description">
                <textarea
                  className="input"
                  rows={3}
                  value={draft.mod.description ?? ""}
                  onChange={(event) => projects.editMod("description", event.target.value)}
                />
              </Field>
            </div>

            <div className="panel">
              <h3>In the shop</h3>
              <div className="grid-2">
                <Field label="Paint job name" hint="What the player sees at the dealer.">
                  <TextInput value={draft.skin.name} onChange={(value) => projects.editSkin("name", value)} />
                </Field>
                <Field label="Price">
                  <NumberInput
                    value={draft.skin.price ?? 12000}
                    min={0}
                    onChange={(value) => projects.editSkin("price", value)}
                  />
                </Field>
                <Field label="Unlock level">
                  <NumberInput
                    value={draft.skin.unlock ?? 0}
                    min={0}
                    onChange={(value) => projects.editSkin("unlock", value)}
                  />
                </Field>
              </div>
              <Toggle
                label="Airbrush"
                hint="Multiplies the mask onto the player's chosen base colour using the mask's alpha. Leave on unless the livery must be fully opaque."
                checked={draft.skin.airbrush ?? true}
                onChange={(value) => projects.editSkin("airbrush", value)}
              />
              <TexturePicker
                label="Shop icon"
                hint="Letterboxed into 256×64 rather than stretched, so a logo is not squashed."
                uploadId={draft.skin.icon}
                onPick={(id) => projects.editSkin("icon", id)}
              />
            </div>

            <TextureSlots />

            <div className="panel">
              <h3>Output</h3>
              <div className="grid-2">
                <Field
                  label="Texture format"
                  hint="DXT5 keeps a full alpha channel and is what stock paint jobs use. Raw is eight times larger but free of block artefacts."
                >
                  <select
                    className="input"
                    value={draft.output?.dds_format ?? "dxt5"}
                    onChange={(event) =>
                      projects.editOutput("dds_format", event.target.value as "dxt5" | "dxt1" | "raw")
                    }
                  >
                    <option value="dxt5">DXT5 (BC3, with alpha)</option>
                    <option value="dxt1">DXT1 (BC1, no alpha)</option>
                    <option value="raw">Uncompressed</option>
                  </select>
                </Field>
              </div>
              <Toggle
                label="Generate mipmaps"
                checked={draft.output?.mipmaps ?? true}
                onChange={(value) => projects.editOutput("mipmaps", value)}
              />
              <Toggle
                label="Resize masks that do not match the template"
                hint="Off by default: a mismatch usually means the artwork was painted on the wrong template, and resampling would hide that."
                checked={projects.resizeMismatched}
                onChange={(value) => {
                  projects.resizeMismatched = value;
                }}
              />
            </div>

            {projects.buildJob ? <JobProgress job={projects.buildJob} /> : null}
            {projects.lastBuild ? <BuildResult build={projects.lastBuild} /> : null}
          </>
        )}
      </section>
    </div>
  );
});

/** One slot per mask the selected truck actually needs. */
const TextureSlots = observer(function TextureSlots() {
  const { projects } = useStore();
  const draft = projects.draft;
  if (!draft) return null;

  const vehicle = draft.vehicle;
  const size = vehicle.template_size ?? [4096, 4096];
  const cabins = Object.entries(vehicle.cabins ?? {});
  const accessories = Object.keys(vehicle.accessories ?? {});

  return (
    <div className="panel">
      <h3>Masks</h3>
      {vehicle.separate_paintjobs && cabins.length > 0 ? (
        <>
          <p className="small dim">
            This truck unwraps each cabin separately, so each needs its own mask. The shared mask below
            is used for any cabin you leave empty.
          </p>
          <div className="slot-grid">
            {cabins.map(([key, cabin]) => (
              <TexturePicker
                key={key}
                label={cabin.name ?? `Cabin ${key}`}
                expect={size as [number, number]}
                uploadId={draft.textures?.cabins?.[key] ?? null}
                onPick={(id) => projects.setCabinTexture(key, id)}
              />
            ))}
          </div>
        </>
      ) : null}

      <div className="slot-grid">
        <TexturePicker
          label={vehicle.separate_paintjobs ? "Shared fallback mask" : "Main mask"}
          hint="Painted on the truck's UV template."
          expect={size as [number, number]}
          uploadId={draft.textures?.main ?? null}
          onPick={(id) => projects.setMainTexture(id)}
        />
      </div>

      {accessories.length > 0 ? (
        <>
          <h4>Accessories</h4>
          <p className="small dim">
            Optional. Anything left empty gets a transparent mask and keeps the player's base colour.
          </p>
          <div className="slot-grid">
            {accessories.map((label) => (
              <TexturePicker
                key={label}
                label={label}
                uploadId={draft.textures?.accessories?.[label] ?? null}
                onPick={(id) => projects.setAccessoryTexture(label, id)}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
});
