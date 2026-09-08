import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SettingsDialog,
  isSettingsSection,
  type SettingsSection,
} from "../../src/features/settings/SettingsDialog";
import { GRAPH_ID, mountAt } from "./harness";

function SettingsNavigation({
  initial = "index",
  onClose = () => {},
}: {
  initial?: SettingsSection;
  onClose?: () => void;
}) {
  const [section, setSection] = useState(initial);
  return (
    <SettingsDialog graphId={GRAPH_ID} section={section} onSection={setSection} onClose={onClose} />
  );
}

describe("mobile settings navigation", () => {
  beforeEach(() => {
    const matchMedia = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...matchMedia(query),
      matches: query === "(max-width: 600px)",
    }));
  });

  afterEach(() => vi.restoreAllMocks());

  it("opens a grouped index and restores the selected row after returning from a page", async () => {
    const user = userEvent.setup();
    await mountAt(`/g/${GRAPH_ID}/custom`, <SettingsNavigation />);

    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Application" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "This graph" })).toBeInTheDocument();
    expect(screen.queryByTestId("settings-appearance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-back")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("settings-tab-journal"));

    expect(screen.getByTestId("settings-date-format")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Journal" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Back to settings" }));

    expect(screen.queryByTestId("settings-date-format")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-tab-journal")).toHaveFocus();
  });

  it("honours a linked section and keeps Close available on the page and index", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    await mountAt(
      `/g/${GRAPH_ID}/custom`,
      <SettingsNavigation initial="appearance" onClose={onClose} />,
    );

    expect(screen.getByTestId("settings-appearance")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close", exact: true }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Back to settings" }));
    await user.click(screen.getByRole("button", { name: "Close", exact: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

it("accepts the mobile index URL and resolves it to the first page on desktop", async () => {
  expect(isSettingsSection("index")).toBe(true);
  expect(isSettingsSection("missing")).toBe(false);
  await mountAt(`/g/${GRAPH_ID}/custom`, <SettingsNavigation />);

  expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
  expect(screen.getByTestId("settings-appearance")).toBeInTheDocument();
  expect(screen.getByTestId("settings-tab-appearance")).toHaveAttribute("aria-current", "page");
  expect(screen.queryByTestId("settings-back")).not.toBeInTheDocument();
});
