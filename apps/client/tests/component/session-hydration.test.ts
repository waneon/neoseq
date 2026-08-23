import { describe, expect, it } from "vitest";
import { GraphSession } from "../../src/core-port/session";
import { findBlock, findPage, findTag, outlineOwnerKey } from "../../src/core-port/snapshot";
import { FakeCorePort } from "../../src/core-port/testing/fake-core-port";

class TrackingCorePort extends FakeCorePort {
  readonly readOwners: string[] = [];

  override async readOutline(request: Parameters<FakeCorePort["readOutline"]>[0]) {
    this.readOwners.push(outlineOwnerKey(request.owner));
    return super.readOutline(request);
  }
}

describe("outline hydration", () => {
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
});
