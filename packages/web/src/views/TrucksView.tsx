import { observer } from "mobx-react-lite";
import { useState } from "react";

import { api, type BlendRoot } from "../api";
import { JobProgress } from "../components/JobProgress";
import { Dropzone, Field, NumberInput, TextInput, Toggle, UnitList } from "../components/ui";
import { useStore } from "../store";

/**
 * Trucks a skin can target.
 *
 * Two halves: what Blender can tell us (parts, variants, which shader the
 * painted surfaces use) and what only the game's own def files can (the cabin
 * and accessory unit names). The second half is typed in by hand, and the
 * layout says so rather than pretending the import is complete.
 */
export const TrucksView = observer(function TrucksView() {
  const store = useStore();
  const { vehicles } = store;
  const draft = vehicles.draft;
  const [templateSize, setTemplateSize] = useState(4096);

  return (
    <div className="split">
      <aside className="list-pane">
        <div className="pane-head">
          <h2>Trucks</h2>
          <button className="button small" onClick={vehicles.startNew}>
            New
          </button>
        </div>

        <Dropzone
          accept=".blend"
          label="Drop a .blend to import"
          busy={Boolean(vehicles.importJob)}
          onFiles={(files) => {
            if (files[0]) void vehicles.importBlend(files[0], templateSize);
          }}
        />
        <div className="inline">
          <span className="small dim">Template</span>
          <select
            className="input small"
            value={templateSize}
            onChange={(event) => setTemplateSize(Number(event.target.value))}
          >
            {[1024, 2048, 4096, 8192].map((size) => (
              <option key={size} value={size}>
                {size}×{size}
              </option>
            ))}
          </select>
        </div>
        {!store.system?.blender.available ? (
          <p className="small warn">
            Blender was not found on the server, so .blend import is unavailable. Building skins from
            artwork still works.
          </p>
        ) : null}

        {vehicles.importJob ? <JobProgress job={vehicles.importJob} /> : null}

        <ul className="record-list">
          {vehicles.all.map((record) => (
            <li key={record.id}>
              <button
                className={record.id === vehicles.selectedId ? "record active" : "record"}
                onClick={() => vehicles.select(record.id)}
              >
                <strong>{record.vehicle.name || "(unnamed)"}</strong>
                <span className="mono small dim">{record.vehicle.path || "no def path"}</span>
                <span className="small dim">
                  {Object.keys(record.vehicle.cabins ?? {}).length} cabins ·{" "}
                  {Object.keys(record.vehicle.accessories ?? {}).length} accessory groups
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="editor-pane">
        {!draft ? (
          <EmptyState />
        ) : (
          <>
            <div className="pane-head">
              <h2>{draft.name || "New truck"}</h2>
              <div className="inline">
                {vehicles.selectedId ? (
                  <>
                    <button
                      className="button small"
                      onClick={() => {
                        store.projects.startNew(vehicles.selectedId!);
                        store.setView("skins");
                      }}
                    >
                      New skin for this truck
                    </button>
                    <button
                      className="button small danger"
                      onClick={() => void vehicles.remove(vehicles.selectedId!)}
                    >
                      Delete
                    </button>
                  </>
                ) : null}
                <button className="button primary" disabled={vehicles.saving} onClick={() => void vehicles.save()}>
                  {vehicles.saving ? "Saving…" : vehicles.dirty ? "Save changes" : "Saved"}
                </button>
              </div>
            </div>

            {vehicles.selected?.source ? <BlendReport roots={vehicles.selected.source.roots} /> : null}

            <div className="grid-2">
              <Field label="Display name" hint="Shown in the mod description.">
                <TextInput value={draft.name} onChange={(value) => vehicles.edit("name", value)} />
              </Field>
              <Field
                label="Def path"
                hint="Must match def/vehicle/truck/<path>/ in the truck's own mod, e.g. olzzon.scania142."
              >
                <TextInput mono value={draft.path} onChange={(value) => vehicles.edit("path", value)} />
              </Field>
              <Field label="Author" hint="Appended to the texture folder for mod trucks.">
                <TextInput value={draft.author ?? ""} onChange={(value) => vehicles.edit("author", value)} />
              </Field>
              <Field label="Template size">
                <NumberInput
                  value={draft.template_size?.[0] ?? 4096}
                  min={256}
                  onChange={(value) => vehicles.edit("template_size", [value, value])}
                />
              </Field>
            </div>

            <div className="stack">
              <Toggle
                label="This truck comes from a mod"
                hint="Adds [author] to the texture folder, matching the community template packs."
                checked={draft.mod ?? true}
                onChange={(value) => vehicles.edit("mod", value)}
              />
              <Toggle
                label="Mirrored alternate UV set"
                hint="True when the painted materials use the truckpaint.altuv shader flavour. Wrong here and the livery lands on the wrong side of the cab."
                checked={draft.alternate_uvset ?? false}
                onChange={(value) => vehicles.edit("alternate_uvset", value)}
              />
              <Toggle
                label="Each cabin has its own UV layout"
                hint="Gives every cabin its own mask and its own paint job definition. Most single-cab mod trucks leave this off."
                checked={draft.separate_paintjobs ?? false}
                onChange={(value) => vehicles.edit("separate_paintjobs", value)}
              />
            </div>

            <CabinEditor />
            <AccessoryEditor />
            {vehicles.selected?.template ? <TemplateViewer /> : null}
          </>
        )}
      </section>
    </div>
  );
});

function EmptyState() {
  return (
    <div className="empty">
      <h3>No truck selected</h3>
      <p>
        Drop a <code>.blend</code> on the left to have Blender read its SCS structure and render a paint
        template, or create one by hand for a truck that is already in the game.
      </p>
    </div>
  );
}

const BlendReport = observer(function BlendReport({ roots }: { roots: BlendRoot[] }) {
  const root = roots[0];
  if (!root) return null;
  return (
    <div className="panel">
      <h3>From Blender</h3>
      <div className="grid-2">
        <div>
          <div className="small dim">SCS Root</div>
          <div className="mono">{root.name}</div>
        </div>
        <div>
          <div className="small dim">Painted polygons</div>
          <div className="mono">
            {root.paintObjects.reduce((sum, object) => sum + object.polygons, 0).toLocaleString()} across{" "}
            {root.paintObjects.length} object(s)
          </div>
        </div>
      </div>

      {root.mixedUvset ? (
        <p className="warn">
          Some truckpaint materials use <code>.altuv</code> and some do not. Pick one for the whole
          vehicle, or the livery will be mirrored on part of it.
        </p>
      ) : null}

      <details>
        <summary>{root.paintMaterials.length} truckpaint material(s)</summary>
        <ul className="mono small">
          {root.paintMaterials.map((material) => (
            <li key={material.name}>
              {material.name} — {material.effect} — uv={material.uvLayer ?? "?"}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>
          {root.parts.length} part(s), {root.variants.length} variant(s)
        </summary>
        <p className="small dim">
          Variants are Blender's own; the game's cabin names below come from the truck's def files, not
          from here.
        </p>
        <ul className="mono small">
          {root.variants.map((variant) => (
            <li key={variant.name}>
              {variant.name}: {variant.parts.join(", ") || "(no parts)"}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
});

const CabinEditor = observer(function CabinEditor() {
  const { vehicles } = useStore();
  const draft = vehicles.draft;
  if (!draft) return null;
  const cabins = Object.entries(draft.cabins ?? {});

  return (
    <div className="panel">
      <div className="pane-head">
        <h3>Cabins</h3>
        <button className="button small" onClick={vehicles.addCabin}>
          Add cabin
        </button>
      </div>
      <p className="small dim">
        The unit names are the game's, from <code>def/vehicle/truck/{draft.path || "<path>"}/</code>. Each
        becomes <code>suitable_for[]: "&lt;unit&gt;.{draft.path || "<path>"}.cabin"</code>. Several
        cabins can share one entry when they share a UV layout.
      </p>
      {cabins.length === 0 ? (
        <p className="small dim">
          None. A paint job with no cabins listed is offered for every cabin, which is right for most
          single-cab trucks.
        </p>
      ) : null}
      {cabins.map(([key, cabin]) => (
        <div className="row" key={key}>
          <div className="row-key mono">{key}</div>
          <Field label="Name">
            <TextInput
              value={cabin.name ?? ""}
              onChange={(value) => vehicles.updateCabin(key, { name: value })}
            />
          </Field>
          <Field label="Accessory units">
            <UnitList
              units={cabin.units ?? []}
              placeholder="topline, highline"
              onChange={(units) => vehicles.updateCabin(key, { units })}
            />
          </Field>
          <button className="button small danger" onClick={() => vehicles.removeCabin(key)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
});

const AccessoryEditor = observer(function AccessoryEditor() {
  const { vehicles } = useStore();
  const [label, setLabel] = useState("");
  const draft = vehicles.draft;
  if (!draft) return null;
  const accessories = Object.entries(draft.accessories ?? {});

  return (
    <div className="panel">
      <div className="pane-head">
        <h3>Painted accessories</h3>
        <div className="inline">
          <TextInput value={label} onChange={setLabel} placeholder="Sun Visor" />
          <button
            className="button small"
            onClick={() => {
              vehicles.addAccessory(label);
              setLabel("");
            }}
          >
            Add group
          </button>
        </div>
      </div>
      <p className="small dim">
        Each group gets its own mask. Accessories with no artwork get a transparent one, so they keep
        the player's base colour instead of showing the cabin's texture stretched over them.
      </p>
      {accessories.map(([name, units]) => (
        <div className="row" key={name}>
          <div className="row-key">{name}</div>
          <Field label="Accessory units">
            <UnitList
              units={units}
              placeholder="sunshld.stock, sunshld.sunshld_01"
              onChange={(next) => vehicles.updateAccessory(name, next)}
            />
          </Field>
          <button className="button small danger" onClick={() => vehicles.removeAccessory(name)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
});

const TemplateViewer = observer(function TemplateViewer() {
  const { vehicles } = useStore();
  const record = vehicles.selected;
  const [part, setPart] = useState<string>("");
  if (!record?.template) return null;

  const url = part ? api.partTemplateUrl(record.id, part) : api.templateUrl(record.id);
  return (
    <div className="panel">
      <div className="pane-head">
        <h3>Paint template</h3>
        <div className="inline">
          <select className="input small" value={part} onChange={(event) => setPart(event.target.value)}>
            <option value="">All parts</option>
            {record.template.groups.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
          <a className="button small" href={url} download>
            Download PNG
          </a>
        </div>
      </div>
      <p className="small dim">
        {record.template.size}×{record.template.size}, {record.template.polygons.toLocaleString()}{" "}
        polygons across {record.template.groups.length} part(s). Paint underneath this layer, then
        delete it before exporting.
      </p>
      <div className="checkerboard">
        <img src={url} alt="Paint template" />
      </div>
    </div>
  );
});
