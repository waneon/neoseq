// Documents sharing a name are listed by their own titles and kinds.

import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { envelope } from "../../src/core-port/commands";
import { DocumentNameConflicts } from "../../src/features/shell/DocumentNameConflicts";
import { WasmGraphCore } from "../../src/wasm/neoseq_core.js";
import { GRAPH_ID, mountAt } from "./harness";

it("names each clashing document as it is written", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/custom`, <DocumentNameConflicts />);
  const peer = WasmGraphCore.fromSnapshot(GRAPH_ID, 999n, harness.port.exportSnapshot());
  await harness.settle(() =>
    harness.session.execute({ type: "ensure_page", page_id: "plans", title: "Plans" }),
  );
  peer.executeJson(
    JSON.stringify(envelope(GRAPH_ID, { type: "ensure_tag", tag_id: "plans-tag", name: "PLANS" })),
    "2026-10-15T00:00:00Z",
  );
  const inbound = harness.session as unknown as { applyRemote(bytes: ArrayBuffer): Promise<void> };
  await harness.settle(() => inbound.applyRemote(peer.exportSnapshot().buffer as ArrayBuffer));
  const banner = await screen.findByTestId("document-name-conflicts");
  expect(banner).toHaveTextContent("Plans (Page)");
  expect(banner).toHaveTextContent("#PLANS (Tag)");
  peer.free();
});
