// Virtualized outline editor. Rows are addressed by stable BlockId; text
// edits become SpliceMarkdown commands at IME-safe boundaries; structural
// keys map to core commands and the authoritative snapshot re-render is the
// only state path (no optimistic tree mutations).

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
  MoreHorizontalIcon,
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
import { MOD } from "../commands/keys";
import { useCommands } from "../commands/context";
import type { PageSnapshot } from "../../core-port/snapshot";
import { findBlock, findPage, stringValue } from "../../core-port/snapshot";
import { flattenOutline, rowIndexOf, type OutlineRow } from "../../entities/outline";
import { useSession, useSessionState } from "../shell/session-context";
import { BlockInspector } from "../properties/BlockInspector";
import { TagChips } from "../properties/TagChips";
import { QueryBlock } from "../query/QueryBlock";
import { TaskProjection } from "../tasks/TaskProjection";
import { codePointIndex, codePointLength, diffSplice } from "./text-diff";

const FLUSH_DEBOUNCE_MS = 400;

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
  pageId: string;
  readonly: boolean;
  focusedId: string | null;
  pendingCaret: RefObject<number | null>;
  inspectedId: string | null;
  setFocus(id: string | null, caret?: number): void;
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
  menu: {
    addChild(row: OutlineRow): void;
    indent(row: OutlineRow): void;
    outdent(row: OutlineRow): void;
    move(row: OutlineRow, delta: number): void;
    remove(row: OutlineRow, rows: OutlineRow[]): void;
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
  const [, force] = useReducer((tick: number) => tick + 1, 0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
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
  // GraphSession resolves commands only after reconciling its snapshot. Read
  // that snapshot directly during the temp-id handoff so a parent render that
  // still carries the previous page object cannot briefly remove the editor.
  const authoritativePage = findPage(state.snapshot, page.id) ?? page;
  pageRef.current = authoritativePage;
  collapsedRef.current = collapsed;

  const rows = withPendingRows(flattenOutline(authoritativePage, collapsed), pendingRows.current);
  const readonly = state.mode === "readonly";

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

  const flush = useCallback(
    (id: string) => {
      if (isPendingId(id)) return; // transferred when the real id arrives
      const draft = drafts.current.get(id);
      const baseline = baselines.current.get(id);
      if (draft === undefined || baseline === undefined) return;
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
        .catch(() => {
          // The core rejected the edit; fall back to authoritative text.
          drafts.current.delete(id);
          baselines.current.delete(id);
          force();
        });
    },
    [session],
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

  const setFocus = useCallback((id: string | null, caret?: number) => {
    pendingCaret.current = caret ?? null;
    focusedRef.current = id;
    setFocusedId(id);
  }, []);
  const focusedRef = useRef<string | null>(null);

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
      abandonPending();
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
              .catch(() => undefined);
          }
        } else {
          pendingRows.current.shift();
          drafts.current.delete(head.tempId);
          baselines.current.delete(head.tempId);
          abandonPending();
        }
        pendingDispatching.current = false;
        force();
        dispatchPending();
      })
      .catch(() => {
        pendingDispatching.current = false;
        abandonPending();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, scheduleFlush, setFocus]);

  const abandonPending = useCallback(() => {
    let fallback: string | null = null;
    for (const entry of pendingRows.current) {
      if (!isPendingId(entry.afterId)) fallback = entry.afterId;
      drafts.current.delete(entry.tempId);
      baselines.current.delete(entry.tempId);
    }
    pendingRows.current = [];
    if (focusedRef.current && isPendingId(focusedRef.current)) setFocus(fallback);
    force();
  }, [setFocus]);

  const run = useCallback(
    (command: Parameters<GraphSession["execute"]>[0]) =>
      session.execute(command).catch(() => undefined),
    [session],
  );

  const editor: EditorContext = {
    session,
    pageId: authoritativePage.id,
    readonly,
    focusedId,
    pendingCaret,
    inspectedId,
    setFocus,
    toggleInspect: (id) => setInspectedId((current) => (current === id ? null : id)),
    toggleCollapse: (id) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
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
    onKeyDown: (row, allRows, event) => onKeyDown(editor, row, allRows, event),
    flushNow,
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
        .catch(() => undefined);
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
        void run({
          type: "indent_block",
          page_id: authoritativePage.id,
          block_id: row.block.id,
        });
      },
      outdent: (row) => {
        flushNow(row.block.id);
        void run({
          type: "outdent_block",
          page_id: authoritativePage.id,
          block_id: row.block.id,
        });
      },
      move: (row, delta) => {
        flushNow(row.block.id);
        const target = row.index + delta;
        if (target < 0 || target >= row.siblingCount) return;
        void run({
          type: "move_block",
          block_id: row.block.id,
          page_id: authoritativePage.id,
          parent: row.parentId,
          index: target,
        });
      },
      remove: (row, allRows) => {
        const position = rowIndexOf(allRows, row.block.id);
        const previous = allRows[position - 1]?.block.id ?? null;
        void run({
          type: "delete_block",
          page_id: authoritativePage.id,
          block_id: row.block.id,
        }).then(() => {
          setFocus(previous);
        });
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

  return (
    <section className="outline-section" aria-label="Outline">
      {rows.length === 0 ? (
        // A fake first line rather than a button labelled with a mouse
        // instruction: a bullet in row 1's exact gutter position, then the
        // placeholder, over a target big enough to hit anywhere.
        <button
          className="outline-placeholder"
          onClick={() => editor.insertRootBlock(0)}
          disabled={readonly}
          aria-label="Add the first block"
          data-testid="outline-start"
        >
          <span className="dot" aria-hidden />
          <span className="label">Write something…</span>
        </button>
      ) : (
        <div
          className="outline-viewport"
          role="tree"
          aria-label="Blocks"
          aria-activedescendant={focusedId ? `row-${focusedId}` : undefined}
          style={{ height: virtualizer.getTotalSize() }}
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
                />
              </div>
            );
          })}
        </div>
      )}
      {rows.length === 1 && rows[0].block.markdown.length === 0 && (
        <p className="outline-hint">
          <kbd className="kbd">{MOD}K</kbd> to search · <kbd className="kbd">{MOD}/</kbd> for
          shortcuts
        </p>
      )}
      {rows.length > 0 && !readonly && (
        // The region under the last block IS the add-a-block affordance, so no
        // permanent button is needed and the page's dead bottom padding becomes
        // a live target.
        <button
          className="outline-append"
          onClick={() => editor.insertRootBlock(authoritativePage.blocks.length)}
          aria-label="Add a block"
          data-testid="outline-append"
        />
      )}
    </section>
  );
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

  const isUndo = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z";
  const isRedo =
    ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "z") ||
    (event.ctrlKey && event.key.toLowerCase() === "y");
  if (isRedo) {
    event.preventDefault();
    editor.flushNow(id);
    void editor.session.execute({ type: "redo" }).catch(() => undefined);
    return;
  }
  if (isUndo) {
    event.preventDefault();
    editor.flushNow(id);
    void editor.session.execute({ type: "undo" }).catch(() => undefined);
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
        .catch(() => undefined);
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
}: {
  row: OutlineRow;
  rows: OutlineRow[];
  editor: EditorContext;
  lit: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isFocused = editor.focusedId === row.block.id;
  const pending = isPendingId(row.block.id);
  const value = editor.draftOf(row);
  const tags = row.block.tags;

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
      aria-selected={isFocused}
      data-focused={isFocused}
      data-collapsed={row.collapsed}
      data-has-children={row.hasChildren}
      data-block-id={row.block.id}
      data-testid="outline-row"
      // Depth drives the indent AND the thread gradient; `lit` drives how much
      // of it is on the active path. Custom properties rather than a paddingLeft
      // shorthand, which silently overrode the row's own padding.
      style={{ "--depth": row.depth, "--lit": lit } as CSSProperties}
    >
      <span className="outline-gutter">
        <button
          className="outline-toggle"
          aria-label={row.collapsed ? "Expand" : "Collapse"}
          tabIndex={-1}
          onClick={() => editor.toggleCollapse(row.block.id)}
        >
          {row.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </button>
        <button
          className="outline-bullet"
          data-testid="block-bullet"
          tabIndex={-1}
          aria-label="Focus this block"
          onClick={() => editor.setFocus(row.block.id)}
        />
      </span>
      <div className="outline-text">
        <textarea
          ref={textareaRef}
          className="outline-input"
          rows={1}
          value={value}
          placeholder={row.depth === 0 ? "Write something…" : ""}
          readOnly={editor.readonly}
          aria-label="Block text"
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
      <div className="row-menu" style={pending ? { visibility: "hidden" } : undefined}>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button className="icon-btn" aria-label="More block actions" data-testid="block-menu">
              <MoreHorizontalIcon />
            </button>
          </DropdownMenuTrigger>
          {/* Every item states its shortcut. Tab, Shift-Tab, Alt-Arrow and
              Backspace all worked before and were taught nowhere. */}
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              data-testid="menu-properties"
              onSelect={() => editor.toggleInspect(row.block.id)}
            >
              <Settings2Icon aria-hidden />
              Properties &amp; tags
              <DropdownMenuShortcut>{MOD}⇧P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={editor.readonly}
              onSelect={() => editor.menu.addChild(row)}
            >
              <CornerDownRightIcon aria-hidden />
              Add child block
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={editor.readonly || row.index === 0}
              onSelect={() => editor.menu.indent(row)}
            >
              <IndentIncreaseIcon aria-hidden />
              Indent
              <DropdownMenuShortcut>⇥</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={editor.readonly || row.depth === 0}
              onSelect={() => editor.menu.outdent(row)}
            >
              <IndentDecreaseIcon aria-hidden />
              Outdent
              <DropdownMenuShortcut>⇧⇥</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="menu-move-up"
              disabled={editor.readonly || row.index === 0}
              onSelect={() => editor.menu.move(row, -1)}
            >
              <ArrowUpIcon aria-hidden />
              Move up
              <DropdownMenuShortcut>⌥↑</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="menu-move-down"
              disabled={editor.readonly || row.index >= row.siblingCount - 1}
              onSelect={() => editor.menu.move(row, 1)}
            >
              <ArrowDownIcon aria-hidden />
              Move down
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
              Delete block
              <DropdownMenuShortcut>⌫</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
