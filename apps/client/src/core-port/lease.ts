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

import type { GraphLocatorDto } from "../generated/core-port";
import { CorePortFailure } from "../core-worker";
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

export async function acquireLease(
  locator: GraphLocatorDto,
  options: { wait?: boolean; signal?: AbortSignal } = {},
): Promise<Lease> {
  const graphId = JSON.stringify([locator.repository_id, locator.graph_id]);
  if (typeof navigator === "undefined") {
    return { mode: "exclusive", release: () => {} };
  }

  let shared = tabLeases.get(graphId);
  if (!shared) {
    shared = createTabLease(graphId, options.wait ?? false, options.signal);
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

  // A read-only session has no lock to lend to a waiting directory operation.
  // Retire that acquisition, while its existing readers keep their own handles.
  if (mode === "readonly" && options.wait) {
    releaseConsumer(graphId, shared);
    if (tabLeases.get(graphId) === shared) tabLeases.delete(graphId);
    return acquireLease(locator, options);
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

function createTabLease(graphId: string, wait: boolean, signal?: AbortSignal): TabLease {
  let releaseLock: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const mode = navigator.locks
    ? webLockMode(graphId, held, wait, signal)
    : typeof BroadcastChannel === "function"
      ? electedMode(graphId, held, wait, signal)
      : Promise.resolve<LeaseMode>("exclusive");
  return { consumers: 0, mode, releaseLock, tail: Promise.resolve() };
}

function webLockMode(
  graphId: string,
  held: Promise<void>,
  wait: boolean,
  signal?: AbortSignal,
): Promise<LeaseMode> {
  return new Promise<LeaseMode>((resolve, reject) => {
    void navigator.locks
      .request(`neoseq:graph:${graphId}`, wait ? { signal } : { ifAvailable: true }, (lock) => {
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

async function electedMode(
  graphId: string,
  held: Promise<void>,
  wait: boolean,
  signal?: AbortSignal,
): Promise<LeaseMode> {
  for (;;) {
    signal?.throwIfAborted();
    const mode = await electionAttempt(graphId, held);
    if (mode === "exclusive" || !wait) return mode;
    // Reclaim after either a release or a closed/crashed holder. BroadcastChannel
    // has no peer-disconnection event, so waiting acquisitions retry the election.
    await new Promise<void>((resolve) => setTimeout(resolve, CLAIM_WINDOW_MS));
  }
}

function electionAttempt(graphId: string, held: Promise<void>): Promise<LeaseMode> {
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

/** How long a directory operation waits for this graph's sessions to close.
 * This tab's own closing session hands over at once; another tab's editor may
 * never close, and an operation it releases later would surprise its reader. */
const DIRECTORY_WAIT_MS = 3_000;

/** Runs a directory operation under the same lease that protects graph sessions. */
export async function withGraphLease<T>(
  locator: GraphLocatorDto,
  action: () => Promise<T>,
  waitMs = DIRECTORY_WAIT_MS,
): Promise<T> {
  let lease: Lease;
  try {
    lease = await acquireLease(locator, { wait: true, signal: AbortSignal.timeout(waitMs) });
  } catch (error) {
    // An abort reason is recognized by name: it may come from another realm.
    if ((error as { name?: unknown } | null)?.name !== "TimeoutError") throw error;
    throw new CorePortFailure({
      code: "graph_already_open",
      message: "the graph is open in another tab",
      retryable: true,
    });
  }
  try {
    return await action();
  } finally {
    lease.release();
  }
}
