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

export function configuredTimezone(): string {
  return appSettings().timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
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
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function todayLocalDate(): string {
  return localDateIn(configuredTimezone());
}

/** Pure calendar arithmetic on a YYYY-MM-DD string. */
export function addDays(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** The wall-clock time of day (HH:MM) in the configured timezone. */
export function nowLocalTime(instant: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: configuredTimezone(),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

/** Whole days from `from` to `to`, negative when `to` is in the past. */
export function dayDifference(to: string, from: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / 86_400_000);
}

function utcDay(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Calendar arithmetic in months or years, clamped to the target month's length.
 * A task scheduled on the 31st and repeating monthly lands on the 30th of a
 * 30-day month rather than sliding into the next one, which is the behaviour a
 * person means by "every month".
 */
export function addMonths(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + delta, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(Math.min(day, lastDay))}`;
}
