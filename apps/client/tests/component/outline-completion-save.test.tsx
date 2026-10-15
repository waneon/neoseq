// Input typed while a completion menu is open must still reach the graph.

import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findPage } from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";

async function mountBlock() {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "alpha",
    });
  });
  const source = (await screen.findByLabelText("Block text")) as HTMLTextAreaElement;
  const user = userEvent.setup();
  await user.click(source);
  source.setSelectionRange(source.value.length, source.value.length);
  const saved = () => findPage(harness.session.getState().snapshot, "home")?.blocks[0].markdown;
  return { harness, user, saved };
}

describe("input held by an open completion", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { typed: " #pro", menu: "tag-menu" },
    { typed: " /cod", menu: "slash-menu" },
    { typed: " [[Ho", menu: "page-reference-menu" },
  ])("saves $typed once the menu closes without a choice", async ({ typed, menu }) => {
    const { user, saved } = await mountBlock();
    await user.keyboard(typed.replaceAll("[", "[["));
    expect(screen.getByTestId(menu)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(saved()).toMatch(/^alpha /));
    expect(saved()).toContain(typed.trim().slice(0, 3));
  });

  it("saves when the page is hidden while the menu is still open", async () => {
    const { user, saved } = await mountBlock();
    await user.keyboard(" #pro");
    expect(screen.getByTestId("tag-menu")).toBeInTheDocument();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(saved()).toBe("alpha #pro"));
  });
});
