// Virtualized outline editor. Rows are addressed by stable BlockId; text
// edits become SpliceMarkdown commands at IME-safe boundaries; structural
// keys map to core commands and the authoritative snapshot re-render is the
// only state path (no optimistic tree mutations).
//
// There are two kinds of "current" here and they are deliberately different
// things. The *caret* is where text goes, and it lives in one textarea. The
// *selection* is a set of blocks a structural command will act on — dragged out
// along the strip beside the bullets, moved by dragging any of its bullets, and
// deleted, indented or outdented as one. A caret and a selection never coexist:
// taking one drops the other, so Delete can only ever mean one thing.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import type { GraphSession } from "../../core-port/session";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { useCommands } from "../commands/context";
import { formatBinding, useShortcutBindings, bindingMatches } from "../commands/shortcuts";
import { useNotify, type Notifier } from "../notify/context";
import { failureReason } from "../notify/errors";
import type { PageSnapshot } from "../../core-port/snapshot";
import { findBlock, findPage, stringValue } from "../../core-port/snapshot";
import { flattenOutline, rowIndexOf, type OutlineRow } from "../../entities/outline";
import { useSession, useSessionState } from "../shell/session-context";
import { BlockInspector } from "../properties/BlockInspector";
import { TagChips } from "../properties/TagChips";
import { QueryBlock } from "../query/QueryBlock";
import { TaskProjection } from "../tasks/TaskProjection";
import { codePointIndex, codePointLength, diffSplice } from "./text-diff";
import {
  dropTarget,
  idsInRange,
  movePlan,
  outdentOrder,
  selectionRoots,
  selectionSize,
  type DropTarget,
} from "./selection";
import { useI18n, type MessageFunction } from "../../i18n";
import { diagnostics } from "../../diagnostics/coordinator";
import { lengthBucket } from "../../diagnostics/redaction";

const FLUSH_DEBOUNCE_MS = 400;
/** How far a bullet must travel before a click becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Edge band that pulls the scroll container along during a drag. */
const AUTOSCROLL_BAND_PX = 56;
const AUTOSCROLL_MAX_PX = 18;

// Pending rows bridge the async gap between Enter and the core's
// InsertBlock acknowledgement: each is focused synchronously so fast typing
// lands in the new block, then swaps to its real BlockId. They may chain
// (Enter pressed again before the previous insert resolves); commands are
// dispatched in order once each predecessor id becomes real. They render
// optimistically only because the inverse (drop the row) is known.
const PENDING_PREFIX = "pending-";

export function isPendingId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

interface PendingRow {
  tempId: string;
  /** Block this row follows — a real BlockId or an earlier tempId. */
  afterId: string;
  mode: "child" | "sibling";
  /** Markdown submitted with the InsertBlock command. */
  baseline: string;
  dispatched: boolean;
  /** Indent/outdent keys typed before the real id arrived. */
  structural: ("indent" | "outdent")[];
}

interface EditorContext {
  session: GraphSession;
  notify: Notifier;
  message: MessageFunction;
  pageId: string;
  readonly: boolean;
  focusedId: string | null;
  pendingCaret: RefObject<number | null>;
  inspectedId: string | null;
  menuFor: string | null;
  selected: ReadonlySet<string>;
  /** Rows the selection covers, passengers included — what a bulk verb will take. */
  selectionCount: number;
  setFocus(id: string | null, caret?: number): void;
  takeTreeFocus(): void;
  openMenu(id: string | null): void;
  toggleInspect(id: string): void;
  toggleCollapse(id: string): void;
  draftOf(row: OutlineRow): string;
  onInput(row: OutlineRow, value: string): void;
  onCompositionStart(row: OutlineRow): void;
  onCompositionEnd(row: OutlineRow): void;
  onKeyDown(row: OutlineRow, rows: OutlineRow[], event: KeyboardEvent<HTMLTextAreaElement>): void;
  flushNow(id: string): void;
  insertRootBlock(index: number): void;
  enqueuePendingInsert(row: OutlineRow, tail: string, asChild: boolean): void;
  queuePendingStructural(tempId: string, kind: "indent" | "outdent"): void;
  /** Pointer entry points for the selection strip and the bullet handle. */
  onGripPointerDown(row: OutlineRow, event: ReactPointerEvent): void;
  onBulletPointerDown(row: OutlineRow, event: ReactPointerEvent): void;
  onRowContextMenu(row: OutlineRow, event: React.MouseEvent): void;
  menu: {
    addChild(row: OutlineRow): void;
    indent(row: OutlineRow): void;
    outdent(row: OutlineRow): void;
    move(row: OutlineRow, delta: number): void;
    remove(row: OutlineRow, rows: OutlineRow[]): void;
    indentSelection(): void;
    outdentSelection(): void;
    removeSelection(): void;
  };
}

