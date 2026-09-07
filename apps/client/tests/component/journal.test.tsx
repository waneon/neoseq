// Journal ensure + navigation + tombstones for deleted/missing pages.

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findJournalPage } from "../../src/core-port/snapshot";
import { setConfiguredTimezone, todayLocalDate } from "../../src/entities/journal";
import { GRAPH_ID, mountAt } from "./harness";

describe("journal and navigation", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["journal", "journal/2026-09-06"])(
    "follows the new local day from %s after a suspended tab resumes",
    async (route) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-06T14:59:30Z"));
      setConfiguredTimezone("Asia/Seoul");
      const { session, router, settle } = await mountAt(`/g/${GRAPH_ID}/${route}`);
      expect(screen.getByTestId("journal-calendar-trigger")).toHaveAttribute(
        "data-date",
        "2026-09-06",
      );
      vi.setSystemTime(new Date("2026-09-06T15:00:00Z"));
      await settle(() => fireEvent.focus(window));
      await waitFor(() => {
        expect(screen.getByTestId("journal-calendar-trigger")).toHaveAttribute(
          "data-date",
          "2026-09-07",
        );
        expect(findJournalPage(session.getState().snapshot, "2026-09-07")).toBeDefined();
      });
      expect(router.state.location.pathname).toBe(`/g/${GRAPH_ID}/journal`);
    },
  );

  it("keeps an explicitly selected historical day while today changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T14:59:30Z"));
    setConfiguredTimezone("Asia/Seoul");
    const { session } = await mountAt(`/g/${GRAPH_ID}/journal/2026-09-01`);
    vi.setSystemTime(new Date("2026-09-06T15:00:00Z"));
    act(() => fireEvent.focus(window));
    expect(screen.getByTestId("journal-calendar-trigger")).toHaveAttribute(
      "data-date",
      "2026-09-01",
    );
    expect(findJournalPage(session.getState().snapshot, "2026-09-07")).toBeUndefined();
  });

  it("saves the final debounced edit to the previous journal when midnight changes the page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T14:59:30Z"));
    setConfiguredTimezone("Asia/Seoul");
    const { session, settle } = await mountAt(`/g/${GRAPH_ID}/journal`);
    const previous = findJournalPage(session.getState().snapshot, "2026-09-06")!;
    await settle(() =>
      session.execute({
        type: "insert_block",
        owner: { kind: "page", id: previous.id },
        parent: null,
        index: 0,
        markdown: "Before midnight",
      }),
    );
    const input = screen.getByLabelText("Block text");
    fireEvent.change(input, { target: { value: "Before midnight, saved" } });
    expect(findJournalPage(session.getState().snapshot, "2026-09-06")!.blocks[0].markdown).toBe(
      "Before midnight",
    );
    vi.setSystemTime(new Date("2026-09-06T15:00:00Z"));
    await settle(() => fireEvent.focus(window));
    await waitFor(() => {
      expect(findJournalPage(session.getState().snapshot, "2026-09-06")!.blocks[0].markdown).toBe(
        "Before midnight, saved",
      );
      expect(screen.getByTestId("journal-calendar-trigger")).toHaveAttribute(
        "data-date",
        "2026-09-07",
      );
    });
  });

  it("ensures today's journal exactly once and renders it", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/journal`);
    const today = todayLocalDate();
    await waitFor(() => {
      const page = findJournalPage(session.getState().snapshot, today);
      expect(page).toBeDefined();
    });
    expect(screen.getByTestId("journal-title")).toBeInTheDocument();
    expect(screen.getByTestId("journal-calendar-trigger")).toHaveAttribute("data-date", today);
  });

  it("opens a specific journal date from the route", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/journal/2026-01-15`);
    await waitFor(() => {
      expect(findJournalPage(session.getState().snapshot, "2026-01-15")).toBeDefined();
    });
    expect(screen.getByTestId("journal-title")).toHaveTextContent("January 15, 2026");
  });

  it("rejects invalid dates with a tombstone instead of creating pages", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/journal/2026-02-30`);
    expect(await screen.findByTestId("tombstone")).toHaveTextContent("Not a calendar date");
    expect(session.getState().snapshot.pages).toHaveLength(0);
  });

  it("shows a tombstone for missing pages and never creates a replacement", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/p/ghost`);
    const user = userEvent.setup();
    expect(await screen.findByTestId("tombstone")).toHaveTextContent("isn't available");
    await user.click(screen.getByTestId("restore-page"));
    // The tombstone looks identical either way, so the refusal is reported
    // rather than tucked under the button.
    expect(await screen.findByTestId("toast")).toHaveTextContent("Couldn’t restore this page");
    expect(session.getState().snapshot.pages).toHaveLength(0);
  });

  it("restores a deleted page from its tombstone", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/p/doomed`);
    await session.execute({ type: "ensure_page", page_id: "doomed", title: "Doomed" });
    await session.execute({ type: "delete_page", page_id: "doomed" });
    const user = userEvent.setup();
    expect(await screen.findByTestId("tombstone")).toHaveTextContent("isn't available");
    await user.click(screen.getByTestId("restore-page"));
    await waitFor(() => expect(screen.getByTestId("page-title")).toHaveValue("Doomed"));
  });
});
