// Per-tab graph lease. Each tab runs its own Worker with its own Loro peer
// id, so two tabs editing one graph would race the shared IndexedDB log.
// Exactly one tab holds the writable lease; a tab without it opens the graph
// read-only and never issues commands.
//
// The Web Locks API is the lease where the browser offers it. It exists only
// in secure contexts, and a self-hosted appliance reached over plain HTTP on a
// local network is not one. There the tabs elect a holder themselves over a
// BroadcastChannel: a claimant announces itself, the current holder or any
// earlier claimant answers, and silence for one claim window means the lease
// is free. Both routes give the session the same answer and the same
// obligation to release.

import { randomUUID } from "@/lib/crypto";

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
  if (typeof navigator === "undefined") {
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
  const mode = navigator.locks
    ? webLockMode(graphId, held)
    : typeof BroadcastChannel === "function"
      ? electedMode(graphId, held)
      : Promise.resolve<LeaseMode>("exclusive");
  return { consumers: 0, mode, releaseLock, tail: Promise.resolve() };
}

function webLockMode(graphId: string, held: Promise<void>): Promise<LeaseMode> {
  return new Promise<LeaseMode>((resolve, reject) => {
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
}

/** How long a claimant waits for a holder or an earlier claimant to answer.
 * Delivery between tabs of one browser is ordinarily immediate; the window
 * covers a tab whose main thread is briefly busy. */
const CLAIM_WINDOW_MS = 300;

type LeaseMessage = { type: "claim"; claim: string } | { type: "held"; claim: string };

function electedMode(graphId: string, held: Promise<void>): Promise<LeaseMode> {
  const channel = new BroadcastChannel(`neoseq:lease:${graphId}`);
  const claim = randomUUID();
  return new Promise<LeaseMode>((resolve) => {
    const answer = (theirs: string) => channel.postMessage({ type: "held", claim: theirs });
    const timer = setTimeout(() => {
      // Nobody objected: hold the lease and answer every later claimant until
      // the last consumer in this tab releases it.
      channel.onmessage = (event: MessageEvent<LeaseMessage>) => {
        if (event.data?.type === "claim") answer(event.data.claim);
      };
      void held.then(() => channel.close());
      resolve("exclusive");
    }, CLAIM_WINDOW_MS);
    channel.onmessage = (event: MessageEvent<LeaseMessage>) => {
      const data = event.data;
      if (!data) return;
      // Two tabs claiming at once settle by claim id: the smaller wins and
      // tells the larger so; the larger stands down the moment it hears either
      // a holder or a smaller claim.
      if (data.type === "claim" && data.claim > claim) {
        answer(data.claim);
        return;
      }
      if ((data.type === "held" && data.claim === claim) || data.type === "claim") {
        clearTimeout(timer);
        channel.close();
        resolve("readonly");
      }
    };
    channel.postMessage({ type: "claim", claim } satisfies LeaseMessage);
  });
}

function releaseConsumer(graphId: string, shared: TabLease): void {
  shared.consumers -= 1;
  if (shared.consumers > 0) return;
  if (tabLeases.get(graphId) === shared) tabLeases.delete(graphId);
  shared.releaseLock();
}