export function Outliner({
  page,
  scrollElement,
}: {
  page: PageSnapshot;
  scrollElement: HTMLElement | null;
}) {
  const session = useSession();
  const state = useSessionState();
  const commands = useCommands();
  const notify = useNotify();
  const bindings = useShortcutBindings();
  const { message } = useI18n();
  const [, force] = useReducer((tick: number) => tick + 1, 0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [marqueeing, setMarqueeing] = useState(false);
  const [drop, setDrop] = useState<(DropTarget & { top: number }) | null>(null);
  const drafts = useRef(new Map<string, string>());
  const baselines = useRef(new Map<string, string>());
  const composing = useRef(false);
  const flushTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingCaret = useRef<number | null>(null);
  const pendingSeq = useRef(0);
  const pendingRows = useRef<PendingRow[]>([]);
  const pendingDispatching = useRef(false);
  const pageRef = useRef(page);
  const collapsedRef = useRef(collapsed);
  const rowsRef = useRef<OutlineRow[]>([]);
  const selectedRef = useRef<ReadonlySet<string>>(selected);
  const anchorId = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const releasePointer = useRef<(() => void) | null>(null);
  const autoScroll = useRef<{ speed: number; frame: number } | null>(null);
  // GraphSession resolves commands only after reconciling its snapshot. Read
  // that snapshot directly during the temp-id handoff so a parent render that
  // still carries the previous page object cannot briefly remove the editor.
  const authoritativePage = findPage(state.snapshot, page.id) ?? page;
  pageRef.current = authoritativePage;
  collapsedRef.current = collapsed;
  selectedRef.current = selected;

  const rows = withPendingRows(flattenOutline(authoritativePage, collapsed), pendingRows.current);
  rowsRef.current = rows;
  const readonly = state.mode === "readonly";
  const selectionCount = useMemo(
    () => (selected.size === 0 ? 0 : selectionSize(rows, selected)),
    [rows, selected],
  );

  const recordEditorDiagnostic = useCallback((id: string, checkpoint: "flush" | "reconcile") => {
    if (isPendingId(id)) return;
    const draft = drafts.current.get(id);
    const baseline = baselines.current.get(id);
    const authoritative = findBlock(pageRef.current, id)?.markdown;
    diagnostics.recordEditorState(id, {
      checkpoint,
      snapshot_revision: state.revision,
      focused: focusedId === id,
      composing: focusedId === id && composing.current,
      draft_state: draft === undefined ? "absent" : draft === baseline ? "clean" : "dirty",
      draft_length: draft === undefined ? undefined : lengthBucket(draft.length),
      authoritative_length: authoritative === undefined ? undefined : lengthBucket(authoritative.length),
      draft_baseline_relation: valueRelation(draft, baseline),
      draft_authoritative_relation: valueRelation(draft, authoritative),
    });
  }, [focusedId, state.revision]);

  useEffect(() => {
    const ids = new Set(drafts.current.keys());
    if (focusedId) ids.add(focusedId);
    for (const id of ids) recordEditorDiagnostic(id, "reconcile");
    // This checkpoint deliberately follows authoritative session revisions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.revision]);

  // Drop a block's draft only once the authoritative snapshot matches it;
  // the focused draft and queued pending rows survive so IME composition
  // and in-flight typing are never clobbered.
  useEffect(() => {
    for (const id of [...drafts.current.keys()]) {
      if (id === focusedId || isPendingId(id)) continue;
      const block = findBlock(pageRef.current, id);
      if (!block || block.markdown === drafts.current.get(id)) {
        drafts.current.delete(id);
        baselines.current.delete(id);
      }
    }
  }, [state.revision, focusedId]);

  // A block that left the page cannot stay selected — a stale id would send the
  // next bulk command at something that is no longer there.
  useEffect(() => {
    if (selectedRef.current.size === 0) return;
    const live = new Set(
      [...selectedRef.current].filter((id) => findBlock(pageRef.current, id) !== undefined),
    );
    if (live.size !== selectedRef.current.size) setSelected(live);
  }, [state.revision]);

  const flush = useCallback(
    (id: string) => {
      if (isPendingId(id)) return; // transferred when the real id arrives
      const draft = drafts.current.get(id);
      const baseline = baselines.current.get(id);
      if (draft === undefined || baseline === undefined) return;
      recordEditorDiagnostic(id, "flush");
      const splice = diffSplice(baseline, draft);
      if (!splice) return;
      baselines.current.set(id, draft);
      session
        .execute({
          type: "splice_markdown",
          page_id: pageRef.current.id,
          block_id: id,
          ...splice,
        })
        .catch((error: unknown) => {
          // The core rejected the edit; fall back to authoritative text. The
          // row silently changing back under the caret is exactly the kind of
          // failure that has no home on screen, so it is reported.
          drafts.current.delete(id);
          baselines.current.delete(id);
          force();
          notify.failure(message("failure.lastEdit"), error);
        });
    },
    [message, notify, recordEditorDiagnostic, session],
  );

  const flushNow = useCallback(
    (id: string) => {
      const timer = flushTimers.current.get(id);
      if (timer) {
        clearTimeout(timer);
        flushTimers.current.delete(id);
      }
      flush(id);
    },
    [flush],
  );

  const scheduleFlush = useCallback(
    (id: string) => {
      const timer = flushTimers.current.get(id);
      if (timer) clearTimeout(timer);
      flushTimers.current.set(
        id,
        setTimeout(() => {
          flushTimers.current.delete(id);
          flush(id);
        }, FLUSH_DEBOUNCE_MS),
      );
    },
    [flush],
  );

  const focusedRef = useRef<string | null>(null);
  const setFocus = useCallback((id: string | null, caret?: number) => {
    pendingCaret.current = caret ?? null;
    focusedRef.current = id;
    setFocusedId(id);
    // The caret and the block selection are two answers to "what does the next
    // command act on", so only one of them may exist at a time.
    if (id !== null) setSelected((current) => (current.size === 0 ? current : new Set()));
  }, []);

  const clearSelection = useCallback(() => {
    anchorId.current = null;
    setSelected((current) => (current.size === 0 ? current : new Set()));
  }, []);

  /**
   * Hands the keyboard to the tree. A selection and a caret are the two answers
   * to "what does the next key act on", so taking one has to take the other's
   * focus with it — otherwise ⌫ reaches a textarea while rows sit highlighted.
   */
  const takeTreeFocus = useCallback(() => {
    focusedRef.current = null;
    setFocusedId(null);
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement) active.blur();
    viewportRef.current?.focus({ preventScroll: true });
  }, []);

  /** The ⇧-click anchor, resolved against the outline as it is now. */
  const anchorRowIndex = useCallback(
    (rows: OutlineRow[]) => (anchorId.current ? rowIndexOf(rows, anchorId.current) : -1),
    [],
  );

  /** Dispatches the oldest pending insert whose predecessor id is real. */
  const dispatchPending = useCallback(() => {
    if (pendingDispatching.current) return;
    const head = pendingRows.current[0];
    if (!head || head.dispatched || isPendingId(head.afterId)) return;
    // A preceding queued structural command may have reconciled after the
    // component's last render. Compute the next insert from GraphSession's
    // current snapshot, not the render-time page ref, so parent/index cannot
    // lag behind an indent or outdent that just completed.
    const currentPage =
      findPage(session.getState().snapshot, pageRef.current.id) ?? pageRef.current;
    const source = flattenOutline(currentPage, collapsedRef.current).find(
      (row) => row.block.id === head.afterId,
    );
    if (!source) {
      // The anchor block disappeared (e.g. undo); pending edits cannot land.
      abandonPending("The block it would follow is gone.");
      return;
    }
    head.dispatched = true;
    pendingDispatching.current = true;
    session
      .execute({
        type: "insert_block",
        page_id: currentPage.id,
        parent: head.mode === "child" ? head.afterId : source.parentId,
        index: head.mode === "child" ? 0 : source.index + 1,
        markdown: head.baseline,
      })
      .then(async (result) => {
        const realId = result.created_block;
        const typed = drafts.current.get(head.tempId) ?? head.baseline;
        const wasFocused = focusedRef.current === head.tempId;
        const active = document.activeElement;
        const caret =
          active instanceof HTMLTextAreaElement ? active.selectionStart : typed.length;
        if (realId) {
          for (const entry of pendingRows.current) {
            if (entry.afterId === head.tempId) entry.afterId = realId;
          }
          if (typed !== head.baseline) {
            // Keystrokes that raced the acknowledgement move to the block
            // and persist immediately (unless an IME composition is open).
            drafts.current.set(realId, typed);
            baselines.current.set(realId, head.baseline);
          }
          // Commit removal of the temp row, the real-id focus state, and the
          // reconciled snapshot in one browser task. The layout focus effect
          // runs before flushSync returns, so no key can land between the two
          // textarea identities or hit a handler that still names tempId.
          flushSync(() => {
            pendingRows.current.shift();
            drafts.current.delete(head.tempId);
            baselines.current.delete(head.tempId);
            if (wasFocused) setFocus(realId, caret);
            force();
          });
          if (typed !== head.baseline) {
            if (composing.current) scheduleFlush(realId);
            else flushNow(realId);
          }
          // Structural keys typed before acknowledgement replay in order and
          // must reconcile before the next pending insert computes its
          // parent/index from the snapshot.
          for (const kind of head.structural) {
            await session
              .execute({
                type: kind === "indent" ? "indent_block" : "outdent_block",
                page_id: pageRef.current.id,
                block_id: realId,
              })
              .catch((error: unknown) => {
                notify.failure(
                  kind === "indent"
                    ? message("failure.indentBlock")
                    : message("failure.outdentBlock"),
                  error,
                );
              });
          }
        } else {
          pendingRows.current.shift();
          drafts.current.delete(head.tempId);
          baselines.current.delete(head.tempId);
          abandonPending(message("outline.engineMissingId"));
        }
        pendingDispatching.current = false;
        force();
        dispatchPending();
      })
      .catch((error: unknown) => {
        pendingDispatching.current = false;
        abandonPending(failureReason(error, message));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, notify, session, scheduleFlush, setFocus]);

  /**
   * Drops the optimistic rows an insert never claimed. Whatever the user typed
   * into them goes with them, so this is never allowed to happen quietly.
   */
  const abandonPending = useCallback(
    (reason: string) => {
      const lost = pendingRows.current.length;
      const typed = pendingRows.current.some(
        (entry) => (drafts.current.get(entry.tempId) ?? "").length > 0,
      );
      let fallback: string | null = null;
      for (const entry of pendingRows.current) {
        if (!isPendingId(entry.afterId)) fallback = entry.afterId;
        drafts.current.delete(entry.tempId);
        baselines.current.delete(entry.tempId);
      }
      pendingRows.current = [];
      if (focusedRef.current && isPendingId(focusedRef.current)) setFocus(fallback);
      force();
      if (lost === 0) return;
      notify.show({
        tone: "danger",
        key: "pending-insert-abandoned",
        title: message("outline.newBlocksFailed", { count: lost }),
        detail: typed ? message("outline.pendingTypedLost", { reason }) : reason,
      });
    },
    [message, notify, setFocus],
  );

  const run = useCallback(
    (command: Parameters<GraphSession["execute"]>[0], summary: string) =>
      session.execute(command).catch((error: unknown) => {
        notify.failure(summary, error);
        return undefined;
      }),
    [notify, session],
  );

  // ── pointer plumbing ────────────────────────────────────────────────────
  //
  // Both gestures listen on the window rather than on the element they started
  // from: a virtualized row can be recycled out of the DOM mid-drag, and pointer
  // capture on a removed element takes the rest of the gesture with it.

  const stopAutoScroll = useCallback(() => {
    if (!autoScroll.current) return;
    cancelAnimationFrame(autoScroll.current.frame);
    autoScroll.current = null;
  }, []);

  const updateAutoScroll = useCallback(
    (clientY: number) => {
      const container = scrollElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const above = rect.top + AUTOSCROLL_BAND_PX - clientY;
      const below = clientY - (rect.bottom - AUTOSCROLL_BAND_PX);
      const speed =
        above > 0
          ? -Math.min(AUTOSCROLL_MAX_PX, (above / AUTOSCROLL_BAND_PX) * AUTOSCROLL_MAX_PX)
          : below > 0
            ? Math.min(AUTOSCROLL_MAX_PX, (below / AUTOSCROLL_BAND_PX) * AUTOSCROLL_MAX_PX)
            : 0;
      if (speed === 0) {
        stopAutoScroll();
        return;
      }
      if (autoScroll.current) {
        autoScroll.current.speed = speed;
        return;
      }
      const step = () => {
        const active = autoScroll.current;
        if (!active || !container) return;
        container.scrollTop += active.speed;
        active.frame = requestAnimationFrame(step);
      };
      autoScroll.current = { speed, frame: requestAnimationFrame(step) };
    },
    [scrollElement, stopAutoScroll],
  );

  const endGesture = useCallback(() => {
    releasePointer.current?.();
    releasePointer.current = null;
    stopAutoScroll();
  }, [stopAutoScroll]);

  useEffect(() => endGesture, [endGesture]);

  const listen = useCallback(
    (
      onMove: (event: PointerEvent) => void,
      onFinish: (event: PointerEvent, cancelled: boolean) => void,
    ) => {
      // A second press while a gesture is live retires the first one. Without
      // this its window listeners would outlive it, and a later bare move would
      // still be driving a drag nobody is holding.
      endGesture();
      const move = (event: PointerEvent) => onMove(event);
      const finish = (cancelled: boolean) => (event: PointerEvent) => {
        endGesture();
        onFinish(event, cancelled);
      };
      const release = finish(false);
      const cancel = finish(true);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", cancel);
      releasePointer.current = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", release);
        window.removeEventListener("pointercancel", cancel);
      };
    },
    [endGesture],
  );

  /** Selection by range, not by rectangle — see `selection.ts`. */
  const onGripPointerDown = useCallback(
    (row: OutlineRow, event: ReactPointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = rowIndexOf(rowsRef.current, row.block.id);
      if (start < 0) return;
      const extend = event.shiftKey ? anchorRowIndex(rowsRef.current) : -1;
      const anchor = extend >= 0 ? extend : start;
      anchorId.current = rowsRef.current[anchor]?.block.id ?? null;
      takeTreeFocus();
      setMarqueeing(true);
      setSelected(selectableIds(rowsRef.current, anchor, start));
      listen(
        (move) => {
          updateAutoScroll(move.clientY);
          const index = rowIndexAtPoint(viewportRef.current, move.clientY, rowsRef.current);
          if (index === null) return;
          const next = selectableIds(rowsRef.current, anchor, index);
          setSelected((current) => (sameIds(current, next) ? current : next));
        },
        () => {
          setMarqueeing(false);
          takeTreeFocus();
        },
      );
    },
    [listen, updateAutoScroll],
  );

  const applyMove = useCallback(
    (target: DropTarget, moving: ReadonlySet<string>) => {
      const roots = selectionRoots(rowsRef.current, moving);
      if (roots.length === 0) return;
      void runSequence(
        movePlan(rowsRef.current, roots, target).map((step) => ({
          type: "move_block" as const,
          block_id: step.blockId,
          page_id: pageRef.current.id,
          parent: step.parent,
          index: step.index,
        })),
        session,
        (error) => notify.failure(message("failure.moveBlocks", { count: roots.length }), error),
      );
    },
    [message, notify, session],
  );

  /** The bullet is the block's handle: press, move, and the subtree travels. */
  const onBulletPointerDown = useCallback(
    (row: OutlineRow, event: ReactPointerEvent) => {
      if (event.button !== 0) return;
      if (isPendingId(row.block.id)) {
        // Nothing to drag or act on yet, and the press must not reach Radix's
        // own trigger handling and open a menu with no content.
        event.preventDefault();
        return;
      }
      const index = rowIndexOf(rowsRef.current, row.block.id);
      if (index < 0) return;

      // Shift extends the selection, ⌘/⌃ toggles one row: the two gestures a
      // list has meant everywhere for thirty years. Both hand the keyboard to the
      // tree, because leaving the caret in a textarea while rows are highlighted
      // is exactly the ambiguity the two states are meant not to have.
      const anchor = anchorRowIndex(rowsRef.current);
      if (event.shiftKey && anchor >= 0) {
        event.preventDefault();
        takeTreeFocus();
        setSelected(selectableIds(rowsRef.current, anchor, index));
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        takeTreeFocus();
        anchorId.current = row.block.id;
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(row.block.id)) next.delete(row.block.id);
          else next.add(row.block.id);
          return next;
        });
        return;
      }

      event.preventDefault();
      // The anchor moves on every plain press, so a following ⇧-click extends
      // from the row the user actually last touched. It is stored by id: a row
      // index stops meaning anything the moment a block is inserted or deleted.
      anchorId.current = row.block.id;
      const startX = event.clientX;
      const startY = event.clientY;
      const moving = selectedRef.current.has(row.block.id)
        ? new Set(selectedRef.current)
        : new Set([row.block.id]);
      let started = false;
      let target: DropTarget | null = null;
      const metrics = readMetrics(sectionRef.current);

      listen(
        (move) => {
          if (!started) {
            if (Math.abs(move.clientY - startY) + Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX) {
              return;
            }
            if (readonly) return;
            started = true;
            takeTreeFocus();
            setSelected(moving);
            setDragging(true);
          }
          updateAutoScroll(move.clientY);
          const resolved = resolveDrop(
            viewportRef.current,
            rowsRef.current,
            moving,
            move.clientX,
            move.clientY,
            metrics,
          );
          target = resolved;
          setDrop(resolved);
        },
        (_event, cancelled) => {
          setDrop(null);
          setDragging(false);
          if (cancelled) return;
          if (!started) {
            // A press that never travelled is a click: put the caret in the line.
            setFocus(row.block.id);
            return;
          }
          if (target) applyMove(target, moving);
        },
      );
    },
    [applyMove, listen, readonly, setFocus, updateAutoScroll],
  );

  const onRowContextMenu = useCallback(
    (row: OutlineRow, event: React.MouseEvent) => {
      event.preventDefault();
      if (isPendingId(row.block.id)) return;
      // Right-clicking outside the selection collapses it onto the row under the
      // pointer; inside it, the selection is what the menu is about.
      if (!selectedRef.current.has(row.block.id)) {
        anchorId.current = row.block.id;
        setSelected(new Set());
      }
      setMenuFor(row.block.id);
    },
    [],
  );

  const editor: EditorContext = {
    session,
    notify,
    message,
    pageId: authoritativePage.id,
    readonly,
    focusedId,
    pendingCaret,
    inspectedId,
    menuFor,
    selected,
    selectionCount,
    setFocus,
    takeTreeFocus,
    openMenu: setMenuFor,
    toggleInspect: (id) => setInspectedId((current) => (current === id ? null : id)),
    toggleCollapse: (id) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      // A row that just went out of sight cannot stay selected: ⌫ and ⇥ resolve
      // the selection against the *visible* outline, so a hidden member would
      // make them quietly do nothing.
      if (selectedRef.current.size > 0) {
        const visible = new Set(
          flattenOutline(pageRef.current, nextCollapsed(collapsedRef.current, id)).map(
            (row) => row.block.id,
          ),
        );
        const kept = new Set([...selectedRef.current].filter((entry) => visible.has(entry)));
        if (kept.size !== selectedRef.current.size) setSelected(kept);
      }
    },
    draftOf: (row) => drafts.current.get(row.block.id) ?? row.block.markdown,
    onInput: (row, value) => {
      if (!baselines.current.has(row.block.id)) {
        baselines.current.set(row.block.id, row.block.markdown);
      }
      drafts.current.set(row.block.id, value);
      force();
      if (!composing.current) scheduleFlush(row.block.id);
    },
    onCompositionStart: (row) => {
      composing.current = true;
      const timer = flushTimers.current.get(row.block.id);
      if (timer) {
        clearTimeout(timer);
        flushTimers.current.delete(row.block.id);
      }
    },
    onCompositionEnd: (row) => {
      composing.current = false;
      scheduleFlush(row.block.id);
    },
    onKeyDown: (row, allRows, event) => onKeyDown(editor, row, allRows, event, bindings),
    flushNow,
    onGripPointerDown,
    onBulletPointerDown,
    onRowContextMenu,
    enqueuePendingInsert: (row, tail, asChild) => {
      pendingSeq.current += 1;
      const tempId = `${PENDING_PREFIX}${pendingSeq.current}`;
      drafts.current.set(tempId, tail);
      // Enter must return with the new textarea already mounted and focused;
      // the following key may arrive in the next browser task with no delay.
      flushSync(() => {
        pendingRows.current.push({
          tempId,
          afterId: row.block.id,
          mode: asChild ? "child" : "sibling",
          baseline: tail,
          dispatched: false,
          structural: [],
        });
        setFocus(tempId, 0);
        force();
      });
      dispatchPending();
    },
    queuePendingStructural: (tempId, kind) => {
      const pending = pendingRows.current.find((entry) => entry.tempId === tempId);
      pending?.structural.push(kind);
    },
    insertRootBlock: (index) => {
      void session
        .execute({
          type: "insert_block",
          page_id: authoritativePage.id,
          parent: null,
          index,
          markdown: "",
        })
        .then((result) => {
          if (result.created_block) setFocus(result.created_block, 0);
        })
        .catch((error: unknown) => {
          notify.failure(message("failure.addBlock"), error);
        });
    },
    menu: {
      addChild: (row) => {
        flushNow(row.block.id);
        setCollapsed((current) => {
          const next = new Set(current);
          next.delete(row.block.id);
          return next;
        });
        editor.enqueuePendingInsert(row, "", true);
      },
      indent: (row) => {
        flushNow(row.block.id);
        void run(
          {
            type: "indent_block",
            page_id: authoritativePage.id,
            block_id: row.block.id,
          },
          message("failure.indentBlock"),
        );
      },
      outdent: (row) => {
        flushNow(row.block.id);
        void run(
          {
            type: "outdent_block",
            page_id: authoritativePage.id,
            block_id: row.block.id,
          },
          message("failure.outdentBlock"),
        );
      },
      move: (row, delta) => {
        flushNow(row.block.id);
        const target = row.index + delta;
        if (target < 0 || target >= row.siblingCount) return;
        void run(
          {
            type: "move_block",
            block_id: row.block.id,
            page_id: authoritativePage.id,
            parent: row.parentId,
            index: target,
          },
          delta < 0 ? message("failure.moveBlockUp") : message("failure.moveBlockDown"),
        );
      },
      remove: (row, allRows) => {
        const position = rowIndexOf(allRows, row.block.id);
        const previous = allRows[position - 1]?.block.id ?? null;
        void run(
          {
            type: "delete_block",
            page_id: authoritativePage.id,
            block_id: row.block.id,
          },
          message("failure.deleteBlock"),
        ).then(() => {
          setFocus(previous);
        });
      },
      // Group structure runs one core command per selected root. Indent replays
      // in document order because each call re-reads the previous sibling;
      // outdent replays in reverse, because it drops each block immediately
      // after its former parent and would otherwise stack them backwards.
      indentSelection: () => {
        // Document order; see `outdentOrder` for why the other direction is not.
        const roots = selectionRoots(rowsRef.current, selectedRef.current);
        void runSequence(
          roots.map((root) => ({
            type: "indent_block" as const,
            page_id: authoritativePage.id,
            block_id: root.block.id,
          })),
          session,
          (error) => notify.failure(message("failure.indentBlock"), error),
        );
      },
      outdentSelection: () => {
        const roots = outdentOrder(selectionRoots(rowsRef.current, selectedRef.current));
        void runSequence(
          roots.map((root) => ({
            type: "outdent_block" as const,
            page_id: authoritativePage.id,
            block_id: root.block.id,
          })),
          session,
          (error) => notify.failure(message("failure.outdentBlock"), error),
        );
      },
      removeSelection: () => {
        const roots = selectionRoots(rowsRef.current, selectedRef.current);
        if (roots.length === 0) return;
        const first = rowIndexOf(rowsRef.current, roots[0].block.id);
        const fallback = rowsRef.current[first - 1]?.block.id ?? null;
        clearSelection();
        void runSequence(
          roots.map((root) => ({
            type: "delete_block" as const,
            page_id: authoritativePage.id,
            block_id: root.block.id,
          })),
          session,
          (error) =>
            notify.failure(message("failure.deleteBlocks", { count: roots.length }), error),
        ).then(() => setFocus(fallback));
      },
    },
  };

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 30,
    overscan: 10,
    // jsdom (component tests) has no layout; the observer corrects this in
    // real browsers.
    initialRect: { width: 800, height: 600 },
    getItemKey: (index) => rows[index].block.id,
  });

  // Keep keyboard-focused rows visible even when virtualization would have
  // recycled them.
  useEffect(() => {
    if (!focusedId) return;
    const index = rowIndexOf(rows, focusedId);
    if (index >= 0) virtualizer.scrollToIndex(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedId]);

  // ⌘⇧P means "properties of what is in front of me". While a block is focused
  // that is the block; the shell falls back to the page when this slot is empty.
  useEffect(() => {
    if (!focusedId || isPendingId(focusedId)) {
      commands.setBlockProperties(null);
      return;
    }
    commands.setBlockProperties(() => setInspectedId(focusedId));
    return () => commands.setBlockProperties(null);
  }, [commands, focusedId]);

  // Which thread segments to light: the indices of the focused block's ancestors,
  // outermost first. Each rendered row derives its own count from this, so nothing
  // walks the whole list. See DESIGN.md § The outline / Thread.
  const ancestors = ancestorPath(rows, focusedId);

  /** The bare keys a selection answers to. They only reach here while the tree
   * itself holds focus, which is exactly when no text field can lose them. */
  const onSelectionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (selected.size === 0 || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      // Put the caret back where the selection started rather than leaving focus
      // on a container with nothing selected — Escape means "back to writing".
      const roots = selectionRoots(rows, selected);
      clearSelection();
      if (roots[0]) setFocus(roots[0].block.id);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if (!readonly) editor.menu.removeSelection();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (readonly) return;
      if (event.shiftKey) editor.menu.outdentSelection();
      else editor.menu.indentSelection();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      // Stepping out of a selection lands the caret at the edge it left from.
      event.preventDefault();
      const roots = selectionRoots(rows, selected);
      const edge = event.key === "ArrowUp" ? roots[0] : roots[roots.length - 1];
      if (edge) setFocus(edge.block.id);
    }
  };

  return (
    <section
      className="outline-section"
      aria-label={message("outline.outline")}
      ref={sectionRef}
      data-dragging={dragging || undefined}
      data-selecting={marqueeing || undefined}
    >
      {/* The selection has no visible counter — the highlighted rows are the
          count — so this is how it reaches a screen reader. */}
      <span className="sr-only" aria-live="polite">
        {selectionCount > 0 ? message("outline.selection", { count: selectionCount }) : ""}
      </span>
      {rows.length === 0 ? (
        // A fake first line rather than a button labelled with a mouse
        // instruction: a faint bullet in row 1's exact gutter position over a
        // target big enough to hit anywhere. No placeholder sentence — the
        // document belongs to the user, including when it is empty.
        <button
          className="outline-placeholder"
          onClick={() => editor.insertRootBlock(0)}
          disabled={readonly}
          aria-label={message("outline.addFirstBlock")}
          data-testid="outline-start"
        >
          <span className="dot" aria-hidden />
        </button>
      ) : (
        <div
          className="outline-viewport"
          role="tree"
          aria-label={message("outline.blocks")}
          aria-multiselectable="true"
          aria-activedescendant={focusedId ? `row-${focusedId}` : undefined}
          style={{ height: virtualizer.getTotalSize() }}
          ref={viewportRef}
          tabIndex={-1}
          onKeyDown={onSelectionKeyDown}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <BlockRow
                  row={row}
                  rows={rows}
                  editor={editor}
                  lit={litFor(ancestors, item.index, row.depth)}
                  bindings={bindings}
                />
              </div>
            );
          })}
          {drop && (
            <div
              className="outline-drop"
              data-testid="outline-drop"
              style={
                { top: drop.top, "--drop-depth": drop.depth } as CSSProperties
              }
            />
          )}
        </div>
      )}
      {rows.length > 0 && !readonly && (
        // The region under the last block IS the add-a-block affordance, so no
        // permanent button is needed and the page's dead bottom padding becomes
        // a live target. Hovering it raises the faint bullet of the line it
        // would make.
        <button
          className="outline-append"
          onClick={() => editor.insertRootBlock(authoritativePage.blocks.length)}
          aria-label={message("outline.addBlock")}
          data-testid="outline-append"
        />
      )}
    </section>
  );
}

