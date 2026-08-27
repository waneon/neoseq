// Virtualized outline editor. Rows are addressed by stable BlockId; text
// edits become inline-content splices at IME-safe boundaries; structural
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
  type ClipboardEvent,
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
  CopyIcon,
  CornerDownRightIcon,
  HashIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import type { GraphSession } from "../../core-port/session";
import type { Command, SplitPlacement } from "../../core-port/commands";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { Kbd } from "@/ui/kbd";
import { useCommands } from "../commands/context";
import { Shortcut } from "../commands/Shortcut";
import { useShortcutBindings, bindingMatches } from "../commands/shortcuts";
import { useNotify, type Notifier } from "../notify/context";
import { failureReason } from "../notify/errors";
import type { BlockSnapshot, OutlineOwner, PageReferenceSpan } from "../../core-port/snapshot";
import {
  findBlock,
  findOutline,
  materializePageReferences,
  queryDocument,
  sameOutlineOwner,
  stringValue,
} from "../../core-port/snapshot";
import { flattenOutline, rowIndexOf, type OutlineRow } from "../../entities/outline";
import { useSession, useSessionState } from "../shell/session-context";
import { useHistoryActions, type HistoryRevealRequest } from "../history/context";
import { BlockChips } from "../properties/BlockChips";
import { PropertyPicker } from "../properties/PropertyPicker";
import { TagPicker } from "../properties/TagPicker";
import { TagChips } from "../properties/TagChips";
import { QueryBlock } from "../query/QueryBlock";
import { TaskPriorityControl } from "../tasks/PriorityControl";
import { TaskStatusControl } from "../tasks/StatusControl";
import { TASK_PRIORITY_KEY, TASK_STATUS_KEY } from "../../entities/tasks";
import {
  transformAutoClosers,
  type AutoCloserMarker,
} from "../blocks/editor/auto-pair";
import { transformSelection } from "./selection-transform";
import type { PeerPresence } from "../sync/SyncAgent";
import {
  coveredIds,
  coveredMask,
  dropTarget,
  idsInRange,
  selectionRoots,
  type DropTarget,
} from "./selection";
import {
  overlayReducer,
  pointerGestureReducer,
  type PropertyRequest,
  type TagRequest,
} from "./interaction-state";
import {
  initialOutlineDraftState,
  outlineDraftReducer,
  type OutlineDraftAction,
  type PendingOutlineOperation,
} from "./draft-state";
import {
  buildClipboardBundle,
  createOutlineFragment,
  isPlainEmptyBlock,
  parseMarkdownOutline,
  readOutlineFragment,
  setClipboardData,
  writeClipboardBundle,
  type OutlineClipboardItem,
} from "./clipboard";
import type { OutlineFragment } from "../../core-port/fragment";
import {
  caretAnchor,
  elementAnchor,
  pointAnchor,
  snapshotAnchor,
  type Anchor,
} from "@/ui/anchored";
import { useI18n, type MessageFunction, type MessageKey } from "../../i18n";
import { useImmediateState, useLatest } from "../../lib/react";
import { BlockMarkdown } from "../markdown/BlockMarkdown";
import { hasMarkdownSyntax } from "../markdown/profile";
import { BlockBody, BlockRowFrame } from "../blocks/BlockPresentation";
import { BlockTextArea } from "../blocks/editor/BlockTextArea";
import {
  caretForVerticalEntry,
  normalCaretAfterEdit,
  wordEditsAcrossUnits,
  wordMotionAcrossUnits,
  type VimMode,
  type VimSurfaceCommand,
  type VimVisualLineCommand,
  type VimWordMotionCommand,
} from "../blocks/editor/vim/engine";
import { applyVimTextEffect, vimKeyFromEvent } from "../blocks/editor/vim/dom";
import { useVimSession, type VimSession } from "../blocks/editor/vim/session";
import {
  useBlockActivationEntrance,
  vimModeForActivation,
  type BlockActivationEntrance,
  type BlockActivationMethod,
} from "../blocks/editor/activation";
import { BLOCK_SURFACE_POLICY } from "../blocks/editor/surface-policy";
import { useEditorKeymap } from "../settings/preferences";
import type { EditorKeymap } from "../../entities/settings";
import {
  BlockPageMenu,
  BlockSlashMenu,
  BlockTagMenu,
  completionAnchor,
  detectPage,
  detectHash,
  detectSlash,
  filterPageOptions,
  filterTagOptions,
  removeCompletionToken,
  type BlockCompletionRequest,
  type BlockPageOption,
  type BlockTagOption,
} from "../blocks/editor/BlockCompletions";
import {
  canonicalContentBoundary,
  joinInlineContentProjections,
  planInlineEdit,
  planPageReference,
  splitInlineContentProjection,
  type InlineContentProjection,
} from "../blocks/editor/inline-content";
import {
  buildSlashItems,
  filterSlashItems,
  type SlashItem,
} from "../blocks/editor/slash-commands";
import { createQueryCommand } from "../query/commands";

const FLUSH_DEBOUNCE_MS = 400;
/** How far a bullet must travel before a click becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/**
 * How long a row the user just uncovered carries `data-revealed`. Matches
 * `--dur-disclose` plus a frame, so the attribute outlives the animation it
 * starts rather than cutting it off part-way.
 */
const REVEAL_MS = 220;
const NOTHING_REVEALED: ReadonlySet<string> = new Set();
/**
 * Anything that floats over the outline and can be dismissed by clicking past
 * it. Read from the document rather than from React state because these come
 * from four different owners — a block's menu, the page's menu, an entity
 * autocomplete, a settings dialog — and the outline is not one of them.
 */
const FLOATING_OVERLAY_SELECTOR =
  '[data-slot="dropdown-menu-content"],[data-slot="dialog-content"],.ac-popover,.property-picker,.tag-picker,.slash-menu,.cmdk';
/** Edge band that pulls the scroll container along during a drag. */
const AUTOSCROLL_BAND_PX = 56;
const AUTOSCROLL_MAX_PX = 18;
/** How long caret moves coalesce before one presence frame goes out. */
const PRESENCE_PUBLISH_MS = 150;

const VIM_MODE_MESSAGE = {
  normal: "vim.mode.normal",
  insert: "vim.mode.insert",
  "operator-pending": "vim.mode.operatorPending",
  "visual-line": "vim.mode.visualLine",
} as const satisfies Record<VimMode, MessageKey>;

interface VisualLineRange {
  anchorId: string;
  headId: string;
  returnCaret: number;
  returnColumn: number;
}

interface NavigationRevealRequest {
  id: string;
  sequence: number;
}

// Pending rows bridge the async gap between Enter and the core's block-creation
// acknowledgement: each is focused synchronously so fast typing
// lands in the new block, then swaps to its real BlockId. They may chain
// (Enter pressed again before the previous split resolves); commands are
// dispatched in order once each anchor id becomes real. They render
// optimistically only because the inverse (drop the row) is known.
const PENDING_PREFIX = "pending-";

type InputMethod = "keyboard" | "pointer" | "context_menu";

function isPendingId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

type SlashRequest = BlockCompletionRequest;
type TagOption = BlockTagOption;
type PageOption = BlockPageOption;

interface EditorContext {
  session: GraphSession;
  notify: Notifier;
  message: MessageFunction;
  owner: OutlineOwner;
  graphId: string;
  readonly: boolean;
  keymap: EditorKeymap;
  vim: VimSession;
  focusedId: string | null;
  pendingCaret: RefObject<number | null>;
  /**
   * Whether the focus about to arrive belongs to a press. `focus` is delivered
   * by the browser as a press's own default action and says nothing about what
   * caused it, so the shared entrance records the press before focus arrives.
   */
  activationEntrance: BlockActivationEntrance;
  propertyRequest: PropertyRequest | null;
  tagRequest: TagRequest | null;
  slashRequest: SlashRequest | null;
  /** Items the current slash query reaches, best match first. */
  slashResults: SlashItem[];
  /** Index into `slashResults` the keyboard is on. */
  slashActive: number;
  /** The `#` twin of the slash menu: same token scan, tags instead of verbs. */
  hashRequest: SlashRequest | null;
  hashResults: TagOption[];
  hashActive: number;
  pageRequest: SlashRequest | null;
  pageResults: PageOption[];
  pageActive: number;
  menuFor: string | null;
  menuAnchor: Anchor;
  /** Explicit roots plus the descendants their structural action carries. */
  covered: ReadonlySet<string>;
  /** Rows the last expand uncovered. They fade up; nothing else in the list does. */
  revealed: ReadonlySet<string>;
  /** Rows the selection covers, passengers included — what a bulk verb will take. */
  selectionCount: number;
  revision: number;
  presence: readonly PeerPresence[];
  activateBlock(
    id: string | null,
    caret: number | undefined,
    inputMethod: BlockActivationMethod,
  ): void;
  /** Drops the caret when focus genuinely left this row. See `releaseFocus`. */
  releaseFocus(id: string): void;
  publishSelection(blockId: string, textarea: HTMLTextAreaElement): void;
  takeTreeFocus(): void;
  /** Drops the caret and selects exactly this block (⌘A past the text). */
  selectOnly(row: OutlineRow): void;
  openMenu(id: string | null, anchor?: Anchor): void;
  openProperties(id: string, key?: string, anchor?: HTMLElement | Anchor): void;
  openTags(id: string, anchor?: HTMLElement | Anchor): void;
  closeSlash(): void;
  setSlashActive(index: number): void;
  acceptSlash(row: OutlineRow, item?: SlashItem): void;
  closeHash(): void;
  setHashActive(index: number): void;
  acceptHash(row: OutlineRow, option?: TagOption): void;
  closePage(): void;
  setPageActive(index: number): void;
  acceptPage(row: OutlineRow, option?: PageOption): void;
  toggleCollapse(id: string): void;
  draftOf(row: OutlineRow): string;
  autoClosersOf(blockId: string): readonly AutoCloserMarker[];
  pageReferencesOf(block: BlockSnapshot): readonly PageReferenceSpan[];
  onInput(
    row: OutlineRow,
    value: string,
    textarea: HTMLTextAreaElement,
    edit?: {
      autoCloser?: AutoCloserMarker;
      preferredStart?: number;
      preferredEnd?: number;
    },
  ): void;
  onCompositionStart(row: OutlineRow): void;
  onCompositionEnd(row: OutlineRow, textarea: HTMLTextAreaElement): void;
  onKeyDown(row: OutlineRow, rows: OutlineRow[], event: KeyboardEvent<HTMLTextAreaElement>): void;
  flushNow(id: string): void;
  runHistory(id: string, redo: boolean): void;
  insertRootBlock(index: number, inputMethod: InputMethod): void;
  enqueuePendingInsert(
    row: OutlineRow,
    tail: string,
    asChild: boolean,
    inputMethod: InputMethod,
  ): void;
  enqueuePendingSplit(
    row: OutlineRow,
    index: number,
    head: InlineContentProjection,
    tail: InlineContentProjection,
    asChild: boolean,
    inputMethod: InputMethod,
  ): void;
  mergeBackward(
    row: OutlineRow,
    rows: OutlineRow[],
    textarea: HTMLTextAreaElement,
    inputMethod: InputMethod,
  ): void;
  queuePendingStructural(tempId: string, kind: "indent" | "outdent"): void;
  runVimStructure(
    kind: "delete" | "indent" | "outdent",
    row: OutlineRow,
    rows: OutlineRow[],
    count: number,
  ): void;
  runVimVisualLine(
    command: VimVisualLineCommand,
    row?: OutlineRow,
    rows?: OutlineRow[],
  ): void;
  runVimWordMotion(
    command: VimWordMotionCommand,
    row: OutlineRow,
    rows: OutlineRow[],
    textarea: HTMLTextAreaElement,
  ): void;
  /** Pointer entry points for the selection strip and the bullet handle. */
  onGripPointerDown(row: OutlineRow, event: ReactPointerEvent): void;
  onSurfacePointerDown(row: OutlineRow, event: ReactPointerEvent): void;
  onBulletPointerDown(row: OutlineRow, event: ReactPointerEvent): void;
  onRowContextMenu(row: OutlineRow, event: React.MouseEvent): void;
  /** True when the press that is being handled began with something floating. */
  pressStartedOverOverlay(): boolean;
  /** Closes what is floating over the outline and drops a selection. */
  dismissTransient(): void;
  pasteOutline(row: OutlineRow, items: OutlineClipboardItem[]): void;
  pasteFragment(row: OutlineRow, fragment: OutlineFragment): void;
  menu: {
    addChild(row: OutlineRow): void;
    indent(row: OutlineRow): void;
    outdent(row: OutlineRow): void;
    move(row: OutlineRow, delta: number): void;
    remove(row: OutlineRow, rows: OutlineRow[]): void;
    indentSelection(inputMethod: InputMethod): void;
    outdentSelection(inputMethod: InputMethod): void;
    removeSelection(inputMethod: InputMethod): void;
    copySelection(inputMethod: InputMethod): void;
  };
}

