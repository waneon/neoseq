// The two app-wide preferences that reach into the rest of the interface: how a
// journal day is written, and which keys do what.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { journalDateFormat, setJournalDateFormat } from "../../src/entities/journal";
import { resetAppSettingsCache } from "../../src/entities/settings";
import {
  DEFAULT_BINDINGS,
  resolveBindings,
} from "../../src/features/commands/shortcuts";
import { SettingsDialog } from "../../src/features/settings/SettingsDialog";
import { GRAPH_ID, mountAt } from "./harness";

function mountSettings(section: "journal" | "keyboard") {
  return mountAt(
    `/g/${GRAPH_ID}/custom`,
    <SettingsDialog
      graphId={GRAPH_ID}
      section={section}
      onSection={() => {}}
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetAppSettingsCache();
});
afterEach(() => {
  localStorage.clear();
  resetAppSettingsCache();
});

describe("journal date format", () => {
  it("offers each format with a live example of the choice", async () => {
    const user = userEvent.setup();
    await mountSettings("journal");
    const select = screen.getByTestId("settings-date-format");
    // The label alone ("Numeric") does not tell you what you will get.
    expect(select).toHaveTextContent(/Weekday and full date — .*20\d\d/);
    await user.selectOptions(select, "iso");
    expect(journalDateFormat()).toBe("iso");
  });

  it("is what the journal title, not just this dialog, is written in", async () => {
    setJournalDateFormat("iso");
    await mountAt(`/g/${GRAPH_ID}/journal/2026-01-15`);
    expect(await screen.findByTestId("journal-title")).toHaveTextContent("2026-01-15");

    setJournalDateFormat("medium");
    resetAppSettingsCache();
    await mountAt(`/g/${GRAPH_ID}/journal/2026-01-15`);
    await waitFor(() =>
      expect(screen.getAllByTestId("journal-title")[1]).toHaveTextContent("Jan 15, 2026"),
    );
  });
});

describe("editable shortcuts", () => {
  it("records a new binding on the badge that shows the old one", async () => {
    const user = userEvent.setup();
    await mountSettings("keyboard");
    const badge = screen.getByTestId("shortcut-palette");
    expect(badge).toHaveTextContent("Ctrl+K");

    await user.click(badge);
    expect(badge).toHaveTextContent("Press keys…");
    fireEvent.keyDown(badge, { key: "j", metaKey: true });

    await waitFor(() => expect(badge).toHaveTextContent("Ctrl+J"));
    expect(resolveBindings().palette).toEqual({ key: "j", shift: false, alt: false });
  });

  it("refuses a combination that is already another action, and says which", async () => {
    const user = userEvent.setup();
    await mountSettings("keyboard");
    const badge = screen.getByTestId("shortcut-palette");
    await user.click(badge);
    fireEvent.keyDown(badge, { key: "p", metaKey: true, shiftKey: true });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Ctrl+Shift+P is already Properties of this block or page.",
    );
    expect(resolveBindings().palette).toEqual(DEFAULT_BINDINGS.palette);
  });

  it("refuses a combination the browser takes before the page sees it", async () => {
    const user = userEvent.setup();
    await mountSettings("keyboard");
    const badge = screen.getByTestId("shortcut-palette");
    await user.click(badge);
    fireEvent.keyDown(badge, { key: "w", metaKey: true });

    expect(await screen.findByRole("alert")).toHaveTextContent("belongs to the browser");
    expect(resolveBindings().palette).toEqual(DEFAULT_BINDINGS.palette);
  });

  it("insists on a modifier, which is what keeps a bare key out of a text field", async () => {
    const user = userEvent.setup();
    await mountSettings("keyboard");
    const badge = screen.getByTestId("shortcut-palette");
    await user.click(badge);
    fireEvent.keyDown(badge, { key: "j" });

    expect(await screen.findByRole("alert")).toHaveTextContent("has to include Ctrl");
    expect(resolveBindings().palette).toEqual(DEFAULT_BINDINGS.palette);
  });

  it("restores one binding and all of them", async () => {
    const user = userEvent.setup();
    await mountSettings("keyboard");
    const badge = screen.getByTestId("shortcut-palette");
    await user.click(badge);
    fireEvent.keyDown(badge, { key: "j", metaKey: true });
    await waitFor(() => expect(badge).toHaveTextContent("Ctrl+J"));

    await user.click(screen.getByTestId("shortcut-reset-palette"));
    await waitFor(() => expect(badge).toHaveTextContent("Ctrl+K"));
    // With nothing customised there is nothing to restore, so the button goes.
    expect(screen.queryByTestId("shortcut-reset-all")).not.toBeInTheDocument();
  });
});
