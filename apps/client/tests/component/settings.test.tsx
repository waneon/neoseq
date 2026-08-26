// The two app-wide preferences that reach into the rest of the interface: how a
// journal day is written, and which keys do what.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  editorKeymap,
  resetAppSettingsCache,
} from "../../src/entities/settings";
import { graphName, renameGraph } from "../../src/core-port/directory";
import {
  DEFAULT_BINDINGS,
  resolveBindings,
} from "../../src/features/commands/shortcuts";
import { SettingsDialog } from "../../src/features/settings/SettingsDialog";
import { DEFAULT_ACCENT_HUE, storedAccentHue } from "../../src/ui/theme";
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
  it("chooses a browser-local editor keymap independently of global shortcuts", async () => {
    const user = userEvent.setup();
    await mountSettings("keyboard");
    const chooser = screen.getByTestId("settings-editor-keymap");

    expect(within(chooser).getByRole("button", { name: "Standard" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(chooser).getByRole("button", { name: "Vim" }));

    await waitFor(() => expect(editorKeymap()).toBe("vim"));
    expect(resolveBindings()).toEqual(DEFAULT_BINDINGS);
  });

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
  it("keeps the due tiers ordered and previews each one in its own tone", async () => {
    const user = userEvent.setup();
    await mountSettings("tasks");

    // Each row previews itself with the real chip in the real tone. `upcoming`
    // is blue on its own account and not the accent's: a step in an ordered scale
    // may not move because somebody chose a different accent.
    expect(screen.getByTestId("due-preview-overdue")).toHaveAttribute("data-palette", "danger");
    expect(screen.getByTestId("due-preview-overdue")).not.toHaveTextContent("Overdue");
    expect(screen.getByTestId("due-preview-today")).toHaveAttribute("data-palette", "attention");
    expect(screen.getByTestId("due-preview-soon")).toHaveAttribute("data-palette", "caution");
    expect(screen.getByTestId("due-preview-upcoming")).toHaveAttribute("data-palette", "info");
    expect(dueTiers().soonDays).toBe(3);
    expect(screen.queryByRole("button", { name: "Accent" })).not.toBeInTheDocument();

    // One quiet well opens a continuous picker. Its named colours are starting
    // points, while hue and intensity persist as bounded OKLCH coordinates.
    await user.click(screen.getByTestId("due-tone-soon"));
    let picker = await screen.findByTestId("due-tone-soon-picker");
    expect(within(picker).getByRole("button", { name: "Gold" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const preview of picker.querySelectorAll(".color-studio-preview .task-chip")) {
      expect(preview).toHaveAttribute("data-palette", "caution");
    }
    fireEvent.change(within(picker).getByLabelText("Hue"), { target: { value: "318" } });
    fireEvent.change(within(picker).getByLabelText("Intensity"), { target: { value: "0.18" } });
    await waitFor(() => expect(dueTiers().soonTone).toEqual({ hue: 318, chroma: 0.18 }));
    expect(screen.getByTestId("due-preview-soon").style.getPropertyValue("--tone"))
      .toContain("318");
    for (const preview of picker.querySelectorAll(".color-studio-preview .task-chip")) {
      expect(preview).not.toHaveAttribute("data-palette");
      expect((preview as HTMLElement).style.getPropertyValue("--tone")).toContain("318");
    }

    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("due-tone-upcoming"));
    picker = await screen.findByTestId("due-tone-upcoming-picker");
    await user.click(within(picker).getByRole("button", { name: "Green" }));
    await waitFor(() => expect(dueTiers().upcomingTone).toBe("ok"));
    expect(within(picker).getByRole("button", { name: "Green" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // A second threshold inside the first would name a step no date can reach, so
    // the reader's number is kept and the ordering is repaired around it.
    fireEvent.change(screen.getByTestId("due-days-soon"), { target: { value: "30" } });
    await waitFor(() => expect(dueTiers().soonDays).toBe(30));
    expect(dueTiers().upcomingDays).toBe(30);
  });

  it("stores the accent as a hue and never as a colour", async () => {
    const user = userEvent.setup();
    await mountSettings("appearance");

    const accent = screen.getByTestId("settings-accent");
    const custom = within(accent).getByRole("button", { name: "Custom" });
    // Iris is where the product starts, so it is the step already pressed.
    expect(within(accent).getByRole("button", { name: "Iris" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(custom).toHaveAttribute("aria-pressed", "false");

    // The rail fills the gaps between the named starting points. Only its hue
    // reaches storage and the root; lightness and chroma remain CSS tokens.
    await user.click(custom);
    let picker = await screen.findByTestId("settings-accent-picker");
    expect(within(picker).queryByRole("button", { name: "Teal" })).not.toBeInTheDocument();
    fireEvent.change(within(picker).getByLabelText("Hue"), { target: { value: "318" } });
    await waitFor(() => expect(storedAccentHue()).toBe(318));
    expect(document.documentElement.style.getPropertyValue("--accent-h")).toBe("318");
    expect(custom.getAttribute("style")).toContain("318");
    expect(within(accent).getByRole("button", { name: "Custom" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(accent.querySelectorAll('.color-choice [aria-pressed="true"]')).toHaveLength(0);

    await user.click(within(accent).getByRole("button", { name: "Teal" }));
    await waitFor(() => expect(storedAccentHue()).toBe(195));
    // One number reaches the root, and `app.css` turns it into every colour
    // derived from the accent — nothing here computes one.
    expect(document.documentElement.style.getPropertyValue("--accent-h")).toBe("195");

    // Back to the default, and the override is removed rather than written out,
    // so a reader who never chose one still follows the shipped iris.
    await user.click(custom);
    picker = await screen.findByTestId("settings-accent-picker");
    await user.click(within(picker).getByRole("button", { name: "Restore defaults" }));
    await waitFor(() => expect(storedAccentHue()).toBe(DEFAULT_ACCENT_HUE));
    expect(document.documentElement.style.getPropertyValue("--accent-h")).toBe("");
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