export function Outliner({
  owner,
  blocks,
  scrollElement,
}: {
  owner: OutlineOwner;
  blocks: BlockSnapshot[];
  scrollElement: HTMLElement | null;
}) {
  const session = useSession();
  const state = useSessionState();
  const commands = useCommands();
  const history = useHistoryActions();
  const notify = useNotify();
  const bindings = useShortcutBindings();
  const keymap = useEditorKeymap();
  const vim = useVimSession(keymap === "vim");
  const { message, compare } = useI18n();
  const [historyRevealRevision, bumpHistoryReveal] = useReducer(
    (revision: number) => revision + 1,
    0,
  );
  const [focusedId, setFocusedId, focusedRef] = useImmediateState<string | null>(null);
  const revealSequence = useRef(0);
  const [navigationReveal, setNavigationReveal] = useState<NavigationRevealRequest | null>(null);
  const revealNavigationTarget = useCallback((id: string | null) => {
    if (id === null) {
      setNavigationReveal(null);
      return;
    }
    revealSequence.current += 1;
    setNavigationReveal({ id, sequence: revealSequence.current });
  }, []);
  const [overlay, dispatchOverlay] = useReducer(overlayReducer, { kind: "none" });
  const propertyRequest = overlay.kind === "property" ? overlay.request : null;
  const tagRequest = overlay.kind === "tag" ? overlay.request : null;
  const slashRequest = overlay.kind === "slash" ? overlay.request : null;
  const slashActive = overlay.kind === "slash" ? overlay.active : 0;
  const hashRequest = overlay.kind === "hash" ? overlay.request : null;
  const hashActive = overlay.kind === "hash" ? overlay.active : 0;
  const pageRequest = overlay.kind === "page" ? overlay.request : null;
  const pageActive = overlay.kind === "page" ? overlay.active : 0;
  const menuFor = overlay.kind === "menu" ? overlay.blockId : null;
  const menuAnchor = overlay.kind === "menu" ? overlay.anchor : null;
  const setPropertyRequest = useCallback((request: PropertyRequest | null) => {
    dispatchOverlay(
      request
        ? { type: "open", overlay: { kind: "property", request } }
        : { type: "close", kind: "property" },
    );
  }, []);
  const setTagRequest = useCallback((request: TagRequest | null) => {
    dispatchOverlay(
      request
        ? { type: "open", overlay: { kind: "tag", request } }
        : { type: "close", kind: "tag" },
    );
  }, []);
  const setSlashRequest = useCallback((request: SlashRequest | null) => {
    dispatchOverlay(
      request
        ? { type: "open", overlay: { kind: "slash", request, active: 0 } }
        : { type: "close", kind: "slash" },
    );
  }, []);
  const setHashRequest = useCallback((request: SlashRequest | null) => {
    dispatchOverlay(
      request
        ? { type: "open", overlay: { kind: "hash", request, active: 0 } }
        : { type: "close", kind: "hash" },
    );
  }, []);
  const setPageRequest = useCallback((request: SlashRequest | null) => {
    dispatchOverlay(
      request
        ? { type: "open", overlay: { kind: "page", request, active: 0 } }
        : { type: "close", kind: "page" },
    );
  }, []);
  const setSlashActiveState = useCallback((index: number) => {
    dispatchOverlay({ type: "activate", kind: "slash", index });
  }, []);
  const setHashActiveState = useCallback((index: number) => {
    dispatchOverlay({ type: "activate", kind: "hash", index });
  }, []);
  const setPageActiveState = useCallback((index: number) => {
    dispatchOverlay({ type: "activate", kind: "page", index });
  }, []);
  const setMenuFor = useCallback((blockId: string | null, anchor: Anchor = null) => {
    dispatchOverlay(
      blockId
        ? { type: "open", overlay: { kind: "menu", blockId, anchor } }
        : { type: "close", kind: "menu" },
    );
  }, []);
  const [collapsed, setCollapsed, collapsedRef] =
    useImmediateState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(NOTHING_REVEALED);
  const [selected, setSelected, selectedRef] =
    useImmediateState<ReadonlySet<string>>(new Set());
  const [visualLine, setVisualLine, visualLineRef] =
    useImmediateState<VisualLineRange | null>(null);
  const [pointerGesture, dispatchPointerGesture] = useReducer(pointerGestureReducer, {
    kind: "idle",
  });
  const dragging = pointerGesture.kind === "dragging";
  const marqueeing = pointerGesture.kind === "selecting";
  const drop = pointerGesture.kind === "dragging" ? pointerGesture.drop : null;
  const [draftState, setDraftState, draftStateRef] = useImmediateState(initialOutlineDraftState);
  const dispatchDraft = useCallback((action: OutlineDraftAction) => {
    setDraftState((current) => outlineDraftReducer(current, action));
  }, [setDraftState]);
  const composing = useRef(false);
  const [compositionRevision, finishComposition] = useReducer(
    (revision: number) => revision + 1,
    0,
  );
  const mounted = useRef(true);
  const flushTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingCaret = useRef<number | null>(null);
  /**
   * A press that lands in a settled line is a pointer-owned entrance — the reader
   * is going to write — but the browser hands that entrance over as a bare
   * `focus`, and the `click` that would have said so arrives one paint too late.
   * In Vim that paint is a whole frame of the Normal-mode block caret sitting in
   * a line the reader is about to type into. The press marks itself here on the
   * way down, and the entrance is read rather than guessed.
   */
  const activationEntrance = useBlockActivationEntrance();
  const pendingSeq = useRef(0);
  const draftInputRevision = useRef(0);
  const pendingDispatching = useRef(false);
  const pendingProperty = useRef<{
    blockId: string;
    selection?: { start: number; end: number };
    /** A slash choice made on a pending row, replayed once the real id lands. */
    action?: SlashItem["action"];
  } | null>(null);
  /** A `#` choice made on a pending row, replayed once the real id lands. */
  const pendingTag = useRef<{ blockId: string; option: TagOption } | null>(null);
  const anchorId = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const releasePointer = useRef<(() => void) | null>(null);
  const autoScroll = useRef<{ speed: number; frame: number } | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceTimer = useRef<number | null>(null);
  const presenceDraft = useRef<Omit<PeerPresence, "session_id" | "principal" | "expires_at"> | null>(null);
  const pendingHistoryReveal = useRef<HistoryRevealRequest | null>(null);
  const overlayAtPressStart = useRef(false);
  // GraphSession resolves commands only after reconciling its snapshot. Read
  // that snapshot directly during the temp-id handoff so a parent render that
  // still carries the previous page object cannot briefly remove the editor.
  const authoritativeOutline = findOutline(state.snapshot, owner);
  const outline = authoritativeOutline ?? { blocks };
  const pageDirectory = useMemo(
    () => state.snapshot.page_directory
      ?? state.snapshot.pages.map((page) => ({
        id: page.id,
        title: page.title,
        journal_date: null,
        deleted: false,
      })),
    [state.snapshot.page_directory, state.snapshot.pages],
  );
  const ownerRef = useLatest(owner);
  const outlineRef = useLatest(outline);

  const projectedCollapsed = new Set(collapsed);
  for (const operation of draftState.pendingOperations) {
    if (operation.kind === "merge" && !collapsed.has(operation.targetId)) {
      projectedCollapsed.delete(operation.sourceId);
    }
  }
  const pendingProjection = projectPendingOperations(
    flattenOutline(outline, projectedCollapsed),
    draftState.pendingOperations,
    draftState.drafts,
    draftState.pageReferences,
  );
  const rows = pendingProjection.rows;
  const rowsRef = useLatest(rows);
  const readonly = state.mode === "readonly";
  // `selected` is the concrete identity set the user saw selected when the
  // gesture completed. Do not derive it again from the current hierarchy:
  // undoing a reparent must move rows without changing which rows are selected.
  const selectionCovered = selected;
  const selectionCount = useMemo(
    () => rows.reduce((count, row) => count + Number(selected.has(row.block.id)), 0),
    [rows, selected],
  );

  const clearVisualLineState = useCallback(() => {
    if (!visualLineRef.current) return;
    setVisualLine(null);
  }, [setVisualLine]);

  const leaveVisualLine = useCallback(() => {
    if (!visualLineRef.current) return;
    clearVisualLineState();
    vim.reset();
  }, [clearVisualLineState, vim.reset]);

  // A page rename changes only the directory and the disposable projection.
  // Reproject local baselines and drafts as well, including a focused dirty
  // editor, so its next splice never turns an untouched reference into stale
  // literal source. References already edited through stay ordinary Markdown.
  useEffect(() => {
    if (composing.current) return;
    const completionBlockId = slashRequest?.blockId
      ?? hashRequest?.blockId
      ?? pageRequest?.blockId;
    const entries: Array<{
      id: string;
      baseline: string;
      draft: string;
      pageReferences: readonly PageReferenceSpan[];
    }> = [];
    for (const [id, baseline] of draftStateRef.current.baselines) {
      if (id === completionBlockId) continue;
      const references = draftStateRef.current.pageReferences.get(id);
      const draft = draftStateRef.current.drafts.get(id);
      if (!references || draft === undefined || references.length === 0) continue;
      const pending = planInlineEdit(id, baseline, references, draft);
      const baselineProjection = materializePageReferences(baseline, references, pageDirectory);
      const draftProjection = materializePageReferences(
        draft,
        pending?.references ?? references,
        pageDirectory,
      );
      if (
        baselineProjection.markdown === baseline
        && draftProjection.markdown === draft
        && samePageReferences(baselineProjection.pageReferences, references)
      ) continue;
      entries.push({
        id,
        baseline: baselineProjection.markdown,
        draft: draftProjection.markdown,
        pageReferences: baselineProjection.pageReferences,
      });
    }
    if (entries.length > 0) dispatchDraft({ type: "reproject", entries });
  }, [
    compositionRevision,
    dispatchDraft,
    hashRequest?.blockId,
    pageDirectory,
    pageRequest?.blockId,
    slashRequest?.blockId,
    state.revision,
  ]);

  // Drop a block's draft only once the authoritative snapshot matches it;
  // the focused draft and queued pending rows survive so IME composition
  // and in-flight typing are never clobbered.
  useEffect(() => {
    const draftIds: string[] = [];
    const autoCloserIds: string[] = [];
    for (const id of draftStateRef.current.drafts.keys()) {
      if (id === focusedId || isPendingId(id)) continue;
      const block = findBlock(outlineRef.current, id);
      if (!block || block.markdown === draftStateRef.current.drafts.get(id)) draftIds.push(id);
    }
    for (const id of draftStateRef.current.autoClosers.keys()) {
      if (!isPendingId(id) && !findBlock(outlineRef.current, id)) {
        autoCloserIds.push(id);
      }
    }
    if (draftIds.length > 0 || autoCloserIds.length > 0) {
      dispatchDraft({ type: "reconcile", draftIds, autoCloserIds });
    }
  }, [dispatchDraft, state.revision, focusedId]);

  // A block that left the page cannot stay selected — a stale id would send the
  // next bulk command at something that is no longer there.
  useEffect(() => {
    const visual = visualLineRef.current;
    if (
      visual
      && (
        !findBlock(outlineRef.current, visual.anchorId)
        || !findBlock(outlineRef.current, visual.headId)
      )
    ) {
      const empty = new Set<string>();
      setSelected(empty);
      setVisualLine(null);
      anchorId.current = null;
      vim.reset();
      return;
    }
    if (selectedRef.current.size === 0) return;
    const live = new Set(
      [...selectedRef.current].filter((id) => findBlock(outlineRef.current, id) !== undefined),
    );
    if (live.size !== selectedRef.current.size) {
      setSelected(live);
    }
  }, [state.revision]);

  // Whether the press now in flight began while something was floating over the
  // page. It has to be sampled here, on `window` in the capture phase, because
  // that is the only listener that runs *before* Radix's own document-level
  // dismisser: by the time a click reaches the append region, the menu it was
  // aimed past has already been unmounted, and asking "is a menu open?" then
  // always answers no. See `dismissTransient`.
  useEffect(() => {
    const sample = () => {
      overlayAtPressStart.current =
        document.querySelector(FLOATING_OVERLAY_SELECTOR) !== null;
    };
    window.addEventListener("pointerdown", sample, true);
    return () => window.removeEventListener("pointerdown", sample, true);
  }, []);

  // The slash menu floats over the outline but never takes focus, so it needs
  // its own way out: a press anywhere past it, or Escape from wherever the
  // keyboard happens to be, closes it and only it.
  useEffect(() => {
    if (!slashRequest) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const node = event.target;
      if (node instanceof Element && node.closest(".slash-menu")) return;
      setSlashRequest(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      setSlashRequest(null);
    };
    window.addEventListener("pointerdown", closeOnOutsidePress, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [slashRequest]);

  // The tag menu floats the same way and leaves the same way.
  useEffect(() => {
    if (!hashRequest) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const node = event.target;
      if (node instanceof Element && node.closest(".tag-menu")) return;
      setHashRequest(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      setHashRequest(null);
    };
    window.addEventListener("pointerdown", closeOnOutsidePress, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [hashRequest]);

  useEffect(() => {
    if (!pageRequest) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const node = event.target;
      if (node instanceof Element && node.closest(".page-reference-menu")) return;
      setPageRequest(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      setPageRequest(null);
    };
    window.addEventListener("pointerdown", closeOnOutsidePress, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [pageRequest, setPageRequest]);

  const flush = useCallback(
    (id: string) => {
      if (isPendingId(id)) return; // transferred when the real id arrives
      if (draftStateRef.current.pendingOperations.some(
        (operation) => operation.kind === "merge" && operation.targetId === id,
      )) return; // flushed after the canonical merge establishes this baseline
      const draft = draftStateRef.current.drafts.get(id);
      const baseline = draftStateRef.current.baselines.get(id);
      if (draft === undefined || baseline === undefined) return;
      const references = draftStateRef.current.pageReferences.get(id)
        ?? findBlock(outlineRef.current, id)?.page_references
        ?? [];
      const plan = planInlineEdit(id, baseline, references, draft);
      if (!plan) return;
      if (mounted.current) {
        dispatchDraft({
          type: "set-baseline",
          id,
          value: draft,
          pageReferences: plan.references,
        });
      }
      void session
        .execute({
          type: "splice_block_content",
          owner: ownerRef.current,
          ...plan.splice,
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          // The core rejected the edit; fall back to authoritative text. The
          // row silently changing back under the caret is exactly the kind of
          // failure that has no home on screen, so it is reported.
          dispatchDraft({ type: "clear", ids: [id] });
          notify.failure(message("failure.lastEdit"), error);
        });
    },
    [dispatchDraft, message, notify, session],
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

  /**
   * Commits the text edit that consumed a completion token together with the
   * semantic action selected from that completion. Neither half may survive if
   * the other is rejected, and one undo restores both.
   */
  const stageDraftSplice = useCallback((id: string, next: string): Command | null => {
      const timer = flushTimers.current.get(id);
      if (timer) {
        clearTimeout(timer);
        flushTimers.current.delete(id);
      }
      const baseline = draftStateRef.current.baselines.get(id);
      const references = draftStateRef.current.pageReferences.get(id)
        ?? findBlock(outlineRef.current, id)?.page_references
        ?? [];
      const plan = baseline === undefined
        ? null
        : planInlineEdit(id, baseline, references, next);
      if (!plan) return null;
      dispatchDraft({
        type: "set-baseline",
        id,
        value: next,
        pageReferences: plan.references,
      });
      return {
        type: "splice_block_content",
        owner: ownerRef.current,
        ...plan.splice,
      };
    }, [dispatchDraft]);

  const commitDraftWith = useCallback(
    async (id: string, next: string, action: Command | null, failure: string) => {
      const commands: Command[] = [];
      const splice = stageDraftSplice(id, next);
      if (splice) commands.push(splice);
      if (action) commands.push(action);
      if (commands.length === 0) return;
      try {
        await session.execute(commands.length === 1
          ? commands[0]
          : { type: "batch", commands });
      } catch (error) {
        if (mounted.current) dispatchDraft({ type: "clear", ids: [id] });
        notify.failure(failure, error);
      }
    },
    [dispatchDraft, notify, session, stageDraftSplice],
  );

  const flushRef = useLatest(flush);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (revealTimer.current) clearTimeout(revealTimer.current);
      if (presenceTimer.current !== null) clearTimeout(presenceTimer.current);
      const pending = [...flushTimers.current.entries()];
      flushTimers.current.clear();
      for (const [, timer] of pending) clearTimeout(timer);
      // Leaving the route must not throw away the final debounced keystroke.
      // The command still runs, while the unmounted editor no longer updates
      // its local baseline or reports through a surface that is gone.
      for (const [id] of pending) flushRef.current(id);
    };
  }, [flushRef]);

  const runHistory = useCallback(
    (id: string, redo: boolean) => {
      flushNow(id);
      const inputRevision = draftInputRevision.current;
      void history
        .run(redo ? "redo" : "undo", {
          kind: "outline",
          owner: ownerRef.current,
          blockId: id,
        })
        .then(() => {
          // GraphSession resolves only after its snapshot is authoritative. A
          // focused clean draft must stand down now or it masks the history
          // result; preserve it only if the user typed again while we waited.
          if (draftInputRevision.current !== inputRevision) {
            return;
          }
          dispatchDraft({ type: "clear", ids: [id] });
        })
        .catch((error: unknown) => {
          notify.failure(redo ? message("failure.redo") : message("failure.undo"), error);
        });
    },
    [dispatchDraft, flushNow, history, message, notify],
  );

  const publishSelection = useCallback((blockId: string, textarea: HTMLTextAreaElement) => {
    // Coalesced: `select` fires for every keystroke and caret move, and each
    // publish is a worker round-trip plus a socket frame. Peers reading a
    // caret 150ms late is invisible; a frame per keystroke is not free.
    presenceDraft.current = {
      owner,
      block_id: blockId,
      anchor: textarea.selectionStart,
      head: textarea.selectionEnd,
    };
    if (presenceTimer.current !== null) return;
    presenceTimer.current = window.setTimeout(() => {
      presenceTimer.current = null;
      if (presenceDraft.current) session.publishPresence(presenceDraft.current);
    }, PRESENCE_PUBLISH_MS);
  }, [owner, session]);

  /**
   * One entrance to a caret. Pointer-owned entrances start writing; keyboard
   * and programmatic moves retain the modal state. Visual Line is cleared here
   * without an intermediate Normal reset, so call order cannot overwrite the
   * mode chosen by the same activation.
   */
  const activateBlock = useCallback((
    id: string | null,
    caret: number | undefined,
    inputMethod: BlockActivationMethod,
  ) => {
    const previous = focusedRef.current;
    if (previous !== null && previous !== id) {
      dispatchDraft({ type: "clear-auto-closers", ids: [previous] });
    }
    pendingCaret.current = caret ?? null;
    setFocusedId(id);
    // The caret and the block selection are two answers to "what does the next
    // command act on", so only one of them may exist at a time.
    if (id !== null) {
      const leavingVisualLine = visualLineRef.current !== null;
      if (selectedRef.current.size > 0) {
        const empty = new Set<string>();
        setSelected(empty);
      }
      clearVisualLineState();
      const activationMode = vimModeForActivation(keymap, readonly, inputMethod);
      if (activationMode) {
        vim.reset(activationMode);
      } else if (keymap === "vim" && leavingVisualLine) {
        vim.reset();
      }
    }
    revealNavigationTarget(
      id !== null && (inputMethod === "keyboard" || inputMethod === "programmatic")
        ? id
        : null,
    );
  }, [clearVisualLineState, dispatchDraft, keymap, readonly, revealNavigationTarget, vim.reset]);

  const clearSelection = useCallback(() => {
    anchorId.current = null;
    if (selectedRef.current.size > 0) {
      const empty = new Set<string>();
      setSelected(empty);
    }
    leaveVisualLine();
  }, [leaveVisualLine]);

  /**
   * Focus leaving a row's text is what returns a Markdown block to its reading
   * projection. It has to be answered here rather than in the row, because a
   * `blur` says only that the textarea lost focus — never where focus went — and
   * the row is not the thing that knows: the answer arrives with the next focus
   * event, and for a press on quiet space it is "nowhere at all".
   *
   * Two destinations are *not* leaving: something else inside the same row (a
   * chip, the bullet), and anything floating over the page (a menu, the property
   * picker, a dialog) — in both cases the caret is coming straight back, and
   * re-rendering the row underneath the thing that is opening is exactly what it
   * must not do.
   *
   * Switching to another window needs no case of its own. Every engine keeps
   * `document.activeElement` on the element that had focus when the window loses
   * it — that is how the caret is still there on return — so the same test that
   * asks "is focus still in this row?" answers this too.
   */
  const releaseFocus = useCallback((id: string) => {
    requestAnimationFrame(() => {
      if (focusedRef.current !== id) return;
      const active = document.activeElement;
      if (active instanceof Element) {
        if (active.closest(`[data-block-id="${cssEscape(id)}"]`)) return;
        if (active.closest(FLOATING_OVERLAY_SELECTOR)) return;
      }
      dispatchDraft({ type: "clear-auto-closers", ids: [id] });
      setFocusedId(null);
      revealNavigationTarget(null);
    });
  }, [dispatchDraft, revealNavigationTarget]);

  /**
   * Hands the keyboard to the tree. A selection and a caret are the two answers
   * to "what does the next key act on", so taking one has to take the other's
   * focus with it — otherwise ⌫ reaches a textarea while rows sit highlighted.
   */
  const takeTreeFocus = useCallback(() => {
    if (focusedRef.current !== null) {
      dispatchDraft({ type: "clear-auto-closers", ids: [focusedRef.current] });
    }
    setFocusedId(null);
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement) active.blur();
    viewportRef.current?.focus({ preventScroll: true });
    revealNavigationTarget(null);
  }, [dispatchDraft, revealNavigationTarget]);

  /** The ⇧-click anchor, resolved against the outline as it is now. */
  const anchorRowIndex = useCallback(
    (rows: OutlineRow[]) => (anchorId.current ? rowIndexOf(rows, anchorId.current) : -1),
    [],
  );

  /**
   * Drops the optimistic rows an insert never claimed. Whatever the user typed
   * into them goes with them, so this is never allowed to happen quietly.
   */
  const abandonPending = useCallback(
    (reason: string) => {
      const pendingOperations = draftStateRef.current.pendingOperations;
      const creations = pendingOperations.filter((entry) => entry.kind !== "merge");
      const lost = creations.length;
      const typed = creations.some(
        (entry) => (draftStateRef.current.drafts.get(entry.tempId)
          ?? entry.created.markdown) !== entry.created.markdown,
      );
      let fallback: string | null = null;
      for (const entry of creations) {
        if (!isPendingId(entry.anchorId)) fallback = entry.anchorId;
      }
      dispatchDraft({ type: "abandon-pending" });
      if (focusedRef.current && isPendingId(focusedRef.current)) {
        activateBlock(fallback, undefined, "programmatic");
      }
      if (lost === 0) return;
      notify.show({
        tone: "danger",
        key: "pending-insert-abandoned",
        title: message("outline.newBlocksFailed", { count: lost }),
        detail: typed ? message("outline.pendingTypedLost", { reason }) : reason,
      });
    },
    [activateBlock, dispatchDraft, message, notify],
  );

  /** Dispatches the oldest pending outline operation whose dependencies are real. */
  const dispatchPending = useCallback(() => {
    if (pendingDispatching.current) return;
    const head = draftStateRef.current.pendingOperations[0];
    if (!head || head.dispatched) return;
    if (head.kind === "merge") {
      if (isPendingId(head.sourceId) || isPendingId(head.targetId)) return;
      dispatchDraft({ type: "mark-dispatched", id: head.id });
      pendingDispatching.current = true;
      void session
        .execute({
          type: "merge_block_backward",
          owner: ownerRef.current,
          block_id: head.sourceId,
        })
        .then(() => {
          const typed = draftStateRef.current.drafts.get(head.targetId)
            ?? head.merged.markdown;
          const active = document.activeElement;
          const caret = active instanceof HTMLTextAreaElement
            ? active.selectionStart
            : head.joinCaret;
          const wasFocused = focusedRef.current === head.targetId;
          flushSync(() => {
            dispatchDraft({ type: "complete-merge", id: head.id });
            if (wasFocused) activateBlock(head.targetId, caret, "programmatic");
          });
          if (typed !== head.merged.markdown) flushNow(head.targetId);
          pendingDispatching.current = false;
          dispatchPending();
        })
        .catch((error: unknown) => {
          const timer = flushTimers.current.get(head.targetId);
          if (timer) {
            clearTimeout(timer);
            flushTimers.current.delete(head.targetId);
          }
          flushSync(() => {
            dispatchDraft({ type: "fail-merge", id: head.id });
            activateBlock(head.sourceId, 0, "programmatic");
          });
          pendingDispatching.current = false;
          notify.failure(message("failure.mergeBlock"), error);
          dispatchPending();
        });
      return;
    }
    if (isPendingId(head.anchorId)) return;
    // A preceding queued structural command may have reconciled after the
    // component's last render. Compute the next insert from GraphSession's
    // current snapshot, not the render-time page ref, so parent/index cannot
    // lag behind an indent or outdent that just completed.
    const currentOutline =
      findOutline(session.getState().snapshot, ownerRef.current) ?? outlineRef.current;
    const source = flattenOutline(currentOutline, collapsedRef.current).find(
      (row) => row.block.id === head.anchorId,
    );
    if (!source) {
      // The anchor block disappeared (e.g. undo); pending edits cannot land.
      abandonPending("The block it would follow is gone.");
      return;
    }
    dispatchDraft({ type: "mark-dispatched", id: head.id });
    pendingDispatching.current = true;
    const placement: SplitPlacement = head.mode === "before"
      ? "before"
      : head.mode === "child"
        ? "first_child"
        : "after";
    const command: Command = head.kind === "insert"
      ? {
          type: "insert_block",
          owner: ownerRef.current,
          parent: head.mode === "child" ? head.anchorId : source.parentId,
          index: head.mode === "before" ? source.index : head.mode === "child" ? 0 : source.index + 1,
          markdown: head.created.markdown,
        }
      : {
          type: "split_block",
          owner: ownerRef.current,
          block_id: head.anchorId,
          index: head.splitIndex,
          placement,
        };
    session
      .execute(command)
      .then(async (result) => {
        const realId = result.created_block;
        const structural = draftStateRef.current.pendingOperations
          .find((operation) => operation.kind !== "merge" && operation.tempId === head.tempId)
          ?.structural ?? head.structural;
        const typed = draftStateRef.current.drafts.get(head.tempId)
          ?? head.created.markdown;
        const wasFocused = focusedRef.current === head.tempId;
        const active = document.activeElement;
        const caret =
          active instanceof HTMLTextAreaElement ? active.selectionStart : typed.length;
        if (realId) {
          // Commit removal of the temp row, the real-id focus state, and the
          // reconciled snapshot in one browser task. The layout focus effect
          // runs before flushSync returns, so no key can land between the two
          // textarea identities or hit a handler that still names tempId.
          flushSync(() => {
            // Keystrokes and generated closer provenance that raced the
            // acknowledgement move with the row in the same reducer transition.
            dispatchDraft({
              type: "adopt",
              tempId: head.tempId,
              blockId: realId,
              typed,
            });
            if (wasFocused) activateBlock(realId, caret, "programmatic");
            // A slash menu opened on the pending row must follow the block to
            // its real identity, or Enter stops meaning "take the highlighted
            // command" the moment the acknowledgement lands.
            dispatchOverlay({
              type: "replace-pending-block",
              pendingId: head.tempId,
              blockId: realId,
            });
          });
          let completionCommitted = false;
          if (pendingProperty.current?.blockId === head.tempId) {
            const intent = pendingProperty.current;
            pendingProperty.current = null;
            if (intent.action?.kind === "set") {
              const action = intent.action;
              void commitDraftWith(
                realId,
                typed,
                {
                  type: "set_property",
                  owner: { kind: "block", owner: ownerRef.current, id: realId },
                  key: action.key,
                  value: action.value,
                },
                message("failure.setProperty"),
              );
              completionCommitted = true;
            } else if (intent.action?.kind === "query") {
              void commitDraftWith(
                realId,
                typed,
                createQueryCommand({ kind: "block", owner: ownerRef.current, id: realId }),
                message("failure.createQuery"),
              );
              completionCommitted = true;
            } else {
              const key = intent.action?.kind === "picker" ? intent.action.key : undefined;
              const commandPrefix = stageDraftSplice(realId, typed) ?? undefined;
              completionCommitted = true;
              requestAnimationFrame(() => {
                const anchor = document.querySelector<HTMLTextAreaElement>(
                  `[data-block-id="${cssEscape(realId)}"] textarea`,
                );
                setPropertyRequest({
                  blockId: realId,
                  key,
                  anchor: anchor
                    ? caretAnchor(anchor, intent.selection?.start ?? anchor.selectionStart)
                    : null,
                  selection: intent.selection,
                  commandPrefix,
                });
              });
            }
          }
          if (pendingTag.current?.blockId === head.tempId) {
            const intent = pendingTag.current;
            pendingTag.current = null;
            void commitDraftWith(
              realId,
              typed,
              intent.option.present
                ? null
                : {
                    type: "add_tag",
                    entity: { kind: "block", owner: ownerRef.current, id: realId },
                    tag_id: intent.option.id,
                  },
              message(intent.option.present ? "failure.lastEdit" : "failure.addTag"),
            );
            completionCommitted = true;
          }
          if (typed !== head.created.markdown && !completionCommitted) {
            if (composing.current) scheduleFlush(realId);
            else flushNow(realId);
          }
          // Structural keys typed before acknowledgement replay in order and
          // must reconcile before the next pending insert computes its
          // parent/index from the snapshot.
          for (const kind of structural) {
            await session
              .execute({
                type: kind === "indent" ? "indent_blocks" : "outdent_blocks",
                owner: ownerRef.current,
                block_ids: [realId],
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
          dispatchDraft({ type: "discard-head", tempId: head.tempId });
          abandonPending(message("outline.engineMissingId"));
        }
        pendingDispatching.current = false;
        dispatchPending();
      })
      .catch((error: unknown) => {
        pendingDispatching.current = false;
        abandonPending(failureReason(error, message));
      });
  }, [
    abandonPending,
    activateBlock,
    commitDraftWith,
    dispatchDraft,
    flushNow,
    message,
    notify,
    scheduleFlush,
    session,
    stageDraftSplice,
  ]);

  const run = useCallback(
    (
      command: Parameters<GraphSession["execute"]>[0],
      summary: string,
    ) => session.execute(command)
      .catch((error: unknown) => {
        notify.failure(summary, error);
        return undefined;
      }),
    [notify, session],
  );

  const visualCaret = useCallback((range: VisualLineRange): number => {
    const allRows = rowsRef.current;
    const anchor = rowIndexOf(allRows, range.anchorId);
    const head = rowIndexOf(allRows, range.headId);
    const row = allRows[head];
    if (!row) return 0;
    const value = draftStateRef.current.drafts.get(row.block.id) ?? row.block.markdown;
    if (head === anchor) return Math.min(range.returnCaret, value.length);
    return caretForVerticalEntry(value, head < anchor ? -1 : 1, range.returnColumn);
  }, []);

  const restoreVisualCaret = useCallback((range: VisualLineRange) => {
    const caret = visualCaret(range);
    setVisualLine(null);
    anchorId.current = null;
    const empty = new Set<string>();
    setSelected(empty);
    activateBlock(range.headId, caret, "keyboard");
  }, [activateBlock, setVisualLine, visualCaret]);

  const runVimVisualLine = useCallback((
    command: VimVisualLineCommand,
    row?: OutlineRow,
    allRows: OutlineRow[] = rowsRef.current,
  ) => {
    if (command.action === "begin") {
      if (!row || readonly || isPendingId(row.block.id)) {
        vim.reset();
        return;
      }
      flushNow(row.block.id);
      const anchor = rowIndexOf(allRows, row.block.id);
      if (anchor < 0) {
        vim.reset();
        return;
      }
      const head = stepVisualLineIndex(allRows, anchor, anchor, 1, command.count - 1);
      const range: VisualLineRange = {
        anchorId: row.block.id,
        headId: allRows[head].block.id,
        returnCaret: command.caret,
        returnColumn: command.column,
      };
      anchorId.current = range.anchorId;
      setVisualLine(range);
      const ids = selectableIds(allRows, anchor, head);
      setSelected(ids);
      takeTreeFocus();
      revealNavigationTarget(range.headId);
      return;
    }

    const range = visualLineRef.current;
    if (!range) {
      vim.reset();
      return;
    }
    const anchor = rowIndexOf(allRows, range.anchorId);
    const head = rowIndexOf(allRows, range.headId);
    if (anchor < 0 || head < 0) {
      clearSelection();
      return;
    }

    if (command.action === "move" || command.action === "edge") {
      const target = command.action === "move"
        ? stepVisualLineIndex(allRows, anchor, head, command.direction, command.count)
        : edgeVisualLineIndex(allRows, anchor, command.edge);
      const next = { ...range, headId: allRows[target].block.id };
      setVisualLine(next);
      const ids = selectableIds(allRows, anchor, target);
      setSelected(ids);
      revealNavigationTarget(next.headId);
      return;
    }
    if (command.action === "cancel") {
      restoreVisualCaret(range);
      return;
    }

    const roots = selectionRoots(allRows, selectedRef.current);
    if (roots.length === 0) {
      restoreVisualCaret(range);
      return;
    }
    if (command.action === "delete") {
      const mask = coveredMask(allRows, selectedRef.current);
      const first = mask.findIndex(Boolean);
      let fallback: OutlineRow | undefined;
      for (let index = first; index < allRows.length; index += 1) {
        if (!mask[index]) {
          fallback = allRows[index];
          break;
        }
      }
      if (!fallback) {
        for (let index = first - 1; index >= 0; index -= 1) {
          if (!mask[index]) {
            fallback = allRows[index];
            break;
          }
        }
      }
      setVisualLine(null);
      anchorId.current = null;
      const empty = new Set<string>();
      setSelected(empty);
      void run(
        { type: "delete_blocks", owner, block_ids: roots.map((entry) => entry.block.id) },
        message("failure.deleteBlocks", { count: roots.length }),
      ).then(() => activateBlock(fallback?.block.id ?? null, 0, "programmatic"));
      return;
    }

    const caret = visualCaret(range);
    setVisualLine(null);
    anchorId.current = null;
    const empty = new Set<string>();
    setSelected(empty);
    activateBlock(range.headId, caret, "keyboard");
    void run(
      {
        type: command.action === "indent" ? "indent_blocks" : "outdent_blocks",
        owner,
        block_ids: roots.map((entry) => entry.block.id),
      },
      message(command.action === "indent" ? "failure.indentBlock" : "failure.outdentBlock"),
    );
  }, [
    clearSelection,
    flushNow,
    message,
    owner,
    readonly,
    revealNavigationTarget,
    restoreVisualCaret,
    run,
    activateBlock,
    setVisualLine,
    takeTreeFocus,
    vim.reset,
    visualCaret,
  ]);

  const runVimWordMotion = useCallback((
    command: VimWordMotionCommand,
    row: OutlineRow,
    allRows: OutlineRow[],
    textarea: HTMLTextAreaElement,
  ) => {
    const units = allRows.filter((entry) => !isPendingId(entry.block.id));
    const current = units.findIndex((entry) => entry.block.id === row.block.id);
    if (current < 0) return;
    const values = units.map((entry) => (
      draftStateRef.current.drafts.get(entry.block.id) ?? entry.block.markdown
    ));

    if (command.operator === null) {
      const target = wordMotionAcrossUnits(
        values,
        { unit: current, offset: command.caret },
        command.motion,
        command.count,
      );
      const targetRow = units[target.unit];
      if (!targetRow) return;
      if (targetRow.block.id === row.block.id) {
        textarea.setSelectionRange(target.offset, target.offset);
        publishSelection(row.block.id, textarea);
        return;
      }
      flushNow(row.block.id);
      activateBlock(targetRow.block.id, target.offset, "keyboard");
      return;
    }

    if (readonly) return;
    const plan = wordEditsAcrossUnits(
      values,
      { unit: current, offset: command.caret },
      command.motion,
      command.count,
    );
    if (plan.edits.length === 0) {
      if (command.operator === "change") vim.reset();
      return;
    }

    const updates = plan.edits.map((edit) => {
      const targetRow = units[edit.unit];
      const value = values[edit.unit];
      return {
        row: targetRow,
        value,
        next: `${value.slice(0, edit.from)}${value.slice(edit.to)}`,
        from: edit.from,
        to: edit.to,
      };
    }).filter((update) => update.row !== undefined);
    if (updates.length === 0) return;

    for (const update of updates) flushNow(update.row.block.id);
    draftInputRevision.current += 1;
    for (const update of updates) {
      dispatchDraft({
        type: "edit",
        id: update.row.block.id,
        value: update.next,
        baselineIfAbsent: update.row.block.markdown,
        autoClosers: [],
      });
    }
    setSlashRequest(null);
    setHashRequest(null);
    setPageRequest(null);

    const caretRow = units[plan.caret.unit];
    if (!caretRow) return;
    const caretValue = updates.find((update) => update.row.block.id === caretRow.block.id)?.next
      ?? values[plan.caret.unit];
    const caret = command.operator === "change"
      ? Math.min(plan.caret.offset, caretValue.length)
      : normalCaretAfterEdit(caretValue, plan.caret.offset);
    const currentUpdate = updates.find((update) => update.row.block.id === row.block.id);
    if (caretRow.block.id === row.block.id) {
      if (currentUpdate) textarea.value = currentUpdate.next;
      textarea.setSelectionRange(caret, caret);
      publishSelection(row.block.id, textarea);
    } else {
      activateBlock(caretRow.block.id, caret, "keyboard");
    }

    const ids = updates.map((update) => update.row.block.id);
    const contentPlans = updates.flatMap((update) => {
      const references = draftStateRef.current.pageReferences.get(update.row.block.id)
        ?? update.row.block.page_references
        ?? [];
      const plan = planInlineEdit(
        update.row.block.id,
        update.value,
        references,
        update.next,
      );
      if (!plan) return [];
      dispatchDraft({
        type: "set-baseline",
        id: update.row.block.id,
        value: update.next,
        pageReferences: plan.references,
      });
      return [plan.splice];
    });
    if (contentPlans.length === 0) return;
    void session.execute({
      type: "splice_block_contents",
      owner,
      splices: contentPlans,
    }).catch((error: unknown) => {
      dispatchDraft({ type: "clear", ids });
      notify.failure(message("failure.lastEdit"), error);
    });
  }, [
    dispatchDraft,
    flushNow,
    message,
    notify,
    owner,
    publishSelection,
    readonly,
    session,
    activateBlock,
    vim.reset,
  ]);

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

  /** Selection by row range, started from any quiet writing-surface area. */
  const beginRangeSelection = useCallback(
    (
      start: number,
      point: { clientX: number; clientY: number; shiftKey: boolean; preventDefault(): void },
      immediate: boolean,
      options?: {
        /**
         * Activate only once the pointer reaches a *different* row. This is how
         * a drag that starts inside the focused textarea stays a text selection
         * until it visibly leaves the block — at which point it becomes what
         * crossing a block boundary has to mean: a block selection.
         */
        requireRowChange?: boolean;
      },
    ) => {
      if (start < 0) return;
      const extend = point.shiftKey ? anchorRowIndex(rowsRef.current) : -1;
      const anchor = extend >= 0 ? extend : start;
      const startX = point.clientX;
      const startY = point.clientY;
      let active = immediate;
      anchorId.current = rowsRef.current[anchor]?.block.id ?? null;

      const activate = () => {
        // A native text selection may already be underway (the drag began in a
        // focused textarea); it must not survive next to a block selection.
        window.getSelection()?.removeAllRanges();
        leaveVisualLine();
        takeTreeFocus();
        dispatchPointerGesture({ type: "select" });
        setSelected(selectableIds(rowsRef.current, anchor, start));
      };
      if (immediate) {
        point.preventDefault();
        activate();
      }

      listen(
        (move) => {
          if (!active) {
            if (options?.requireRowChange) {
              const under = rowIndexAtPoint(viewportRef.current, move.clientY, rowsRef.current);
              if (under === null || under === start) return;
            } else if (
              Math.abs(move.clientY - startY) + Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX
            ) {
              return;
            }
            active = true;
            move.preventDefault();
            activate();
          }
          updateAutoScroll(move.clientY);
          const index = rowIndexAtPoint(viewportRef.current, move.clientY, rowsRef.current);
          if (index === null) return;
          const next = selectableIds(rowsRef.current, anchor, index);
          setSelected((current) => (sameIds(current, next) ? current : next));
        },
        () => {
          if (!active) {
            // The press never became a drag: a plain click on quiet space, which
            // is first of all the way *out* of an existing selection.
            if (!point.shiftKey && selectedRef.current.size > 0) clearSelection();
            return;
          }
          dispatchPointerGesture({ type: "end" });
          takeTreeFocus();
        },
      );
    },
    [
      anchorRowIndex,
      clearSelection,
      leaveVisualLine,
      listen,
      takeTreeFocus,
      updateAutoScroll,
    ],
  );

  const onGripPointerDown = useCallback(
    (row: OutlineRow, event: ReactPointerEvent) => {
      if (event.button !== 0) return;
      beginRangeSelection(rowIndexOf(rowsRef.current, row.block.id), event, true);
    },
    [beginRangeSelection],
  );

  const onSurfacePointerDown = useCallback(
    (row: OutlineRow, event: ReactPointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("button, a, select, input, [contenteditable='true'], .outline-tags, .block-chips, .query-block")) {
        return;
      }
      if (target instanceof HTMLTextAreaElement) {
        if (!target.classList.contains("outline-input")) return;
        if (document.activeElement === target) {
          // A drag inside the block being written is a text selection until it
          // crosses into another row; then it is a block selection starting here.
          beginRangeSelection(rowIndexOf(rowsRef.current, row.block.id), event, false, {
            requireRowChange: true,
          });
          return;
        }
      }
      beginRangeSelection(rowIndexOf(rowsRef.current, row.block.id), event, false);
    },
    [beginRangeSelection],
  );

  // The centered page leaves a broad quiet margin beside the outline. At the
  // same vertical position as the rows it behaves like the writing surface,
  // so a selection drag does not have to begin on a tiny gutter target.
  useEffect(() => {
    if (!scrollElement) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof HTMLElement)) return;
      if (event.target.closest(".page-body")) return;
      const viewport = viewportRef.current;
      if (!viewport || rowsRef.current.length === 0) return;
      const rect = viewport.getBoundingClientRect();
      if (event.clientY < rect.top || event.clientY > rect.bottom) return;
      const index = rowIndexAtPoint(viewport, event.clientY, rowsRef.current);
      if (index !== null) beginRangeSelection(index, event, false);
    };
    scrollElement.addEventListener("pointerdown", onPointerDown);
    return () => scrollElement.removeEventListener("pointerdown", onPointerDown);
  }, [beginRangeSelection, scrollElement]);

  const applyMove = useCallback(
    (target: DropTarget, moving: ReadonlySet<string>) => {
      const roots = selectionRoots(rowsRef.current, moving);
      if (roots.length === 0) return;
      void run(
        {
          type: "move_blocks",
          block_ids: roots.map((root) => root.block.id),
          owner: ownerRef.current,
          parent: target.parentId,
          after: target.afterId,
        },
        message("failure.moveBlocks", { count: roots.length }),
      );
    },
    [message, run],
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
        leaveVisualLine();
        takeTreeFocus();
        setSelected(selectableIds(rowsRef.current, anchor, index));
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        leaveVisualLine();
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
        : selectableIds(rowsRef.current, index, index);
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
            leaveVisualLine();
            takeTreeFocus();
            setSelected(moving);
            dispatchPointerGesture({ type: "drag" });
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
          dispatchPointerGesture({ type: "drop", target: resolved });
        },
        (_event, cancelled) => {
          dispatchPointerGesture({ type: "end" });
          if (cancelled) return;
          if (!started) {
            // A press that never travelled is a click: put the caret in the line.
            activateBlock(row.block.id, undefined, "pointer");
            return;
          }
          if (target) applyMove(target, moving);
        },
      );
    },
    [
      applyMove,
      activateBlock,
      leaveVisualLine,
      listen,
      readonly,
      updateAutoScroll,
    ],
  );

  const onRowContextMenu = useCallback(
    (row: OutlineRow, event: React.MouseEvent) => {
      event.preventDefault();
      if (isPendingId(row.block.id)) return;
      // Right-clicking outside the selection collapses it onto the row under the
      // pointer; inside it, the selection is what the menu is about.
      if (!selectionCovered.has(row.block.id)) {
        anchorId.current = row.block.id;
        setSelected(new Set());
      }
      const editor = event.currentTarget
        .closest<HTMLElement>('[data-testid="outline-row"]')
        ?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
      setMenuFor(row.block.id, pointAnchor(event.clientX, event.clientY, editor));
    },
    [selectionCovered],
  );

  const copySelection = useCallback(
    (_inputMethod: InputMethod) => {
      const fragment = createOutlineFragment(
        state.snapshot,
        outline,
        selectedRef.current,
      );
      if (!fragment) return;
      void writeClipboardBundle(buildClipboardBundle(fragment)).catch((error: unknown) => {
        notify.failure(message("failure.copyBlocks"), error);
      });
    },
    [message, notify, outline, state.snapshot],
  );

  const onCopySelection = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (selectedRef.current.size === 0) return;
      const fragment = createOutlineFragment(
        state.snapshot,
        outline,
        selectedRef.current,
      );
      if (!fragment) return;
      event.preventDefault();
      setClipboardData(event.clipboardData, buildClipboardBundle(fragment));
    },
    [outline, state.snapshot],
  );

  const pasteOutline = useCallback(
    (row: OutlineRow, items: OutlineClipboardItem[]) => {
      if (readonly || isPendingId(row.block.id) || items.length === 0) return;
      flushNow(row.block.id);
      const replace = isPlainEmptyBlock(
          row.block,
          draftStateRef.current.drafts.get(row.block.id) ?? row.block.markdown,
        )
        ? row.block.id
        : null;
      void session.execute({
        type: "insert_outline",
        owner,
        parent: row.parentId,
        index: replace ? row.index : row.index + 1,
        replace,
        items,
      }).then(
        (result) => {
          if (result.created_block) {
            activateBlock(result.created_block, undefined, "keyboard");
          }
        },
        (error: unknown) => {
          notify.failure(message("failure.pasteBlocks"), error);
        },
      );
    },
    [activateBlock, flushNow, message, notify, owner, readonly, session],
  );

  const pasteFragment = useCallback(
    (row: OutlineRow, fragment: OutlineFragment) => {
      if (readonly || isPendingId(row.block.id) || fragment.items.length === 0) return;
      flushNow(row.block.id);
      const replace = isPlainEmptyBlock(
          row.block,
          draftStateRef.current.drafts.get(row.block.id) ?? row.block.markdown,
        )
        ? row.block.id
        : null;
      void session.execute({
        type: "paste_outline",
        owner,
        parent: row.parentId,
        index: replace ? row.index : row.index + 1,
        replace,
        fragment,
      }).then(
        (result) => {
          if (result.created_block) {
            activateBlock(result.created_block, undefined, "keyboard");
          }
        },
        (error: unknown) => {
          notify.failure(message("failure.pasteBlocks"), error);
        },
      );
    },
    [activateBlock, flushNow, message, notify, owner, readonly, session],
  );

  const slashItems = useMemo(() => buildSlashItems(message), [message]);
  const slashResults = useMemo(
    () => (slashRequest ? filterSlashItems(slashItems, slashRequest.query) : []),
    [slashItems, slashRequest],
  );
  const slashIndex = Math.min(slashActive, Math.max(slashResults.length - 1, 0));

  const hashResults = useMemo<TagOption[]>(() => {
    if (!hashRequest) return [];
    const present = new Set(findBlock(outline, hashRequest.blockId)?.tags ?? []);
    return filterTagOptions(state.snapshot.tags, hashRequest.query, present, compare);
  }, [compare, hashRequest, outline, state.snapshot.tags]);
  const hashIndex = Math.min(hashActive, Math.max(hashResults.length - 1, 0));
  const pageResults = useMemo<PageOption[]>(
    () => pageRequest ? filterPageOptions(pageDirectory, pageRequest.query, compare) : [],
    [compare, pageDirectory, pageRequest],
  );
  const pageIndex = Math.min(pageActive, Math.max(pageResults.length - 1, 0));

  const updateCompletions = (
    blockId: string,
    value: string,
    textarea: HTMLTextAreaElement,
  ): boolean => {
    const page = isPendingId(blockId)
      ? null
      : detectPage(value, textarea.selectionStart, textarea.selectionEnd);
    if (page) {
      const results = filterPageOptions(pageDirectory, page.query, compare);
      dispatchOverlay({
        type: "set-completion",
        overlay: results.length > 0
          ? { kind: "page", request: { blockId, ...page, anchor: textarea }, active: 0 }
          : null,
      });
      return results.length > 0;
    }
    const slash = detectSlash(value, textarea.selectionStart, textarea.selectionEnd);
    if (slash) {
      dispatchOverlay({
        type: "set-completion",
        overlay: filterSlashItems(slashItems, slash.query).length > 0
          ? { kind: "slash", request: { blockId, ...slash, anchor: textarea }, active: 0 }
          : null,
      });
      return filterSlashItems(slashItems, slash.query).length > 0;
    }

    const hash = detectHash(value, textarea.selectionStart, textarea.selectionEnd);
    const hasHashResults = hash
      ? filterTagOptions(state.snapshot.tags, hash.query, NO_TAGS, compare).length > 0
      : false;
    dispatchOverlay({
      type: "set-completion",
      overlay:
        hash && hasHashResults
          ? { kind: "hash", request: { blockId, ...hash, anchor: textarea }, active: 0 }
          : null,
    });
    return hasHashResults;
  };

  const editor: EditorContext = {
    session,
    notify,
    message,
    owner,
    graphId: state.snapshot.graph_id,
    readonly,
    keymap,
    vim,
    focusedId,
    pendingCaret,
    activationEntrance,
    propertyRequest,
    tagRequest,
    slashRequest,
    slashResults,
    slashActive: slashIndex,
    hashRequest,
    hashResults,
    hashActive: hashIndex,
    pageRequest,
    pageResults,
    pageActive: pageIndex,
    menuFor,
    menuAnchor,
    covered: selectionCovered,
    revealed,
    selectionCount,
    revision: state.revision,
    presence: [...state.presence.values()].filter(
      (peer) => peer.owner !== undefined && sameOutlineOwner(peer.owner, owner),
    ),
    activateBlock,
    releaseFocus,
    publishSelection,
    takeTreeFocus,
    selectOnly: (row) => {
      if (isPendingId(row.block.id)) return;
      anchorId.current = row.block.id;
      takeTreeFocus();
      const index = rowIndexOf(rowsRef.current, row.block.id);
      setSelected(selectableIds(rowsRef.current, index, index));
    },
    openMenu: setMenuFor,
    openProperties: (id, key, anchor = null) => {
      const element = anchor instanceof HTMLElement ? anchor : anchor?.owner ?? null;
      const placement = anchor instanceof HTMLTextAreaElement
        ? caretAnchor(anchor, anchor.selectionStart)
        : anchor instanceof HTMLElement
          ? elementAnchor(anchor)
          : anchor;
      setPropertyRequest({
        blockId: id,
        key,
        anchor: placement,
        selection: element instanceof HTMLTextAreaElement
          ? { start: element.selectionStart, end: element.selectionEnd }
          : undefined,
      });
    },
    openTags: (id, anchor = null) => {
      setTagRequest({
        blockId: id,
        anchor: anchor instanceof HTMLTextAreaElement
          ? caretAnchor(anchor, anchor.selectionStart)
          : anchor instanceof HTMLElement
            ? elementAnchor(anchor)
            : anchor,
      });
    },
    closeSlash: () => setSlashRequest(null),
    setSlashActive: setSlashActiveState,
    acceptSlash: (row, item) => {
      const request = slashRequest;
      const chosen = item ?? slashResults[slashIndex];
      if (!request || request.blockId !== row.block.id || readonly || !chosen) return;
      // Removing the token can reconcile and replace the textarea before the
      // picker mounts. Its place is part of this gesture, so capture it while
      // the gesture's anchor still exists instead of handing Radix a detached
      // element whose bounding box is the origin.
      const pickerAnchor = snapshotAnchor(completionAnchor(request));
      const value = draftStateRef.current.drafts.get(row.block.id) ?? row.block.markdown;
      const { value: next, caret } = removeCompletionToken(value, request);
      dispatchDraft({
        type: "edit",
        id: row.block.id,
        value: next,
        baselineIfAbsent: row.block.markdown,
        autoClosers: [],
      });
      pendingCaret.current = caret;
      setSlashRequest(null);
      if (isPendingId(row.block.id)) {
        // The choice waits for the real BlockId; a temp id never crosses into
        // the picker or a command.
        pendingProperty.current = {
          blockId: row.block.id,
          selection: { start: caret, end: caret },
          action: chosen.action,
        };
        dispatchPending();
        return;
      }
      if (chosen.action.kind === "set") {
        // A direct item is one keystroke to one property write — no picker.
        void commitDraftWith(
          row.block.id,
          next,
          {
            type: "set_property",
            owner: { kind: "block", owner, id: row.block.id },
            key: chosen.action.key,
            value: chosen.action.value,
          },
          message("failure.setProperty"),
        );
        return;
      }
      if (chosen.action.kind === "query") {
        void commitDraftWith(
          row.block.id,
          next,
          createQueryCommand({ kind: "block", owner, id: row.block.id }),
          message("failure.createQuery"),
        );
        return;
      }
      const commandPrefix = stageDraftSplice(row.block.id, next) ?? undefined;
      setPropertyRequest({
        blockId: row.block.id,
        key: chosen.action.key,
        anchor: pickerAnchor,
        selection: { start: caret, end: caret },
        commandPrefix,
      });
    },
    closeHash: () => setHashRequest(null),
    setHashActive: setHashActiveState,
    acceptHash: (row, option) => {
      const request = hashRequest;
      const chosen = option ?? hashResults[hashIndex];
      if (!request || request.blockId !== row.block.id || readonly || !chosen) return;
      // The token leaves the Markdown exactly as a slash token does: the tag
      // becomes structural membership, never text.
      const value = draftStateRef.current.drafts.get(row.block.id) ?? row.block.markdown;
      const { value: next, caret } = removeCompletionToken(value, request);
      dispatchDraft({
        type: "edit",
        id: row.block.id,
        value: next,
        baselineIfAbsent: row.block.markdown,
        autoClosers: [],
      });
      pendingCaret.current = caret;
      setHashRequest(null);
      if (isPendingId(row.block.id)) {
        // The choice waits for the real BlockId; a temp id never crosses into
        // a command.
        pendingTag.current = { blockId: row.block.id, option: chosen };
        dispatchPending();
        return;
      }
      void commitDraftWith(
        row.block.id,
        next,
        chosen.present
          ? null
          : {
              type: "add_tag",
              entity: { kind: "block", owner, id: row.block.id },
              tag_id: chosen.id,
            },
        message(chosen.present ? "failure.lastEdit" : "failure.addTag"),
      );
    },
    closePage: () => setPageRequest(null),
    setPageActive: setPageActiveState,
    acceptPage: (row, option) => {
      const request = pageRequest;
      const chosen = option ?? pageResults[pageIndex];
      if (!request || request.blockId !== row.block.id || readonly || !chosen) return;
      const id = row.block.id;
      const draft = draftStateRef.current.drafts.get(id) ?? row.block.markdown;
      const baseline = draftStateRef.current.baselines.get(id) ?? row.block.markdown;
      const baselineReferences = draftStateRef.current.pageReferences.get(id)
        ?? row.block.page_references
        ?? [];
      const pendingText = planInlineEdit(id, baseline, baselineReferences, draft);
      const currentReferences = pendingText?.references ?? baselineReferences;
      const pageId = chosen.create ? `p-${crypto.randomUUID()}` : chosen.id;
      const replacement = planPageReference(
        id,
        draft,
        currentReferences,
        request.start,
        request.end,
        pageId,
        chosen.title,
      );
      dispatchDraft({
        type: "edit",
        id,
        value: replacement.value,
        baselineIfAbsent: row.block.markdown,
        autoClosers: [],
      });
      dispatchDraft({
        type: "set-baseline",
        id,
        value: replacement.value,
        pageReferences: replacement.plan.references,
      });
      pendingCaret.current = replacement.caret;
      setPageRequest(null);

      const commands: Command[] = [];
      if (chosen.create) {
        commands.push({ type: "ensure_page", page_id: pageId, title: chosen.title });
      }
      if (pendingText) {
        commands.push({
          type: "splice_block_content",
          owner,
          ...pendingText.splice,
        });
      }
      commands.push({
        type: "splice_block_content",
        owner,
        ...replacement.plan.splice,
      });
      void session.execute(commands.length === 1
        ? commands[0]
        : { type: "batch", commands }).catch((error: unknown) => {
        if (mounted.current) dispatchDraft({ type: "clear", ids: [id] });
        notify.failure(message("failure.lastEdit"), error);
      });
    },
    toggleCollapse: (id) => {
      if (visualLineRef.current) clearSelection();
      const expanding = collapsedRef.current.has(id);
      const next = nextCollapsed(collapsedRef.current, id);
      const after = flattenOutline(outlineRef.current, next);
      setCollapsed(next);

      // Expanding is the one structural change in the outline that leaves no
      // other trace: rows the user has never seen simply exist on the next frame,
      // in the middle of a list, and the eye has nothing to follow. The rows this
      // gesture uncovered — and only those, never a row the virtualizer happened
      // to mount while scrolling — fade up while the chevron turns.
      if (expanding) {
        const before = new Set(rowsRef.current.map((row) => row.block.id));
        const uncovered = after
          .map((row) => row.block.id)
          .filter((entry) => !before.has(entry));
        if (uncovered.length > 0) {
          setRevealed(new Set(uncovered));
          if (revealTimer.current) clearTimeout(revealTimer.current);
          revealTimer.current = setTimeout(() => setRevealed(NOTHING_REVEALED), REVEAL_MS);
        }
      }

      // A row that just went out of sight cannot stay selected: ⌫ and ⇥ resolve
      // the selection against the *visible* outline, so a hidden member would
      // make them quietly do nothing. Expanding a selected parent is the inverse
      // gesture and materializes the passengers it deliberately reveals. This
      // is a local selection gesture, unlike a later document revision, so it is
      // allowed to change concrete membership.
      if (selectedRef.current.size > 0) {
        if (expanding) {
          const expanded = coveredIds(after, selectedRef.current);
          if (!sameIds(expanded, selectedRef.current)) setSelected(expanded);
        } else {
          const visible = new Set(after.map((row) => row.block.id));
          const kept = new Set([...selectedRef.current].filter((entry) => visible.has(entry)));
          if (kept.size !== selectedRef.current.size) setSelected(kept);
        }
      }
    },
    draftOf: (row) => pendingProjection.content.get(row.block.id)?.markdown
      ?? draftState.drafts.get(row.block.id)
      ?? row.block.markdown,
    autoClosersOf: (blockId) => draftState.autoClosers.get(blockId) ?? [],
    pageReferencesOf: (block) => pendingProjection.content.get(block.id)?.pageReferences
      ?? draftState.pageReferences.get(block.id)
      ?? block.page_references
      ?? [],
    onInput: (row, value, textarea, edit) => {
      const previous = draftStateRef.current.drafts.get(row.block.id) ?? row.block.markdown;
      let nextClosers = transformAutoClosers(
        previous,
        value,
        draftStateRef.current.autoClosers.get(row.block.id) ?? [],
        edit?.preferredStart,
        edit?.preferredEnd,
      );
      const generatedCloser = edit?.autoCloser;
      if (generatedCloser) {
        nextClosers = [
          ...nextClosers.filter(
            (marker) =>
              marker.offset !== generatedCloser.offset ||
              marker.closer !== generatedCloser.closer,
          ),
          generatedCloser,
        ];
      }
      draftInputRevision.current += 1;
      dispatchDraft({
        type: "edit",
        id: row.block.id,
        value,
        baselineIfAbsent: row.block.markdown,
        pageReferencesIfAbsent: row.block.page_references ?? [],
        autoClosers: nextClosers,
      });
      if (!composing.current) {
        const completing = updateCompletions(row.block.id, value, textarea);
        if (completing) {
          const timer = flushTimers.current.get(row.block.id);
          if (timer) {
            clearTimeout(timer);
            flushTimers.current.delete(row.block.id);
          }
        } else {
          scheduleFlush(row.block.id);
        }
      }
    },
    onCompositionStart: (row) => {
      composing.current = true;
      const timer = flushTimers.current.get(row.block.id);
      if (timer) {
        clearTimeout(timer);
        flushTimers.current.delete(row.block.id);
      }
    },
    onCompositionEnd: (row, textarea) => {
      composing.current = false;
      finishComposition();
      const value = draftStateRef.current.drafts.get(row.block.id) ?? row.block.markdown;
      if (!updateCompletions(row.block.id, value, textarea)) scheduleFlush(row.block.id);
    },
    onKeyDown: (row, allRows, event) => onKeyDown(editor, row, allRows, event, bindings),
    flushNow,
    runHistory,
    onGripPointerDown,
    onSurfacePointerDown,
    onBulletPointerDown,
    onRowContextMenu,
    pressStartedOverOverlay: () => overlayAtPressStart.current,
    // Clicking past a menu, a popover or a selection is first a way *out* of it.
    // The empty region under the last block is a real button — it makes a block —
    // which meant dismissing a block menu by clicking below the writing also
    // appended an empty row the user never asked for, every time. Radix has
    // already closed its own layer by now; what is left to undo is the outline's
    // share of the same gesture.
    dismissTransient: () => {
      dispatchOverlay({ type: "close" });
      if (selectedRef.current.size > 0) clearSelection();
    },
    pasteOutline,
    pasteFragment,
    enqueuePendingInsert: (row, tail, asChild, inputMethod) => {
      pendingSeq.current += 1;
      const tempId = `${PENDING_PREFIX}${pendingSeq.current}`;
      // Enter must return with the new textarea already mounted and focused;
      // the following key may arrive in the next browser task with no delay.
      flushSync(() => {
        dispatchDraft({
          type: "enqueue",
          operation: {
            kind: "insert",
            id: tempId,
            tempId,
            anchorId: row.block.id,
            mode: asChild ? "child" : "sibling",
            created: { markdown: tail, pageReferences: [] },
            dispatched: false,
            structural: [],
          },
        });
        activateBlock(tempId, 0, inputMethod);
      });
      dispatchPending();
    },
    enqueuePendingSplit: (row, index, head, tail, asChild, inputMethod) => {
      pendingSeq.current += 1;
      const tempId = `${PENDING_PREFIX}${pendingSeq.current}`;
      const leading = index === 0;
      flushSync(() => {
        dispatchDraft({
          type: "enqueue",
          operation: {
            kind: "split",
            id: tempId,
            tempId,
            anchorId: row.block.id,
            mode: leading ? "before" : asChild ? "child" : "sibling",
            splitIndex: index,
            source: leading ? tail : head,
            created: leading ? head : tail,
            dispatched: false,
            structural: [],
          },
        });
        activateBlock(tempId, 0, inputMethod);
      });
      dispatchPending();
    },
    mergeBackward: (row, allRows, textarea, inputMethod) => {
      if (
        draftStateRef.current.pendingOperations.length > 0
        && !isPendingId(row.block.id)
      ) return;
      const target = allRows.find(
        (candidate) => candidate.parentId === row.parentId && candidate.index === row.index - 1,
      );
      if (!target || (!isPendingId(row.block.id) && isPendingId(target.block.id))) return;
      const targetContent = {
        markdown: editor.draftOf(target),
        pageReferences: editor.pageReferencesOf(target.block),
      };
      const projectedSource = editor.draftOf(row);
      const projectedReferences = editor.pageReferencesOf(row.block);
      const liveSource = textarea.value;
      const liveReferences = liveSource === projectedSource
        ? projectedReferences
        : planInlineEdit(row.block.id, projectedSource, projectedReferences, liveSource)
          ?.references ?? projectedReferences;
      const sourceContent = { markdown: liveSource, pageReferences: liveReferences };
      flushNow(target.block.id);
      flushNow(row.block.id);
      pendingSeq.current += 1;
      const operationId = `merge-${pendingSeq.current}`;
      flushSync(() => {
        dispatchDraft({
          type: "enqueue",
          operation: {
            kind: "merge",
            id: operationId,
            sourceId: row.block.id,
            targetId: target.block.id,
            merged: joinInlineContentProjections(targetContent, sourceContent),
            joinCaret: targetContent.markdown.length,
            dispatched: false,
          },
        });
        activateBlock(target.block.id, targetContent.markdown.length, inputMethod);
      });
      dispatchPending();
    },
    queuePendingStructural: (tempId, kind) => {
      dispatchDraft({ type: "queue-structural", tempId, kind });
    },
    runVimStructure: (kind, row, allRows, count) => {
      if (readonly || isPendingId(row.block.id)) return;
      flushNow(row.block.id);
      const start = rowIndexOf(allRows, row.block.id);
      if (start < 0) return;
      const selectedIds = new Set(
        allRows
          .slice(start, Math.min(allRows.length, start + Math.max(1, count)))
          .map((entry) => entry.block.id),
      );
      const roots = selectionRoots(allRows, selectedIds);
      if (roots.length === 0) return;
      const blockIds = roots.map((entry) => entry.block.id);
      if (kind === "delete") {
        const mask = coveredMask(allRows, new Set(blockIds));
        let fallback: OutlineRow | undefined;
        for (let index = start; index < allRows.length; index += 1) {
          if (!mask[index]) {
            fallback = allRows[index];
            break;
          }
        }
        if (!fallback) {
          for (let index = start - 1; index >= 0; index -= 1) {
            if (!mask[index]) {
              fallback = allRows[index];
              break;
            }
          }
        }
        void run(
          { type: "delete_blocks", owner, block_ids: blockIds },
          message("failure.deleteBlocks", { count: blockIds.length }),
        ).then(() => activateBlock(fallback?.block.id ?? null, 0, "programmatic"));
        return;
      }
      void run(
        {
          type: kind === "indent" ? "indent_blocks" : "outdent_blocks",
          owner,
          block_ids: blockIds,
        },
        message(kind === "indent" ? "failure.indentBlock" : "failure.outdentBlock"),
      );
    },
    runVimVisualLine,
    runVimWordMotion,
    insertRootBlock: (index, inputMethod) => {
      void session
        .execute({
          type: "insert_block",
          owner,
          parent: null,
          index,
          markdown: "",
        })
        .then((result) => {
          if (result.created_block) activateBlock(result.created_block, 0, inputMethod);
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
        editor.enqueuePendingInsert(row, "", true, "context_menu");
      },
      indent: (row) => {
        flushNow(row.block.id);
        void run(
          {
            type: "indent_blocks",
            owner,
            block_ids: [row.block.id],
          },
          message("failure.indentBlock"),
        );
      },
      outdent: (row) => {
        flushNow(row.block.id);
        void run(
          {
            type: "outdent_blocks",
            owner,
            block_ids: [row.block.id],
          },
          message("failure.outdentBlock"),
        );
      },
      move: (row, delta) => {
        flushNow(row.block.id);
        const target = row.index + delta;
        if (target < 0 || target >= row.siblingCount) return;
        const stationary = rowsRef.current.filter(
          (candidate) => candidate.parentId === row.parentId && candidate.block.id !== row.block.id,
        );
        const after = target === 0 ? null : stationary[target - 1]?.block.id;
        if (target > 0 && after === undefined) return;
        void run(
          {
            type: "move_blocks",
            block_ids: [row.block.id],
            owner,
            parent: row.parentId,
            after: after ?? null,
          },
          delta < 0 ? message("failure.moveBlockUp") : message("failure.moveBlockDown"),
        );
      },
      remove: (row, allRows) => {
        const position = rowIndexOf(allRows, row.block.id);
        const previous = allRows[position - 1]?.block.id ?? null;
        void run(
          {
            type: "delete_blocks",
            owner,
            block_ids: [row.block.id],
          },
          message("failure.deleteBlock"),
        ).then(() => {
          activateBlock(previous, undefined, "programmatic");
        });
      },
      // One user gesture crosses the core boundary as one command. The core
      // owns root normalization, ordering, validation, and the undo group.
      indentSelection: (_inputMethod) => {
        const roots = selectionRoots(rowsRef.current, selectedRef.current);
        if (roots.length === 0) return;
        void run(
          {
            type: "indent_blocks",
            owner,
            block_ids: roots.map((root) => root.block.id),
          },
          message("failure.indentBlock"),
        );
      },
      outdentSelection: (_inputMethod) => {
        const roots = selectionRoots(rowsRef.current, selectedRef.current);
        if (roots.length === 0) return;
        void run(
          {
            type: "outdent_blocks",
            owner,
            block_ids: roots.map((root) => root.block.id),
          },
          message("failure.outdentBlock"),
        );
      },
      removeSelection: (_inputMethod) => {
        const roots = selectionRoots(rowsRef.current, selectedRef.current);
        if (roots.length === 0) return;
        const first = rowIndexOf(rowsRef.current, roots[0].block.id);
        const fallback = rowsRef.current[first - 1]?.block.id ?? null;
        clearSelection();
        void run(
          {
            type: "delete_blocks",
            owner,
            block_ids: roots.map((root) => root.block.id),
          },
          message("failure.deleteBlocks", { count: roots.length }),
        ).then(() => activateBlock(fallback, undefined, "programmatic"));
      },
      copySelection,
    },
  };

  // ── One outline, two origins ──
  //
  // The rows are virtualized against the *page* scroller, because an outline
  // scrolls together with everything above it: a title, its properties, and on a
  // tag its defaults and its query results. So "how far has the reader scrolled"
  // is measured from the top of the page, while "where does row 40 sit" is
  // measured from the top of the outline. The virtualizer compares those two
  // numbers to decide which rows exist, so it has to be told the distance
  // between their origins. Left at zero it builds the window that would be right
  // if the outline began at the top of the page — the wrong band of rows by
  // exactly the header's height, which reads as blank space where the reader is
  // looking and rows rendered where nobody is. It is the same arithmetic that
  // aims `scrollToIndex`, so a revealed block landed off-screen by the same
  // distance.
  //
  // That height is not a constant: a query panel fills in when its results
  // arrive, a disclosure opens, a default is added. So it is measured rather
  // than assumed, and re-measured whenever anything that can push the outline
  // down changes size.
  const [scrollMargin, setScrollMargin] = useState(0);
  const populated = rows.length > 0;
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!scrollElement || !viewport || !scrollElement.contains(viewport)) return;

    const measure = () => {
      const offset =
        viewport.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top +
        scrollElement.scrollTop;
      // A fractional layout would otherwise re-render the whole outline on every
      // observation without moving a single row.
      setScrollMargin((current) =>
        Math.abs(current - offset) < 1 ? current : offset,
      );
    };
    measure();

    // jsdom (component tests) has no layout and no ResizeObserver: there every
    // rect is 0, which is the right answer for a page with no header to clear.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    // Everything that can move the outline down: each box between it and the
    // scroller, and everything laid out above each of those. A box that appears
    // or disappears needs no watching of its own — it changes the height of the
    // parent already in this walk.
    for (let node: Element | null = viewport; node; node = node.parentElement) {
      observer.observe(node);
      for (
        let above = node.previousElementSibling;
        above;
        above = above.previousElementSibling
      ) {
        observer.observe(above);
      }
      if (node === scrollElement) break;
    }
    return () => observer.disconnect();
  }, [populated, scrollElement]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 30,
    overscan: 10,
    scrollMargin,
    // jsdom (component tests) has no layout; the observer corrects this in
    // real browsers.
    initialRect: { width: 800, height: 600 },
    getItemKey: (index) => rows[index].block.id,
  });

  const revealHistoryTarget = useCallback((request: HistoryRevealRequest) => {
    const allRows = flattenOutline(outlineRef.current, new Set());
    const target = allRows.find((row) => row.block.id === request.blockId);
    if (!target) return false;

    const parents = new Map(allRows.map((row) => [row.block.id, row.parentId]));
    const ancestors = new Set<string>();
    let parentId = target.parentId;
    while (parentId) {
      ancestors.add(parentId);
      parentId = parents.get(parentId) ?? null;
    }
    if (ancestors.size > 0) {
      setCollapsed((current) => {
        const next = new Set(current);
        let changed = false;
        for (const id of ancestors) changed = next.delete(id) || changed;
        return changed ? next : current;
      });
    }

    setRevealed(new Set([request.blockId]));
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => {
      revealTimer.current = null;
      setRevealed(NOTHING_REVEALED);
    }, REVEAL_MS);
    pendingHistoryReveal.current = request;
    bumpHistoryReveal();
    return true;
  }, []);

  // History owns *what* should be revealed; the mounted outliner owns *how*.
  // Re-register after reconciliation so a cross-page request can be retried as
  // soon as the destination page is present in the authoritative snapshot.
  useEffect(
    () => history.registerRevealer(owner, revealHistoryTarget),
    [history, owner, revealHistoryTarget, state.revision],
  );

  useEffect(() => {
    const request = pendingHistoryReveal.current;
    if (!request) return;
    const index = rowIndexOf(rows, request.blockId);
    if (index < 0) return;
    virtualizer.scrollToIndex(index);
    if (request.focus && focusedRef.current !== request.blockId) {
      activateBlock(request.blockId, undefined, "programmatic");
    }
    pendingHistoryReveal.current = null;
  }, [activateBlock, historyRevealRevision, rows, virtualizer]);

  // A navigation arrival asks to be revealed exactly once. Focus itself is a
  // durable editing state and must not imply durable scroll ownership: after a
  // reader starts scrolling, virtualizer renders may continue while that same
  // textarea remains focused.
  //
  // "Bring the focused row into view" is the right behaviour for a row that
  // arrived from the keyboard and the wrong one for a row the pointer just
  // pressed: a block carrying a long query result is taller than the viewport,
  // so aligning it moves the page out from under the caret the user placed. A
  // row already on screen is by definition in view, whichever way focus reached
  // it, so intersection is the whole test.
  useEffect(() => {
    if (!navigationReveal) return;
    const consume = () => setNavigationReveal((current) =>
      current?.sequence === navigationReveal.sequence ? null : current);
    const index = rowIndexOf(rows, navigationReveal.id);
    if (index < 0) return;
    const element = viewportRef.current?.querySelector(
      `[data-block-id="${cssEscape(navigationReveal.id)}"]`,
    );
    if (element && scrollElement) {
      const row = element.getBoundingClientRect();
      const view = scrollElement.getBoundingClientRect();
      if (row.bottom > view.top && row.top < view.bottom) {
        consume();
        return;
      }
      // A mounted row already has exact geometry. Native nearest-edge scrolling
      // completes synchronously and owns no later reconciliation pass, so an
      // old keyboard arrival cannot pull the page back after focus leaves and
      // the reader scrolls elsewhere. The virtualizer is reserved for a row
      // that does not exist in the DOM yet.
      if (typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "nearest", inline: "nearest" });
        consume();
        return;
      }
    }
    // Keep the request until the virtual row mounts; the next pass consumes it
    // after exact geometry has either confirmed or completed the reveal.
    virtualizer.scrollToIndex(index);
  }, [navigationReveal, rows, scrollElement, virtualizer]);

  // Mod+P means "properties of what is in front of me". While a block is focused
  // that is the block; the shell falls back to the page when this slot is empty.
  useLayoutEffect(() => {
    if (focusedId && isPendingId(focusedId)) {
      return commands.registerBlockProperties((key?: string) => {
        const active = document.activeElement;
        pendingProperty.current = {
          blockId: focusedId,
          selection: active instanceof HTMLTextAreaElement
            ? { start: active.selectionStart, end: active.selectionEnd }
            : undefined,
          action: key ? { kind: "picker", key } : undefined,
        };
        dispatchPending();
      });
    }
    const selectedId = selected.size === 1 ? [...selected][0] : null;
    const targetId = focusedId ?? selectedId;
    if (!targetId) {
      if (selected.size > 1) {
        return commands.registerBlockProperties(() => notify.show({
          tone: "info",
          key: "property-selection-count",
          title: message("properties.selectOne"),
        }));
      }
      return;
    }
    return commands.registerBlockProperties((key?: string) => {
      const anchor = document.querySelector<HTMLTextAreaElement>(
        `[data-block-id="${cssEscape(targetId)}"] textarea`,
      );
      setPropertyRequest({
        blockId: targetId,
        key,
        anchor: anchor ? caretAnchor(anchor, anchor.selectionStart) : null,
        selection: anchor
          ? { start: anchor.selectionStart, end: anchor.selectionEnd }
          : undefined,
      });
    });
  }, [commands, dispatchPending, focusedId, message, notify, selected]);

  // Which thread segments to light: the indices of the focused block's ancestors,
  // outermost first. Each rendered row derives its own count from this, so nothing
  // walks the whole list. See designs/outliner.md § Structural Thread.
  const ancestors = ancestorPath(rows, focusedId);

  /** The bare keys a selection answers to. They only reach here while the tree
   * itself holds focus, which is exactly when no text field can lose them. */
  const onSelectionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (selected.size === 0 || event.nativeEvent.isComposing) return;
    if (keymap === "vim" && visualLine) {
      const interpretation = vim.interpret(
        {
          value: "",
          selectionStart: 0,
          selectionEnd: 0,
          editable: !readonly,
          supportsVisualLine: BLOCK_SURFACE_POLICY.outline.visualLine,
        },
        vimKeyFromEvent(event),
      );
      if (interpretation.handled) {
        event.preventDefault();
        for (const effect of interpretation.effects) {
          if (effect.kind === "surface" && effect.command.type === "visual-line") {
            editor.runVimVisualLine(effect.command);
          }
        }
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // Put the caret back where the selection started rather than leaving focus
      // on a container with nothing selected — Escape means "back to writing".
      const roots = selectionRoots(rows, selected);
      clearSelection();
      if (roots[0]) activateBlock(roots[0].block.id, undefined, "keyboard");
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if (!readonly) editor.menu.removeSelection("keyboard");
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (readonly) return;
      if (event.shiftKey) editor.menu.outdentSelection("keyboard");
      else editor.menu.indentSelection("keyboard");
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      // Stepping out of a selection lands the caret at the edge it left from.
      event.preventDefault();
      const roots = selectionRoots(rows, selected);
      const edge = event.key === "ArrowUp" ? roots[0] : roots[roots.length - 1];
      if (edge) activateBlock(edge.block.id, undefined, "keyboard");
    }
  };

  const propertyBlock = propertyRequest
    ? findBlock(outline, propertyRequest.blockId)
    : undefined;
  const tagBlock = tagRequest ? findBlock(outline, tagRequest.blockId) : undefined;

  const closePropertyPicker = () => {
    const originalAnchor = propertyRequest?.anchor;
    const blockId = propertyRequest?.blockId;
    const selection = propertyRequest?.selection;
    setPropertyRequest(null);
    requestAnimationFrame(() => {
      // A picker opened from a slash command owns a captured box because the
      // command may replace its textarea. Restore focus to the live canonical
      // editor, never to that geometry value or a detached former editor.
      const anchor = originalAnchor?.owner?.isConnected
        ? originalAnchor.owner
        : blockId
          ? document.querySelector<HTMLTextAreaElement>(
            `[data-block-id="${cssEscape(blockId)}"] textarea`,
          )
          : null;
      if (anchor instanceof HTMLTextAreaElement) {
        keepingPageStill(anchor, () => {
          anchor.focus({ preventScroll: true });
          if (selection) anchor.setSelectionRange(selection.start, selection.end);
        });
      } else {
        anchor?.focus({ preventScroll: true });
      }
    });
  };

  const closeTagPicker = () => {
    const anchor = tagRequest?.anchor?.owner;
    setTagRequest(null);
    requestAnimationFrame(() => {
      if (anchor?.isConnected) anchor.focus({ preventScroll: true });
    });
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
      {keymap === "vim" && (focusedId || visualLine) && (
        <span
          className="vim-mode-indicator"
          data-mode={vim.state.mode}
          data-testid="vim-mode-indicator"
          role="status"
        >
          {message(VIM_MODE_MESSAGE[vim.state.mode])}
        </span>
      )}
      {rows.length === 0 ? (
        // A fake first line rather than a button labelled with a mouse
        // instruction: a faint bullet in row 1's exact gutter position over a
        // target big enough to hit anywhere. No placeholder sentence — the
        // document belongs to the user, including when it is empty.
        <button
          className="outline-placeholder"
          onClick={() => {
            if (editor.pressStartedOverOverlay()) {
              editor.dismissTransient();
              return;
            }
            editor.insertRootBlock(0, "pointer");
          }}
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
          aria-activedescendant={
            focusedId
              ? `row-${focusedId}`
              : visualLine
                ? `row-${visualLine.headId}`
                : undefined
          }
          style={{ height: virtualizer.getTotalSize() }}
          ref={viewportRef}
          tabIndex={-1}
          onKeyDown={onSelectionKeyDown}
          onCopy={onCopySelection}
          onPointerDownCapture={(event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const rowElement = target.closest<HTMLElement>("[data-block-id]");
            const row = rowsRef.current.find(
              (candidate) => candidate.block.id === rowElement?.dataset.blockId,
            );
            if (row) onSurfacePointerDown(row, event);
          }}
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
                  // `item.start` is page-relative; the row is placed inside
                  // the outline, so the header's height comes back off.
                  transform: `translateY(${item.start - scrollMargin}px)`,
                }}
              >
                <BlockRow
                  row={row}
                  rows={rows}
                  editor={editor}
                  lit={litFor(ancestors, item.index, row.depth)}
                  ancestor={ancestors.indices.includes(item.index)}
                  bindings={bindings}
                />
              </div>
            );
          })}
          {drop && (
            <div
              className="outline-drop"
              data-testid="outline-drop"
              data-after-id={drop.afterId ?? ""}
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
          onClick={() => {
            // The empty space under the writing is the one target in the product
            // that is both "make a block" and "the nearest place with nothing on
            // it", and the second reading has to win: dismissing a menu by
            // clicking past it must not also append a row nobody asked for.
            if (editor.pressStartedOverOverlay() || selectionCount > 0) {
              // With rows selected, the first click on empty space is the way
              // out of the selection — never also a new block.
              editor.dismissTransient();
              return;
            }
            editor.insertRootBlock(outline.blocks.length, "pointer");
          }}
          aria-label={message("outline.addBlock")}
          data-testid="outline-append"
        />
      )}
      {propertyRequest && propertyBlock && (
        <PropertyPicker
          key={`${propertyRequest.blockId}:${propertyRequest.key ?? "new"}`}
          target={{
            kind: "block",
            id: propertyBlock.id,
            owner,
            bag: propertyBlock.properties,
          }}
          anchor={propertyRequest.anchor}
          initialKey={propertyRequest.key}
          commandPrefix={propertyRequest.commandPrefix}
          onClose={closePropertyPicker}
        />
      )}
      {tagRequest && tagBlock && (
        <TagPicker
          owner={owner}
          block={tagBlock}
          anchor={tagRequest.anchor}
          onClose={closeTagPicker}
        />
      )}
      {slashRequest && (
        <BlockSlashMenu
          request={slashRequest}
          results={slashResults}
          active={slashIndex}
          onHover={setSlashActiveState}
          onClose={() => setSlashRequest(null)}
          onChoose={(item) => {
            const row = rowsRef.current.find((entry) => entry.block.id === slashRequest.blockId);
            if (row) editor.acceptSlash(row, item);
          }}
        />
      )}
      {hashRequest && (
        <BlockTagMenu
          request={hashRequest}
          results={hashResults}
          active={hashIndex}
          onHover={setHashActiveState}
          onClose={() => setHashRequest(null)}
          onChoose={(option) => {
            const row = rowsRef.current.find((entry) => entry.block.id === hashRequest.blockId);
            if (row) editor.acceptHash(row, option);
          }}
        />
      )}
      {pageRequest && (
        <BlockPageMenu
          request={pageRequest}
          results={pageResults}
          active={pageIndex}
          onHover={setPageActiveState}
          onClose={() => setPageRequest(null)}
          onChoose={(option) => {
            const row = rowsRef.current.find((entry) => entry.block.id === pageRequest.blockId);
            if (row) editor.acceptPage(row, option);
          }}
        />
      )}
    </section>
  );
}

