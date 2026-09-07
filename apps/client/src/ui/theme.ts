// Browser-local appearance preferences: resolved mode and a reader-selected hue.
// CSS owns lightness, chroma and both complete palettes, including pre-paint OS
// resolution. The hue changes appearance without changing semantic color roles;
// every offered hue keeps normal text above the 4.5:1 contrast threshold.

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
