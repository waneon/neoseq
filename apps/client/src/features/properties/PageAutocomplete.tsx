// Page reference autocomplete backed by the core snapshot's page index.
// Selecting an entry writes a stable PageId; an optional create action
// makes a new page and then resolves to its id.
//
// The option list renders in a portal so it escapes the outline's scroll
// container and virtualized stacking context (which otherwise clipped it).

import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { isDeleted, pageKind, pageTitle } from "../../core-port/snapshot";
import { Input } from "@/ui/shadcn/input";
import { cn } from "@/lib/utils";
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const listId = useId();

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

  const reposition = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setAnchor({ left: rect.left, top: rect.bottom + 4, width: rect.width });
  }, []);

  // Keep the portaled list glued to the input while open.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition, options.length]);

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
      setOpen(true);
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

  const optionId = (index: number) => `${listId}-opt-${index}`;

  return (
    <div className="autocomplete">
      <Input
        ref={inputRef}
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={open && options.length > 0 ? listId : undefined}
        aria-autocomplete="list"
        aria-label={placeholder}
        aria-activedescendant={open && options[active] ? optionId(active) : undefined}
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
      {open &&
        anchor &&
        createPortal(
          <div
            className="ac-popover"
            style={{
              left: anchor.left,
              top: anchor.top,
              minWidth: anchor.width,
              maxWidth: Math.max(anchor.width, 320),
            }}
          >
            {options.length === 0 ? (
              <div role="status" className="autocomplete-hint">
                No matching pages
              </div>
            ) : (
              <ul id={listId} role="listbox" className="m-0 list-none p-0">
                {options.map((option, index) => (
                  <li key={option.create ? "__create" : option.id}>
                    <button
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === active}
                      data-active={index === active}
                      className={cn(
                        "flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors",
                        "hover:bg-accent data-[active=true]:bg-accent",
                      )}
                      onMouseEnter={() => setActive(index)}
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
          </div>,
          document.body,
        )}
    </div>
  );
}
