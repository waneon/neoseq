import { afterEach, describe, expect, it } from "vitest";
import type { GraphSession } from "../../src/core-port/session";
import { findPage } from "../../src/core-port/snapshot";
import { projectBuffer, spliceBuffer } from "../../src/features/blocks/editor/content-buffer";
import { contentSessionsFor } from "../../src/features/blocks/editor/content-session";
import { openWasmSession } from "./wasm-test-port";

const owner = { kind: "page", id: "home" } as const;
const sessions: GraphSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function openContent(markdown = "abcdef") {
  const opened = await openWasmSession();
  sessions.push(opened.session);
  const { session } = opened;
  await session.execute({ type: "ensure_page", page_id: owner.id, title: "Home" });
  await session.execute({ type: "insert_block", owner, parent: null, index: 0, markdown });
  await session.hydrateOutline(owner);
  const block = findPage(session.getState().snapshot, owner.id)!.blocks[0];
  const store = contentSessionsFor(session);
  const target = store.open(owner, block.id, block.content);
  return { ...opened, block, store, target };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("graph content sessions", () => {
  it("shares one target and lowers after a preceding canonical change", async () => {
    const { session, port, store, target, block } = await openContent();
    const otherSurface = store.open({ ...owner }, block.id, block.content);
    expect(otherSurface).toBe(target);
    const entered = gate();
    const resume = gate();
    port.beforeExecute = async () => {
      port.beforeExecute = null;
      entered.release();
      await resume.promise;
    };
    const preceding = session.execute({
      type: "splice_block_contents",
      owner,
      splices: [
        { block_id: block.id, index: 1, delete: 0, insert: [{ type: "markdown", value: "X" }] },
        { block_id: block.id, index: 5, delete: 0, insert: [{ type: "markdown", value: "Y" }] },
      ],
    });
    await entered.promise;
    target.replace(spliceBuffer(target.buffer, 3, 0, [{ type: "markdown", value: "L" }]));
    expect(projectBuffer(otherSurface.buffer, []).markdown).toBe("abcLdef");
    const save = otherSurface.submit();
    resume.release();
    await preceding;
    await save;
    expect(findPage(session.getState().snapshot, owner.id)!.blocks[0].markdown).toBe("aXbcLdYef");
  });

  it("restores rejected edits with newer input for one subsequent submission", async () => {
    const { session, port, target } = await openContent("ab");
    const entered = gate();
    const resume = gate();
    target.replace(spliceBuffer(target.buffer, 1, 0, [{ type: "markdown", value: "X" }]));
    port.beforeExecute = async () => {
      port.beforeExecute = null;
      entered.release();
      await resume.promise;
      throw new Error("rejected before application");
    };
    const failed = target.submit().catch((error: unknown) => error);
    await entered.promise;
    target.replace(spliceBuffer(target.buffer, 3, 0, [{ type: "markdown", value: "Y" }]));
    resume.release();
    expect(await failed).toBeInstanceOf(Error);
    expect(projectBuffer(target.buffer, []).markdown).toBe("aXbY");
    await target.submit();
    expect(findPage(session.getState().snapshot, owner.id)!.blocks[0].markdown).toBe("aXbY");
  });

  it("retains a rejected semantic action across surfaces even without a text diff", async () => {
    const { session, port, store, target, block } = await openContent("ab");
    const stop = target.observe(() => {});
    port.beforeExecute = async () => {
      port.beforeExecute = null;
      throw new Error("rejected");
    };
    await expect(
      target.submit([{ type: "ensure_page", page_id: "chosen", title: "Chosen" }]),
    ).rejects.toThrow();
    stop();
    expect(target.hasPendingActions).toBe(true);
    expect(store.buffers(owner).has(block.id)).toBe(true);
    const nextSurface = store.open(owner, block.id, block.content);
    nextSurface.edit("ab tail", []);
    await nextSurface.submit();
    expect(findPage(session.getState().snapshot, "chosen")).toBeDefined();
    expect(findPage(session.getState().snapshot, owner.id)!.blocks[0].markdown).toBe("ab tail");
    expect(nextSurface.hasPendingActions).toBe(false);
  });

  it("keeps applied but unsaved content as the source of subsequent input", async () => {
    const { session, port, target } = await openContent("ab");
    target.replace(spliceBuffer(target.buffer, 1, 0, [{ type: "markdown", value: "X" }]));
    port.failNextSave = {
      code: "storage_full",
      message: "disk unavailable",
      retryable: true,
    };
    await expect(target.submit()).resolves.toEqual({ newerInput: false });
    expect(session.getState().save.kind).toBe("unsaved");
    expect(projectBuffer(target.buffer, []).markdown).toBe("aXb");
    target.replace(spliceBuffer(target.buffer, 3, 0, [{ type: "markdown", value: "Y" }]));
    await session.retry();
    await target.submit();
    expect(findPage(session.getState().snapshot, owner.id)!.blocks[0].markdown).toBe("aXbY");
  });

  it("retains an unavailable block draft and refuses to write stale positions", async () => {
    const { session, target, block } = await openContent();
    target.replace(spliceBuffer(target.buffer, 3, 0, [{ type: "markdown", value: "L" }]));
    await session.execute({ type: "delete_blocks", owner, block_ids: [block.id] });
    expect(projectBuffer(target.buffer, []).markdown).toBe("abcLdef");
    await expect(target.submit()).rejects.toMatchObject({
      detail: { code: "invalid_request", retryable: false },
    });
  });

  it("discards idle clean buffers when their last surface leaves", async () => {
    const { store, target, block } = await openContent();
    const unobserve = target.observe(() => {});
    expect(store.buffers(owner).has(block.id)).toBe(true);
    unobserve();
    await Promise.resolve();
    expect(store.buffers(owner).has(block.id)).toBe(false);
  });

  it("keeps the target identity across an effect cleanup and immediate reattachment", async () => {
    const { session, store, target, block } = await openContent();
    target.observe(() => {})();
    let publications = 0;
    const unobserve = target.observe(() => {
      publications += 1;
    });
    await Promise.resolve();
    expect(store.target(owner, block.id)).toBe(target);
    await session.execute({
      type: "splice_block_content",
      owner,
      block_id: block.id,
      index: 0,
      delete: 0,
      insert: [{ type: "markdown", value: "X" }],
    });
    expect(publications).toBe(1);
    unobserve();
  });
});

it("recovers a retained draft when a refresh restores its source", async () => {
  const { session, port, target, block } = await openContent();
  // A lost event forces a full refresh without position mappings.
  const subscribe = port.subscribe.bind(port);
  port.subscribe = async (request) => ({ ...(await subscribe(request)), resync_required: true });
  target.edit("abcLdef", []);
  await session.execute({
    type: "splice_block_content",
    owner,
    block_id: block.id,
    index: 1,
    delete: 0,
    insert: [{ type: "markdown", value: "X" }],
  });
  await expect(target.submit()).rejects.toMatchObject({ detail: { code: "invalid_request" } });
  await session.execute({
    type: "splice_block_content",
    owner,
    block_id: block.id,
    index: 1,
    delete: 1,
    insert: [],
  });
  await target.submit();
  expect(findPage(session.getState().snapshot, owner.id)!.blocks[0].markdown).toBe("abcLdef");
});
