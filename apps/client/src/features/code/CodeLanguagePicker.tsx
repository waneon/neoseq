// The corner control of an editable code block: its language, searchable.
//
// Choosing rewrites only the fence's info string. A name outside the curated
// list can still be written as typed; it is kept and shown as plain text.

import { useId, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useI18n } from "../../i18n";
import { AnchoredPanel } from "@/ui/anchored-panel";
import { elementAnchor } from "@/ui/anchored";
import { fuzzyScore } from "../commands/registry";
import { CODE_LANGUAGES, codeLanguage } from "./languages";

interface Choice {
  /** The info string the choice writes; empty for plain text. */
  info: string;
  label: string;
  custom?: boolean;
}

function rank(choices: readonly Choice[], query: string, names: Map<Choice, string[]>) {
  const scored: { choice: Choice; score: number }[] = [];
  for (const choice of choices) {
    let best: number | null = null;
    for (const name of names.get(choice) ?? [choice.label]) {
      const score = fuzzyScore(name, query);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best !== null) scored.push({ choice, score: best });
  }
  return scored.sort((left, right) => right.score - left.score).map((entry) => entry.choice);
}

export function CodeLanguagePicker({
  info,
  disabled,
  open,
  onOpenChange,
  onChange,
  returnFocus,
}: {
  info: string;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (info: string) => void;
  /** Where focus goes when the list closes; the trigger by default. */
  returnFocus?: () => HTMLElement | null;
}) {
  const { message } = useI18n();
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const word = info.split(/\s+/u, 1)[0];
  const current = word ? codeLanguage(word) : undefined;
  const { choices, names } = useMemo(() => {
    const plain: Choice = { info: "", label: message("code.plainText") };
    const languages = CODE_LANGUAGES.map((language): Choice => ({
      info: language.id,
      label: language.label,
    }));
    const all = [plain, ...languages];
    return {
      choices: all,
      names: new Map<Choice, string[]>([
        [plain, [plain.label, "plain", "text", "txt"]],
        ...languages.map((choice, index): [Choice, string[]] => [
          choice,
          [choice.label, CODE_LANGUAGES[index].id, ...CODE_LANGUAGES[index].aliases],
        ]),
      ]),
    };
  }, [message]);

  const needle = query.trim();
  const results = useMemo((): Choice[] => {
    if (!needle) return choices;
    const ranked = rank(choices, needle, names);
    const exact = codeLanguage(needle);
    const name = needle.split(/\s+/u, 1)[0];
    return exact || name.includes("`")
      ? ranked
      : [...ranked, { info: name, label: name, custom: true }];
  }, [choices, names, needle]);
  const selected = Math.min(active, results.length - 1);

  const close = () => {
    setQuery("");
    setActive(0);
    onOpenChange(false);
  };
  const choose = (choice: Choice | undefined) => {
    if (!choice) return;
    onChange(choice.info);
    close();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="code-language"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={message("code.language")}
        disabled={disabled}
        data-testid="code-language"
        onClick={() => (open ? close() : onOpenChange(true))}
      >
        <span>{current?.label ?? (word || message("code.plainText"))}</span>
        <ChevronDownIcon aria-hidden />
      </button>
      {open && (
        <AnchoredPanel
          anchor={() => elementAnchor(trigger.current)}
          className="slash-menu code-language-menu"
          label={message("code.language")}
          options={{ width: 240, maxHeight: 340 }}
          revision={results.length}
          initialFocus={() => input.current}
          returnFocus={returnFocus}
          testId="code-language-menu"
          onClose={close}
        >
          <div className="code-language-search">
            <SearchIcon aria-hidden />
            <input
              ref={input}
              role="combobox"
              aria-label={message("code.searchLanguages")}
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={results[selected] ? `${listId}-${selected}` : undefined}
              aria-autocomplete="list"
              placeholder={message("code.searchLanguages")}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setActive((selected + step + results.length) % results.length);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  choose(results[selected]);
                }
              }}
            />
          </div>
          <div id={listId} role="listbox" aria-label={message("code.language")}>
            {results.map((choice, index) => (
              <button
                key={choice.custom ? `custom:${choice.info}` : choice.info}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === selected}
                data-active={index === selected}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(choice)}
              >
                <span className="slash-item-text">
                  <strong>
                    {choice.custom
                      ? message("code.useLanguage", { name: choice.label })
                      : choice.label}
                  </strong>
                </span>
                {!choice.custom && (choice.info === "" ? !word : choice.info === current?.id) && (
                  <CheckIcon aria-hidden />
                )}
              </button>
            ))}
          </div>
        </AnchoredPanel>
      )}
    </>
  );
}
