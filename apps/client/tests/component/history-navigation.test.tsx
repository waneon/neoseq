import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useHistoryActions } from "../../src/features/history/context";
import { PageView } from "../../src/features/page/PageView";
import { GRAPH_ID, mountAt } from "./harness";

function HistoryPage() {
  const history = useHistoryActions();
  return (
    <>
      <button
        type="button"
        onClick={() => void history.run("undo", { kind: "global-shortcut" })}
      >
        Undo history
      </button>
      <PageView />
    </>
  );
}

describe("history navigation", () => {
  it("expands collapsed ancestors before revealing a same-page target", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/p/home`, <HistoryPage />);
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    const parent = await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: null,
      index: 0,
      markdown: "parent",
    });
    const child = await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: parent.created_block,
      index: 0,
      markdown: "before",
    });
    await session.execute({
      type: "edit_markdown",
      page_id: "home",
      block_id: child.created_block!,
      markdown: "after",
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));
    await user.click(screen.getAllByRole("button", { name: "Collapse" })[0]);
    expect(screen.getAllByLabelText("Block text")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Undo history" }));

    await waitFor(() => {
      expect(screen.getAllByLabelText("Block text")).toHaveLength(2);
      expect(screen.getAllByLabelText("Block text")[1]).toHaveValue("before");
    });
    expect(screen.getAllByRole("treeitem")[1]).toHaveAttribute("data-revealed", "true");
  });

  it("moves to a cross-page block target and reveals it without stealing focus", async () => {
    const { session, router } = await mountAt(
      `/g/${GRAPH_ID}/p/home`,
      <HistoryPage />,
    );
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await session.execute({ type: "ensure_page", page_id: "target", title: "Target" });
    await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: null,
      index: 0,
      markdown: "stay here",
    });
    const inserted = await session.execute({
      type: "insert_block",
      page_id: "target",
      parent: null,
      index: 0,
      markdown: "before",
    });
    await session.execute({
      type: "edit_markdown",
      page_id: "target",
      block_id: inserted.created_block!,
      markdown: "after",
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Undo history" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/g/${GRAPH_ID}/p/target`);
      expect(screen.getByLabelText("Block text")).toHaveValue("before");
    });
    const textarea = screen.getByLabelText("Block text");
    expect(textarea.closest('[role="treeitem"]')).toHaveAttribute("data-revealed", "true");
    expect(document.activeElement).not.toBe(textarea);
  });

  it("keeps the current route for graph-wide history effects", async () => {
    const { session, router } = await mountAt(
      `/g/${GRAPH_ID}/p/home`,
      <HistoryPage />,
    );
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await session.execute({ type: "ensure_tag", tag_id: "topic", name: "Topic" });
    await session.execute({ type: "delete_tag", tag_id: "topic" });

    await userEvent.setup().click(screen.getByRole("button", { name: "Undo history" }));

    await waitFor(() => expect(session.getState().snapshot.tags[0]?.id).toBe("topic"));
    expect(router.state.location.pathname).toBe(`/g/${GRAPH_ID}/p/home`);
  });
});
