// Entity autocomplete backed by the graph summary's page or tag index.
// Selecting an entry writes a stable ID; an optional create action creates
// the requested entity first.
//
// The option list renders in a portal so it escapes the outline's scroll
// container and virtualized stacking context (which otherwise clipped it).

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Command } from "../../core-port/commands";
import { isDeleted, pageKind, pageTitle } from "../../core-port/snapshot";
import { canonicalEntityName } from "../../entities/names";
import { AnchoredPanel } from "@/ui/anchored-panel";
import { elementAnchor } from "@/ui/anchored";
import { Input } from "@/ui/shadcn/input";
import { useSession, useSessionSelector } from "../shell/session-context";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { randomUUID } from "@/lib/crypto";

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
  onCreate,
  onCreated,
}: {
  placeholder: string;
  allowCreate?: boolean;
  autoFocus?: boolean;
  inputId?: string;
  kind?: "page" | "tag";
  onPick: (entityId: string) => void | Promise<void>;
  /** Commands that attach a newly created entity to the intent's target. */
  onCreate?: (entityId: string) => Command | Command[];
  onCreated?: (entityId: string) => void | Promise<void>;
}) {
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.snapshot === right.snapshot,
  );
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const notify = useNotify();
  const { message, compare } = useI18n();

  const options = useMemo<Option[]>(() => {
    const canonical = canonicalEntityName(query);
    const entities =
      kind === "tag"
        ? state.snapshot.tags.map((tag) => ({ id: tag.id, label: tag.name }))
        : state.snapshot.pages
            .filter((page) => !isDeleted(page))
            .map((page) => ({ id: page.id, label: pageTitle(page), kind: pageKind(page) }));
    const matches = entities
      .filter(
        (entity) => canonical.length === 0 || canonicalEntityName(entity.label).includes(canonical),
      )
      .sort((left, right) => compare(left.label, right.label))
      .slice(0, 8);
    const exact = entities.some((entity) => canonicalEntityName(entity.label) === canonical);
    const result: Option[] = matches.map(({ id, label }) => ({ id, label }));
    if (allowCreate && canonical.length > 0 && !exact) {
      result.push({ id: "", label: query.trim(), create: true });
    }
    return result;
  }, [state.snapshot, query, allowCreate, kind, compare]);

  const pick = async (option: Option) => {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      if (option.create) {
        const id = `${kind === "tag" ? "t" : "p"}-${randomUUID()}`;
        const ensure =
          kind === "tag"
            ? { type: "ensure_tag" as const, tag_id: id, name: option.label }
            : { type: "ensure_page" as const, page_id: id, title: option.label };
        const attached = onCreate?.(id);
        const commands =
          attached === undefined
            ? [ensure]
            : [ensure, ...(Array.isArray(attached) ? attached : [attached])];
        await session.execute({ type: "batch", commands });
        await onCreated?.(id);
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
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || submitting.current) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (open ? Math.min(index + 1, Math.max(0, options.length - 1)) : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (open ? Math.max(index - 1, 0) : Math.max(0, options.length - 1)));
    } else if (event.key === "Enter" && open) {
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
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-busy={pending}
        aria-label={placeholder}
        aria-activedescendant={open && options[active] ? optionId(active) : undefined}
        placeholder={placeholder}
        value={query}
        readOnly={pending}
        autoFocus={autoFocus}
        data-testid={`${kind}-autocomplete`}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => {
          // An empty, untyped list offers no action. Keeping it closed also
          // leaves Escape for the picker that owns this field.
          setOpen(options.length > 0);
        }}
        onBlur={(event) => {
          // Options keep the caret in this field on pointerdown. Only a real
          // focus transfer out of the field and its list ends the interaction.
          if (!listRef.current?.contains(event.relatedTarget)) setOpen(false);
        }}
        onKeyDown={onKeyDown}
      />
      {open && inputRef.current && (
        <AnchoredPanel
          anchor={elementAnchor(inputRef.current)}
          id={listId}
          role="listbox"
          label={placeholder}
          className="ac-popover"
          options={{ matchAnchorWidth: true, maxWidth: 320, maxHeight: 264 }}
          revision={options.length}
          surfaceRef={listRef}
          dismissOnExternalScroll
          preserveAnchorFocus
          onClose={() => setOpen(false)}
        >
          {options.length === 0 ? (
            <div role="status" className="ac-hint">
              {message(kind === "tag" ? "properties.noTags" : "properties.noPages")}
            </div>
          ) : (
            <ul role="presentation" className="m-0 list-none p-0">
              {options.map((option, index) => (
                <li key={option.create ? "__create" : option.id} role="presentation">
                  <button
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === active}
                    data-active={index === active}
                    className="property-picker-option"
                    tabIndex={-1}
                    disabled={pending}
                    onPointerMove={() => setActive(index)}
                    onPointerDown={(event) => {
                      // Keep the field focused until the complete pointer
                      // gesture selects this row. Starting `pick` here can
                      // reconcile and close the portal before mouseup/click,
                      // leaving the browser to finish a gesture on a node
                      // that no longer exists.
                      event.preventDefault();
                    }}
                    onClick={() => void pick(option)}
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
        </AnchoredPanel>
      )}
    </div>
  );
}