function valueRelation(
  left: string | undefined,
  right: string | undefined,
): "equal" | "different" | "missing" {
  if (left === undefined || right === undefined) return "missing";
  return left === right ? "equal" : "different";
}

/** Runs core commands in order, stopping at the first rejection. */
async function runSequence(
  commands: Parameters<GraphSession["execute"]>[0][],
  session: GraphSession,
  onFailure: (error: unknown) => void,
): Promise<void> {
  for (const command of commands) {
    const rejection = await session
      .execute(command)
      .then(() => null)
      .catch((error: unknown) => ({ error }));
    if (rejection) {
      onFailure(rejection.error);
      return;
    }
  }
}

/** The collapsed set as it will be after toggling `id`. */
function nextCollapsed(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/** Real (non-pending) block ids in the inclusive row range. */
function selectableIds(rows: OutlineRow[], from: number, to: number): Set<string> {
  const ids = idsInRange(rows, from, to);
  for (const id of [...ids]) {
    if (isPendingId(id)) ids.delete(id);
  }
  return ids;
}

interface Metrics {
  indent: number;
  slot: number;
}

/** The two layout tokens the drag arithmetic needs, read from CSS, never copied. */
function readMetrics(section: HTMLElement | null): Metrics {
  const fallback = { indent: 24, slot: 20 };
  if (!section) return fallback;
  const styles = getComputedStyle(section);
  const indent = Number.parseFloat(styles.getPropertyValue("--indent"));
  const slot = Number.parseFloat(styles.getPropertyValue("--slot"));
  return {
    indent: Number.isFinite(indent) && indent > 0 ? indent : fallback.indent,
    slot: Number.isFinite(slot) && slot > 0 ? slot : fallback.slot,
  };
}

/**
 * The row index at a viewport Y, or the nearest one when the pointer is past
 * either end of what is rendered. Nearest rather than null is what lets a fast
 * drag past the edge keep extending while auto-scroll catches up.
 */
function rowIndexAtPoint(
  viewport: HTMLElement | null,
  clientY: number,
  rows: OutlineRow[],
): number | null {
  if (!viewport) return null;
  let nearest: { index: number; distance: number } | null = null;
  for (const node of viewport.querySelectorAll<HTMLElement>("[data-block-id]")) {
    const id = node.dataset.blockId;
    if (!id) continue;
    const index = rowIndexOf(rows, id);
    if (index < 0) continue;
    const rect = node.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) return index;
    const distance = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
    if (!nearest || distance < nearest.distance) nearest = { index, distance };
  }
  return nearest?.index ?? null;
}

