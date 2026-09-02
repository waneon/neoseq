// Appearance preferences that belong to the browser rather than to a graph: the
// mode, and the hue the accent is built from.
//
// Mode resolution is CSS-only: `app.css` declares the dark tokens under
// `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and under
// `:root[data-theme="dark"]`, so an explicit choice wins over the OS in both
// directions and a runtime without `matchMedia` still renders correctly. This
// module only records the choice; it never asks the browser what mode it is in.
//
// The accent is the same deal one step further in. What is stored is a *hue* and
// nothing else — never a colour. `app.css` owns the lightness and the chroma of
// the accent in each mode, so every hue a reader can reach lands on the measured
// row of the contrast table (designs/foundations.md § Semantic Color): the widest miss
// across the whole circle is 4.81:1 against the canvas in light mode, where the
// committed iris measures 5.56:1 and the bar is 4.5:1. A preference that cannot
// leave a contrast guarantee is a preference that needs no warning next to it.

export type Theme = "system" | "light" | "dark";

const KEY = "neoseq.theme";
const ACCENT_KEY = "neoseq.accent-hue";

/** Iris. The hue the product ships with, and one of the offered steps. */
export const DEFAULT_ACCENT_HUE = 277;

const themeListeners = new Set<() => void>();

/** Every surface that shows the current mode reads this store, so the palette
 * row and the settings control cannot disagree. */
export function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

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
  for (const listener of themeListeners) listener();
}

/** Cycles System → Light → Dark → System, for the palette's one-key toggle. */
export function nextTheme(current: Theme): Theme {
  return current === "system" ? "light" : current === "light" ? "dark" : "system";
}

/** Degrees, wrapped into the circle. A stored angle is never a colour. */
export function normalizeHue(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ACCENT_HUE;
  return ((Math.round(value) % 360) + 360) % 360;
}

export function storedAccentHue(): number {
  try {
    const raw = localStorage.getItem(ACCENT_KEY);
    if (raw === null) return DEFAULT_ACCENT_HUE;
    const value = Number(raw);
    return Number.isFinite(value) ? normalizeHue(value) : DEFAULT_ACCENT_HUE;
  } catch {
    return DEFAULT_ACCENT_HUE;
  }
}

/**
 * Writes the hue onto the root, where `--accent` and everything derived from it
 * read it. One custom property is the whole mechanism: the selection, the caret,
 * the lit thread, every tint and every focus halo are already expressed in terms
 * of `--accent`, so they all move together and none of them is recomputed here.
 */
export function setAccentHue(hue: number): void {
  const angle = normalizeHue(hue);
  const root = document.documentElement;
  if (angle === DEFAULT_ACCENT_HUE) root.style.removeProperty("--accent-h");
  else root.style.setProperty("--accent-h", String(angle));
  try {
    if (angle === DEFAULT_ACCENT_HUE) localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, String(angle));
  } catch {
    // A blocked write costs the next launch, not this session.
  }
}
