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

export { LOCALE_DEFINITIONS };
export type { MessageFunction, MessageKey, SupportedLocale };
export type LocalePreference = "system" | SupportedLocale;

const STORAGE_KEY = "neoseq.dashboard.locale.v1";
const catalogModules = import.meta.glob("./locales/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Record<MessageKey, string>>;
const catalogs = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale) => [locale, catalogModules[`./locales/${locale}.json`]]),
) as Record<SupportedLocale, Record<MessageKey, string>>;

interface LocaleRuntime {
  readonly locale: SupportedLocale;
  readonly direction: TextDirection;
  readonly message: MessageFunction;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
}

interface I18nContextValue extends LocaleRuntime {
  readonly preference: LocalePreference;
  setPreference(preference: LocalePreference): void;
}

function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

function platformLocales(): readonly string[] {
  return typeof navigator === "undefined" ? [] : navigator.languages;
}

export function storedLocalePreference(): LocalePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocalePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

function localeFallbacks(tag: string): readonly string[] {
  try {
    const locale = new Intl.Locale(tag);
    const candidates = [locale.baseName];
    if (locale.script) candidates.push(`${locale.language}-${locale.script}`);
    candidates.push(locale.language);
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

export function resolveLocale(
  preference: LocalePreference,
  availableLocales: readonly string[] = platformLocales(),
): SupportedLocale {
  if (preference !== "system") return preference;
  for (const candidate of availableLocales) {
    for (const fallback of localeFallbacks(candidate)) {
      if (SUPPORTED_LOCALES.includes(fallback as SupportedLocale)) {
        return fallback as SupportedLocale;
      }
    }
  }
  return "en";
}

export function createLocaleRuntime(locale: SupportedLocale): LocaleRuntime {
  const definition = LOCALE_DEFINITIONS.find((candidate) => candidate.tag === locale);
  if (!definition) throw new Error(`unsupported locale: ${locale}`);
  const messageCache = new Map<MessageKey, IntlMessageFormat>();
  const numberCache = new Map<string, Intl.NumberFormat>();

  const message = ((key: MessageKey, ...args: [Record<string, unknown>?]) => {
    let formatter = messageCache.get(key);
    if (!formatter) {
      formatter = new IntlMessageFormat(catalogs[locale][key], locale);
      messageCache.set(key, formatter);
    }
    return String(formatter.format(args[0]));
  }) as MessageFunction;

  return {
    locale,
    direction: definition.direction,
    message,
    formatNumber(value, options) {
      const key = JSON.stringify(options ?? {});
      let formatter = numberCache.get(key);
      if (!formatter) {
        formatter = new Intl.NumberFormat(locale, options);
        numberCache.set(key, formatter);
      }
      return formatter.format(value);
    },
  };
}

function applyDocumentLocale(runtime: LocaleRuntime): void {
  document.documentElement.lang = runtime.locale;
  document.documentElement.dir = runtime.direction;
  document.title = runtime.message("dashboard.documentTitle");
}

export function applyInitialDocumentLocale(): void {
  applyDocumentLocale(createLocaleRuntime(resolveLocale(storedLocalePreference())));
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setStoredPreference] = useState(storedLocalePreference);
  const [availableLocales, setAvailableLocales] = useState(platformLocales);
  const locale = useMemo(
    () => resolveLocale(preference, availableLocales),
    [availableLocales, preference],
  );
  const runtime = useMemo(() => createLocaleRuntime(locale), [locale]);

  useEffect(() => {
    const updatePlatformLocales = () => setAvailableLocales(platformLocales());
    window.addEventListener("languagechange", updatePlatformLocales);
    return () => window.removeEventListener("languagechange", updatePlatformLocales);
  }, []);

  useLayoutEffect(() => applyDocumentLocale(runtime), [runtime]);

  const setPreference = useCallback((next: LocalePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The selection still applies for the current tab when storage is unavailable.
    }
    setStoredPreference(next);
  }, []);

  const value = useMemo(
    () => ({ ...runtime, preference, setPreference }),
    [preference, runtime, setPreference],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside LocaleProvider");
  return value;
}
