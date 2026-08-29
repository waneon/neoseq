// The two browser-local preferences, and the only controls in this app that
// change nothing on the server.
//
// They are reachable before there is a session because they describe the
// operator's screen rather than their authority — an operator who cannot read
// the sign-in form should not have to sign in to fix that.

import { useState } from "react";
import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from "lucide-react";

import { ChoiceField } from "@/ui/components";
import { setTheme, storedTheme, THEMES, type Theme } from "@/ui/theme";
import { LOCALE_DEFINITIONS, useI18n, type LocalePreference } from "@/i18n";

const THEME_GLYPH: Record<Theme, LucideIcon> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

const THEME_LABEL = {
  system: "appearance.system",
  light: "appearance.light",
  dark: "appearance.dark",
} as const;

/** A track with the chosen key raised out of it — one signal, no second mark. */
export function ThemeControl() {
  const { message } = useI18n();
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  return (
    <div className="segmented" role="group" aria-label={message("appearance.label")}>
      {THEMES.map((option) => {
        const Glyph = THEME_GLYPH[option];
        return (
          <button
            key={option}
            type="button"
            aria-pressed={theme === option}
            aria-label={message(THEME_LABEL[option])}
            onClick={() => {
              setTheme(option);
              setThemeState(option);
            }}
          >
            <Glyph aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

export function LanguageControl() {
  const { message, preference, setPreference } = useI18n();
  return (
    <ChoiceField
      className="flex-none"
      triggerClassName="w-auto min-w-[9rem]"
      label={message("language.label")}
      hideLabel
      value={preference}
      options={[
        { value: "system", label: message("language.system") },
        ...LOCALE_DEFINITIONS.map((locale) => ({
          value: locale.tag,
          label: message(locale.labelKey),
        })),
      ]}
      onValueChange={(value) => setPreference(value as LocalePreference)}
    />
  );
}
