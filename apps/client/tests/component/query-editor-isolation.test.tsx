import { act } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { contentSessionsFor } from "../../src/features/blocks/editor/content-session";
import { useQueryResultEditor } from "../../src/features/query/edit";
import { useSession } from "../../src/features/shell/session-context";
import { useI18n } from "../../src/i18n";
import { GRAPH_ID, mountAt } from "./harness";

describe("query result editor", () => {
  it("does not re-render while another block is typed in", async () => {
    // Every visible query owns one editor; typing anywhere must not repaint them.
    let renders = 0;
    function Probe() {
      const session = useSession();
      const [state] = useState(() => session.getState());
      const { message } = useI18n();
      useQueryResultEditor({ session, state, enabled: true, message });
      renders += 1;
      return null;
    }
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, <Probe />);
    const inserted = await harness.settle(async () => {
      await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
      return harness.session.execute({
        type: "insert_block",
        owner: { kind: "page", id: "home" },
        parent: null,
        index: 0,
        markdown: "typed",
      });
    });
    const before = renders;

    const content = contentSessionsFor(harness.session).open(
      { kind: "page", id: "home" },
      inserted.created_block!,
      [{ type: "markdown", value: "typed" }],
    );
    act(() => content.splice(0, 0, [{ type: "markdown", value: "x" }]));
    act(() => content.splice(1, 0, [{ type: "markdown", value: "y" }]));

    expect(renders).toBe(before);
  });
});
