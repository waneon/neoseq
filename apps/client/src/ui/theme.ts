// Appearance preference. Resolution itself is CSS-only: `app.css` declares the
// dark tokens under `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`
// and under `:root[data-theme="dark"]`, so an explicit choice wins over the OS in
// both directions and a runtime without `matchMedia` still renders correctly.
// This module only records the choice; it never asks the browser what mode it is
// in and never decides a colour in JavaScript.

export type Theme = "system" | "light" | "dark";

const KEY = "neoseq.theme";

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

/** Cycles System → Light → Dark → System, for the palette's one-key toggle. */
export function nextTheme(current: Theme): Theme {
  return current === "system" ? "light" : current === "light" ? "dark" : "system";
}
