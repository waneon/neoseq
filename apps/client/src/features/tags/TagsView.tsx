import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { elementAnchor } from "@/ui/anchored";
import {
  FolderIcon,
  HashIcon,
  SearchIcon,
  XIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PlusIcon,
  Settings2Icon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
} from "lucide-react";
import type { Command } from "../../core-port/commands";
import type { TagSnapshot } from "../../core-port/snapshot";
import { FAVOURITE_KEY, isFavourite } from "../../entities/favourites";
import { canonicalEntityName } from "../../entities/names";
import {
  TAG_GROUP_KEY,
  TAG_ORDER_KEY,
  groupOrderWrites,
  groupedTags,
  nextTagOrder,
  orderWrites,
  tagGroup,
  tagColor,
} from "../../entities/tag-identity";
import type { Placement } from "../../entities/ordering";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { Input } from "@/ui/shadcn/input";
import { ConfirmDialog, Dialog } from "../../ui/components";
import { Button } from "@/ui/shadcn/button";
import { useI18n } from "../../i18n";
import { graphPath } from "../graphs/routing";
import { LOCAL_REPOSITORY_ID } from "../repositories/directory";
import { useNotify } from "../notify/context";
import { useProgressiveItems } from "../../lib/progressive";
import { propertyDisplayName } from "../properties/property-display";
import { PropertyPicker } from "../properties/PropertyPicker";
import { useSession, useSessionSelector } from "../shell/session-context";
import {
  queryExecutionSignature,
  queryExecutionStore,
  useQueryExecution,
} from "../query/execution";
import { TagGroupField, TagIdentityPicker, TagMark } from "./TagIdentity";
import { randomUUID } from "@/lib/crypto";

const USAGE_SOURCE = `PREFIX neo: <urn:neoseq:vocab:v1:>

SELECT ?tag (COUNT(DISTINCT ?node) AS ?uses) WHERE {
  ?node neo:tag ?tag .
}
GROUP BY ?tag`;
const USAGE_OWNER = "tags:usage";
const LANGUAGE = "sparql-1.1/neoseq-v1" as const;

type Dragged = { kind: "tag"; tag: TagSnapshot } | { kind: "group"; name: string };

type TagDrop = { group: string | null; beforeId: string | null };
type GroupDrop = { index: number };
type Drag =
  | { kind: "tag"; tag: TagSnapshot; drop: TagDrop | null }
  | { kind: "group"; name: string; drop: GroupDrop | null }
  | null;

type Drop =
  | { kind: "tag"; group: string | null; beforeId: string | null }
  | { kind: "group"; index: number };

