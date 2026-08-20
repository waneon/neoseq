// The two app-wide preferences that reach into the rest of the interface: how a
// journal day is written, and which keys do what.

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configuredTimezone,
  journalDateFormat,
  setConfiguredTimezone,
  setJournalDateFormat,
} from "../../src/entities/journal";
import {
  dueTiers,
  resetAppSettingsCache,
  threadTone,
} from "../../src/entities/settings";
import { graphName, renameGraph } from "../../src/core-port/directory";
import {
  DEFAULT_BINDINGS,
  resolveBindings,
} from "../../src/features/commands/shortcuts";
import { SettingsDialog } from "../../src/features/settings/SettingsDialog";
import { chooseFromMenu, GRAPH_ID, mountAt } from "./harness";

function mountSettings(section: "journal" | "keyboard" | "appearance" | "tasks" | "graph") {
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
    const chooser = screen.getByTestId("settings-date-format");
    // The label alone ("Numeric") does not tell you what you will get: the
    // trigger states the current choice, example and all.
    expect(chooser).toHaveTextContent(/Weekday and full date — .*20\d\d/);
    await chooseFromMenu(user, chooser, /ISO/);
    expect(journalDateFormat()).toBe("iso");
  });

  it("is what the journal title, not just this dialog, is written in", async () => {
    setJournalDateFormat("iso");
    const first = await mountAt(`/g/${GRAPH_ID}/journal/2026-01-15`);
    expect(await screen.findByTestId("journal-title")).toHaveTextContent("2026-01-15");
    first.view.unmount();

    setJournalDateFormat("medium");
    resetAppSettingsCache();
    await mountAt(`/g/${GRAPH_ID}/journal/2026-01-15`);
    await waitFor(() =>
      expect(screen.getByTestId("journal-title")).toHaveTextContent("Jan 15, 2026"),
    );
  });

  it("keeps the mounted timezone control synchronized with the preference store", async () => {
    await mountSettings("journal");
    const chooser = screen.getByTestId("settings-timezone");

    act(() => setConfiguredTimezone("America/New_York"));

    await waitFor(() => expect(chooser).toHaveTextContent("America/New_York"));
    expect(configuredTimezone()).toBe("America/New_York");
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
    fireEvent.keyDown(badge, { key: "p", metaKey: true });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Ctrl+P is already Properties of this block or page.",
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

describe("presentation preferences", () => {
  it("records the outline thread tone as a tone name, never a colour", async () => {
    const user = userEvent.setup();
    await mountSettings("appearance");

    const group = screen.getByTestId("settings-thread-tone");
    const accent = screen.getByRole("button", { name: "Accent", pressed: false });
    await user.click(accent);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Accent" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    // The stored preference is the *name* of a declared tone. `app.css` owns what
    // it looks like, which is what keeps both modes and the contrast table valid.
    expect(threadTone()).toBe("accent");
    expect(group.querySelector('[data-palette="accent"]')).not.toBeNull();
  });

  it("keeps the due tiers ordered and previews each one in its own tone", async () => {
    const user = userEvent.setup();
    await mountSettings("tasks");

    // Each row previews itself with the real chip in the real tone.
    expect(screen.getByTestId("due-preview-overdue")).toHaveAttribute("data-palette", "danger");
    expect(screen.getByTestId("due-preview-upcoming")).toHaveAttribute("data-palette", "accent");

    await chooseFromMenu(user, screen.getByTestId("due-tone-upcoming"), "Green");
    await waitFor(() => expect(dueTiers().upcomingTone).toBe("ok"));

    // A second threshold inside the first would name a step no date can reach, so
    // the reader's number is kept and the ordering is repaired around it.
    fireEvent.change(screen.getByTestId("due-days-soon"), { target: { value: "30" } });
    await waitFor(() => expect(dueTiers().soonDays).toBe(30));
    expect(dueTiers().upcomingDays).toBe(30);
  });
});

describe("graph directory settings", () => {
  it("shows directory changes while clean and preserves an active name draft", async () => {
    await mountSettings("graph");
    const input = screen.getByTestId("settings-graph-name");

    act(() => renameGraph(GRAPH_ID, "Changed elsewhere"));
    await waitFor(() => expect(input).toHaveValue("Changed elsewhere"));

    fireEvent.change(input, { target: { value: "My active draft" } });
    act(() => renameGraph(GRAPH_ID, "Another change"));
    expect(input).toHaveValue("My active draft");

    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue("My active draft"));
    expect(graphName(GRAPH_ID)).toBe("My active draft");
  });
});
