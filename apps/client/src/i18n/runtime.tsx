import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import IntlMessageFormat from "intl-messageformat";
import {
  appSettings,
  isJournalDateFormat,
  subscribeAppSettings,
  updateAppSettings,
  type JournalDateFormat,
} from "../entities/settings";
import {
  LOCALE_DEFINITIONS,
  SUPPORTED_LOCALES,
  type MessageFunction,
  type MessageKey,
  type SupportedLocale,
  type TextDirection,
} from "./generated/messages";

export { LOCALE_DEFINITIONS };
export type { SupportedLocale };
export type LocalePreference = "system" | SupportedLocale;

const catalogModules = import.meta.glob("./locales/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Record<MessageKey, string>>;
const catalogs = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale) => [locale, catalogModules[`./locales/${locale}.json`]]),
) as Record<SupportedLocale, Record<MessageKey, string>>;

export interface LocaleRuntime {
  readonly locale: SupportedLocale;
  readonly direction: TextDirection;
  readonly message: MessageFunction;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatBytes(value: number): string;
  formatLocalDate(value: string, options?: Intl.DateTimeFormatOptions): string;
  formatInstant(
    value: string | number | Date,
    timeZone?: string,
    options?: Intl.DateTimeFormatOptions,
  ): string;
  compare(left: string, right: string): number;
}

interface LocaleContextValue extends LocaleRuntime {
  readonly preference: LocalePreference;
  setPreference(preference: LocalePreference): void;
  /** How a journal day is written. An app-wide choice, not a per-graph one. */
  readonly journalDateFormat: JournalDateFormat;
  /** A journal day in the chosen format; `iso` returns the stored value verbatim. */
  formatJournalDate(date: string): string;
}

function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

export function storedLocalePreference(): LocalePreference {
  const value = appSettings().locale;
  return isLocalePreference(value) ? value : "system";
}

function canonicalLanguage(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0]?.split("-")[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function resolveLocale(
  preference: LocalePreference,
  platformLocales: readonly string[] = typeof navigator === "undefined"
    ? []
    : navigator.languages,
): SupportedLocale {
  if (preference !== "system") return preference;
  for (const candidate of platformLocales) {
    const language = canonicalLanguage(candidate);
    if (language && SUPPORTED_LOCALES.includes(language as SupportedLocale)) {
      return language as SupportedLocale;
    }
  }
  return "en";
}

/**
 * `Intl` options per journal date format, or `null` for ISO — the one choice that
 * is not a locale rendering at all but the stored value shown unchanged.
 */
export function journalDateOptions(
  format: JournalDateFormat,
): Intl.DateTimeFormatOptions | null {
  switch (format) {
    case "full":
      return { weekday: "long", year: "numeric", month: "long", day: "numeric" };
    case "long":
      return { year: "numeric", month: "long", day: "numeric" };
    case "medium":
      return { year: "numeric", month: "short", day: "numeric" };
    case "short":
      return { year: "numeric", month: "numeric", day: "numeric" };
    case "iso":
      return null;
  }
}

function formatterKey(kind: string, options: object | undefined): string {
  return `${kind}:${JSON.stringify(options ?? {})}`;
}

export function createLocaleRuntime(locale: SupportedLocale): LocaleRuntime {
  const definition = LOCALE_DEFINITIONS.find((candidate) => candidate.tag === locale);
  if (!definition) throw new Error(`unsupported locale: ${locale}`);
  const messageCache = new Map<MessageKey, IntlMessageFormat>();
  const numberCache = new Map<string, Intl.NumberFormat>();
  const dateCache = new Map<string, Intl.DateTimeFormat>();
  const collator = new Intl.Collator(locale, {
    usage: "sort",
    sensitivity: "base",
    numeric: true,
  });

  const message = ((key: MessageKey, ...args: [Record<string, unknown>?]) => {
    let formatter = messageCache.get(key);
    if (!formatter) {
      formatter = new IntlMessageFormat(catalogs[locale][key], locale);
      messageCache.set(key, formatter);
    }
    return String(formatter.format(args[0]));
  }) as MessageFunction;

  const formatNumber = (value: number, options?: Intl.NumberFormatOptions) => {
    const key = formatterKey("number", options);
    let formatter = numberCache.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, options);
      numberCache.set(key, formatter);
    }
    return formatter.format(value);
  };

  const formatDate = (
    value: Date,
    timeZone: string | undefined,
    options: Intl.DateTimeFormatOptions | undefined,
  ) => {
    const merged = { ...options, timeZone };
    const key = formatterKey("date", merged);
    let formatter = dateCache.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, merged);
      dateCache.set(key, formatter);
    }
    return formatter.format(value);
  };

  return {
    locale,
    direction: definition.direction,
    message,
    formatNumber,
    formatBytes: (value) =>
      `${formatNumber(value / (1024 * 1024), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })} MB`,
    formatLocalDate: (value, options) => {
      const [year, month, day] = value.split("-").map(Number);
      if (![year, month, day].every(Number.isFinite)) return value;
      return formatDate(
        new Date(Date.UTC(year, month - 1, day)),
        "UTC",
        options ?? { weekday: "long", year: "numeric", month: "long", day: "numeric" },
      );
    },
    formatInstant: (value, timeZone, options) => {
      const instant = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(instant.valueOf())) return String(value);
      return formatDate(
        instant,
        timeZone,
        options ?? {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        },
      );
    },
    compare: collator.compare,
  };
}

