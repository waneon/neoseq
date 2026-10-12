import { useRef } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { useI18n } from "../i18n";

/** A filter field for a directory: Escape or the clear control empties it. */
export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  testId?: string;
}) {
  const { message } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="search-field">
      <SearchIcon aria-hidden />
      <input
        ref={input}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="search-field-clear"
          aria-label={message("common.clearSearch")}
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          <XIcon aria-hidden />
        </button>
      )}
    </div>
  );
}
