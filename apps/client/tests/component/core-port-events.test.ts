import { describe, expect, it } from "vitest";
import { openWasmSession } from "./wasm-test-port";
import { SEMANTIC_EVENTS } from "../../src/generated/core-port";

describe("CorePort semantic events", () => {
  it("keeps the generated PascalCase vocabulary through subscription", async () => {
    const { session, port, graphHandle } = await openWasmSession("typed-events");

    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    const batch = await port.subscribe({ graph_handle: graphHandle, after_cursor: 0 });

    expect(new Set(SEMANTIC_EVENTS).size).toBe(SEMANTIC_EVENTS.length);
    expect(batch.events[0]).toMatchObject({
      source: "local",
      kind: { type: "semantic", name: "PageEnsured" },
    });
    await session.close();
  });
});
