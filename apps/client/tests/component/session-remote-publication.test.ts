import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphSession, type SessionPort } from "../../src/core-port/session";
import { findPage } from "../../src/core-port/snapshot";
import { SyncAgent } from "../../src/features/sync/SyncAgent";
import type { SyncState } from "../../src/core-worker";
import { WasmTestPort } from "./wasm-test-port";

const OWNER = { kind: "page", id: "home" } as const;
const SYNC_STATE: SyncState = {
  version_vector: [],
  pending: 1,
  replica_id: 1,
  history_epoch: 1,
  has_server_base: true,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sessions: GraphSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.restoreAllMocks();
});

async function openRemote(graphId: string) {
  // Exercise real local execution and transport wake, with no network startup.
  vi.spyOn(SyncAgent.prototype, "start").mockImplementation(() => {});
  const port = Object.assign(new WasmTestPort(), {
    configureSync: vi.fn(async () => {}),
    syncState: vi.fn(async (): Promise<SyncState> => SYNC_STATE),
    nextSyncFrame: vi.fn(async () => null),
    acknowledgeOutbox: vi.fn(async () => {}),
    importRemote: vi.fn<NonNullable<SessionPort["importRemote"]>>(),
    replaceRemote: vi.fn(async () => {}),
    encodeSyncMessage: vi.fn(async () => new ArrayBuffer(0)),
    decodeSyncMessage: vi.fn<NonNullable<SessionPort["decodeSyncMessage"]>>(),
  });
  const session = new GraphSession(graphId, port, {
    repository_id: "remote",
    server_url: "https://sync.example.test",
    account_id: "account",
    username: "writer",
  });
  sessions.push(session);
  await session.open();
  await session.execute({ type: "ensure_page", page_id: OWNER.id, title: "Home" });
  const inserted = await session.execute({
    type: "insert_block",
    owner: OWNER,
    parent: null,
    index: 0,
    markdown: "headtail",
  });
  await session.hydrateOutline(OWNER);
  return { session, port, blockId: inserted.created_block! };
}

describe("remote local completion", () => {
  it("adopts a split and accepts the next edit while the outbox read is stalled", async () => {
    const { session, port, blockId } = await openRemote("remote-split-publication");
    const entered = deferred();
    const release = deferred();
    port.syncState.mockClear();
    port.syncState.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return SYNC_STATE;
    });
    try {
      const completion = session.execute({
        type: "split_block",
        owner: OWNER,
        block_id: blockId,
        index: 4,
        placement: "after",
      });
      await entered.promise;
      // This acknowledgement must finish before the transport barrier opens:
      // the outline uses it to replace its temporary row with the canonical ID.
      const result = await completion;
      expect(result.created_block).toBeTruthy();
      await session.execute({
        type: "splice_block_content",
        owner: OWNER,
        block_id: result.created_block!,
        index: 4,
        delete: 0,
        insert: [{ type: "markdown", value: "!" }],
      });
      expect(
        findPage(session.getState().snapshot, OWNER.id)!.blocks.map((b) => b.markdown),
      ).toEqual(["head", "tail!"]);
      expect(session.getState().save.kind).toBe("saved");
      expect(port.syncState).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
  });

  it("reports outbox failure as sync failure without rejecting a saved edit", async () => {
    const { session, port, blockId } = await openRemote("remote-wake-failure");
    port.syncState.mockRejectedValue(new Error("Outbox unavailable"));
    const syncFailure = new Promise<void>((resolve) => {
      const unsubscribe = session.subscribe(() => {
        if (session.getState().sync.kind !== "error") return;
        unsubscribe();
        resolve();
      });
    });
    await expect(
      session.execute({
        type: "split_block",
        owner: OWNER,
        block_id: blockId,
        index: 4,
        placement: "after",
      }),
    ).resolves.toMatchObject({ created_block: expect.any(String) });
    await syncFailure;
    expect(session.getState().save.kind).toBe("saved");
    expect(session.getState().sync).toMatchObject({ kind: "error" });
    expect(findPage(session.getState().snapshot, OWNER.id)!.blocks).toHaveLength(2);
  });

  it("finishes a local durability retry before the transport read finishes", async () => {
    const { session, port, blockId } = await openRemote("remote-retry-publication");
    port.failNextSave = { code: "storage_full", message: "Full", retryable: true };
    await session.execute({
      type: "split_block",
      owner: OWNER,
      block_id: blockId,
      index: 4,
      placement: "after",
    });
    expect(session.getState().save.kind).toBe("unsaved");
    const release = deferred();
    port.syncState.mockImplementation(async () => {
      await release.promise;
      return SYNC_STATE;
    });
    try {
      await session.retry();
      expect(session.getState().save.kind).toBe("saved");
      await session.executePrepared(() => null);
    } finally {
      release.resolve();
    }
  });
});