/** Which gap the pointer is in, at which depth, and where to draw the line. */
function resolveDrop(
  viewport: HTMLElement | null,
  rows: OutlineRow[],
  moving: ReadonlySet<string>,
  clientX: number,
  clientY: number,
  metrics: Metrics,
): (DropTarget & { top: number }) | null {
  if (!viewport) return null;
  const index = rowIndexAtPoint(viewport, clientY, rows);
  if (index === null) return null;
  const node = viewport.querySelector<HTMLElement>(
    `[data-block-id="${cssEscape(rows[index].block.id)}"]`,
  );
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  const after = clientY > rect.top + rect.height / 2;
  const gap = after ? index + 1 : index;
  const desired = Math.round(
    (clientX - viewportRect.left - metrics.slot / 2) / metrics.indent,
  );
  const target = dropTarget(rows, moving, gap, Math.max(0, desired));
  if (!target) return null;
  const top = (after ? rect.bottom : rect.top) - viewportRect.top;
  return { ...target, top };
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value;
}

interface AncestorPath {
  /** Row indices of the focused block's ancestors, outermost first. */
  indices: number[];
  /** Row index of the focused block; rows after it light nothing. */
  focused: number;
}

/** Walks back from the caret collecting each strictly shallower row. O(depth). */
function ancestorPath(rows: OutlineRow[], focusedId: string | null): AncestorPath {
  if (!focusedId) return { indices: [], focused: -1 };
  const focused = rowIndexOf(rows, focusedId);
  if (focused < 0) return { indices: [], focused: -1 };
  const indices: number[] = [];
  let depth = rows[focused].depth;
  for (let index = focused - 1; index >= 0 && depth > 0; index -= 1) {
    if (rows[index].depth < depth) {
      indices.unshift(index);
      depth = rows[index].depth;
    }
  }
  return { indices, focused };
}