export function TagsView() {
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.snapshot === right.snapshot && left.mode === right.mode,
  );
  const notify = useNotify();
  const { message, compare } = useI18n();
  const readonly = state.mode === "readonly";
  const [creatingIn, setCreatingIn] = useState<{ group: string | null; name?: string } | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string | null | undefined>(undefined);
  const createRef = useRef<HTMLButtonElement>(null);
  const [drag, setDrag] = useState<Drag>(null);

  const tags = state.snapshot.tags;
  const groups = useMemo(() => groupedTags(tags, compare), [tags, compare]);
  const uses = useTagUsage();
  // A group has no independent lifetime. Removing its last tag returns to all tags.
  const activeGroup = groups.some((group) => group.name === selectedGroup)
    ? selectedGroup
    : undefined;
  const term = canonicalEntityName(search);
  const filtering = term.length > 0 || activeGroup !== undefined;
  const visibleGroups = groups
    .filter((group) => activeGroup === undefined || group.name === activeGroup)
    .map((group) => ({
      ...group,
      tags: group.tags.filter(
        (tag) =>
          !term ||
          canonicalEntityName(tag.name).includes(term) ||
          canonicalEntityName(group.name ?? "").includes(term),
      ),
    }))
    .filter((group) => group.tags.length > 0);
  const visibleCount = visibleGroups.reduce((count, group) => count + group.tags.length, 0);
  const clearFilters = () => {
    setSearch("");
    setSelectedGroup(undefined);
  };

  const run = (commands: Command[], failure: string) => {
    if (commands.length === 0) return;
    // Filing and ordering are one visible gesture even when several tag-owned
    // fields move. The core preflights and commits that gesture as one state.
    void session
      .execute(commands.length === 1 ? commands[0] : { type: "batch", commands })
      .catch((cause: unknown) => notify.failure(failure, cause));
  };

  const orderCommands = (writes: Placement[]): Command[] =>
    writes.map((write) => ({
      type: "set_property",
      owner: { kind: "tag", tag_id: write.id },
      key: TAG_ORDER_KEY,
      value: { type: "number", value: write.order },
    }));

  const placeTag = (tag: TagSnapshot, group: string | null, beforeId: string | null) => {
    const members = (groups.find((item) => item.name === group)?.tags ?? []).filter(
      (item) => item.id !== tag.id,
    );
    const found = beforeId === null ? -1 : members.findIndex((item) => item.id === beforeId);
    const index = found < 0 ? members.length : found;
    const ordered = [...members.slice(0, index), tag, ...members.slice(index)];
    const owner = { kind: "tag", tag_id: tag.id } as const;
    const commands: Command[] = [];
    if (tagGroup(tag) !== group) {
      commands.push(
        group === null
          ? { type: "remove_property", owner, key: TAG_GROUP_KEY }
          : {
              type: "set_property",
              owner,
              key: TAG_GROUP_KEY,
              value: { type: "string", value: group },
            },
      );
    }
    commands.push(...orderCommands(orderWrites(ordered, tag.id)));
    run(commands, message("failure.fileTag", { name: tag.name }));
  };

  const placeGroup = (name: string, index: number) => {
    const real = groups.filter((group) => group.name !== null);
    const from = real.findIndex((group) => group.name === name);
    if (from < 0) return;
    const rest = real.filter((_, position) => position !== from);
    const at = Math.max(0, Math.min(rest.length, index > from ? index - 1 : index));
    if (at === from) return;
    const next = [...rest.slice(0, at), real[from], ...rest.slice(at)];
    run(orderCommands(groupOrderWrites(next, at)), message("failure.fileTag", { name }));
  };

  const startDrag = (item: Dragged) => {
    if (item.kind === "tag") {
      setDrag({ kind: "tag", tag: item.tag, drop: null });
      return;
    }
    setDrag({ kind: "group", name: item.name, drop: null });
  };
  const endDrag = () => setDrag(null);

  const setDrop = (drop: Drop) => {
    setDrag((current) => {
      if (current?.kind === "tag" && drop.kind === "tag") {
        return { ...current, drop: { group: drop.group, beforeId: drop.beforeId } };
      }
      if (current?.kind === "group" && drop.kind === "group") {
        return { ...current, drop: { index: drop.index } };
      }
      return current;
    });
  };

  const commitDrop = () => {
    if (drag?.kind === "tag" && drag.drop) {
      placeTag(drag.tag, drag.drop.group, drag.drop.beforeId);
    } else if (drag?.kind === "group" && drag.drop) {
      placeGroup(drag.name, drag.drop.index);
    }
    endDrag();
  };

  const sections =
    drag?.kind === "tag" && !visibleGroups.some((group) => group.name === null)
      ? [...visibleGroups, { name: null, tags: [] }]
      : visibleGroups;
  const realGroups = groups.filter((group) => group.name !== null);

  return (
    <div className="page-scroll">
      <article
        className="page-body tags-directory enter-fade-view"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDrag((current) => (current ? { ...current, drop: null } : null));
          }
        }}
      >
        <header className="tags-header">
          <div className="tags-heading">
            <div className="title-row">
              <h1>{message("tags.title")}</h1>
              <span className="tags-total">{tags.length}</span>
            </div>
            {!readonly && (
              <Button
                ref={createRef}
                data-testid="new-tag"
                onClick={() => setCreatingIn({ group: activeGroup ?? null })}
              >
                <PlusIcon aria-hidden />
                {message("tags.new")}
              </Button>
            )}
          </div>
          <p className="tags-description">{message("tags.directoryHint")}</p>
        </header>

        {tags.length > 0 && (
          <div className="tags-browser-tools">
            <div className="tags-search">
              <SearchIcon aria-hidden />
              <Input
                type="search"
                className="h-[42px] bg-[var(--surface-1)] px-10"
                data-testid="tag-search"
                aria-label={message("tags.findTag")}
                placeholder={message("tags.findTag")}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  endDrag();
                }}
              />
              {search && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={message("tags.clearSearch")}
                  onClick={() => {
                    setSearch("");
                    window.document
                      .querySelector<HTMLInputElement>('[data-testid="tag-search"]')
                      ?.focus();
                  }}
                >
                  <XIcon aria-hidden />
                </Button>
              )}
            </div>
            {groups.some((group) => group.name !== null) && (
              <div className="tags-filters" role="group" aria-label={message("tags.filterGroup")}>
                <button
                  type="button"
                  aria-pressed={activeGroup === undefined}
                  onClick={() => {
                    setSelectedGroup(undefined);
                    endDrag();
                  }}
                >
                  {message("tags.all")}
                  <span>{tags.length}</span>
                </button>
                {groups.map((group) => (
                  <button
                    type="button"
                    key={group.name ?? " ungrouped"}
                    aria-pressed={activeGroup === group.name}
                    title={group.name ?? message("tags.ungrouped")}
                    onClick={() => {
                      setSelectedGroup(group.name);
                      endDrag();
                    }}
                  >
                    <span className="tags-filter-label">
                      {group.name ?? message("tags.ungrouped")}
                    </span>
                    <span>{group.tags.length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {tags.length === 0 ? (
          <div className="tags-empty-state" data-testid="tags-empty">
            <HashIcon aria-hidden />
            <h2>{message("tags.empty")}</h2>
            <p>{message("tags.emptyHint")}</p>
            {!readonly && (
              <Button variant="secondary" onClick={() => setCreatingIn({ group: null })}>
                <PlusIcon aria-hidden />
                {message("tags.createFirst")}
              </Button>
            )}
          </div>
        ) : visibleCount === 0 ? (
          <div className="tags-empty-state" data-testid="tags-no-results">
            <SearchIcon aria-hidden />
            <h2>{message("tags.noResults")}</h2>
            <p>{message("tags.noResultsHint")}</p>
            <div className="tags-empty-actions">
              <Button variant="secondary" onClick={clearFilters}>
                {message("tags.clearFilters")}
              </Button>
              {!readonly && term && (
                <Button
                  onClick={() => setCreatingIn({ group: activeGroup ?? null, name: search.trim() })}
                >
                  <PlusIcon aria-hidden />
                  {message("tags.new")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="tags-list-caption">
              <span role="status">{message("tags.listCount", { count: visibleCount })}</span>
              <span>{message("tags.usage")}</span>
            </div>
            <div className="tag-groups" data-testid="tag-list">
              {sections.map((group) => {
                const index = realGroups.findIndex((item) => item.name === group.name);
                return (
                  <TagGroupSection
                    key={group.name ?? " ungrouped"}
                    name={group.name}
                    headed={group.name !== null || sections.length > 1}
                    index={index}
                    last={index === realGroups.length - 1}
                    tags={group.tags}
                    uses={uses}
                    readonly={readonly}
                    reorderable={!filtering}
                    drag={drag}
                    onCreateHere={() => setCreatingIn({ group: group.name })}
                    onDragStart={startDrag}
                    onDragEnd={endDrag}
                    onDropAt={setDrop}
                    onCommit={commitDrop}
                    onPlaceTag={placeTag}
                    onPlaceGroup={placeGroup}
                  />
                );
              })}
            </div>
          </>
        )}
      </article>
      {creatingIn && (
        <NewTagDialog
          group={creatingIn.group}
          initialName={creatingIn.name ?? ""}
          existing={tags}
          returnFocus={() => createRef.current}
          onCancel={() => setCreatingIn(null)}
          onCreated={() => {
            clearFilters();
            setCreatingIn(null);
          }}
        />
      )}
    </div>
  );
}

function TagGroupSection({
  name,
  headed,
  index,
  last,
  tags,
  uses,
  readonly,
  drag,
  reorderable,
  onCreateHere,
  onDragStart,
  onDragEnd,
  onDropAt,
  onCommit,
  onPlaceTag,
  onPlaceGroup,
}: {
  name: string | null;
  headed: boolean;
  index: number;
  last: boolean;
  tags: TagSnapshot[];
  uses: Map<string, number>;
  readonly: boolean;
  drag: Drag;
  reorderable: boolean;
  onCreateHere: () => void;
  onDragStart: (drag: Dragged) => void;
  onDragEnd: () => void;
  onDropAt: (drop: Drop) => void;
  onCommit: () => void;
  onPlaceTag: (tag: TagSnapshot, group: string | null, beforeId: string | null) => void;
  onPlaceGroup: (name: string, index: number) => void;
}) {
  const session = useSession();
  const allTags = useSessionSelector((state) => state.snapshot.tags);
  const notify = useNotify();
  const { message } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const tagWindow = useProgressiveItems(tags, (tag) => tag.id, 100);

  const fileCommand = (tag: TagSnapshot, group: string | null): Command => {
    const owner = { kind: "tag", tag_id: tag.id } as const;
    return group === null
      ? { type: "remove_property", owner, key: TAG_GROUP_KEY }
      : {
          type: "set_property",
          owner,
          key: TAG_GROUP_KEY,
          value: { type: "string", value: group },
        };
  };

  const fileAll = (group: string | null) => {
    const commands = allTags
      .filter((tag) => tagGroup(tag) === name)
      .map((tag) => fileCommand(tag, group));
    if (commands.length === 0) return;
    void session
      .execute(commands.length === 1 ? commands[0] : { type: "batch", commands })
      .catch((cause: unknown) => {
        notify.failure(message("failure.fileTag", { name: name ?? tags[0]?.name ?? "" }), cause);
      });
  };

  const renameGroup = (next: string) => {
    setRenaming(false);
    const trimmed = next.trim();
    if (!trimmed || trimmed === name) return;
    fileAll(trimmed);
  };

  const ungroup = () => {
    fileAll(null);
  };

  const movingGroup = drag?.kind === "group";
  const takesTag = drag?.kind === "tag";
  const groupDrop = drag?.kind === "group" ? drag.drop : null;
  const tagDrop = drag?.kind === "tag" ? drag.drop : null;
  const groupSeam =
    movingGroup && groupDrop && index >= 0
      ? groupDrop.index === index
        ? "before"
        : groupDrop.index === index + 1 && last
          ? "after"
          : undefined
      : undefined;

  return (
    <section
      className="tag-group"
      data-seam={groupSeam}
      data-dragging={(movingGroup && drag.name === name) || undefined}
      onDragOver={(event) => {
        if (!movingGroup || index < 0 || drag.name === name) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const box = event.currentTarget.getBoundingClientRect();
        const after = event.clientY > box.top + box.height / 2;
        onDropAt({ kind: "group", index: index + (after ? 1 : 0) });
      }}
      onDrop={(event) => {
        if (!drag) return;
        event.preventDefault();
        onCommit();
      }}
    >
      {headed && (
        <div
          className="tag-group-head"
          draggable={!readonly && reorderable && name !== null && !renaming}
          onDragStart={(event) => {
            if (name === null) return;
            event.dataTransfer.setData("text/plain", name);
            event.dataTransfer.effectAllowed = "move";
            onDragStart({ kind: "group", name });
          }}
          onDragEnd={onDragEnd}
          onDragOver={(event) => {
            if (!takesTag) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            // Dropped on the heading is dropped at the top of what it names.
            onDropAt({ kind: "tag", group: name, beforeId: tags[0]?.id ?? null });
          }}
        >
          {renaming ? (
            <GroupNameField
              initial={name ?? ""}
              onCommit={renameGroup}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <h2 data-testid="tag-group-name">
              <FolderIcon aria-hidden />
              {name ?? message("tags.ungrouped")}
            </h2>
          )}
          <span className="tag-group-count">{tags.length}</span>
          {!readonly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  className="tag-group-actions"
                  aria-label={message("tags.groupActions", {
                    name: name ?? message("tags.ungrouped"),
                  })}
                  data-testid="tag-group-menu"
                >
                  <MoreHorizontalIcon aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onCreateHere}>
                  <PlusIcon aria-hidden />
                  {message("tags.newHere")}
                </DropdownMenuItem>
                {name !== null && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={!reorderable || index <= 0}
                      data-testid="tag-group-up"
                      onSelect={() => onPlaceGroup(name, index - 1)}
                    >
                      <ChevronUpIcon aria-hidden />
                      {message("common.moveUp")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!reorderable || last}
                      data-testid="tag-group-down"
                      onSelect={() => onPlaceGroup(name, index + 2)}
                    >
                      <ChevronDownIcon aria-hidden />
                      {message("common.moveDown")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      data-testid="tag-group-rename"
                      onSelect={() => requestAnimationFrame(() => setRenaming(true))}
                    >
                      <PencilLineIcon aria-hidden />
                      {message("tags.renameGroup")}
                    </DropdownMenuItem>
                    <DropdownMenuItem data-testid="tag-group-ungroup" onSelect={ungroup}>
                      <Trash2Icon aria-hidden />
                      {message("tags.ungroupAll")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      <ul
        className="tag-rows"
        onDragOver={(event) => {
          // Only the gap below the rows reaches this: a row stops the event where
          // it can answer more precisely than "somewhere in this group".
          if (!takesTag || event.target !== event.currentTarget) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          onDropAt({ kind: "tag", group: name, beforeId: null });
        }}
      >
        {tagWindow.items.map((tag, position) => (
          <TagRow
            key={tag.id}
            tag={tag}
            uses={uses.get(tag.id)}
            readonly={readonly}
            reorderable={reorderable}
            dragging={drag?.kind === "tag" && drag.tag.id === tag.id}
            seam={
              tagDrop?.group === name
                ? tagDrop.beforeId === tag.id
                  ? "before"
                  : tagDrop.beforeId === null && position === tags.length - 1
                    ? "after"
                    : undefined
                : undefined
            }
            takesTag={takesTag}
            onDragStart={() => onDragStart({ kind: "tag", tag })}
            onDragEnd={onDragEnd}
            onDragOver={(before) =>
              onDropAt({
                kind: "tag",
                group: name,
                beforeId: before ? tag.id : (tags[position + 1]?.id ?? null),
              })
            }
            canMoveUp={reorderable && position > 0}
            canMoveDown={reorderable && position < tags.length - 1}
            onMove={(delta) => {
              const target = position + delta;
              if (target < 0 || target >= tags.length) return;
              onPlaceTag(tag, name, delta < 0 ? tags[target].id : (tags[target + 1]?.id ?? null));
            }}
          />
        ))}
        {tagWindow.remaining > 0 && (
          <li>
            <button type="button" className="tag-more" onClick={tagWindow.showMore}>
              {message("tags.showMore", {
                count: Math.min(tagWindow.remaining, 100),
              })}
            </button>
          </li>
        )}
        {tags.length === 0 && (
          <li
            className="tag-group-drop"
            data-seam={tagDrop?.group === name ? "into" : undefined}
            onDragOver={(event) => {
              if (!takesTag) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              onDropAt({ kind: "tag", group: name, beforeId: null });
            }}
          >
            {message("tags.dropHere")}
          </li>
        )}
      </ul>
    </section>
  );
}

function TagRow({
  tag,
  uses,
  readonly,
  reorderable,
  dragging,
  seam,
  takesTag,
  onDragStart,
  onDragEnd,
  onDragOver,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  tag: TagSnapshot;
  uses: number | undefined;
  readonly: boolean;
  reorderable: boolean;
  dragging: boolean;
  seam: "before" | "after" | undefined;
  takesTag: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (before: boolean) => void;
  onMove: (delta: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const { repositoryId = LOCAL_REPOSITORY_ID, graphId = "" } = useParams();
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  const [identityAt, setIdentityAt] = useState<HTMLElement | null>(null);
  const [picker, setPicker] = useState<{ key?: string; anchor: HTMLElement | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const markRef = useRef<HTMLElement | null>(null);
  const actionsRef = useRef<HTMLButtonElement>(null);

  const starred = isFavourite(tag);
  const summary = tag.defaults.map((field) => propertyDisplayName(field.key, message)).join(" · ");

  return (
    <li
      className="tag-row"
      data-testid="tag-row"
      data-dragging={dragging || undefined}
      data-seam={seam}
      data-hue={tagColor(tag) ?? undefined}
      draggable={!readonly && reorderable}
      onDragStart={(event) => {
        // A payload is what makes the drag real to the browser; the row being
        // moved is held in React state, where a drop can actually read it.
        event.dataTransfer.setData("text/plain", tag.name);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!takesTag) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const box = event.currentTarget.getBoundingClientRect();
        onDragOver(event.clientY < box.top + box.height / 2);
      }}
    >
      <span
        className="tag-row-mark"
        ref={(node) => {
          markRef.current = node;
        }}
      >
        <TagMark tag={tag} onOpen={readonly ? undefined : (anchor) => setIdentityAt(anchor)} />
      </span>
      <div className="tag-row-content">
        <Link
          className="tag-row-name"
          to={graphPath(repositoryId, graphId, `t/${tag.id}`)}
          draggable={false}
          title={tag.name}
          data-testid="tag-row-link"
        >
          <span>{tag.name}</span>
          {starred && <StarIcon aria-hidden />}
        </Link>
        {summary && (
          <span className="tag-row-defaults" title={summary}>
            {summary}
          </span>
        )}
      </div>
      <span
        className="tag-row-uses"
        data-empty={uses ? undefined : "true"}
        title={message("tags.usesLabel", { count: uses ?? 0 })}
      >
        <span aria-hidden>{uses ?? 0}</span>
        <span className="sr-only">{message("tags.usesLabel", { count: uses ?? 0 })}</span>
      </span>
      {!readonly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={actionsRef}
              size="icon"
              className="tag-row-actions"
              aria-label={message("tags.actionsNamed", { name: tag.name })}
              data-testid="tag-row-menu"
            >
              <MoreHorizontalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              data-testid="tag-row-favourite"
              onSelect={() => {
                const owner = { kind: "tag", tag_id: tag.id } as const;
                void session
                  .execute(
                    starred
                      ? { type: "remove_property", owner, key: FAVOURITE_KEY }
                      : {
                          type: "set_property",
                          owner,
                          key: FAVOURITE_KEY,
                          value: { type: "checkbox", value: true },
                        },
                  )
                  .catch((cause: unknown) =>
                    notify.failure(message("failure.customizeTag", { name: tag.name }), cause),
                  );
              }}
            >
              {starred ? <StarOffIcon aria-hidden /> : <StarIcon aria-hidden />}
              {message(starred ? "favourites.remove" : "favourites.add")}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="tag-row-customize"
              onSelect={() => requestAnimationFrame(() => setIdentityAt(markRef.current))}
            >
              <Settings2Icon aria-hidden />
              {message("tags.customize")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => requestAnimationFrame(() => setPicker({ anchor: markRef.current }))}
            >
              <PlusIcon aria-hidden />
              {message("tags.addDefault")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!canMoveUp}
              data-testid="tag-row-up"
              onSelect={() => onMove(-1)}
            >
              <ChevronUpIcon aria-hidden />
              {message("common.moveUp")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canMoveDown}
              data-testid="tag-row-down"
              onSelect={() => onMove(1)}
            >
              <ChevronDownIcon aria-hidden />
              {message("common.moveDown")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              data-testid="tag-delete"
              onSelect={() => setConfirmDelete(true)}
            >
              <Trash2Icon aria-hidden />
              {message("tags.deleteAction")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {identityAt && (
        <TagIdentityPicker
          tag={tag}
          anchor={elementAnchor(identityAt)}
          onClose={() => setIdentityAt(null)}
        />
      )}
      {picker && (
        <PropertyPicker
          target={{ owner: { kind: "tag_default", tag_id: tag.id }, bag: tag.defaults }}
          anchor={elementAnchor(picker.anchor)}
          initialKey={picker.key}
          onClose={() => setPicker(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={message("tags.deleteTitle")}
          cancelLabel={message("common.cancel")}
          confirmLabel={message("tags.deleteAction")}
          testId="confirm-delete-tag"
          returnFocus={() => actionsRef.current}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await session.execute({ type: "delete_tag", tag_id: tag.id });
          }}
          onConfirmError={(cause) =>
            notify.failure(message("failure.deleteTag", { name: tag.name }), cause)
          }
        >
          {message("tags.deleteConfirm", { name: tag.name })}
        </ConfirmDialog>
      )}
    </li>
  );
}

function NewTagDialog({
  group,
  initialName,
  existing,
  onCreated,
  onCancel,
  returnFocus,
}: {
  group: string | null;
  initialName: string;
  existing: TagSnapshot[];
  onCreated: () => void;
  onCancel: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const session = useSession();
  const { message } = useI18n();
  const [draft, setDraft] = useState(initialName);
  const [groupDraft, setGroupDraft] = useState(group ?? "");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const nameId = useId();
  const groupId = useId();
  const name = draft.trim();
  const duplicate =
    name && existing.some((tag) => canonicalEntityName(tag.name) === canonicalEntityName(name));

  const create = async () => {
    if (!name || duplicate || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFailure(null);
    const tagId = `t-${randomUUID()}`;
    const owner = { kind: "tag", tag_id: tagId } as const;
    const nextGroup = groupDraft.trim() || null;
    const siblings = existing.filter((tag) => tagGroup(tag) === nextGroup);
    const commands: Command[] = [{ type: "ensure_tag", tag_id: tagId, name }];
    if (nextGroup !== null)
      commands.push({
        type: "set_property",
        owner,
        key: TAG_GROUP_KEY,
        value: { type: "string", value: nextGroup },
      });
    commands.push({
      type: "set_property",
      owner,
      key: TAG_ORDER_KEY,
      value: { type: "number", value: nextTagOrder(siblings) },
    });
    try {
      await session.execute({ type: "batch", commands });
      onCreated();
    } catch {
      setFailure(message("failure.createEntity", { name }));
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      title={message("tags.new")}
      onClose={onCancel}
      dismissible={!pending}
      returnFocus={returnFocus}
    >
      <form
        className="tag-create-form"
        aria-busy={pending || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault();
        }}
      >
        <p>{message("tags.createHint")}</p>
        <div className="tag-create-field">
          <label htmlFor={nameId}>{message("tags.name")}</label>
          <Input
            id={nameId}
            autoFocus
            data-testid="new-tag-name"
            placeholder={message("tags.namePlaceholder")}
            value={draft}
            disabled={pending}
            aria-invalid={!!duplicate}
            aria-describedby={duplicate ? `${nameId}-error` : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setFailure(null);
            }}
          />
          {duplicate && (
            <p className="field-error" id={`${nameId}-error`} role="status">
              {message("tags.duplicate", { name })}
            </p>
          )}
        </div>
        <div className="tag-create-field">
          <label htmlFor={groupId}>
            {message("tags.group")}
            <span>{message("tags.optional")}</span>
          </label>
          <TagGroupField
            id={groupId}
            testId="new-tag-group"
            value={groupDraft || null}
            disabled={pending}
            onChange={(value) => setGroupDraft(value ?? "")}
          />
        </div>
        {failure && (
          <p className="field-error" role="alert">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            {message("common.cancel")}
          </Button>
          <Button
            type="submit"
            data-testid="new-tag-submit"
            disabled={!name || !!duplicate || pending}
          >
            {message("tags.new")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function GroupNameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const { message } = useI18n();
  const [draft, setDraft] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="tag-group-rename-input"
      value={draft}
      aria-label={message("tags.renameGroup")}
      data-testid="tag-group-rename-field"
      maxLength={64}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(draft);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

function useTagUsage(): Map<string, number> {
  const session = useSession();
  const canonicalRevision = useSessionSelector((state) => state.canonicalRevision);
  const store = queryExecutionStore(session);
  const request = useMemo(
    () => ({ kind: "raw_sparql" as const, language: LANGUAGE, source: USAGE_SOURCE, bindings: {} }),
    [],
  );
  const signature = useMemo(() => queryExecutionSignature(request), [request]);
  const execution = useQueryExecution(store, USAGE_OWNER, signature, canonicalRevision);

  useEffect(() => {
    void store.run(USAGE_OWNER, signature, canonicalRevision, request);
  }, [canonicalRevision, request, signature, store]);

  return useMemo(() => {
    const counts = new Map<string, number>();
    const result = execution.frame?.result;
    if (result?.kind !== "select") return counts;
    for (const row of result.rows) {
      const tag = row.tag;
      const uses = row.uses;
      if (tag?.kind !== "iri" || tag.entity?.kind !== "tag" || uses?.kind !== "literal") continue;
      const count = Number.parseInt(uses.value, 10);
      if (Number.isFinite(count)) counts.set(tag.entity.id, count);
    }
    return counts;
  }, [execution.frame]);
}
