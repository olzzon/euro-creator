import { createContext, useContext, type ReactNode } from "react";

import { RootStore } from "./stores/RootStore";

const StoreContext = createContext<RootStore | null>(null);

export function StoreProvider({ store, children }: { store: RootStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): RootStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside a StoreProvider");
  return store;
}
