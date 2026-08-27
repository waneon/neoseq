import { describe, expect, it } from "vitest";
import { GraphSession } from "../../src/core-port/session";
import type { StorageCapabilitiesDto } from "../../src/generated/core-port";
import { findBlock, findPage, findTag, outlineOwnerKey } from "../../src/core-port/snapshot";
import { FakeCorePort } from "../../src/core-port/testing/fake-core-port";

class TrackingCorePort extends FakeCorePort {
  readonly readOwners: string[] = [];
  summaryReads = 0;

  override async read(request: Parameters<FakeCorePort["read"]>[0]) {
    this.summaryReads += 1;
    return super.read(request);
  }

  override async readOutline(request: Parameters<FakeCorePort["readOutline"]>[0]) {
    this.readOwners.push(outlineOwnerKey(request.owner));
    return super.readOutline(request);
  }
}

class DeferredCapabilitiesPort extends FakeCorePort {
  private resolveCapabilities!: (value: StorageCapabilitiesDto) => void;
  private readonly pendingCapabilities = new Promise<StorageCapabilitiesDto>((resolve) => {
    this.resolveCapabilities = resolve;
  });

  override async openGraph(request: Parameters<FakeCorePort["openGraph"]>[0]) {
    const opened = await super.openGraph(request);
    return { ...opened, capabilities: undefined };
  }

  storageCapabilities(): Promise<StorageCapabilitiesDto> {
    return this.pendingCapabilities;
  }

  completeCapabilities(value: StorageCapabilitiesDto): void {
    this.resolveCapabilities(value);
  }
}

describe("outline hydration", () => {
  it("publishes the canonical document before capability discovery finishes", async () => {
    const port = new DeferredCapabilitiesPort();
    const session = new GraphSession("staged-open-test", port);

    await session.open();

    expect(session.getState().status).toBe("ready");
    expect(session.getState().capabilities).toBeNull();
    const capabilitiesPublished = new Promise<void>((resolve) => {
      const unsubscribe = session.subscribe(() => {
        if (!session.getState().capabilities) return;
        unsubscribe();
        resolve();
      });
    });
    port.completeCapabilities({
      durable: true,
      persisted: true,
      quota_bytes: 10_000,
      usage_bytes: 1_000,
    });
    await capabilitiesPublished;

    expect(session.getState().capabilities?.durable).toBe(true);
    await session.close();
  });

  it("deduplicates page and tag owners and publishes one canonical snapshot", async () => {
    const port = new TrackingCorePort();
    const seed = new GraphSession("hydration-test", port);
    await seed.open();
    await seed.execute({ type: "ensure_page", page_id: "one", title: "One" });
    await seed.execute({
      type: "insert_block",
      owner: { kind: "page", id: "one" },
      parent: null,
      index: 0,
      markdown: "First canonical block",
    });
    await seed.execute({ type: "ensure_page", page_id: "two", title: "Two" });
    await seed.execute({
      type: "insert_block",
      owner: { kind: "page", id: "two" },
      parent: null,
      index: 0,
      markdown: "Second canonical block",
    });
    await seed.execute({ type: "ensure_tag", tag_id: "topic", name: "Topic" });
    await seed.execute({
      type: "insert_block",
      owner: { kind: "tag", id: "topic" },
      parent: null,
      index: 0,
      markdown: "Tag canonical block",
    });
    await seed.close();

    const session = new GraphSession("hydration-test", port);
    await session.open();
    port.readOwners.length = 0;
    let publications = 0;
    const unsubscribe = session.subscribe(() => {
      publications += 1;
    });

    await session.hydrateOutlines([
      { kind: "page", id: "two" },
      { kind: "tag", id: "topic" },
      { kind: "page", id: "one" },
      { kind: "tag", id: "topic" },
      { kind: "page", id: "missing" },
    ]);

    expect(port.readOwners).toEqual(["page:two", "tag:topic", "page:one"]);
    expect(publications).toBe(1);
    expect(session.getState().hydratedOutlines).toEqual(
      new Set(["page:two", "tag:topic", "page:one"]),
    );
    const one = findPage(session.getState().snapshot, "one");
    const two = findPage(session.getState().snapshot, "two");
    expect(one && findBlock(one, "b-1")?.markdown).toBe("First canonical block");
    expect(two && findBlock(two, "b-2")?.markdown).toBe("Second canonical block");
    const topic = findTag(session.getState().snapshot, "topic");
    expect(topic && findBlock(topic, "b-3")?.markdown).toBe("Tag canonical block");

    unsubscribe();
    await session.close();
  });

  it("reconciles an acknowledged content splice without rereading the owner", async () => {
    const port = new TrackingCorePort();
    const session = new GraphSession("content-patch-test", port);
    await session.open();
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    const inserted = await session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "Before",
    });
    port.readOwners.length = 0;
    port.summaryReads = 0;

    await session.execute({
      type: "splice_block_content",
      owner: { kind: "page", id: "home" },
      block_id: inserted.created_block!,
      index: 0,
      delete: 6,
      insert: [{ type: "markdown", value: "After" }],
    });

    expect(port.summaryReads).toBe(0);
    expect(port.readOwners).toEqual([]);
    const page = findPage(session.getState().snapshot, "home");
    expect(page && findBlock(page, inserted.created_block!)?.markdown).toBe("After");
    await session.close();
  });
});