/**
 * How many leading thread levels this row shares with the focused block's path.
 * Every ancestor that begins before this row contributes one, which keeps the line
 * continuous across siblings that sit between an ancestor and the caret. The row's
 * own depth caps it, and rows after the caret light nothing.
 */
function litFor(path: AncestorPath, index: number, depth: number): number {
  if (path.focused < 0 || index > path.focused) return 0;
  let levels = 0;
  while (levels < path.indices.length && path.indices[levels] < index) levels += 1;
  return Math.min(levels, depth);
}

function onKeyDown(
  editor: EditorContext,
  row: OutlineRow,
  rows: OutlineRow[],
  event: KeyboardEvent<HTMLTextAreaElement>,
  bindings: ReturnType<typeof useShortcutBindings>,
) {
  // Never let structural commands interrupt an active IME composition.
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  // Pending rows accept text and the core outline idioms (Enter, Tab)
  // until the insert is acknowledged; other structural keys are ignored.
  if (isPendingId(row.block.id)) {
    if (event.key === "Tab") {
      event.preventDefault();
      editor.queuePendingStructural(row.block.id, event.shiftKey ? "outdent" : "indent");
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!editor.readonly) handleEnter(editor, row, event.currentTarget);
    } else if (event.key === "Backspace" || event.altKey) {
      // Deletion/moves need a real id; swallow only the structural cases.
      if (editor.draftOf(row).length === 0) event.preventDefault();
    }
    return;
  }
  const textarea = event.currentTarget;
  const id = row.block.id;

  // The platform convention for "menu for the thing I am on". Without it the
  // block's verbs would be pointer-only now that the row has no ⋯ button.
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    editor.openMenu(id);
    return;
  }

  // Undo and redo read from the same editable binding table as the rest of the
  // application; inside this textarea they mean the *document*, because here the
  // text the user is typing is the document.
  const isUndo = bindingMatches(event, bindings.undo);
  const isRedo = bindingMatches(event, bindings.redo);
  if (isRedo || isUndo) {
    event.preventDefault();
    editor.flushNow(id);
    void editor.session
      .execute({ type: isRedo ? "redo" : "undo" })
      .catch((error: unknown) => {
        editor.notify.failure(
          isRedo ? editor.message("failure.redo") : editor.message("failure.undo"),
          error,
        );
      });
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (editor.readonly) return;
    handleEnter(editor, row, textarea);
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    if (editor.readonly) return;
    if (event.shiftKey) editor.menu.outdent(row);
    else editor.menu.indent(row);
    return;
  }

  if (event.key === "Backspace") {
    const value = editor.draftOf(row);
    if (
      value.length === 0 &&
      textarea.selectionStart === 0 &&
      textarea.selectionEnd === 0 &&
      !row.hasChildren
    ) {
      event.preventDefault();
      if (editor.readonly) return;
      editor.menu.remove(row, rows);
      return;
    }
  }

  if ((event.key === "ArrowUp" || event.key === "ArrowDown") && event.altKey) {
    event.preventDefault();
    if (editor.readonly) return;
    editor.menu.move(row, event.key === "ArrowUp" ? -1 : 1);
    return;
  }

  // The standard tree idiom, which the outline never had: collapse/expand from
  // the text edges, then step to the parent or first child. Without it the
  // collapse affordance was reachable only by pointer, on a control that is
  // deliberately not a tab stop.
  if (event.key === "ArrowLeft" && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
    const position = rowIndexOf(rows, id);
    if (row.hasChildren && !row.collapsed) {
      event.preventDefault();
      editor.toggleCollapse(id);
      return;
    }
    if (row.depth > 0) {
      for (let index = position - 1; index >= 0; index -= 1) {
        if (rows[index].depth < row.depth) {
          event.preventDefault();
          editor.flushNow(id);
          editor.setFocus(rows[index].block.id);
          return;
        }
      }
    }
    return;
  }

  if (event.key === "ArrowRight" && textarea.selectionStart === textarea.value.length) {
    if (row.hasChildren && row.collapsed) {
      event.preventDefault();
      editor.toggleCollapse(id);
      return;
    }
    if (row.hasChildren) {
      const position = rowIndexOf(rows, id);
      const child = rows[position + 1];
      if (child && child.depth > row.depth) {
        event.preventDefault();
        editor.flushNow(id);
        editor.setFocus(child.block.id, 0);
      }
    }
    return;
  }

  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const value = textarea.value;
    const caret = textarea.selectionStart;
    const atFirstLine = !value.slice(0, caret).includes("\n");
    const atLastLine = !value.slice(caret).includes("\n");
    const position = rowIndexOf(rows, id);
    if (event.key === "ArrowUp" && atFirstLine && position > 0) {
      event.preventDefault();
      editor.flushNow(id);
      editor.setFocus(rows[position - 1].block.id);
    } else if (event.key === "ArrowDown" && atLastLine && position < rows.length - 1) {
      event.preventDefault();
      editor.flushNow(id);
      editor.setFocus(rows[position + 1].block.id, 0);
    }
  }
}

