// The graph's tags, and the one screen for keeping them in order.
//
// A grid of identical cards is a fine way to show four tags and a terrible way to
// manage forty: nothing is grouped, nothing is told apart, and the only thing a
// card can say about a tag is its name. This is a **directory** instead — the
// shape the rail already uses for pages, one step richer:
//
//   - **Groups are the structure.** A group is a name a tag carries, so a group
//     exists because a tag is in it and vanishes when its last member leaves.
//     There is no group to create, delete, or keep in sync — only tags to file.
//     Everything unfiled gathers under one heading at the end rather than being
//     scattered under a made-up one.
//   - **A row says what a tag is.** Its mark in its own colour, its name, what it
//     copies onto a block, and how many things carry it — that last one from the
//     derived index, in one grouped count for the whole screen, because "which of
//     these is actually in use" is the question a tag list is opened to answer.
//   - **The order is the reader's.** A tag is dragged within its group or into
//     another; a whole group is dragged past its neighbours. The same three moves
//     are menu rows, which is the route that works from a keyboard, on a phone,
//     and for a group that does not exist yet.
//
// **A drag says where it will land, not merely that it is happening.** A wash
// over the group under the pointer answers "which group" and nothing else, which
// is the wrong question once a list has an order. The answer is a **seam**: one
// accent rule drawn exactly between the two rows the tag is about to sit between,
// or between the two groups a group is about to sit between. Nothing reflows
// while the pointer travels — rows sliding out from under a drag is the interface
// guessing, and the guess is wrong on every frame the reader changes their mind.
//
// The row is not a link wrapping controls — that is a control inside a control.
// The name is the link, the mark and the `⋯` are its siblings, and the row's
// hover wash is what makes the three read as one thing.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { elementAnchor } from "@/ui/anchored";
import {
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
import { ConfirmDialog } from "../../ui/components";
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
import { TagIdentityPicker, TagMark } from "./TagIdentity";

/**
 * How many things carry each tag, in one query for the whole screen. It is the
 * fact a tag list exists to surface and the one thing a snapshot cannot answer:
 * membership lives on every block of every page, and only the derived index has
 * all of them resident.
 */
const USAGE_SOURCE = `PREFIX neo: <urn:neoseq:vocab:v1:>

SELECT ?tag (COUNT(DISTINCT ?node) AS ?uses) WHERE {
  ?node neo:tag ?tag .
}
GROUP BY ?tag`;
const USAGE_OWNER = "tags:usage";
const LANGUAGE = "sparql-1.1/neoseq-v1" as const;

/** What is in the reader's hand. */
type Dragged = { kind: "tag"; tag: TagSnapshot } | { kind: "group"; name: string };

type TagDrop = { group: string | null; beforeId: string | null };
type GroupDrop = { index: number };
type Drag =
  | { kind: "tag"; tag: TagSnapshot; drop: TagDrop | null }
  | { kind: "group"; name: string; drop: GroupDrop | null }
  | null;

/**
 * Where it would land. A tag lands *before* a named row, or at the end of its
 * group when nothing follows; a group lands at an index among the groups. Either
 * way the seam is drawn at exactly that place.
 */
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
  const [creatingIn, setCreatingIn] = useState<{ group: string | null } | null>(null);
  const [drag, setDrag] = useState<Drag>(null);

  const tags = state.snapshot.tags;
  const groups = useMemo(() => groupedTags(tags, compare), [tags, compare]);
  const uses = useTagUsage();

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

  /** File a tag: into a group, into a place inside one, or both at once. */
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

  /** Move a whole group's run past its neighbours. */
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

  // A tag can only be dragged *out* of every group if there is somewhere outside
  // to drop it, and a brand new tag needs a row to be typed into. The ungrouped
  // section is both, and it appears for the length of the gesture that needs it
  // rather than standing there empty forever.
  const wantsUngrouped = drag?.kind === "tag" || creatingIn?.group === null;
  const sections =
    wantsUngrouped && !groups.some((group) => group.name === null)
      ? [...groups, { name: null, tags: [] }]
      : groups;
  const realGroups = sections.filter((group) => group.name !== null).length;

  if (tags.length === 0 && readonly) {
    return (
      <div className="page-scroll">
        <article className="page-body enter-fade-view">
          <div className="title-row">
            <h1>{message("tags.title")}</h1>
          </div>
          <p className="tags-empty" data-testid="tags-empty">
            {message("tags.empty")}
          </p>
        </article>
      </div>
    );
  }

  let groupIndex = -1;
  return (
    <div className="page-scroll">
      <article
        className="page-body enter-fade-view"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDrag((current) => (current ? { ...current, drop: null } : null));
          }
        }}
      >
        <div className="title-row">
          <h1>{message("tags.title")}</h1>
          {!readonly && (
            <div className="title-actions">
              <Button data-testid="new-tag" onClick={() => setCreatingIn({ group: null })}>
                <PlusIcon aria-hidden />
                {message("tags.new")}
              </Button>
            </div>
          )}
        </div>
        <p className="tags-hint">{message("tags.hint")}</p>

        <div className="tag-groups" data-testid="tag-list">
          {sections.map((group) => {
            if (group.name !== null) groupIndex += 1;
            const index = group.name === null ? -1 : groupIndex;
            return (
              <TagGroupSection
                key={group.name ?? " ungrouped"}
                name={group.name}
                // A heading that names the only group there is says nothing, so a
                // graph whose tags are all unfiled is one plain list.
                headed={group.name !== null || sections.length > 1}
                index={index}
                last={index === realGroups - 1}
                tags={group.tags}
                uses={uses}
                readonly={readonly}
                drag={drag}
                creating={creatingIn?.group === group.name}
                onCreateHere={() => setCreatingIn({ group: group.name })}
                onCreated={() => setCreatingIn(null)}
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
      </article>
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
  creating,
  onCreateHere,
  onCreated,
  onDragStart,
  onDragEnd,
  onDropAt,
  onCommit,
  onPlaceTag,
  onPlaceGroup,
}: {
  name: string | null;
  headed: boolean;
  /** Position among the real groups; `-1` for the ungrouped section. */
  index: number;
  last: boolean;
  tags: TagSnapshot[];
  uses: Map<string, number>;
  readonly: boolean;
  drag: Drag;
  creating: boolean;
  onCreateHere: () => void;
  onCreated: () => void;
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
    const commands = tags.map((tag) => fileCommand(tag, group));
    if (commands.length === 0) return;
    void session
      .execute(commands.length === 1 ? commands[0] : { type: "batch", commands })
      .catch((cause: unknown) => {
        notify.failure(message("failure.fileTag", { name: name ?? tags[0]?.name ?? "" }), cause);
      });
  };

  /** Renaming a group is rewriting its members: there is nothing else to rename. */
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
          draggable={!readonly && name !== null && !renaming}
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
            <h2 data-testid="tag-group-name">{name ?? message("tags.ungrouped")}</h2>
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
                    {/* The keyboard's half of the drag, and the touch screen's. */}
                    <DropdownMenuItem
                      disabled={index <= 0}
                      data-testid="tag-group-up"
                      onSelect={() => onPlaceGroup(name, index - 1)}
                    >
                      <ChevronUpIcon aria-hidden />
                      {message("common.moveUp")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={last}
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
            canMoveUp={position > 0}
            canMoveDown={position < tags.length - 1}
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
        {creating && (
          <NewTagRow group={name} existing={allTags} onDone={onCreated} onCancel={onCreated} />
        )}
        {tags.length === 0 && !creating && (
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
  dragging: boolean;
  /** Which side of this row the seam is drawn on, if any. */
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
      draggable={!readonly}
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
      {/* The name is the link; the row is not. A link wrapping the mark and the
          menu would be a control inside a control. */}
      <Link
        className="tag-row-name"
        to={graphPath(repositoryId, graphId, `t/${tag.id}`)}
        draggable={false}
        // A name is as long as somebody made it, and an ellipsis with no way to
        // read the rest is a name the reader cannot check.
        title={tag.name}
        data-testid="tag-row-link"
      >
        {tag.name}
      </Link>
      {summary && (
        <span className="tag-row-defaults" title={summary}>
          {summary}
        </span>
      )}
      <span
        className="tag-row-uses"
        data-empty={uses ? undefined : "true"}
        aria-label={message("tags.usesLabel", { count: uses ?? 0 })}
      >
        {uses ?? 0}
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
            {/* The keyboard's half of the drag, and the touch screen's. */}
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
          target={{ kind: "tag", id: tag.id, bag: tag.defaults }}
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

/**
 * The one place a tag comes into existence. It is created *in* the group it was
 * opened from and at the end of it, so filing a new tag is not a second step and
 * creating one never reshuffles what is already filed. The field stays open for
 * the next name — naming ten tags is one gesture repeated, not ten.
 */
function NewTagRow({
  group,
  existing,
  onDone,
  onCancel,
}: {
  group: string | null;
  existing: TagSnapshot[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const create = async () => {
    const name = draft.trim();
    if (!name) return;
    const canonical = canonicalEntityName(name);
    if (existing.some((tag) => canonicalEntityName(tag.name) === canonical)) {
      notify.show({
        tone: "info",
        key: "tag-duplicate",
        title: message("tags.duplicate", { name }),
      });
      return;
    }
    const tagId = `t-${crypto.randomUUID()}`;
    const owner = { kind: "tag", tag_id: tagId } as const;
    const siblings = existing.filter((tag) => tagGroup(tag) === group);
    try {
      const commands: Command[] = [{ type: "ensure_tag", tag_id: tagId, name }];
      if (group !== null) {
        commands.push({
          type: "set_property",
          owner,
          key: TAG_GROUP_KEY,
          value: { type: "string", value: group },
        });
      }
      // Seeded on creation, so an ordinary move only ever writes the tag it moved.
      commands.push({
        type: "set_property",
        owner,
        key: TAG_ORDER_KEY,
        value: { type: "number", value: nextTagOrder(siblings) },
      });
      await session.execute({ type: "batch", commands });
      setDraft("");
      inputRef.current?.focus();
    } catch (error) {
      notify.failure(message("failure.createEntity", { name }), error);
    }
  };

  return (
    <li className="tag-row tag-row-new">
      <span className="tag-row-mark">
        <span className="tag-mark" aria-hidden>
          <span className="hash">#</span>
        </span>
      </span>
      <Input
        ref={inputRef}
        aria-label={message("tags.new")}
        placeholder={message("tags.namePlaceholder")}
        data-testid="new-tag-name"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => (draft.trim() ? undefined : onCancel())}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void create();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          }
        }}
      />
    </li>
  );
}

/** A group is renamed where it is read, like every other name in the product. */
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
      className="tag-group-field"
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

/**
 * One grouped count for every tag in the graph, answered by the derived index.
 * It re-runs on each canonical revision; the execution store deduplicates the
 * work and keeps the last answer on screen while the next one is built, so the
 * column never blinks back to zero between edits.
 */
function useTagUsage(): Map<string, number> {
  const session = useSession();
  const canonicalRevision = useSessionSelector((state) => state.canonicalRevision);
  const store = queryExecutionStore(session);
  const request = useMemo(() => ({ language: LANGUAGE, source: USAGE_SOURCE, bindings: {} }), []);
  const signature = useMemo(() => queryExecutionSignature(request), [request]);
  const execution = useQueryExecution(store, USAGE_OWNER, signature, canonicalRevision);

  useEffect(() => {
    void store.run(USAGE_OWNER, signature, canonicalRevision, request);
  }, [canonicalRevision, request, signature, store]);

  return useMemo(() => {
    const counts = new Map<string, number>();
    const result = execution.result;
    if (result?.kind !== "select") return counts;
    for (const row of result.rows) {
      const tag = row.tag;
      const uses = row.uses;
      if (tag?.kind !== "iri" || tag.entity?.kind !== "tag" || uses?.kind !== "literal") continue;
      const count = Number.parseInt(uses.value, 10);
      if (Number.isFinite(count)) counts.set(tag.entity.id, count);
    }
    return counts;
  }, [execution.result]);
}
