import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { StoreProvider } from "./store";
import { RootStore } from "./stores/RootStore";
import "./styles.css";

const store = new RootStore();
void store.init();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
