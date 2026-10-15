import { useSyncExternalStore } from "react";
import { Settings2Icon } from "lucide-react";
import { LOCALE_DEFINITIONS, useI18n, type LocalePreference } from "../../i18n";
import { setTheme, storedTheme, subscribeTheme, type Theme } from "../../ui/theme";
import { Button } from "@/ui/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuChoice,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";

const THEMES = [
  ["system", "settings.themeSystem"],
  ["light", "settings.themeLight"],
  ["dark", "settings.themeDark"],
] as const;

export function StartupPreferences() {
  const { message, preference, setPreference } = useI18n();
  const theme = useSyncExternalStore(subscribeTheme, storedTheme, storedTheme);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="picker-preferences"
          size="icon"
          variant="ghost"
          aria-label={message("settings.title")}
          title={message("settings.title")}
          data-testid="startup-preferences"
        >
          <Settings2Icon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          label={message("settings.appearance")}
          value={theme}
          onValueChange={(value) => setTheme(value as Theme)}
        >
          {THEMES.map(([value, label]) => (
            <DropdownMenuChoice key={value} value={value}>
              {message(label)}
            </DropdownMenuChoice>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          label={message("language.label")}
          value={preference}
          onValueChange={(value) => setPreference(value as LocalePreference)}
        >
          <DropdownMenuChoice value="system">{message("language.system")}</DropdownMenuChoice>
          {LOCALE_DEFINITIONS.map((locale) => (
            <DropdownMenuChoice key={locale.tag} value={locale.tag}>
              {message(locale.labelKey)}
            </DropdownMenuChoice>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
