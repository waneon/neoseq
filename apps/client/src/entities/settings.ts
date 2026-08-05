// The one owner of the browser-local application settings blob.
//
// These are *app* settings, not graph data: they describe how this browser
// renders Neoseq, they survive every graph, and none of them is ever written to
// a Loro document. Three separate modules used to read and write the same
// localStorage key with their own read-modify-write pair, so a write from one
// could only be trusted because none of them cached. This module keeps one
// parsed snapshot, so it can also publish changes — which is what a live
// journal-date-format or shortcut edit needs.

export type JournalDateFormat = "full" | "long" | "medium" | "short" | "iso";

export const JOURNAL_DATE_FORMATS: JournalDateFormat[] = [
  "full",
  "long",
  "medium",
  "short",
  "iso",
];

export interface AppSettings {
  /** `"system"` or a supported locale tag; validated by the i18n runtime. */
  locale?: string;
  /** IANA zone used to resolve "today" for journals. */
  timezone?: string;
  journalDateFormat?: JournalDateFormat;
  /** Action id → serialized binding. Only overrides are stored. */
  shortcuts?: Record<string, string>;
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

export function journalDateFormat(): JournalDateFormat {
  const stored = appSettings().journalDateFormat;
  return isJournalDateFormat(stored) ? stored : "full";
}

/** Test seam: drops the cached snapshot without touching storage. */
export function resetAppSettingsCache(): void {
  cache = null;
}
