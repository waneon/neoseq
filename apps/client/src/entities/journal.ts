// Journal date helpers. "Today" is resolved in the user's configured IANA
// timezone; the core owns journal identity and idempotent creation. How a day is
// *written* is a presentation preference and lives beside the other app
// settings, because the same choice has to hold on the journal title, the top
// bar, and the palette's date rows.

import {
  appSettings,
  journalDateFormat,
  updateAppSettings,
  type JournalDateFormat,
} from "./settings";

// Rendering asks for the timezone and today's date constantly, and building an
// Intl formatter costs far more than formatting with one. The system zone is
// remembered until the shared clock next ticks, so a zone change in the OS still
// arrives within a minute or on refocus.
let systemTimezone: string | undefined;

/** One formatter per timezone for a fixed locale and shape. */
function formatterCache(locale: string, options: Intl.DateTimeFormatOptions) {
  const formatters = new Map<string, Intl.DateTimeFormat>();
  return (timeZone: string) => {
    let format = formatters.get(timeZone);
    if (!format) {
      format = new Intl.DateTimeFormat(locale, { ...options, timeZone });
      formatters.set(timeZone, format);
    }
    return format;
  };
}

// en-CA formats as YYYY-MM-DD.
const dateFormat = formatterCache("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormat = formatterCache("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

export function forgetSystemTimezone(): void {
  systemTimezone = undefined;
}

export function configuredTimezone(): string {
  return (
    appSettings().timezone ?? (systemTimezone ??= Intl.DateTimeFormat().resolvedOptions().timeZone)
  );
}

export function setConfiguredTimezone(timezone: string | null): void {
  updateAppSettings({ timezone: timezone ?? undefined });
}

export function availableTimezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [configuredTimezone()];
  }
}

export { journalDateFormat };

export function setJournalDateFormat(format: JournalDateFormat): void {
  updateAppSettings({ journalDateFormat: format });
}

/** The local calendar date (YYYY-MM-DD) for `instant` in `timezone`. */
function localDateIn(timezone: string, instant: Date = new Date()): string {
  return dateFormat(timezone).format(instant);
}

export function todayLocalDate(instant: Date = new Date()): string {
  return localDateIn(configuredTimezone(), instant);
}

/** The wall-clock time of day (HH:MM) in the configured timezone. */
export function nowLocalTime(instant: Date = new Date()): string {
  return timeFormat(configuredTimezone()).format(instant);
}