/** No block resolved yet — the open/closed decision doesn't depend on presence. */
const NO_TAGS: ReadonlySet<string> = new Set();

function samePageReferences(
  left: readonly PageReferenceSpan[],
  right: readonly PageReferenceSpan[],
): boolean {
  return left.length === right.length && left.every((reference, index) => {
    const other = right[index];
    return other !== undefined
      && reference.start === other.start
      && reference.end === other.end
      && reference.index === other.index
      && reference.page_id === other.page_id;
  });
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
function selectableIds(rows: readonly OutlineRow[], from: number, to: number): Set<string> {
  const ids = coveredIds(rows, idsInRange(rows, from, to));
  for (const id of [...ids]) {
    if (isPendingId(id)) ids.delete(id);
  }
  return ids;
}

/**
 * Moves between visually distinct structural selections. Descendants already
 * covered by a selected ancestor are passengers, not extra Vim line units.
 */
function stepVisualLineIndex(
  rows: readonly OutlineRow[],
  anchor: number,
  from: number,
  direction: -1 | 1,
  count: number,
): number {
  let index = from;
  let remaining = Math.max(0, count);
  while (remaining > 0) {
    const candidate = nextVisualLineIndex(rows, anchor, index, direction);
    if (candidate === index) break;
    index = candidate;
    remaining -= 1;
  }
  return index;
}

function nextVisualLineIndex(
  rows: readonly OutlineRow[],
  anchor: number,
  from: number,
  direction: -1 | 1,
): number {
  const movingTowardAnchor = direction === 1 ? from < anchor : from > anchor;

  if (direction === 1 && !movingTowardAnchor) {
    const mask = coveredMask(rows, selectableIds(rows, anchor, from));
    let candidate = from + 1;
    while (
      candidate < rows.length
      && (mask[candidate] || isPendingId(rows[candidate].block.id))
    ) {
      candidate += 1;
    }
    return candidate < rows.length ? candidate : from;
  }

  if (direction === -1 && movingTowardAnchor) {
    const roots = selectionRoots(rows, selectableIds(rows, anchor, from));
    for (let cursor = roots.length - 1; cursor >= 0; cursor -= 1) {
      const candidate = rows.findIndex((row) => row.block.id === roots[cursor].block.id);
      if (candidate < from) return candidate;
    }
    return from;
  }

  let candidate = from + direction;
  while (candidate >= 0 && candidate < rows.length && isPendingId(rows[candidate].block.id)) {
    candidate += direction;
  }
  return candidate >= 0 && candidate < rows.length ? candidate : from;
}

function edgeVisualLineIndex(
  rows: readonly OutlineRow[],
  anchor: number,
  edge: "first" | "last",
): number {
  const direction = edge === "first" ? 1 : -1;
  let boundary = edge === "first" ? 0 : rows.length - 1;
  while (boundary >= 0 && boundary < rows.length && isPendingId(rows[boundary].block.id)) {
    boundary += direction;
  }
  boundary = Math.max(0, Math.min(rows.length - 1, boundary));
  const roots = selectionRoots(rows, selectableIds(rows, anchor, boundary));
  const target = edge === "first" ? roots[0] : roots[roots.length - 1];
  return target
    ? rows.findIndex((row) => row.block.id === target.block.id)
    : anchor;
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

/**
 * Runs a caret operation without letting the page follow the caret.
 *
 * `setSelectionRange` reveals the new caret, and "reveal" walks the whole scroll
 * chain: on a block long enough to outgrow the window — a pasted document, a
 * query result, a day's worth of notes in one bullet — restoring the selection
 * after an authoritative refresh scrolled the outline several hundred pixels,
 * seconds after the reader had pressed a line and started reading somewhere
 * else. The intent of the refresh is to keep the caret where it was, and the
 * page is part of where it was.
 *
 * Every ancestor scroller is captured, not just the page's, because the same
 * call also moves a dialog body or a query panel the editor happens to be in.
 */
function keepingPageStill(node: HTMLElement, run: () => void): void {
  const saved: { element: Element; top: number; left: number }[] = [];
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) {
      saved.push({ element: parent, top: parent.scrollTop, left: parent.scrollLeft });
    }
  }
  const pageX = window.scrollX;
  const pageY = window.scrollY;
  run();
  for (const entry of saved) {
    if (entry.element.scrollTop !== entry.top) entry.element.scrollTop = entry.top;
    if (entry.element.scrollLeft !== entry.left) entry.element.scrollLeft = entry.left;
  }
  if (window.scrollX !== pageX || window.scrollY !== pageY) window.scrollTo(pageX, pageY);
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
  if (editor.slashRequest?.blockId === row.block.id) {
    if (event.key === "Escape") {
      event.preventDefault();
      editor.closeSlash();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      editor.acceptSlash(row);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      editor.setSlashActive(Math.min(editor.slashActive + 1, editor.slashResults.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      editor.setSlashActive(Math.max(editor.slashActive - 1, 0));
      return;
    }
    if (event.key === "Tab") {
      // ⇥ means "take the highlighted command", as it does in the palette; it
      // must not also restructure the outline underneath the open menu.
      event.preventDefault();
      editor.acceptSlash(row);
      return;
    }
  }
  if (editor.hashRequest?.blockId === row.block.id) {
    if (event.key === "Escape") {
      event.preventDefault();
      editor.closeHash();
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      editor.acceptHash(row);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      editor.setHashActive(Math.min(editor.hashActive + 1, editor.hashResults.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      editor.setHashActive(Math.max(editor.hashActive - 1, 0));
      return;
    }
  }
  if (editor.pageRequest?.blockId === row.block.id) {
    if (event.key === "Escape") {
      event.preventDefault();
      editor.closePage();
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      editor.acceptPage(row);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      editor.setPageActive(Math.min(editor.pageActive + 1, editor.pageResults.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      editor.setPageActive(Math.max(editor.pageActive - 1, 0));
      return;
    }
  }
  if (editor.keymap === "vim" && handleOutlineVim(editor, row, rows, event)) return;
  // Pending rows accept text and the core outline idioms (Enter, Tab)
  // until the insert is acknowledged; other structural keys are ignored.
  if (isPendingId(row.block.id)) {
    if (event.key === "Tab") {
      event.preventDefault();
      editor.queuePendingStructural(row.block.id, event.shiftKey ? "outdent" : "indent");
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!editor.readonly) handleEnter(editor, row, event.currentTarget);
    } else if (
      event.key === "Backspace"
      && event.currentTarget.selectionStart === 0
      && event.currentTarget.selectionEnd === 0
    ) {
      event.preventDefault();
      if (!editor.readonly && row.index > 0) {
        editor.mergeBackward(row, rows, event.currentTarget, "keyboard");
      }
    } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      // Moves need a real id; swallow only the structural cases.
      event.preventDefault();
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
    editor.runHistory(id, isRedo);
    return;
  }

  // ⌘A/^A widens with each press: first the text, then the block. In an empty
  // block there is no text to take, so the first press already selects the block.
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "a"
  ) {
    const value = editor.draftOf(row);
    const wholeTextSelected =
      textarea.selectionStart === 0 && textarea.selectionEnd === value.length;
    if (value.length === 0 || wholeTextSelected) {
      event.preventDefault();
      editor.selectOnly(row);
    }
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
    if (
      textarea.selectionStart === 0 &&
      textarea.selectionEnd === 0
    ) {
      event.preventDefault();
      if (editor.readonly) return;
      if (row.index > 0) {
        editor.mergeBackward(row, rows, textarea, "keyboard");
      } else if (row.depth > 0) {
        editor.menu.outdent(row);
      }
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
          editor.activateBlock(rows[index].block.id, undefined, "keyboard");
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
        editor.activateBlock(child.block.id, 0, "keyboard");
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
      editor.activateBlock(rows[position - 1].block.id, undefined, "keyboard");
    } else if (event.key === "ArrowDown" && atLastLine && position < rows.length - 1) {
      event.preventDefault();
      editor.flushNow(id);
      editor.activateBlock(rows[position + 1].block.id, 0, "keyboard");
    }
  }
}

function handleOutlineVim(
  editor: EditorContext,
  row: OutlineRow,
  rows: OutlineRow[],
  event: KeyboardEvent<HTMLTextAreaElement>,
): boolean {
  const textarea = event.currentTarget;
  const interpretation = editor.vim.interpret(
    {
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      editable: !editor.readonly,
      supportsVisualLine:
        BLOCK_SURFACE_POLICY.outline.visualLine
        && !editor.readonly
        && !isPendingId(row.block.id),
      supportsCrossBlockWords:
        BLOCK_SURFACE_POLICY.outline.crossBlockWords
        && !isPendingId(row.block.id),
    },
    vimKeyFromEvent(event),
  );
  if (!interpretation.handled) return false;
  event.preventDefault();

  for (const effect of interpretation.effects) {
    if (effect.kind === "surface") {
      runOutlineVimSurface(editor, row, rows, textarea, effect.command);
      continue;
    }
    applyVimTextEffect(textarea, effect, (value, element, edit) => {
      editor.onInput(row, value, element, edit);
      // Normal-mode edits are complete commands, never completion prefixes.
      editor.closeSlash();
      editor.closeHash();
      editor.closePage();
    });
    editor.publishSelection(row.block.id, textarea);
  }
  return true;
}

function runOutlineVimSurface(
  editor: EditorContext,
  row: OutlineRow,
  rows: OutlineRow[],
  textarea: HTMLTextAreaElement,
  command: VimSurfaceCommand,
): void {
  if (command.type === "visual-line") {
    editor.runVimVisualLine(command, row, rows);
    return;
  }
  if (command.type === "history") {
    editor.runHistory(row.block.id, command.redo);
    return;
  }
  if (command.type === "word-motion") {
    editor.runVimWordMotion(command, row, rows, textarea);
    return;
  }
  if (command.type === "focus") {
    const current = rowIndexOf(rows, row.block.id);
    const target = rows[Math.max(0, Math.min(rows.length - 1, current + command.direction * command.count))];
    if (!target || target.block.id === row.block.id) return;
    editor.flushNow(row.block.id);
    const value = editor.draftOf(target);
    editor.activateBlock(
      target.block.id,
      caretForVerticalEntry(value, command.direction, command.column),
      "keyboard",
    );
    return;
  }
  if (command.type === "focus-edge") {
    const target = command.edge === "first" ? rows[0] : rows[rows.length - 1];
    if (!target) return;
    editor.flushNow(row.block.id);
    const value = editor.draftOf(target);
    editor.activateBlock(
      target.block.id,
      command.edge === "first" ? 0 : caretForVerticalEntry(value, -1, value.length),
      "keyboard",
    );
    return;
  }
  if (editor.readonly || isPendingId(row.block.id)) return;
  if (command.type === "open") {
    editor.flushNow(row.block.id);
    if (command.side === "after") editor.enqueuePendingInsert(row, "", false, "keyboard");
    else {
      editor.enqueuePendingSplit(
        row,
        0,
        { markdown: "", pageReferences: [] },
        {
          markdown: editor.draftOf(row),
          pageReferences: editor.pageReferencesOf(row.block),
        },
        false,
        "keyboard",
      );
    }
    return;
  }
  if (command.type === "delete-unit") {
    editor.runVimStructure("delete", row, rows, command.count);
    return;
  }
  editor.runVimStructure(command.type, row, rows, command.count);
}

function handleEnter(editor: EditorContext, row: OutlineRow, textarea: HTMLTextAreaElement) {
  const id = row.block.id;
  const draft = editor.draftOf(row);
  if (draft.length === 0) {
    // An empty block has nothing to split. Enter here means "next line": the
    // new block goes below and takes the caret, exactly as it would have had
    // there been text. (A split at index 0 would instead insert *above* and
    // strand the caret on the wrong row.)
    editor.enqueuePendingInsert(row, "", row.hasChildren && !row.collapsed, "keyboard");
    return;
  }
  const caretUtf16 = textarea.selectionStart;
  const boundary = canonicalContentBoundary(
    draft,
    editor.pageReferencesOf(row.block),
    caretUtf16,
  );
  const split = splitInlineContentProjection(
    draft,
    editor.pageReferencesOf(row.block),
    boundary,
  );
  if (isPendingId(id)) {
    // The pending block's head moves locally; once its real id arrives the
    // queued split follows the baseline reconciliation in session order.
    editor.onInput(row, split.head.markdown, textarea);
  } else {
    editor.flushNow(id);
  }
  editor.enqueuePendingSplit(
    row,
    boundary.index,
    split.head,
    split.tail,
    row.hasChildren && !row.collapsed,
    "keyboard",
  );
}

interface PendingOutlineProjection {
  rows: OutlineRow[];
  content: ReadonlyMap<string, InlineContentProjection>;
}

/**
 * Applies every visible effect of a pending operation as one pure projection.
 * A split owns both the source head and its created tail, so no render can show
 * the same content in both blocks while the canonical command is in flight.
 */
function projectPendingOperations(
  rows: OutlineRow[],
  pending: readonly PendingOutlineOperation[],
  drafts: ReadonlyMap<string, string>,
  pageReferences: ReadonlyMap<string, readonly PageReferenceSpan[]>,
): PendingOutlineProjection {
  let result = rows;
  const content = new Map<string, InlineContentProjection>();
  for (const entry of pending) {
    if (entry.kind === "merge") {
      const sourceIndex = result.findIndex((row) => row.block.id === entry.sourceId);
      const targetIndex = result.findIndex((row) => row.block.id === entry.targetId);
      if (sourceIndex < 0 || targetIndex < 0) continue;
      const source = result[sourceIndex];
      const target = result[targetIndex];
      const targetChildCount = result.filter(
        (row) => row.parentId === entry.targetId,
      ).length;
      const sourceChildCount = result.filter(
        (row) => row.parentId === entry.sourceId,
      ).length;
      const mergedChildCount = targetChildCount + sourceChildCount;
      content.set(entry.targetId, {
        markdown: drafts.get(entry.targetId) ?? entry.merged.markdown,
        pageReferences: pageReferences.get(entry.targetId) ?? entry.merged.pageReferences,
      });
      let sourceSubtreeEnd = sourceIndex + 1;
      while (
        sourceSubtreeEnd < result.length
        && result[sourceSubtreeEnd].depth > source.depth
      ) sourceSubtreeEnd += 1;
      const hidden = target.collapsed
        ? new Set(result.slice(sourceIndex, sourceSubtreeEnd).map((row) => row.block.id))
        : new Set([entry.sourceId]);
      result = result
        .filter((row) => !hidden.has(row.block.id))
        .map((row) => {
          if (row.block.id === entry.targetId) {
            return { ...row, hasChildren: row.hasChildren || source.hasChildren };
          }
          if (row.parentId === entry.targetId) {
            return { ...row, siblingCount: mergedChildCount };
          }
          if (row.parentId === entry.sourceId) {
            return {
              ...row,
              parentId: entry.targetId,
              index: targetChildCount + row.index,
              siblingCount: mergedChildCount,
            };
          }
          return row;
        });
      continue;
    }
    const sourceIndex = result.findIndex((row) => row.block.id === entry.anchorId);
    if (sourceIndex < 0) continue;
    const source = result[sourceIndex];
    if (entry.kind === "split") content.set(entry.anchorId, entry.source);
    let insertAt = entry.mode === "before" ? sourceIndex : sourceIndex + 1;
    if (entry.mode === "sibling") {
      while (insertAt < result.length && result[insertAt].depth > source.depth) insertAt += 1;
    }
    const pendingRow: OutlineRow = {
      block: {
        id: entry.tempId,
        markdown: entry.created.markdown,
        page_references: [...entry.created.pageReferences],
        properties: [],
        tags: [],
        children: [],
      },
      depth: entry.mode === "child" ? source.depth + 1 : source.depth,
      parentId: entry.mode === "child" ? source.block.id : source.parentId,
      index: entry.mode === "child" ? 0 : source.index + (entry.mode === "before" ? 0 : 1),
      siblingCount: entry.mode === "child" ? 1 : source.siblingCount + 1,
      hasChildren: false,
      collapsed: false,
    };
    content.set(entry.tempId, {
      markdown: drafts.get(entry.tempId) ?? entry.created.markdown,
      pageReferences: pageReferences.get(entry.tempId) ?? entry.created.pageReferences,
    });
    result = [...result.slice(0, insertAt), pendingRow, ...result.slice(insertAt)];
  }
  return { rows: result, content };
}

function BlockRow({
  row,
  rows,
  editor,
  lit,
  ancestor,
  bindings,
}: {
  row: OutlineRow;
  rows: OutlineRow[];
  editor: EditorContext;
  lit: number;
  /** On the path from the root to the caret: its own branch is drawn and lit. */
  ancestor: boolean;
  bindings: ReturnType<typeof useShortcutBindings>;
}) {
  const { message } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isFocused = editor.focusedId === row.block.id;
  const pending = isPendingId(row.block.id);
  const value = editor.draftOf(row);
  const pageReferences = editor.pageReferencesOf(row.block);
  const taskStatus = stringValue(row.block.properties, TASK_STATUS_KEY);
  const taskPriority = stringValue(row.block.properties, TASK_PRIORITY_KEY);
  const tags = row.block.tags;
  const selected = editor.covered.has(row.block.id);
  const selectionCount = editor.selectionCount;
  const menuOpen = editor.menuFor === row.block.id;
  const peers = editor.presence.filter((peer) => peer.block_id === row.block.id);
  const projected = useRef(value);
  const revision = useRef(editor.revision);
  const previewMarkdown = !isFocused
    && !pending
    && hasMarkdownSyntax(value, pageReferences.length > 0);
  // A pending row has no id a property command can name yet, so it carries no
  // task marks either.
  const marks = pending
    ? 0
    : Number(taskStatus !== undefined) + Number(taskPriority !== undefined);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0";
    textarea.style.height = `${Math.max(textarea.scrollHeight, 28)}px`;
    // `tags.length` matters because the tag cluster shares the line: chips
    // arriving or leaving change the textarea's width, and width changes what
    // wraps. `previewMarkdown` matters because a hidden textarea measures zero:
    // without it the editor would open clipped to one line.
  }, [value, tags.length, previewMarkdown]);

  useLayoutEffect(() => {
    if (!isFocused) return;
    const textarea = textareaRef.current;
    if (!textarea || document.activeElement === textarea) return;
    // `preventScroll`, like every other focus call in this file. A block carrying
    // a long body or a query result is routinely taller than the window, and the
    // browser's own "reveal the focused element" — followed here by a
    // setSelectionRange that reveals the caret as well — will happily scroll a
    // row that is already on screen until one of its edges is aligned. That is
    // the page moving out from under the caret the reader just placed, which is
    // exactly what designs/outliner.md § Virtualization and Stability forbids;
    // whether it fired at all depended on the row's height against the
    // viewport's, so it was a bug that came and went with the type metrics.
    textarea.focus({ preventScroll: true });
    const caret = editor.pendingCaret.current;
    if (caret !== null) {
      const offset = Math.min(caret, textarea.value.length);
      textarea.setSelectionRange(offset, offset);
      editor.pendingCaret.current = null;
    } else {
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }, [isFocused, editor.pendingCaret]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const previous = projected.current;
    projected.current = value;
    if (!textarea || !isFocused || revision.current === editor.revision) return;
    revision.current = editor.revision;
    const transformed = transformSelection(previous, value, {
      anchor: textarea.selectionStart,
      head: textarea.selectionEnd,
    });
    if (
      transformed.anchor === textarea.selectionStart &&
      transformed.head === textarea.selectionEnd
    ) {
      // Nothing moved. Returning here is not just an optimisation: the call
      // below has a side effect, and making it unconditionally meant every
      // authoritative refresh of an untouched selection paid for it.
      return;
    }
    keepingPageStill(textarea, () => {
      textarea.setSelectionRange(transformed.anchor, transformed.head);
    });
  }, [editor.revision, isFocused, value]);

  return (
    <BlockRowFrame
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
      data-revealed={editor.revealed.has(row.block.id) || undefined}
      data-has-children={row.hasChildren}
      data-ancestor={ancestor || undefined}
      data-block-id={row.block.id}
      data-testid="outline-row"
      // Depth drives the indent AND the thread gradient; `lit` drives how much
      // of it is on the active path. Custom properties rather than a paddingLeft
      // shorthand, which silently overrode the row's own padding.
      style={{ "--depth": row.depth, "--lit": lit } as CSSProperties}
      gutterClassName="outline-gutter"
      prefix={(
        /* Everything left of the bullet. Dragging here selects rows; right-click
           opens the same menu the bullet does. */
        <span
          className="outline-grip"
          data-testid="row-grip"
          aria-hidden
          onPointerDown={(event) => editor.onGripPointerDown(row, event)}
          onContextMenu={(event) => editor.onRowContextMenu(row, event)}
        />
      )}
      gutter={(
        <>
        <button
          className="outline-toggle"
          aria-label={
            row.collapsed ? message("outline.expand") : message("outline.collapse")
          }
          tabIndex={-1}
          onClick={() => editor.toggleCollapse(row.block.id)}
        >
          {/* One glyph, rotated by the row's `data-collapsed` state rather than
              two glyphs swapped on it. A swap changes the mark with no indication
              of which way it went; a turn IS the direction, which is the whole
              content of this control. app.css § .outline-toggle svg. */}
          <ChevronDownIcon />
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
                if (selected && selectionCount > 1) {
                  editor.takeTreeFocus();
                  return;
                }
                // …and not if the verb that closed the menu has already moved the
                // caret somewhere else. `Add child block` mounts a focused pending
                // row synchronously and `Delete` hands the caret to a neighbour;
                // restoring it here afterwards races them and wins, which sent the
                // next thing typed into the row the menu was opened on rather than
                // into the block the user just asked for.
                if (editor.focusedId === null || editor.focusedId === row.block.id) {
                  textareaRef.current?.focus({ preventScroll: true });
                }
              }}
            >
              {selected && selectionCount > 1 ? (
                <>
                  <DropdownMenuItem
                    data-testid="menu-copy-selection"
                    onSelect={() => editor.menu.copySelection("context_menu")}
                  >
                    <CopyIcon aria-hidden />
                    {message("outline.copySelection", { count: selectionCount })}
                    <DropdownMenuShortcut>
                      <Kbd parts={["⌘", "C"]} plain />
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={editor.readonly}
                    onSelect={() => editor.menu.indentSelection("context_menu")}
                  >
                    <IndentIncreaseIcon aria-hidden />
                    {message("outline.indent")}
                    <DropdownMenuShortcut>
                      <Kbd parts={["⇥"]} plain />
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={editor.readonly}
                    onSelect={() => editor.menu.outdentSelection("context_menu")}
                  >
                    <IndentDecreaseIcon aria-hidden />
                    {message("outline.outdent")}
                    <DropdownMenuShortcut>
                      <Kbd parts={["⇧", "⇥"]} plain />
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="menu-delete-selection"
                    variant="destructive"
                    disabled={editor.readonly}
                    onSelect={() => editor.menu.removeSelection("context_menu")}
                  >
                    <Trash2Icon aria-hidden />
                    {message("outline.deleteSelection", { count: selectionCount })}
                    <DropdownMenuShortcut>
                      <Kbd parts={["⌫"]} plain />
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem
                    data-testid="menu-properties"
                    onSelect={() => {
                      const anchor = editor.menuAnchor ?? textareaRef.current;
                      requestAnimationFrame(() => editor.openProperties(row.block.id, undefined, anchor));
                    }}
                  >
                    <Settings2Icon aria-hidden />
                    {message("properties.addOrChange")}
                    <DropdownMenuShortcut>
                      <Shortcut binding={bindings.properties} plain />
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="menu-tags"
                    onSelect={() => {
                      const anchor = editor.menuAnchor ?? textareaRef.current;
                      requestAnimationFrame(() => editor.openTags(row.block.id, anchor));
                    }}
                  >
                    <HashIcon aria-hidden />
                    {message("outline.tags")}
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
                    <DropdownMenuShortcut>
                      <Kbd parts={["⇥"]} plain />
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={editor.readonly || row.depth === 0}
                    onSelect={() => editor.menu.outdent(row)}
                  >
                    <IndentDecreaseIcon aria-hidden />
                    {message("outline.outdent")}
                    <DropdownMenuShortcut>
                      <Kbd parts={["⇧", "⇥"]} plain />
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="menu-move-up"
                    disabled={editor.readonly || row.index === 0}
                    onSelect={() => editor.menu.move(row, -1)}
                  >
                    <ArrowUpIcon aria-hidden />
                    {message("outline.moveUp")}
                    <DropdownMenuShortcut>
                      <Kbd parts={["⌥", "↑"]} plain />
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="menu-move-down"
                    disabled={editor.readonly || row.index >= row.siblingCount - 1}
                    onSelect={() => editor.menu.move(row, 1)}
                  >
                    <ArrowDownIcon aria-hidden />
                    {message("outline.moveDown")}
                    <DropdownMenuShortcut>
                      <Kbd parts={["⌥", "↓"]} plain />
                    </DropdownMenuShortcut>
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
                    <DropdownMenuShortcut>
                      <Kbd parts={["⌫"]} plain />
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          )}
        </DropdownMenu>
        </>
      )}
    >
      <BlockBody
        className="outline-text"
        taskStatus={taskStatus}
        // How many marks stand before the writing. It drives the text's hanging
        // indent, so a wrapped line still aligns with the first one and adding a
        // priority never leaves the glyph sitting on top of the sentence.
        markCount={marks}
      >
        {marks > 0 && (
          <span className="task-marks">
            {taskStatus !== undefined && (
              <TaskStatusControl owner={editor.owner} block={row.block} status={taskStatus} />
            )}
            {taskPriority !== undefined && (
              <TaskPriorityControl
                owner={editor.owner}
                block={row.block}
                priority={taskPriority}
              />
            )}
          </span>
        )}
        <BlockTextArea
          ref={textareaRef}
          className="block-line outline-input"
          rows={1}
          value={value}
          autoClosers={editor.autoClosersOf(row.block.id)}
          data-block-editor
          hidden={previewMarkdown}
          // The browser's spell checker has no idea what a graph is. It underlines
          // page names, tags, property keys and code as mistakes, which in a
          // document made of short lines means a page of red — and it cannot be
          // right about text this product has no language for. The implementation
          // boundary in DESIGN.md cuts the other way here: this is native where
          // native is wrong.
          spellCheck={false}
          tabIndex={previewMarkdown ? -1 : undefined}
          readOnly={editor.readonly}
          acceptsTextInput={
            editor.keymap !== "vim" || editor.vim.state.mode === "insert"
          }
          aria-readonly={editor.readonly ? true : undefined}
          data-vim-mode={editor.keymap === "vim" ? editor.vim.state.mode : undefined}
          aria-label={message("outline.blockText")}
          aria-controls={
            editor.slashRequest?.blockId === row.block.id
              ? "slash-command-menu"
              : editor.hashRequest?.blockId === row.block.id
                ? "tag-suggest-menu"
                : editor.pageRequest?.blockId === row.block.id
                  ? "page-reference-menu"
                  : undefined
          }
          aria-activedescendant={
            editor.slashRequest?.blockId === row.block.id && editor.slashResults[editor.slashActive]
              ? `slash-opt-${editor.slashResults[editor.slashActive].id}`
              : editor.hashRequest?.blockId === row.block.id && editor.hashResults[editor.hashActive]
                ? `tag-opt-${editor.hashActive}`
                : editor.pageRequest?.blockId === row.block.id && editor.pageResults[editor.pageActive]
                  ? `page-reference-opt-${editor.pageActive}`
                  : undefined
          }
          dir="auto"
          // A press marks itself before the browser focuses what it landed on,
          // so the entrance below is read rather than guessed. Both readers of
          // the mark clear it: the gesture it belongs to is over by then, and a
          // mark left standing would tell the next keyboard arrival it was a
          // press.
          onPointerDown={editor.activationEntrance.beginPointer}
          onPointerUp={editor.activationEntrance.completePointer}
          onPointerCancel={editor.activationEntrance.completePointer}
          onFocus={() => {
            const method = editor.activationEntrance.focusMethod();
            if (!isFocused) {
              editor.activateBlock(row.block.id, -1, method);
            }
            if (textareaRef.current) editor.publishSelection(row.block.id, textareaRef.current);
          }}
          onClick={() => {
            editor.activationEntrance.completePointer();
            editor.activateBlock(row.block.id, undefined, "pointer");
          }}
          onSelect={(event) => editor.publishSelection(row.block.id, event.currentTarget)}
          onBlur={() => {
            editor.flushNow(row.block.id);
            editor.releaseFocus(row.block.id);
          }}
          onValueChange={(next, textarea, edit) => editor.onInput(row, next, textarea, edit)}
          onPairSelection={(textarea) => editor.publishSelection(row.block.id, textarea)}
          onCompositionStart={() => editor.onCompositionStart(row)}
          onCompositionEnd={(event) => editor.onCompositionEnd(row, event.currentTarget)}
          onKeyDown={(event) => editor.onKeyDown(row, rows, event)}
          onPaste={(event) => {
            const fragment = readOutlineFragment(event.clipboardData);
            if (fragment && !editor.readonly && !pending) {
              event.preventDefault();
              editor.pasteFragment(row, fragment);
              return;
            }
            const items = parseMarkdownOutline(event.clipboardData.getData("text/plain"));
            if (!items || editor.readonly || pending) return;
            event.preventDefault();
            editor.pasteOutline(row, items);
          }}
        />
        {previewMarkdown && (
          <BlockMarkdown
            markdown={value}
            pageReferences={pageReferences}
            graphId={editor.graphId}
            className="block-line outline-markdown"
            // Read-only blocks hand over too: the textarea is the row's tab stop
            // and its arrow-key navigation, and `readOnly` is what refuses the
            // edit — not the absence of a way in.
            onActivate={(caret, _anchor, inputMethod) => {
              editor.activateBlock(row.block.id, caret, inputMethod);
            }}
          />
        )}
        {peers.length > 0 && (
          <span className="remote-presence">
            {peers.map((peer) => peer.principal).join(", ")}
          </span>
        )}
        {tags.length > 0 && (
          <div className="outline-tags">
            {/* A reference, not a delete button: the chip goes to the tag, which
                now has a place of its own. Writing tags stays on the bullet's
                menu, where a destructive verb belongs. */}
            <TagChips owner={editor.owner} block={row.block} variant="reference" />
          </div>
        )}
        {!pending && (
          <BlockChips
            block={row.block}
            onEdit={(key, anchor) => editor.openProperties(row.block.id, key, anchor)}
          />
        )}
        {!pending && queryDocument(row.block.properties) !== undefined && (
          <QueryBlock owner={editor.owner} block={row.block} />
        )}
      </BlockBody>
    </BlockRowFrame>
  );
}
