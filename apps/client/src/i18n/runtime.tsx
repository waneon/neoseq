import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import IntlMessageFormat from "intl-messageformat";
import {
  LOCALE_DEFINITIONS,
  SUPPORTED_LOCALES,
  type MessageFunction,
  type MessageKey,
  type SupportedLocale,
  type TextDirection,
} from "./generated/messages";

export { LOCALE_DEFINITIONS, SUPPORTED_LOCALES };
export type { SupportedLocale, TextDirection };
export type LocalePreference = "system" | SupportedLocale;

const SETTINGS_KEY = "neoseq.settings.v1";
const catalogModules = import.meta.glob("./locales/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Record<MessageKey, string>>;
const catalogs = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale) => [locale, catalogModules[`./locales/${locale}.json`]]),
) as Record<SupportedLocale, Record<MessageKey, string>>;

interface StoredSettings {
  locale?: LocalePreference;
  [key: string]: unknown;
}

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
}

function readSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as StoredSettings) : {};
  } catch {
    return {};
  }
}

function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

export function storedLocalePreference(): LocalePreference {
  const value = readSettings().locale;
  return isLocalePreference(value) ? value : "system";
}

function persistLocalePreference(preference: LocalePreference): void {
  try {
    const settings = readSettings();
    settings.locale = preference;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A blocked preference write affects the next launch, not this render.
  }
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
});

export function applyDocumentLocale(runtime: LocaleRuntime): void {
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
  initialPreference?: LocalePreference;
}) {
  const [preference, setPreferenceState] = useState<LocalePreference>(
    initialPreference ?? storedLocalePreference,
  );
  const [locale, setLocale] = useState(() => resolveLocale(preference));
  const runtime = useMemo(() => createLocaleRuntime(locale), [locale]);

  const setPreference = useCallback((next: LocalePreference) => {
    persistLocalePreference(next);
    setPreferenceState(next);
    setLocale(resolveLocale(next));
  }, []);

  useEffect(() => {
    if (preference !== "system") return;
    const onLanguageChange = () => setLocale(resolveLocale("system"));
    window.addEventListener("languagechange", onLanguageChange);
    return () => window.removeEventListener("languagechange", onLanguageChange);
  }, [preference]);

  useLayoutEffect(() => applyDocumentLocale(runtime), [runtime]);

  const value = useMemo<LocaleContextValue>(
    () => ({ ...runtime, preference, setPreference }),
    [preference, runtime, setPreference],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n(): LocaleContextValue {
  return useContext(LocaleContext);
}
