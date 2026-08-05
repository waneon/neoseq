import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsView } from "../../src/features/settings/SettingsView";
import {
  createLocaleRuntime,
  resolveLocale,
  storedLocalePreference,
} from "../../src/i18n";
import { mountAt } from "./harness";

describe("locale runtime", () => {
  it("resolves supported platform languages and falls back to English", () => {
    expect(resolveLocale("system", ["ko-KR", "en-US"])).toBe("ko");
    expect(resolveLocale("system", ["ja-JP"])).toBe("en");
    expect(resolveLocale("en", ["ko-KR"])).toBe("en");
  });

  it("formats messages and calendar dates for each locale", () => {
    const en = createLocaleRuntime("en");
    const ko = createLocaleRuntime("ko");

    expect(en.message("outline.newBlocksFailed", { count: 2 })).toContain("2 new blocks");
    expect(ko.message("outline.newBlocksFailed", { count: 2 })).toContain("새 블록 2개");
    expect(en.formatLocalDate("2026-08-05")).toContain("2026");
    expect(ko.formatLocalDate("2026-08-05")).toContain("2026년");
  });
});

describe("language preference", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("switches immediately, updates the document, and persists the choice", async () => {
    const user = userEvent.setup();
    await mountAt("/g/test-graph/custom", <SettingsView />);

    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    await user.selectOptions(screen.getByTestId("settings-language"), "ko");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "설정" })).toBeVisible();
      expect(document.documentElement).toHaveAttribute("lang", "ko");
    });
    expect(storedLocalePreference()).toBe("ko");
  });
});
