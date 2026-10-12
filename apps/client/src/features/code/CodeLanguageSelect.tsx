import { useMemo } from "react";
import { useI18n } from "../../i18n";
import { MenuSelect } from "@/ui/menu-select";
import { CODE_LANGUAGES, codeLanguage } from "./languages";

/** Radix reserves the empty value, so plain text has a name of its own. */
const PLAIN = "plain";

/**
 * The corner control of an editable code block. It rewrites only the fence's
 * info string; a name outside the list stays as written and shows as itself.
 */
export function CodeLanguageSelect({
  info,
  disabled,
  open,
  onOpenChange,
  onCloseAutoFocus,
  onChange,
}: {
  info: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onChange: (info: string) => void;
}) {
  const { message } = useI18n();
  const options = useMemo(
    () => [
      { value: PLAIN, label: message("code.plainText") },
      ...CODE_LANGUAGES.map((language) => ({ value: language.id, label: language.label })),
    ],
    [message],
  );
  const word = info.split(/\s+/u, 1)[0];
  return (
    <MenuSelect
      className="code-language"
      value={word ? (codeLanguage(word)?.id ?? word) : PLAIN}
      placeholder={word}
      options={options}
      label={message("code.language")}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      onValueChange={(value) => onChange(value === PLAIN ? "" : value)}
      testId="code-language"
    />
  );
}
