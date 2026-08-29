import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "@/app/App";
import { LocaleProvider, createLocaleRuntime, resolveLocale, storedLocalePreference } from "@/i18n";

describe("admin internationalization", () => {
  beforeEach(() => localStorage.clear());

  it("resolves BCP 47 platform locales and falls back to English", () => {
    expect(resolveLocale("system", ["zh-Hant-TW", "ko-KR"])).toBe("ko");
    expect(resolveLocale("system", ["not_a_locale"])).toBe("en");
    expect(resolveLocale("en", ["ko-KR"])).toBe("en");
  });

  it("formats each typed catalog", () => {
    expect(createLocaleRuntime("en").message("reset.title", { username: "alice" })).toBe(
      "Reset password for alice",
    );
    expect(createLocaleRuntime("ko").message("reset.title", { username: "alice" })).toBe(
      "alice 비밀번호 재설정",
    );
  });

  it("switches immediately, updates the document, and persists the preference", async () => {
    localStorage.setItem("neoseq.admin.locale.v1", "en");
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );

    expect(screen.getByRole("heading", { name: "Administrator sign in" })).toBeVisible();

    await user.click(screen.getByRole("combobox", { name: "Language" }));
    await user.click(await screen.findByRole("option", { name: "한국어" }));

    expect(screen.getByRole("heading", { name: "관리자 로그인" })).toBeVisible();
    expect(document.documentElement).toHaveAttribute("lang", "ko");
    expect(document.title).toBe("Neoseq Sync 관리");
    expect(storedLocalePreference()).toBe("ko");
  });
});