function handleEnter(editor: EditorContext, row: OutlineRow, textarea: HTMLTextAreaElement) {
  const id = row.block.id;
  const draft = editor.draftOf(row);
  const caretUtf16 = textarea.selectionStart;
  const head = draft.slice(0, caretUtf16);
  const tail = draft.slice(caretUtf16);
  if (isPendingId(id)) {
    // The pending block's tail moves locally; the eventual baseline diff
    // flush reconciles its markdown with the core.
    editor.onInput(row, head);
  } else {
    editor.flushNow(id);
    if (tail.length > 0) {
      const caretPoint = codePointIndex(draft, caretUtf16);
      void editor.session
        .execute({
          type: "splice_markdown",
          page_id: editor.pageId,
          block_id: id,
          index: caretPoint,
          delete: codePointLength(draft) - caretPoint,
          insert: "",
        })
        .catch((error: unknown) => {
          editor.notify.failure(editor.message("failure.splitBlock"), error);
        });
    }
  }
  editor.enqueuePendingInsert(row, tail, row.hasChildren && !row.collapsed);
}

/** Injects the optimistic pending rows into the flattened outline. */
function withPendingRows(rows: OutlineRow[], pending: PendingRow[]): OutlineRow[] {
  let result = rows;
  for (const entry of pending) {
    const sourceIndex = result.findIndex((row) => row.block.id === entry.afterId);
    if (sourceIndex < 0) continue;
    const source = result[sourceIndex];
    let insertAt = sourceIndex + 1;
    if (entry.mode === "sibling") {
      while (insertAt < result.length && result[insertAt].depth > source.depth) insertAt += 1;
    }
    const pendingRow: OutlineRow = {
      block: { id: entry.tempId, markdown: "", properties: [], tags: [], children: [] },
      depth: entry.mode === "child" ? source.depth + 1 : source.depth,
      parentId: entry.mode === "child" ? source.block.id : source.parentId,
      index: entry.mode === "child" ? 0 : source.index + 1,
      siblingCount: entry.mode === "child" ? 1 : source.siblingCount + 1,
      hasChildren: false,
      collapsed: false,
    };
    result = [...result.slice(0, insertAt), pendingRow, ...result.slice(insertAt)];
  }
  return result;
}

