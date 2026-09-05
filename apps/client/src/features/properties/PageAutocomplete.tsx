// Entity autocomplete backed by the graph summary's page or tag index.
// Selecting an entry writes a stable ID; an optional create action creates
// the requested entity first.
//
// The option list renders in a portal so it escapes the outline's scroll
// container and virtualized stacking context (which otherwise clipped it).

import { useMemo, useRef, useState } from "react";
import { canonicalEntityName } from "../../entities/names";
import type { Command } from "../../core-port/commands";
import { isDeleted, pageKind, pageTitle } from "../../core-port/snapshot";
import {
  Autocomplete,
  SearchField,
  Input as AriaInput,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
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
  const listRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
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
      result.push({ id: "__create", label: query.trim(), create: true });
    }
    return result;
  }, [state.snapshot, query, allowCreate, kind, compare]);

  const pick = async (option: Option) => {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setOpen(false);
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
      setQuery("");
    } catch (cause) {
      // The list closes and the value never lands, which on its own reads as an
      // autocomplete that lost the pick. What was typed stays in the field so
      // the choice can be made again.
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

  return (
    <div className="autocomplete">
      <Autocomplete
        inputValue={query}
        onInputChange={(value) => {
          setQuery(value);
          setOpen(true);
        }}
      >
        <SearchField aria-label={placeholder} isReadOnly={pending}>
          <AriaInput
            render={(props) => <Input {...props} />}
            ref={inputRef}
            id={inputId}
            role="combobox"
            aria-expanded={open}
            aria-busy={pending}
            placeholder={placeholder}
            autoFocus={autoFocus}
            data-testid={`${kind}-autocomplete`}
            onFocus={() => setOpen(options.length > 0)}
            onBlur={(event) => {
              if (!listRef.current?.contains(event.relatedTarget)) setOpen(false);
            }}
            onKeyDown={(event) => {
              if (
                !open &&
                !pending &&
                !event.nativeEvent.isComposing &&
                (event.key === "ArrowDown" || event.key === "ArrowUp")
              ) {
                event.preventDefault();
                setOpen(true);
              }
            }}
          />
        </SearchField>
        {open && inputRef.current && (
          <AnchoredPanel
            anchor={elementAnchor(inputRef.current)}
            label={placeholder}
            className="ac-popover"
            options={{ matchAnchorWidth: true, maxWidth: 320, maxHeight: 264 }}
            surfaceRef={listRef}
            preserveAnchorFocus
            dismissOnExternalScroll
            onClose={() => setOpen(false)}
          >
            <ListBox
              autoFocus="first"
              aria-label={placeholder}
              items={options}
              disabledKeys={pending ? options.map((option) => option.id) : []}
              onAction={(id) => {
                const option = options.find((option) => option.id === id);
                if (option) void pick(option);
              }}
              renderEmptyState={() => (
                <div className="ac-hint">
                  {message(kind === "tag" ? "properties.noTags" : "properties.noPages")}
                </div>
              )}
            >
              {(option) => (
                <ListBoxItem
                  id={option.id}
                  textValue={option.label}
                  className="property-picker-option"
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
                </ListBoxItem>
              )}
            </ListBox>
          </AnchoredPanel>
        )}
      </Autocomplete>
    </div>
  );
}
