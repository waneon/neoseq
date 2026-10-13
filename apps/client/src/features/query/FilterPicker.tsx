// What a new filter asks about: every field the subject has, searchable, and a
// group for filters that combine differently.

import { useId, useMemo, useRef, useState } from "react";
import { BracesIcon, SearchIcon } from "lucide-react";
import { AnchoredPanel } from "@/ui/anchored-panel";
import type { Anchor } from "@/ui/anchored";
import { useI18n } from "../../i18n";
import { fuzzyScore } from "../commands/registry";
import type { PlanField } from "../../entities/query-plan";

export interface FilterChoice {
  field: PlanField;
  label: string;
}

export function FilterPicker({
  anchor,
  fields,
  onPick,
  onGroup,
  onClose,
}: {
  anchor: () => Anchor;
  fields: readonly FilterChoice[];
  onPick: (field: PlanField) => void;
  /** Absent when the condition tree is already as deep as it may go. */
  onGroup?: () => void;
  onClose: () => void;
}) {
  const { message } = useI18n();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const needle = query.trim();
    if (!needle) return fields;
    return fields
      .map((choice) => ({ choice, score: fuzzyScore(choice.label, needle) }))
      .filter((entry): entry is { choice: FilterChoice; score: number } => entry.score !== null)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.choice);
  }, [fields, query]);
  // The group is the list's last entry, reachable by keyboard like the rest.
  const count = results.length + (onGroup ? 1 : 0);
  const selected = Math.min(active, Math.max(count - 1, 0));
  const choose = (index: number) => {
    if (index < results.length) onPick(results[index].field);
    else onGroup?.();
  };

  return (
    <AnchoredPanel
      anchor={anchor}
      className="slash-menu qb-field-picker"
      label={message("query.addFilter")}
      options={{ width: 260, maxHeight: 360 }}
      revision={results.length}
      initialFocus={() => input.current}
      testId="qb-field-picker"
      onClose={onClose}
    >
      <div className="qb-picker-search">
        <SearchIcon aria-hidden />
        <input
          ref={input}
          role="combobox"
          aria-label={message("query.searchFields")}
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={count > 0 ? `${listId}-${selected}` : undefined}
          aria-autocomplete="list"
          placeholder={message("query.searchFields")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || count === 0) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((selected + step + count) % count);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(selected);
            }
          }}
        />
      </div>
      <div id={listId} role="listbox" aria-label={message("query.fieldLabel")}>
        {results.map((choice, index) => (
          <button
            key={choice.label}
            id={`${listId}-${index}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === selected}
            data-active={index === selected}
            onPointerMove={() => setActive(index)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => choose(index)}
          >
            <span className="slash-item-text">
              <strong>{choice.label}</strong>
            </span>
          </button>
        ))}
        {onGroup && (
          <button
            id={`${listId}-${results.length}`}
            type="button"
            role="option"
            tabIndex={-1}
            className="qb-picker-group"
            aria-selected={selected === results.length}
            data-active={selected === results.length}
            data-testid="qb-add-group"
            onPointerMove={() => setActive(results.length)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => choose(results.length)}
          >
            <BracesIcon aria-hidden />
            <span className="slash-item-text">
              <strong>{message("query.filterGroup")}</strong>
              <small>{message("query.filterGroupHint")}</small>
            </span>
          </button>
        )}
      </div>
    </AnchoredPanel>
  );
}
