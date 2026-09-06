import { useId, useSyncExternalStore } from "react";
import { Settings2Icon } from "lucide-react";
import { LOCALE_DEFINITIONS, useI18n } from "../../i18n";
import { setTheme, storedTheme, subscribeTheme } from "../../ui/theme";
import { Button } from "@/ui/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  const appearanceId = useId();
  const languageId = useId();

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
        <DropdownMenuLabel id={appearanceId}>{message("settings.appearance")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} aria-labelledby={appearanceId}>
          {THEMES.map(([value, label]) => (
            <DropdownMenuRadioItem key={value} value={value} onSelect={() => setTheme(value)}>
              {message(label)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel id={languageId}>{message("language.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={preference} aria-labelledby={languageId}>
          <DropdownMenuRadioItem value="system" onSelect={() => setPreference("system")}>
            {message("language.system")}
          </DropdownMenuRadioItem>
          {LOCALE_DEFINITIONS.map((locale) => (
            <DropdownMenuRadioItem
              key={locale.tag}
              value={locale.tag}
              onSelect={() => setPreference(locale.tag)}
            >
              {message(locale.labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
