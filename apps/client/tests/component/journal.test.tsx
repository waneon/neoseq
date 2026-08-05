// Journal ensure + navigation + tombstones for deleted/missing pages.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { todayLocalDate } from "../../src/entities/journal";
import { GRAPH_ID, mountAt } from "./harness";

describe("journal and navigation", () => {
  it("ensures today's journal exactly once and renders it", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/journal`);
    const today = todayLocalDate();
    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((p) => p.id === `journal-${today}`);
      expect(page).toBeDefined();
    });
    expect(screen.getByTestId("journal-title")).toBeInTheDocument();
    expect(screen.getByTestId("journal-date")).toHaveValue(today);
  });

  it("opens a specific journal date from the route", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/journal/2026-01-15`);
    await waitFor(() => {
      expect(
        session.getState().snapshot.pages.some((p) => p.id === "journal-2026-01-15"),
      ).toBe(true);
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
