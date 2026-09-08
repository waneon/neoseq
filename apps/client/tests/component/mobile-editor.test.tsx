import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { findPage } from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";

async function mountMobileOutline() {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    for (const [index, markdown] of ["Parent", "A thought"].entries()) {
      await harness.session.execute({
        type: "insert_block",
        owner: { kind: "page", id: "home" },
        parent: null,
        index,
        markdown,
      });
    }
  });
  await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));
  return { ...harness, page: () => findPage(harness.session.getState().snapshot, "home")! };
}

function compactLayout() {
  const matchMedia = window.matchMedia.bind(window);
  return vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...matchMedia(query),
    matches: query === "(max-width: 840px)",
  }));
}

describe("mobile outline writing", () => {
  it("keeps the native caret through structural taps and saves the last edit on Done", async () => {
    const media = compactLayout();
    try {
      const harness = await mountMobileOutline();
      const user = userEvent.setup();
      const input = screen.getAllByLabelText("Block text")[1] as HTMLTextAreaElement;
      await user.click(input);
      input.setSelectionRange(2, 5);
      const toolbar = within(screen.getByTestId("mobile-editor-toolbar"));
      await harness.settle(() =>
        user.click(toolbar.getByRole("button", { name: "Indent", exact: true })),
      );
      await waitFor(() => expect(harness.page().blocks[0].children[0]?.markdown).toBe("A thought"));
      expect(input).toHaveFocus();
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
      await harness.settle(() =>
        user.click(toolbar.getByRole("button", { name: "Outdent", exact: true })),
      );
      await waitFor(() => expect(harness.page().blocks).toHaveLength(2));
      expect(input).toHaveFocus();
      await harness.settle(() => {
        fireEvent.change(input, { target: { value: "A thought worth keeping" } });
        fireEvent.click(toolbar.getByRole("button", { name: "Done", exact: true }));
      });
      await waitFor(() =>
        expect(harness.page().blocks[1].markdown).toBe("A thought worth keeping"),
      );
      expect(screen.queryByTestId("mobile-editor-toolbar")).not.toBeInTheDocument();
      expect(input).not.toHaveFocus();
    } finally {
      media.mockRestore();
    }
  });

  it("offers block actions by tap and a separate visible fold for parent rows", async () => {
    const media = compactLayout();
    try {
      const harness = await mountMobileOutline();
      await harness.settle(() => {
        fireEvent.click(screen.getAllByTestId("mobile-block-handle")[1]);
      });
      expect(await screen.findByTestId("menu-properties")).toBeInTheDocument();
      await harness.settle(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: /^Indent/ }));
        await harness.session.executePrepared(() => null);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      await waitFor(() => expect(harness.page().blocks[0].children).toHaveLength(1));
      const parent = screen.getAllByTestId("mobile-block-handle")[0];
      expect(parent).toHaveAccessibleName("Collapse");
      await harness.settle(() => {
        fireEvent.click(parent);
      });
      expect(screen.getAllByLabelText("Block text")).toHaveLength(1);
      expect(parent).toHaveAccessibleName("Expand");
      await harness.settle(() => {
        fireEvent.click(parent);
      });
      expect(screen.getAllByLabelText("Block text")).toHaveLength(2);
      expect(harness.page().blocks[0].children[0].markdown).toBe("A thought");
    } finally {
      media.mockRestore();
    }
  });
});
