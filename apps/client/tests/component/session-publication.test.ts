import { describe, expect, it, vi } from "vitest";
import { CorePortFailure } from "../../src/core-worker";
import { envelope } from "../../src/core-port/commands";
import { GraphSession } from "../../src/core-port/session";
import { findBlock, findPage } from "../../src/core-port/snapshot";
import type { ExecuteResponse } from "../../src/generated/core-port";
import { WasmTestPort } from "./wasm-test-port";

const OWNER = { kind: "page", id: "home" } as const;
const STORAGE_FAILURE = {
  code: "storage_full",
  message: "Storage is full",
  retryable: true,
} as const;

class PublicationFaultPort extends WasmTestPort {
  failNextRead = false;
  nextEventGap: "resync" | "remote" | null = null;
  lastExecution: ExecuteResponse | null = null;

  override async execute(request: Parameters<WasmTestPort["execute"]>[0]) {
    const result = await super.execute(request);
    this.lastExecution = result;
    return result;
  }

  override async read(request: Parameters<WasmTestPort["read"]>[0]) {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new CorePortFailure({
        code: "internal",
        message: "Authoritative read failed",
        retryable: true,
      });
    }
    return super.read(request);
  }

  override async subscribe(request: Parameters<WasmTestPort["subscribe"]>[0]) {
    const batch = await super.subscribe(request);
    const gap = this.nextEventGap;
    this.nextEventGap = null;
    if (gap === "resync") return { ...batch, resync_required: true };
    if (gap === "remote") {
      return {
        ...batch,
        events: batch.events.map((event) => ({ ...event, source: "remote" as const })),
      };
    }
    return batch;
  }
}

