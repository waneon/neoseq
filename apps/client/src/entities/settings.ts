// The one owner of the browser-local application settings blob.
//
// These are *app* settings, not graph data: they describe how this browser
// renders Neoseq, they survive every graph, and none of them is ever written to
// a Loro document. Three separate modules used to read and write the same
// localStorage key with their own read-modify-write pair, so a write from one
// could only be trusted because none of them cached. This module keeps one
// parsed snapshot, so it can also publish changes — which is what a live
// journal-date-format or shortcut edit needs.

import type { LegacyDefaultQuery } from "./default-queries";

export type JournalDateFormat = "full" | "long" | "medium" | "short" | "iso";

export type EditorKeymap = "standard" | "vim";

export const EDITOR_KEYMAPS: EditorKeymap[] = ["standard", "vim"];

export const JOURNAL_DATE_FORMATS: JournalDateFormat[] = [
  "full",
  "long",
  "medium",
  "short",
  "iso",
];

/**
 * The tones a preference is allowed to name. They are the palette's own five
 * steps and nothing else — a preference chooses *which* declared tone a surface
 * takes, never a colour of its own, so both modes and the contrast table keep
 * holding for every choice (DESIGN.md § The state palette).
 *
 * `accent` is not among them, and `info` is the blue that used to stand in for
 * it. A tone names a step in a closed ordered scale; the accent names where the
 * reader is and what they can act on. While a tier could name the accent, the
 * default `upcoming` step moved with every accent the reader chose and two
 * unrelated meanings shared one colour.
 */
export type ToneName = "neutral" | "info" | "ok" | "attention" | "danger";

export const TONE_NAMES: ToneName[] = ["neutral", "info", "ok", "attention", "danger"];

export function isToneName(value: unknown): value is ToneName {
  return TONE_NAMES.includes(value as ToneName);
}

/**
 * How far off a date is, in the four steps the chips are tinted by. The two
 * numbers are day counts the user owns; the tones name palette steps.
 */
export interface DueTierSettings {
  /** Due within this many days reads as `soon`. */
  soonDays: number;
  /** Due within this many days reads as `upcoming`. */
  upcomingDays: number;
  overdueTone: ToneName;
  soonTone: ToneName;
  upcomingTone: ToneName;
  laterTone: ToneName;
}

export const DEFAULT_DUE_TIERS: DueTierSettings = {
  soonDays: 1,
  upcomingDays: 7,
  overdueTone: "danger",
  soonTone: "attention",
  upcomingTone: "info",
  laterTone: "neutral",
};

/** The widest span a threshold may name: a year of lead time is already "later". */
export const MAX_DUE_DAYS = 365;

export interface AppSettings {
  /** `"system"` or a supported locale tag; validated by the i18n runtime. */
  locale?: string;
  /** IANA zone used to resolve "today" for journals. */
  timezone?: string;
  journalDateFormat?: JournalDateFormat;
  /** Action id → serialized binding. Only overrides are stored. */
  shortcuts?: Record<string, string>;
  /** Modal editing is an editor preference, not a graph property. */
  editorKeymap?: EditorKeymap;
  /** Day thresholds and tones for the scheduled/deadline tint. */
  dueTiers?: Partial<DueTierSettings>;
  /** Pre-v4 browser-local questions, retained only for explicit graph import. */
  defaultQueries?: LegacyDefaultQuery[];
}

const STORAGE_KEY = "neoseq.settings.v1";

let cache: AppSettings | null = null;
const listeners = new Set<() => void>();

function parse(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as AppSettings) : {};
  } catch {
    // Private mode, a disabled store, or a corrupt blob: defaults still work.
    return {};
  }
}

/**
 * The current settings. The object is frozen and identity-stable until the next
 * write, so it is safe as a `useSyncExternalStore` snapshot.
 */
export function appSettings(): AppSettings {
  if (!cache) cache = Object.freeze(parse());
  return cache;
}

/** Applies a patch. `undefined` values delete their key. */
export function updateAppSettings(patch: Partial<AppSettings>): void {
  const next: AppSettings = { ...appSettings() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key as keyof AppSettings];
    else Object.assign(next, { [key]: value });
  }
  cache = Object.freeze(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A blocked write costs the next launch, not this session.
  }
  for (const listener of listeners) listener();
}

export function subscribeAppSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A second tab changing a setting is the same event as this tab changing it —
 * appearance, language and shortcuts are browser-wide, so they must not disagree
 * between two windows of the same app.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    cache = null;
    for (const listener of listeners) listener();
  });
}

export function isJournalDateFormat(value: unknown): value is JournalDateFormat {
  return JOURNAL_DATE_FORMATS.includes(value as JournalDateFormat);
}

export function isEditorKeymap(value: unknown): value is EditorKeymap {
  return EDITOR_KEYMAPS.includes(value as EditorKeymap);
}

export function editorKeymap(): EditorKeymap {
  const stored = appSettings().editorKeymap;
  return isEditorKeymap(stored) ? stored : "standard";
}

export function setEditorKeymap(keymap: EditorKeymap): void {
  updateAppSettings({ editorKeymap: keymap === "standard" ? undefined : keymap });
}

export function journalDateFormat(): JournalDateFormat {
  const stored = appSettings().journalDateFormat;
  return isJournalDateFormat(stored) ? stored : "full";
}

/**
 * The stored due tiers, repaired into a usable shape. A partial or nonsense
 * record still has to produce four ordered steps, because the chips read them
 * on every render: an unusable preference must cost the preference, not the
 * outline.
 */
export function dueTiers(): DueTierSettings {
  const stored = appSettings().dueTiers ?? {};
  const days = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_DUE_DAYS
      ? value
      : fallback;
  const tone = (value: unknown, fallback: ToneName) => (isToneName(value) ? value : fallback);
  const soonDays = days(stored.soonDays, DEFAULT_DUE_TIERS.soonDays);
  return {
    soonDays,
    // The second threshold can never sit inside the first, or `upcoming` would
    // be a step no date can reach.
    upcomingDays: Math.max(soonDays, days(stored.upcomingDays, DEFAULT_DUE_TIERS.upcomingDays)),
    overdueTone: tone(stored.overdueTone, DEFAULT_DUE_TIERS.overdueTone),
    soonTone: tone(stored.soonTone, DEFAULT_DUE_TIERS.soonTone),
    upcomingTone: tone(stored.upcomingTone, DEFAULT_DUE_TIERS.upcomingTone),
    laterTone: tone(stored.laterTone, DEFAULT_DUE_TIERS.laterTone),
  };
}

export function updateDueTiers(patch: Partial<DueTierSettings>): void {
  updateAppSettings({ dueTiers: { ...dueTiers(), ...patch } });
}

/** Test seam: drops the cached snapshot without touching storage. */
export function resetAppSettingsCache(): void {
  cache = null;
}
