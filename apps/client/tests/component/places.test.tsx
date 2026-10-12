// Places the shell offers beyond a single document: the page directory, the
// continuous journal, and this browser's recent visits.

import { renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { findJournalPage } from "../../src/core-port/snapshot";
import { addDays } from "../../src/entities/calendar";
import { todayLocalDate } from "../../src/entities/journal";
import { recordVisit, useRecentVisits } from "../../src/features/shell/recent";
import { GRAPH_ID, mountAt } from "./harness";

describe("page directory", () => {
  it("lists regular pages by name, filters them, and counts incoming links", async () => {
    const user = userEvent.setup();
    const { session, settle } = await mountAt(`/g/${GRAPH_ID}/pages`);
    await settle(async () => {
      await session.execute({ type: "ensure_page", page_id: "b", title: "Beta notes" });
      await session.execute({ type: "ensure_page", page_id: "a", title: "Alpha plan" });
      await session.execute({
        type: "insert_block",
        owner: { kind: "page", id: "a" },
        parent: null,
        index: 0,
        markdown: "",
      });
    });
    await settle(() => session.hydratePage("a"));
    const blockId = session.getState().snapshot.pages.find((page) => page.id === "a")!.blocks[0].id;
    await settle(() =>
      session.execute({
        type: "splice_block_content",
        owner: { kind: "page", id: "a" },
        block_id: blockId,
        index: 0,
        delete: 0,
        insert: [{ type: "page_reference", page_id: "b" }],
      }),
    );

    const directory = screen.getByTestId("pages-directory");
    const links = () => within(directory).getAllByTestId("pages-row-link");
    await waitFor(() =>
      expect(links().map((link) => link.textContent)).toEqual(["Alpha plan", "Beta notes"]),
    );
    const beta = links()[1].closest('[role="row"]')!;
    await waitFor(() =>
      expect(within(beta as HTMLElement).getAllByRole("cell")[1]).toHaveTextContent("1"),
    );

    await user.type(within(directory).getByRole("searchbox", { name: "Filter pages" }), "beta");
    expect(links().map((link) => link.textContent)).toEqual(["Beta notes"]);
  });
});

describe("continuous journal", () => {
  it("continues below today with earlier days that can be edited in place", async () => {
    const user = userEvent.setup();
    const today = todayLocalDate();
    const yesterday = addDays(today, -1);
    const { session, router, settle } = await mountAt(`/g/${GRAPH_ID}/journal`);
    await settle(() => session.execute({ type: "ensure_journal", date: addDays(today, -2) }));
    await settle(() => session.execute({ type: "ensure_journal", date: yesterday }));
    const page = findJournalPage(session.getState().snapshot, yesterday)!;
    await settle(() =>
      session.execute({
        type: "insert_block",
        owner: { kind: "page", id: page.id },
        parent: null,
        index: 0,
        markdown: "Picked up from yesterday",
      }),
    );

    // The empty day before yesterday adds nothing; yesterday follows today.
    const day = await screen.findByTestId("journal-day");
    expect(screen.getAllByTestId("journal-day")).toHaveLength(1);
    expect(day).toHaveTextContent("Yesterday");
    const editor = within(day).getByRole("textbox", { name: "Block text" });
    expect(editor).toHaveValue("Picked up from yesterday");
    await user.click(editor);
    await user.keyboard("{End}, continued");
    await settle(() => editor.blur());
    await waitFor(() =>
      expect(findJournalPage(session.getState().snapshot, yesterday)!.blocks[0].markdown).toBe(
        "Picked up from yesterday, continued",
      ),
    );

    await user.click(within(day).getByRole("link"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/g/${GRAPH_ID}/journal/${yesterday}`),
    );
  });

  it("states how far a journal day is from today", async () => {
    const date = addDays(todayLocalDate(), -3);
    await mountAt(`/g/${GRAPH_ID}/journal/${date}`);
    expect(await screen.findByTestId("journal-distance")).toHaveTextContent("3 days ago");
  });
});

describe("recent visits", () => {
  it("keeps the newest visit first without duplicates", () => {
    const scope = `test:${crypto.randomUUID()}`;
    recordVisit(scope, { kind: "page", id: "one" });
    recordVisit(scope, { kind: "tag", id: "two" });
    recordVisit(scope, { kind: "page", id: "one" });
    const { result } = renderHook(() => useRecentVisits(scope));
    expect(result.current).toEqual([
      { kind: "page", id: "one" },
      { kind: "tag", id: "two" },
    ]);
  });
});
