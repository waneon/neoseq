// The views of a query, when the query is the page.
//
// A saved view has always been part of the query document; what changes here is
// how much of it the surface is allowed to say. Inside the outline the views are
// two entries in a menu, because a row of tabs growing out of a bullet is a
// second interface inside a sentence. Given a page, the views become the page's
// own instrument: they are permanent, they are named by the reader, and moving
// between them is the most repeated gesture on the surface — which is exactly
// what may not be hidden behind a menu (DESIGN.md § Disclosure, 6).
//
// **The track holds states; the verb stands outside it.** The strip is the
// product's one segmented control: a recessed track with the chosen key raised
// out of it, which is how this interface says "this one of these" without
// spending a second signal on it. `+` is a *verb*, so it may not be a key —
// dropped into the track it would read as a view called "plus". It sits beyond
// the track's edge, revealed on approach and pinned where there is no pointer.
//
// **The order is the reader's, and a drag says where it lands.** A tab is dragged
// past its neighbours and a seam — the same 2px accent rule the tag directory
// draws, turned on its side — marks the gap it is about to occupy. Nothing
// reflows while the pointer travels, and `Move left` / `Move right` in the tab's
// own menu is the same move from a keyboard.
//
// **A tab's menu is about the tab.** What a view *is* — its layout, its columns,
// its density, its order — is asked on the answer, through the same three
// controls a query in the outline uses, so one choice is never in two places
// depending on where the query is read. What is left here is what is true of this
// view alone: what it is called, a copy of it, its place in the row, and deleting
// it. **The current tab is the control that opens that menu**: pressing a tab
// that is not the answer chooses it; pressing the one that already is opens what
// it can be named and moved to. Its chevron is drawn rather than revealed,
// because a tab that opens a menu has to say so before it is pressed — and it is
// drawn on exactly one tab, so it reads as "this view" rather than as chrome.
// Right-click reaches any tab's menu without selecting it first, as it does on a
// bullet.

import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  PencilLineIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import type { QueryView, QueryViewKind } from "../../core-port/snapshot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { useI18n } from "../../i18n";

/** Where a view's menu was summoned, in viewport coordinates. */
interface MenuAt {
  viewId: string;
  x: number;
  y: number;
}