function BlockRow({
  row,
  rows,
  editor,
  lit,
  bindings,
}: {
  row: OutlineRow;
  rows: OutlineRow[];
  editor: EditorContext;
  lit: number;
  bindings: ReturnType<typeof useShortcutBindings>;
}) {
  const { message } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isFocused = editor.focusedId === row.block.id;
  const pending = isPendingId(row.block.id);
  const value = editor.draftOf(row);
  const tags = row.block.tags;
  const selected = editor.selected.has(row.block.id);
  const selectionCount = editor.selectionCount;
  const menuOpen = editor.menuFor === row.block.id;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0";
    textarea.style.height = `${Math.max(textarea.scrollHeight, 28)}px`;
  }, [value]);

  useLayoutEffect(() => {
    if (!isFocused) return;
    const textarea = textareaRef.current;
    if (!textarea || document.activeElement === textarea) return;
    textarea.focus();
    const caret = editor.pendingCaret.current;
    if (caret !== null) {
      const offset = Math.min(caret, textarea.value.length);
      textarea.setSelectionRange(offset, offset);
      editor.pendingCaret.current = null;
    } else {
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }, [isFocused, editor.pendingCaret]);

  return (
    <div
      id={`row-${row.block.id}`}
      className="outline-row"
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? !row.collapsed : undefined}
      aria-selected={selected ? true : isFocused}
      data-focused={isFocused}
      data-selected={selected}
      data-empty={value.length === 0}
      data-collapsed={row.collapsed}
      data-has-children={row.hasChildren}
      data-block-id={row.block.id}
      data-testid="outline-row"
      // Depth drives the indent AND the thread gradient; `lit` drives how much
      // of it is on the active path. Custom properties rather than a paddingLeft
      // shorthand, which silently overrode the row's own padding.
      style={{ "--depth": row.depth, "--lit": lit } as CSSProperties}
    >
      {/* Everything left of the bullet. Dragging here selects rows; right-click
          opens the same menu the bullet does. */}
      <span
        className="outline-grip"
        data-testid="row-grip"
        aria-hidden
        onPointerDown={(event) => editor.onGripPointerDown(row, event)}
        onContextMenu={(event) => editor.onRowContextMenu(row, event)}
      />
      <span className="outline-gutter">
        <button
          className="outline-toggle"
          aria-label={
            row.collapsed ? message("outline.expand") : message("outline.collapse")
          }
          tabIndex={-1}
          onClick={() => editor.toggleCollapse(row.block.id)}
        >
          {row.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </button>
        {/* The bullet carries the block's whole pointer vocabulary: click to put
            the caret in the line, drag to move the subtree, right-click for the
            menu. It is the Radix trigger, so the menu is also reachable from the
            keyboard through the row's own ContextMenu / ⇧F10 handling. */}
        <DropdownMenu
          modal={false}
          open={menuOpen}
          onOpenChange={(open) => editor.openMenu(open ? row.block.id : null)}
        >
          <DropdownMenuTrigger asChild>
            <button
              className="outline-bullet"
              data-testid="block-bullet"
              tabIndex={-1}
              aria-label={message("outline.blockActions")}
              onPointerDown={(event) => editor.onBulletPointerDown(row, event)}
              onContextMenu={(event) => editor.onRowContextMenu(row, event)}
            />
          </DropdownMenuTrigger>
          {!pending && (
            <DropdownMenuContent
              align="start"
              onCloseAutoFocus={(event) => {
                // Radix would park focus on the bullet, which is not a tab stop
                // and cannot be typed into. Put the caret back in the line — but
                // not while a selection is up, because focusing a textarea is what
                // drops one, and the user did not ask to lose it by pressing Escape.
                event.preventDefault();
                if (selected && selectionCount > 1) editor.takeTreeFocus();
                else textareaRef.current?.focus();
              }}
            >
              {selected && selectionCount > 1 ? (
                <>
                  <DropdownMenuItem
                    disabled={editor.readonly}
                    onSelect={() => editor.menu.indentSelection()}
                  >
                    <IndentIncreaseIcon aria-hidden />
                    {message("outline.indent")}
                    <DropdownMenuShortcut>⇥</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={editor.readonly}
                    onSelect={() => editor.menu.outdentSelection()}
                  >
                    <IndentDecreaseIcon aria-hidden />
                    {message("outline.outdent")}
                    <DropdownMenuShortcut>⇧⇥</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="menu-delete-selection"
                    variant="destructive"
                    disabled={editor.readonly}
                    onSelect={() => editor.menu.removeSelection()}
                  >
                    <Trash2Icon aria-hidden />
                    {message("outline.deleteSelection", { count: selectionCount })}
                    <DropdownMenuShortcut>⌫</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem
                    data-testid="menu-properties"
                    onSelect={() => editor.toggleInspect(row.block.id)}
                  >
                    <Settings2Icon aria-hidden />
                    {message("outline.propertiesTags")}
                    <DropdownMenuShortcut>
                      {formatBinding(bindings.properties)}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={editor.readonly}
                    onSelect={() => editor.menu.addChild(row)}
                  >
                    <CornerDownRightIcon aria-hidden />
                    {message("outline.addChild")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={editor.readonly || row.index === 0}
                    onSelect={() => editor.menu.indent(row)}
                  >
                    <IndentIncreaseIcon aria-hidden />
                    {message("outline.indent")}
                    <DropdownMenuShortcut>⇥</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={editor.readonly || row.depth === 0}
                    onSelect={() => editor.menu.outdent(row)}
                  >
                    <IndentDecreaseIcon aria-hidden />
                    {message("outline.outdent")}
                    <DropdownMenuShortcut>⇧⇥</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="menu-move-up"
                    disabled={editor.readonly || row.index === 0}
                    onSelect={() => editor.menu.move(row, -1)}
                  >
                    <ArrowUpIcon aria-hidden />
                    {message("outline.moveUp")}
                    <DropdownMenuShortcut>⌥↑</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="menu-move-down"
                    disabled={editor.readonly || row.index >= row.siblingCount - 1}
                    onSelect={() => editor.menu.move(row, 1)}
                  >
                    <ArrowDownIcon aria-hidden />
                    {message("outline.moveDown")}
                    <DropdownMenuShortcut>⌥↓</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="menu-delete"
                    variant="destructive"
                    disabled={editor.readonly}
                    onSelect={() => editor.menu.remove(row, rows)}
                  >
                    <Trash2Icon aria-hidden />
                    {message("outline.deleteBlock")}
                    <DropdownMenuShortcut>⌫</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          )}
        </DropdownMenu>
      </span>
      <div className="outline-text">
        <textarea
          ref={textareaRef}
          className="outline-input"
          rows={1}
          value={value}
          readOnly={editor.readonly}
          aria-label={message("outline.blockText")}
          dir="auto"
          onFocus={() => {
            if (!isFocused) editor.setFocus(row.block.id, -1);
          }}
          onBlur={() => editor.flushNow(row.block.id)}
          onChange={(event) => editor.onInput(row, event.target.value)}
          onCompositionStart={() => editor.onCompositionStart(row)}
          onCompositionEnd={() => editor.onCompositionEnd(row)}
          onKeyDown={(event) => editor.onKeyDown(row, rows, event)}
        />
        {tags.length > 0 && (
          <div className="outline-tags">
            <TagChips pageId={editor.pageId} block={row.block} />
          </div>
        )}
        {!pending && <TaskProjection pageId={editor.pageId} block={row.block} />}
        {!pending && stringValue(row.block.properties, "query.source") !== undefined && (
          <QueryBlock pageId={editor.pageId} block={row.block} />
        )}
        {editor.inspectedId === row.block.id && (
          <BlockInspector
            pageId={editor.pageId}
            block={row.block}
            onClose={() => editor.toggleInspect(row.block.id)}
          />
        )}
      </div>
    </div>
  );
}
