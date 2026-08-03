// Per-tab graph lease. Each tab runs its own Worker with its own Loro peer
// id, so two tabs editing one graph would race the shared IndexedDB log.
// The Web Locks API grants one tab an exclusive lease; a tab without the
// lease opens the graph read-only and never issues commands.

export type LeaseMode = "exclusive" | "readonly";

export interface Lease {
  mode: LeaseMode;
  release(): void;
}

export function acquireLease(graphId: string): Promise<Lease> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    return Promise.resolve({ mode: "exclusive", release: () => {} });
  }
  return new Promise((resolve) => {
    let release: () => void = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    void navigator.locks.request(`neoseq:graph:${graphId}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve({ mode: "readonly", release: () => {} });
        return undefined;
      }
      resolve({ mode: "exclusive", release });
      return held;
    });
  });
}
