// Per-tab graph lease. Each tab runs its own Worker with its own Loro peer
// id, so two tabs editing one graph would race the shared IndexedDB log.
// The Web Locks API grants one tab an exclusive lease; a tab without the
// lease opens the graph read-only and never issues commands.

export type LeaseMode = "exclusive" | "readonly";

export interface Lease {
  mode: LeaseMode;
  release(): void;
}

interface TabLease {
  consumers: number;
  mode: Promise<LeaseMode>;
  releaseLock(): void;
  tail: Promise<void>;
}

const tabLeases = new Map<string, TabLease>();

export async function acquireLease(graphId: string): Promise<Lease> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    return { mode: "exclusive", release: () => {} };
  }

  let shared = tabLeases.get(graphId);
  if (!shared) {
    shared = createTabLease(graphId);
    tabLeases.set(graphId, shared);
  }
  shared.consumers += 1;

  const predecessor = shared.tail;
  let finishTurn: () => void = () => {};
  const turn = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  shared.tail = predecessor.then(() => turn);

  let mode: LeaseMode;
  try {
    mode = await shared.mode;
    if (mode === "exclusive") await predecessor;
    else finishTurn();
  } catch (error) {
    finishTurn();
    releaseConsumer(graphId, shared);
    throw error;
  }

  let released = false;
  return {
    mode,
    release: () => {
      if (released) return;
      released = true;
      finishTurn();
      releaseConsumer(graphId, shared);
    },
  };
}

function createTabLease(graphId: string): TabLease {
  let releaseLock: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const mode = new Promise<LeaseMode>((resolve, reject) => {
    void navigator.locks
      .request(`neoseq:graph:${graphId}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve("readonly");
          return undefined;
        }
        resolve("exclusive");
        return held;
      })
      .catch(reject);
  });
  return { consumers: 0, mode, releaseLock, tail: Promise.resolve() };
}

function releaseConsumer(graphId: string, shared: TabLease): void {
  shared.consumers -= 1;
  if (shared.consumers > 0) return;
  if (tabLeases.get(graphId) === shared) tabLeases.delete(graphId);
  shared.releaseLock();
}