export function QueryViewTabs({
  views,
  activeView,
  readonly,
  panelId,
  onSelect,
  onAdd,
  onReorder,
  onRename,
  onDuplicate,
  onRemove,
  onMove,
}: {
  views: QueryView[];
  activeView: QueryView;
  readonly: boolean;
  /** The region the tabs answer for. */
  panelId: string;
  onSelect: (viewId: string) => void;
  onAdd: (kind: QueryViewKind) => void;
  /** The views in the order the reader just put them. */
  onReorder: (views: QueryView[]) => void;
  onRename: (view: QueryView, name: string) => void;
  onDuplicate: (view: QueryView) => void;
  onRemove: (view: QueryView) => void;
  onMove: (view: QueryView, delta: -1 | 1) => void;
}) {
  const { message } = useI18n();
  const [menuAt, setMenuAt] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** The tab the seam is drawn before, or `null` for the end of the strip. */
  const [seamBefore, setSeamBefore] = useState<string | null | undefined>(undefined);
  const strip = useRef<HTMLDivElement>(null);

  const menuView = views.find((view) => view.id === menuAt?.viewId) ?? null;
  const index = views.findIndex((view) => view.id === activeView.id);

  // A tablist is one tab stop with the arrows moving inside it. Activation
  // follows the arrow: every view is already rendered from the same answer, so
  // there is nothing a deferred `⏎` would save the reader from.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    let next = -1;
    if (step !== 0) next = (index + step + views.length) % views.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = views.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onSelect(views[next].id);
    // The freshly selected tab is the strip's only tab stop, so focus has to
    // follow the selection or the next arrow key would arrive nowhere.
    requestAnimationFrame(() => {
      strip.current
        ?.querySelector<HTMLElement>(`[data-view-id="${CSS.escape(views[next].id)}"]`)
        ?.focus();
    });
  };

  const endDrag = () => {
    setDragging(null);
    setSeamBefore(undefined);
  };

  /** Commit a dropped tab: its new place among the views, as positions. */
  const commitDrop = () => {
    const moved = views.find((view) => view.id === dragging);
    if (!moved || seamBefore === undefined) {
      endDrag();
      return;
    }
    const rest = views.filter((view) => view.id !== moved.id);
    const found = seamBefore === null ? -1 : rest.findIndex((view) => view.id === seamBefore);
    const at = found < 0 ? rest.length : found;
    endDrag();
    onReorder([...rest.slice(0, at), moved, ...rest.slice(at)]);
  };

  const summon = (view: QueryView, at: { x: number; y: number }) => {
    if (readonly) return;
    if (view.id !== activeView.id) onSelect(view.id);
    setMenuAt({ viewId: view.id, ...at });
  };

  /**
   * Where a menu was asked for. A pointer says exactly where; the keyboard's own
   * context-menu key says nothing at all, and read as a position that is the
   * window's top-left corner — so a request with no point falls back to the tab
   * it came from, which is the place the reader is already looking at.
   */
  const pointOf = (event: React.MouseEvent<HTMLElement>) => {
    if (event.clientX !== 0 || event.clientY !== 0) {
      return { x: event.clientX, y: event.clientY };
    }
    const box = event.currentTarget.getBoundingClientRect();
    return { x: box.left, y: box.bottom };
  };

  return (
    <div className="query-views">
      <div
        className="query-view-track"
        role="tablist"
        aria-label={message("query.views")}
        aria-orientation="horizontal"
        ref={strip}
        onKeyDown={onKeyDown}
        onDragOver={(event) => {
          // Only the track's own padding past the last tab reaches this.
          if (dragging === null || event.target !== event.currentTarget) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setSeamBefore(null);
        }}
        onDrop={(event) => {
          if (dragging === null) return;
          event.preventDefault();
          commitDrop();
        }}
      >
        {views.map((view, position) => {
          const current = view.id === activeView.id;
          if (renaming === view.id) {
            return (
              <RenameField
                key={view.id}
                view={view}
                onCommit={(name) => {
                  setRenaming(null);
                  onRename(view, name);
                }}
                onCancel={() => setRenaming(null)}
              />
            );
          }
          const opens = current && !readonly;
          const seam = dragging === null
            ? undefined
            : seamBefore === view.id
              ? "before"
              : seamBefore === null && view.id === views[views.length - 1]?.id
                ? "after"
                : undefined;
          return (
            <button
              key={view.id}
              type="button"
              role="tab"
              className="query-view-tab"
              data-view-id={view.id}
              data-testid="query-view-tab"
              data-dragging={dragging === view.id || undefined}
              data-seam={seam}
              aria-selected={current}
              aria-controls={panelId}
              aria-haspopup={opens ? "menu" : undefined}
              aria-expanded={opens ? menuAt?.viewId === view.id : undefined}
              tabIndex={current ? 0 : -1}
              draggable={!readonly && views.length > 1}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", view.name);
                event.dataTransfer.effectAllowed = "move";
                setDragging(view.id);
              }}
              onDragEnd={endDrag}
              onDragOver={(event) => {
                if (dragging === null || dragging === view.id) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                const box = event.currentTarget.getBoundingClientRect();
                const before = event.clientX < box.left + box.width / 2;
                setSeamBefore(before ? view.id : (views[position + 1]?.id ?? null));
              }}
              onClick={(event) =>
                opens ? summon(view, pointOf(event)) : onSelect(view.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                summon(view, pointOf(event));
              }}
            >
              <span className="query-view-name">{view.name}</span>
              {/* Drawn, not revealed: a control that opens a menu says so before
                  it is pressed. One tab carries it, so it reads as "this view"
                  rather than as a row of chrome. */}
              {opens && <ChevronDownIcon className="query-view-more" aria-hidden />}
            </button>
          );
        })}
      </div>

      {!readonly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="icon-btn query-view-add"
              aria-label={message("query.newView")}
              data-testid="query-view-add"
            >
              <PlusIcon aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{message("query.newView")}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onAdd("table")}>
              {message("query.viewTable")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAdd("list")}>
              {message("query.viewList")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* One menu, two routes into it. Radix needs something to position
          against, so the trigger is a zero-size anchor placed where the reader
          asked — the pointer, or the chevron they pressed. It is `aria-hidden`
          and unfocusable: it is not a control, it is a coordinate. */}
      <DropdownMenu
        modal={false}
        open={menuAt !== null}
        onOpenChange={(open) => (open ? undefined : setMenuAt(null))}
      >
        <DropdownMenuTrigger asChild>
          <span
            className="menu-anchor"
            aria-label={message("query.viewActions", {
              name: menuView?.name ?? "",
            })}
            aria-hidden
            style={{ left: menuAt?.x ?? 0, top: menuAt?.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            // The anchor is hidden from assistive technology and cannot be
            // focused, so focus goes back to the tab the menu was summoned from.
            event.preventDefault();
            strip.current
              ?.querySelector<HTMLElement>(`[data-view-id="${CSS.escape(activeView.id)}"]`)
              ?.focus();
          }}
        >
          <DropdownMenuItem
            data-testid="query-view-rename"
            onSelect={() => {
              const id = menuView?.id;
              if (id) requestAnimationFrame(() => setRenaming(id));
            }}
          >
            <PencilLineIcon aria-hidden />
            {message("query.renameView")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => menuView && onDuplicate(menuView)}>
            <CopyIcon aria-hidden />
            {message("query.duplicateView")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!menuView || views[0]?.id === menuView.id}
            onSelect={() => menuView && onMove(menuView, -1)}
          >
            <ChevronLeftIcon aria-hidden />
            {message("query.moveViewLeft")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!menuView || views[views.length - 1]?.id === menuView.id}
            onSelect={() => menuView && onMove(menuView, 1)}
          >
            <ChevronRightIcon aria-hidden />
            {message("query.moveViewRight")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={views.length <= 1}
            data-testid="query-view-delete"
            onSelect={() => menuView && onRemove(menuView)}
          >
            <Trash2Icon aria-hidden />
            {message("query.deleteView")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * A view is renamed where it stands: the tab becomes the field, at the tab's own
 * size. `⏎` commits, `⎋` abandons, and leaving the field commits what is in it —
 * the same three answers the page title and the new-tag card give.
 */
function RenameField({
  view,
  onCommit,
  onCancel,
}: {
  view: QueryView;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const { message } = useI18n();
  const [draft, setDraft] = useState(() => view.name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.select();
  }, []);

  return (
    // The field grows with what is in it, and it is the *text* that measures
    // itself: a width counted in `ch` is the width of a zero, so `읽는 중` came
    // out half the size it needed and the name was clipped as it was typed. The
    // wrapper carries the same string in a hidden pseudo-element sharing one
    // grid cell with the input, which is exact in every engine and needs no
    // measurement pass.
    <span className="query-view-tab query-view-rename" data-value={draft}>
      <input
        ref={input}
        value={draft}
        aria-label={message("query.renameView")}
        data-testid="query-view-rename-field"
        maxLength={128}
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
    </span>
  );
}
