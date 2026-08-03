// Journal date helpers. "Today" is resolved in the user's configured IANA
// timezone; the core owns journal identity and idempotent creation.

const SETTINGS_KEY = "neoseq.settings.v1";

interface AppSettings {
  timezone?: string;
}

function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as AppSettings) : {};
  } catch {
    return {};
  }
}

export function configuredTimezone(): string {
  return readSettings().timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function setConfiguredTimezone(timezone: string | null): void {
  const settings = readSettings();
  if (timezone) settings.timezone = timezone;
  else delete settings.timezone;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function availableTimezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [configuredTimezone()];
  }
}

/** The local calendar date (YYYY-MM-DD) for `instant` in `timezone`. */
export function localDateIn(timezone: string, instant: Date = new Date()): string {
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

export function formatJournalTitle(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
