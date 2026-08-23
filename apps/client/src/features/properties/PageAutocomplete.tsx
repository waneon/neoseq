// Entity autocomplete backed by the graph summary's page or tag index.
// Selecting an entry writes a stable ID; an optional create action creates
// the requested entity first.
//
// The option list renders in a portal so it escapes the outline's scroll
// container and virtualized stacking context (which otherwise clipped it).

import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { isDeleted, pageKind, pageTitle } from "../../core-port/snapshot";
import { canonicalEntityName } from "../../entities/names";
import { useAnchoredPosition } from "@/ui/anchored";
import { useOverlayRoot } from "@/ui/overlay-root";
import { Input } from "@/ui/shadcn/input";
import { useSession, useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";

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
  kind = "page",
  onPick,
}: {
  placeholder: string;
  allowCreate?: boolean;
  autoFocus?: boolean;
  inputId?: string;
  kind?: "page" | "tag";
  onPick: (entityId: string) => void | Promise<void>;
}) {
  const session = useSession();
  const state = useSessionState();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const notify = useNotify();
  const { message, compare } = useI18n();

  const options = useMemo<Option[]>(() => {
    const canonical = canonicalEntityName(query);
    const entities = kind === "tag"
      ? state.snapshot.tags.map((tag) => ({ id: tag.id, label: tag.name }))
      : state.snapshot.pages
        .filter((page) => !isDeleted(page))
        .map((page) => ({ id: page.id, label: pageTitle(page), kind: pageKind(page) }));
    const matches = entities
      .filter((entity) =>
        canonical.length === 0 || canonicalEntityName(entity.label).includes(canonical)
      )
      .sort((left, right) => compare(left.label, right.label))
      .slice(0, 8);
    const exact = entities.some(
      (entity) => canonicalEntityName(entity.label) === canonical,
    );
    const result: Option[] = matches.map(({ id, label }) => ({ id, label }));
    if (allowCreate && canonical.length > 0 && !exact) {
      result.push({ id: "", label: query.trim(), create: true });
    }
    return result;
  }, [state.snapshot, query, allowCreate, kind, compare]);

  // The list sizes to its own content between the field's width and 320px, and
  // it flips above the field when the field sits near the bottom of the window.
  const position = useAnchoredPosition(
    open ? inputRef.current : null,
    { matchAnchorWidth: true, maxWidth: 320, maxHeight: 264 },
    options.length,
  );
  const overlayRoot = useOverlayRoot();

  const pick = async (option: Option) => {
    try {
      if (option.create) {
        const id = `${kind === "tag" ? "t" : "p"}-${crypto.randomUUID()}`;
        const command = kind === "tag"
          ? { type: "ensure_tag" as const, tag_id: id, name: option.label }
          : { type: "ensure_page" as const, page_id: id, title: option.label };
        await session.execute(command);
        await onPick(id);
      } else {
        await onPick(option.id);
      }
      setOpen(false);
      setQuery("");
    } catch (cause) {
      // The list closes and the value never lands, which on its own reads as an
      // autocomplete that lost the pick. What was typed stays in the field so
      // the choice can be made again.
      setOpen(false);
      setQuery(option.label);
      notify.failure(
        option.create
          ? message("failure.createEntity", { name: option.label })
          : message("failure.selectEntity", { name: option.label }),
        cause,
      );
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
        data-testid={`${kind}-autocomplete`}
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
        createPortal(
          <div className="ac-popover" style={position}>
            {options.length === 0 ? (
              <div role="status" className="ac-hint">
                {message(kind === "tag" ? "properties.noTags" : "properties.noPages")}
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
                      className="property-picker-option"
                      tabIndex={-1}
                      onPointerMove={() => setActive(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        if (blurTimer.current) clearTimeout(blurTimer.current);
                        void pick(option);
                      }}
                    >
                      <span className="property-picker-candidate">
                        <span>
                          {option.create
                            ? message("properties.createEntity", {
                                kind: message(kind === "tag" ? "common.tag" : "common.page"),
                                name: option.label,
                              })
                            : option.label}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>,
          overlayRoot,
        )}
    </div>
  );
}