const defaultRuntime = createLocaleRuntime("en");
const LocaleContext = createContext<LocaleContextValue>({
  ...defaultRuntime,
  preference: "system",
  setPreference: () => {},
  journalDateFormat: "full",
  formatJournalDate: (date) => defaultRuntime.formatLocalDate(date),
});

function applyDocumentLocale(runtime: LocaleRuntime): void {
  document.documentElement.lang = runtime.locale;
  document.documentElement.dir = runtime.direction;
  document.title = runtime.message("app.title");
}

export function applyInitialDocumentLocale(): void {
  if (typeof document === "undefined") return;
  applyDocumentLocale(createLocaleRuntime(resolveLocale(storedLocalePreference())));
}

export function LocaleProvider({
  children,
  initialPreference,
}: {
  children: ReactNode;
  /**
   * Pins the provider to one language regardless of what is stored — a test
   * seam. Without it the stored preference is the source of truth, so a second
   * tab changing the language is honoured here too.
   */
  initialPreference?: LocalePreference;
}) {
  const settings = useSyncExternalStore(subscribeAppSettings, appSettings, appSettings);
  const [pinned, setPinned] = useState<LocalePreference | null>(initialPreference ?? null);
  const preference = pinned ?? (isLocalePreference(settings.locale) ? settings.locale : "system");
  const journalDateFormat = isJournalDateFormat(settings.journalDateFormat)
    ? settings.journalDateFormat
    : "full";

  // `languagechange` is the only signal that the platform's own language list
  // moved under a "system" preference, so that list is state rather than a read
  // taken once per render.
  const [platformLocales, setPlatformLocales] = useState<readonly string[]>(() =>
    typeof navigator === "undefined" ? [] : [...navigator.languages],
  );
  useEffect(() => {
    const read = () =>
      setPlatformLocales(typeof navigator === "undefined" ? [] : [...navigator.languages]);
    window.addEventListener("languagechange", read);
    return () => window.removeEventListener("languagechange", read);
  }, []);

  const locale = useMemo(
    () => resolveLocale(preference, platformLocales),
    [platformLocales, preference],
  );
  const runtime = useMemo(() => createLocaleRuntime(locale), [locale]);

  const setPreference = useCallback((next: LocalePreference) => {
    updateAppSettings({ locale: next });
    setPinned((current) => (current === null ? null : next));
  }, []);

  useLayoutEffect(() => applyDocumentLocale(runtime), [runtime]);

  const formatJournalDate = useCallback(
    (date: string) => {
      const options = journalDateOptions(journalDateFormat);
      return options ? runtime.formatLocalDate(date, options) : date;
    },
    [journalDateFormat, runtime],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      ...runtime,
      preference,
      setPreference,
      journalDateFormat,
      formatJournalDate,
    }),
    [formatJournalDate, journalDateFormat, preference, runtime, setPreference],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n(): LocaleContextValue {
  return useContext(LocaleContext);
}
