import { describe, expect, it } from "vitest";
import { GraphSession } from "../../src/core-port/session";
import { findBlock, findPage } from "../../src/core-port/snapshot";
import { FakeCorePort } from "../../src/core-port/testing/fake-core-port";

class TrackingCorePort extends FakeCorePort {
  readonly readPageIds: string[] = [];

  override async readPage(request: Parameters<FakeCorePort["readPage"]>[0]) {
    this.readPageIds.push(request.page_id);
    return super.readPage(request);
  }
}

describe("page hydration", () => {
  it("deduplicates entity pages and publishes one canonical snapshot", async () => {
    const port = new TrackingCorePort();
    const seed = new GraphSession("hydration-test", port);
    await seed.open();
    await seed.execute({ type: "ensure_page", page_id: "one", title: "One" });
    await seed.execute({
      type: "insert_block",
      page_id: "one",
      parent: null,
      index: 0,
      markdown: "First canonical block",
    });
    await seed.execute({ type: "ensure_page", page_id: "two", title: "Two" });
    await seed.execute({
      type: "insert_block",
      page_id: "two",
      parent: null,
      index: 0,
      markdown: "Second canonical block",
    });
    await seed.close();

    const session = new GraphSession("hydration-test", port);
    await session.open();
    port.readPageIds.length = 0;
    let publications = 0;
    const unsubscribe = session.subscribe(() => {
      publications += 1;
    });

    await session.hydratePages(["two", "one", "two", "missing"]);

    expect(port.readPageIds).toEqual(["two", "one"]);
    expect(publications).toBe(1);
    expect(session.getState().hydratedPages).toEqual(new Set(["two", "one"]));
    const one = findPage(session.getState().snapshot, "one");
    const two = findPage(session.getState().snapshot, "two");
    expect(one && findBlock(one, "b-1")?.markdown).toBe("First canonical block");
    expect(two && findBlock(two, "b-2")?.markdown).toBe("Second canonical block");

    unsubscribe();
    await session.close();
  });
});
