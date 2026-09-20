import { observer } from "mobx-react-lite";
import { useEffect } from "react";

import { Notices } from "./components/ui";
import { useStore } from "./store";
import { BuildsView } from "./views/BuildsView";
import { SkinsView } from "./views/SkinsView";
import { TrucksView } from "./views/TrucksView";

const TABS = [
  { id: "trucks", label: "Trucks" },
  { id: "skins", label: "Skins" },
  { id: "builds", label: "Builds" },
] as const;

export const App = observer(function App() {
  const store = useStore();

  useEffect(() => {
    void store.uploads.load();
    return () => store.jobs.dispose();
  }, [store]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          euro<span>-creator</span>
        </div>
        <nav className="tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={store.view === tab.id ? "tab active" : "tab"}
              onClick={() => store.setView(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <BlenderBadge />
      </header>

      <main>
        {store.view === "trucks" ? <TrucksView /> : null}
        {store.view === "skins" ? <SkinsView /> : null}
        {store.view === "builds" ? <BuildsView /> : null}
      </main>

      <Notices />
    </div>
  );
});

/**
 * Blender's status, always visible.
 *
 * Whether Blender is there and whether it is the version SCS Blender Tools
 * supports decides which half of the app works, so it belongs in the chrome
 * rather than buried in a settings page.
 */
const BlenderBadge = observer(function BlenderBadge() {
  const store = useStore();
  const blender = store.system?.blender;
  if (!blender) return <span className="small dim">…</span>;

  const state = !blender.available ? "failed" : blender.supported ? "succeeded" : "running";
  return (
    <span className={`badge badge-${state}`} title={blender.message}>
      {blender.available
        ? `Blender ${blender.version?.join(".") ?? "?"}${blender.supported ? "" : " (unsupported)"}`
        : "No Blender"}
    </span>
  );
});
