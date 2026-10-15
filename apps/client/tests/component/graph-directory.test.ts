// Each graph's directory entry is stored alone, so tabs cannot overwrite each other's.

import { afterEach, expect, it } from "vitest";
import { graphName, registerGraph, renameGraph } from "../../src/core-port/directory";

afterEach(() => localStorage.clear());

it("moves the shared directory into one entry per graph", () => {
  localStorage.setItem(
    "neoseq.graph-directory.v2",
    JSON.stringify({
      '["local","g-1"]': { repository_id: "local", graph_id: "g-1", name: "One", created_at: "t" },
      '["local","g-2"]': { repository_id: "local", graph_id: "g-2", name: "Two", created_at: "t" },
    }),
  );
  expect(graphName("g-1")).toBe("One");
  expect(graphName("g-2")).toBe("Two");
  expect(localStorage.getItem("neoseq.graph-directory.v2")).toBeNull();
});

it("writes only the graph that changed", () => {
  const first = registerGraph("First");
  const second = registerGraph("Second");
  const before = localStorage.getItem(`neoseq.graph-directory.v3:["local","${first.id}"]`);
  renameGraph(second.id, "Renamed");
  expect(localStorage.getItem(`neoseq.graph-directory.v3:["local","${first.id}"]`)).toBe(before);
  expect(graphName(second.id)).toBe("Renamed");
});
