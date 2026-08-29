// The appearance preference, which belongs to the browser rather than to the
// server this app administers.
//
// Mode resolution is CSS-only: `app.css` declares the dark tokens under both
// `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and
// `:root[data-theme="dark"]`, so an explicit choice wins over the OS in both
// directions and a runtime without `matchMedia` still renders correctly. This
// module only records the choice; it never asks the browser what mode it is in.
//
// The session is memory-only by design (designs/server-administration.md), and
// this is deliberately not: a mode is a fact about the operator's screen, not
// about their administrative authority, and forgetting it at every reload would
// be a flash of the wrong theme rather than a security property.

export type Theme = "system" | "light" | "dark";

const KEY = "neoseq.dashboard.theme";

export const THEMES = ["system", "light", "dark"] as const;

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // A rejected write only costs persistence; the current page still applies.
  }
}
