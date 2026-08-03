// Page reference autocomplete backed by the core snapshot's page index.
// Selecting an entry writes a stable PageId; an optional create action
// makes a new page and then resolves to its id.

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isDeleted, pageKind, pageTitle } from "../../core-port/snapshot";
import { useSession, useSessionState } from "../shell/session-context";

interface Option {
  id: string;
  label: string;
  create?: boolean;
}

export function PageAutocomplete({
  placeholder,
  allowCreate = false,
  autoFocus = false,
  inputId,
  onPick,
}: {
  placeholder: string;
  allowCreate?: boolean;
  autoFocus?: boolean;
  inputId?: string;
  onPick: (pageId: string) => void | Promise<void>;
}) {
  const session = useSession();
  const state = useSessionState();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const options = useMemo<Option[]>(() => {
    const lower = query.trim().toLowerCase();
    const pages = state.snapshot.pages
      .filter((page) => !isDeleted(page))
      .map((page) => ({ id: page.id, label: pageTitle(page), kind: pageKind(page) }))
      .filter((page) => lower.length === 0 || page.label.toLowerCase().includes(lower))
      .sort((left, right) => left.label.localeCompare(right.label))
      .slice(0, 8);
    const exact = pages.some((page) => page.label.toLowerCase() === lower);
    const result: Option[] = pages.map(({ id, label }) => ({ id, label }));
    if (allowCreate && lower.length > 0 && !exact) {
      result.push({ id: "", label: query.trim(), create: true });
    }
    return result;
  }, [state.snapshot, query, allowCreate]);

  const pick = async (option: Option) => {
    setOpen(false);
    setQuery("");
    if (option.create) {
      const pageId = `p-${crypto.randomUUID()}`;
      await session
        .execute({ type: "ensure_page", page_id: pageId, title: option.label })
        .catch(() => undefined);
      await onPick(pageId);
    } else {
      await onPick(option.id);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[active];
      if (option) void pick(option);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="autocomplete">
      <input
        id={inputId}
        className="text-input"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={placeholder}
        placeholder={placeholder}
        value={query}
        autoFocus={autoFocus}
        data-testid="page-autocomplete"
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul className="autocomplete-list" role="listbox">
          {options.length === 0 && <li className="autocomplete-hint">No matching pages</li>}
          {options.map((option, index) => (
            <li key={option.create ? "__create" : option.id} data-active={index === active}>
              <button
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  void pick(option);
                }}
              >
                {option.create ? `Create page “${option.label}”` : option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