async function openBlock(graphId: string) {
  const port = new PublicationFaultPort();
  const session = new GraphSession(graphId, port);
  await session.open();
  await session.execute({ type: "ensure_page", page_id: OWNER.id, title: "Home" });
  const inserted = await session.execute({
    type: "insert_block",
    owner: OWNER,
    parent: null,
    index: 0,
    markdown: "abc",
  });
  await session.hydratePage(OWNER.id);
  const blockId = inserted.created_block!;
  const markdown = () =>
    findBlock(findPage(session.getState().snapshot, OWNER.id)!, blockId)!.markdown;
  return { session, port, blockId, markdown };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("canonical session publication", () => {
  it("prepares a splice after the earlier mutation has published its canonical content", async () => {
    const { session, port, blockId, markdown } = await openBlock("prepared-publication");
    const entered = deferred();
    const release = deferred();
    port.beforeExecute = async () => {
      port.beforeExecute = null;
      entered.resolve();
      await release.promise;
    };
    const first = session.execute({
      type: "splice_block_content",
      owner: OWNER,
      block_id: blockId,
      index: 0,
      delete: 0,
      insert: [{ type: "markdown", value: "X" }],
    });
    const prepare = vi.fn(() => {
      expect(markdown()).toBe("Xabc");
      return {
        type: "splice_block_content" as const,
        owner: OWNER,
        block_id: blockId,
        index: Array.from(markdown()).length,
        delete: 0,
        insert: [{ type: "markdown" as const, value: "!" }],
      };
    });
    const second = session.executePrepared(prepare);
    await entered.promise;
    expect(prepare).not.toHaveBeenCalled();
    expect(markdown()).toBe("abc");

    release.resolve();
    await Promise.all([first, second]);

    expect(prepare).toHaveBeenCalledOnce();
    expect(markdown()).toBe("Xabc!");
    await session.close();
  });

  it.each(["saved", "unsaved"] as const)(
    "preserves an applied command and its %s durability when reconciliation fails",
    async (durability) => {
      const port = new PublicationFaultPort();
      const session = new GraphSession(`applied-read-failure-${durability}`, port);
      await session.open();
      if (durability === "unsaved") port.failNextSave = STORAGE_FAILURE;
      port.failNextRead = true;

      const failure = await session
        .execute({ type: "ensure_page", page_id: OWNER.id, title: "Home" })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CorePortFailure);
      expect((failure as CorePortFailure).applied).toEqual(port.lastExecution!.result);
      expect((failure as CorePortFailure).applied?.created_page).toBe(OWNER.id);
      expect((failure as CorePortFailure).detail.message).toBe("Authoritative read failed");
      expect(session.getState().save).toEqual(
        durability === "saved"
          ? { kind: "saved", sequence: 1 }
          : { kind: "unsaved", ...STORAGE_FAILURE },
      );
      // A failed presentation read does not roll back the authoritative command.
      const authoritative = await port.read({ graph_handle: port.graphHandle });
      expect(authoritative.summary.pages.some((page) => page.id === OWNER.id)).toBe(true);
      if (durability === "unsaved") await session.retry();
      await session.close();
    },
  );

  it("keeps a successful durability retry saved if the following read fails", async () => {
    const port = new PublicationFaultPort();
    const session = new GraphSession("retry-publication-failure", port);
    await session.open();
    port.failNextSave = STORAGE_FAILURE;
    await expect(
      session.execute({ type: "ensure_page", page_id: OWNER.id, title: "Home" }),
    ).resolves.toMatchObject({ created_page: OWNER.id });
    expect(session.getState().save.kind).toBe("unsaved");
    port.failNextRead = true;

    await session.retry();

    expect(session.getState().save).toEqual({ kind: "saved", sequence: 1 });
    await session.execute({ type: "ensure_page", page_id: "next", title: "Next" });
    expect(session.getState().save).toEqual({ kind: "saved", sequence: 2 });
    await session.close();
  });

  it("recovers a failed publication before preparing the next content edit", async () => {
    const { session, port, blockId, markdown } = await openBlock("prepared-recovery");
    port.nextEventGap = "resync";
    port.failNextRead = true;
    const first = session
      .execute({
        type: "splice_block_content",
        owner: OWNER,
        block_id: blockId,
        index: 0,
        delete: 0,
        insert: [{ type: "markdown", value: "X" }],
      })
      .catch((error: unknown) => error);
    const prepare = vi.fn(() => {
      expect(markdown()).toBe("Xabc");
      expect(session.getState().lastChange).toBeNull();
      return {
        type: "splice_block_content" as const,
        owner: OWNER,
        block_id: blockId,
        index: Array.from(markdown()).length,
        delete: 0,
        insert: [{ type: "markdown" as const, value: "!" }],
      };
    });
    const second = session.executePrepared(prepare);

    expect(await first).toBeInstanceOf(CorePortFailure);
    await second;

    expect(prepare).toHaveBeenCalledOnce();
    expect(markdown()).toBe("Xabc!");
    await session.close();
  });

  it("recovers canonical publication before assigning an answer its execution revision", async () => {
    const { session, port, blockId, markdown } = await openBlock("answer-recovery");
    const before = session.getState().canonicalRevision;
    port.nextEventGap = "resync";
    port.failNextRead = true;
    await expect(
      session.execute({
        type: "splice_block_content",
        owner: OWNER,
        block_id: blockId,
        index: 0,
        delete: 0,
        insert: [{ type: "markdown", value: "X" }],
      }),
    ).rejects.toBeInstanceOf(CorePortFailure);
    expect(markdown()).toBe("abc");

    const frame = await session.queryFrame({
      kind: "raw_sparql",
      language: "sparql-1.1/neoseq-v1",
      source: "ASK { ?s ?p ?o }",
      bindings: {},
    });

    expect(markdown()).toBe("Xabc");
    expect(frame.canonicalRevision).toBe(before + 1);
    expect(frame.canonicalRevision).toBe(session.getState().canonicalRevision);
    expect(frame.result).toMatchObject({ kind: "ask", value: true });
    expect(session.getState().lastChange).toBeNull();
    await session.close();
  });

  it.each(["resync", "remote"] as const)(
    "discards a partial content mapping after a %s event gap",
    async (gap) => {
      const { session, port, blockId, markdown } = await openBlock(`publication-gap-${gap}`);
      // The CorePort has a change the frontend has not observed. Its next local
      // receipt describes only the subsequent splice, not this missing prefix.
      await port.execute({
        graph_handle: port.graphHandle,
        command: envelope(session.graphId, {
          type: "splice_block_content",
          owner: OWNER,
          block_id: blockId,
          index: 0,
          delete: 0,
          insert: [{ type: "markdown", value: "X" }],
        }),
      });
      expect(markdown()).toBe("abc");
      port.nextEventGap = gap;

      await session.execute({
        type: "splice_block_content",
        owner: OWNER,
        block_id: blockId,
        index: 4,
        delete: 0,
        insert: [{ type: "markdown", value: "!" }],
      });

      expect(markdown()).toBe("Xabc!");
      expect(session.getState().lastChange).toBeNull();
      await session.close();
    },
  );
});
