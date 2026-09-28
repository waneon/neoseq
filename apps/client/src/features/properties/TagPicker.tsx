import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import type { BlockSnapshot, OutlineOwner } from "../../core-port/snapshot";
import { findBlock, findOutline } from "../../core-port/snapshot";
import { canonicalEntityName, namedDocuments } from "../../entities/names";
import { randomUUID } from "@/lib/crypto";
import { tagGroup } from "../../entities/tag-identity";
import type { Anchor } from "@/ui/anchored";
import { AnchoredPanel } from "@/ui/anchored-panel";
import { Button } from "@/ui/shadcn/button";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionSelector } from "../shell/session-context";
import { TagMark } from "../tags/TagIdentity";
import { TagChips } from "./TagChips";

export function TagPicker({
  owner,
  block,
  anchor,
  onClose,
}: {
  owner: OutlineOwner;
  block: BlockSnapshot;
  anchor: Anchor;
  onClose: () => void;
}) {
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.mode === right.mode && left.snapshot === right.snapshot,
  );
  const { message, compare } = useI18n();
  const notify = useNotify();
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const outline = findOutline(state.snapshot, owner);
  const current = (outline && findBlock(outline, block.id)) ?? block;
  const options = useMemo(() => {
    const canonical = canonicalEntityName(query);
    const matches = state.snapshot.tags
      .filter(
        (tag) =>
          !current.tags.includes(tag.id) &&
          (!canonical || canonicalEntityName(tag.name).includes(canonical)),
      )
      .sort((left, right) => compare(left.name, right.name));
    const rows: (
      | { kind: "existing"; tag: (typeof matches)[number]; name: string }
      | { kind: "create"; name: string }
      | { kind: "convert"; id: string; name: string }
    )[] = matches.map((tag) => ({ kind: "existing", tag, name: tag.name }));
    if (
      canonical &&
      !state.snapshot.tags.some((tag) => canonicalEntityName(tag.name) === canonical)
    ) {
      const page = namedDocuments(state.snapshot).find(
        (entry) =>
          !entry.deleted && !entry.journal_date && canonicalEntityName(entry.title) === canonical,
      );
      rows.push(
        page
          ? { kind: "convert", id: page.id, name: page.title }
          : { kind: "create", name: query.trim() },
      );
    }
    return rows;
  }, [state.snapshot, current.tags, query, compare]);
  const selectedIndex = Math.max(0, Math.min(active, options.length - 1));
  const readonly = state.mode === "readonly";

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, query]);

  const pick = async (option: (typeof options)[number]) => {
    if (submitting.current || readonly) return;
    submitting.current = true;
    setPending(true);
    try {
      const tagId =
        option.kind === "create"
          ? `t-${randomUUID()}`
          : option.kind === "convert"
            ? option.id
            : option.tag.id;
      const add = {
        type: "add_tag" as const,
        entity: { kind: "block" as const, owner, id: block.id },
        tag_id: tagId,
      };
      await session.execute(
        option.kind === "convert"
          ? { type: "batch", commands: [{ type: "set_entity_kind", id: tagId, kind: "tag" }, add] }
          : option.kind === "create"
            ? {
                type: "batch",
                commands: [{ type: "ensure_tag", tag_id: tagId, name: option.name }, add],
              }
            : add,
      );
      setQuery("");
      setActive(0);
    } catch (cause) {
      setQuery(option.name);
      notify.failure(
        message(option.kind === "create" ? "failure.createEntity" : "failure.selectEntity", {
          name: option.name,
        }),
        cause,
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <AnchoredPanel
      anchor={anchor}
      label={message("outline.tags")}
      className="tag-picker tag-membership-picker"
      options={{ width: 356, minWidth: 280, maxHeight: 460 }}
      surfaceRef={panelRef}
      dismissOnExternalScroll
      trapFocus
      initialFocus={() =>
        panelRef.current?.querySelector<HTMLElement>('[data-testid="tag-autocomplete"]') ?? null
      }
      testId="tag-picker"
      onClose={() => {
        if (!submitting.current) onClose();
      }}
      onEscapeKeyDown={(event) => {
        if (submitting.current) event.preventDefault();
      }}
    >
      <header className="tag-picker-head">
        <strong>{message("outline.tags")}</strong>
        <Button
          variant="ghost"
          size="icon"
          aria-label={message("common.close")}
          disabled={pending}
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </header>
      {current.tags.length > 0 && (
        <section className="tag-picker-applied" aria-label={message("tags.applied")}>
          <div className="tag-picker-section-label">
            <span>{message("tags.applied")}</span>
            <span>{current.tags.length}</span>
          </div>
          <div className="tag-picker-chips">
            <TagChips owner={owner} block={current} />
          </div>
        </section>
      )}
      {!readonly && (
        <>
          <div className="tag-picker-search">
            <SearchIcon aria-hidden />
            <input
              role="combobox"
              aria-label={message("properties.addTag")}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                options[selectedIndex] ? `${listId}-${selectedIndex}` : undefined
              }
              aria-busy={pending}
              readOnly={pending}
              autoComplete="off"
              placeholder={message("tags.findTag")}
              value={query}
              data-testid="tag-autocomplete"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (pending || event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setActive(
                    (selectedIndex + direction + options.length) % Math.max(1, options.length),
                  );
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const option = options[selectedIndex];
                  if (option) void pick(option);
                }
              }}
            />
            {query && (
              <button
                type="button"
                className="tag-group-reset"
                aria-label={message("tags.clearSearch")}
                disabled={pending}
                onClick={() => {
                  setQuery("");
                  setActive(0);
                }}
              >
                <XIcon aria-hidden />
              </button>
            )}
          </div>
          <div className="tag-picker-section-label tag-picker-available-label">
            <span>{message("tags.available")}</span>
            <span>{options.length}</span>
          </div>
          <div
            className="tag-picker-results"
            role="listbox"
            id={listId}
            aria-label={message("properties.addTag")}
            ref={listRef}
          >
            {options.length === 0 ? (
              <p role="status" className="tag-picker-empty">
                {state.snapshot.tags.length > 0 && !query.trim()
                  ? message("tags.allApplied")
                  : message("properties.noTags")}
              </p>
            ) : (
              options.map((option, index) => (
                <button
                  type="button"
                  role="option"
                  id={`${listId}-${index}`}
                  key={option.kind === "existing" ? option.tag.id : "__create"}
                  className="tag-picker-option"
                  aria-label={
                    option.kind === "convert"
                      ? message("entity.convertAndApply", { name: option.name })
                      : option.kind === "create"
                        ? message("properties.createEntity", {
                            kind: message("common.tag"),
                            name: option.name,
                          })
                        : option.name
                  }
                  aria-selected={false}
                  aria-disabled={pending}
                  data-active={index === selectedIndex}
                  tabIndex={-1}
                  onPointerMove={() => setActive(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => void pick(option)}
                >
                  <span className="tag-picker-option-mark">
                    {option.kind === "existing" ? (
                      <TagMark tag={option.tag} />
                    ) : (
                      <PlusIcon aria-hidden />
                    )}
                  </span>
                  <span className="tag-picker-option-name">
                    {option.kind === "convert"
                      ? message("entity.convertAndApply", { name: option.name })
                      : option.kind === "create"
                        ? message("properties.createEntity", {
                            kind: message("common.tag"),
                            name: option.name,
                          })
                        : option.name}
                  </span>
                  {option.kind === "existing" && tagGroup(option.tag) && (
                    <span className="tag-picker-option-group">{tagGroup(option.tag)}</span>
                  )}
                  {option.kind === "existing" && (
                    <PlusIcon className="tag-picker-add" aria-hidden />
                  )}
                </button>
              ))
            )}
          </div>
          <footer className="tag-picker-footer">{message("tags.pickerHint")}</footer>
        </>
      )}
    </AnchoredPanel>
  );
}
