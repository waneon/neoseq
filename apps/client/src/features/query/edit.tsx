// Editing a query result without making the query engine a write path.
//
// A builder plan tells us which result columns are direct fields of the row's
// stable subject. This module turns only those columns into controls, hydrates
// the canonical block on demand, and sends the same semantic commands as the
// outline. RDF terms remain display data; they are never mutated in place.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUpRightIcon } from "lucide-react";
import type { QueryEntityRef, RdfTerm } from "../../generated/core-port";
import type { GraphSession, SessionState } from "../../core-port/session";
import type { BlockSnapshot } from "../../core-port/snapshot";
import { findBlock, findPage } from "../../core-port/snapshot";
import { canUserWrite, valueTypeOf } from "../../entities/properties";
import type { MessageFunction } from "../../i18n";
import { cn } from "../../lib/utils";
import type { Anchor } from "@/ui/anchored";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { TASK_PRIORITY_KEY, TASK_STATUS_KEY } from "../../entities/tasks";
import { PropertyPicker } from "../properties/PropertyPicker";
import { TagPicker } from "../properties/TagPicker";
import { PriorityGlyph, TaskStatusGlyph } from "../tasks/glyphs";
import { TaskStatusMenu } from "../tasks/StatusControl";
import { TaskPriorityMenu } from "../tasks/PriorityControl";
import { failureReason } from "../notify/errors";
import { diffSplice } from "../outline/text-diff";
import { BlockMarkdown } from "../markdown/BlockMarkdown";
import { hasMarkdownSyntax } from "../markdown/profile";
import { priorityLabel, statusLabel } from "../tasks/labels";
import {
  CellValue,
  type CellContext,
  type ResultColumn,
  type ResultViewRow,
} from "./cells";

const EDIT_DEBOUNCE_MS = 400;

type BlockRef = Extract<QueryEntityRef, { kind: "block" }>;

export type QueryEditBinding =
  | { kind: "markdown"; block: BlockRef }
  | { kind: "property"; block: BlockRef; key: string }
  | { kind: "tags"; block: BlockRef };

export type DirectBlockField =
  | { kind: "content" }
  | { kind: "property"; key: string }
  | { kind: "tags" };

interface EditOrigin {
  row: ResultViewRow;
}

type ActiveEdit =
  | {
      phase: "loading";
      binding: QueryEditBinding;
      origin: EditOrigin;
      anchor: Anchor;
    }
  | {
      phase: "error";
      binding: QueryEditBinding;
      origin: EditOrigin;
      anchor: Anchor;
      error: string;
    }
  | {
      phase: "markdown";
      binding: Extract<QueryEditBinding, { kind: "markdown" }>;
      origin: EditOrigin;
      anchor: Anchor;
      baseline: string;
      draft: string;
      composing: boolean;
      saving: boolean;
      closeAfterSave: boolean;
      error: string | null;
    }
  | {
      phase: "picker";
      binding: Extract<QueryEditBinding, { kind: "property" | "tags" }>;
      origin: EditOrigin;
      anchor: Anchor;
    };

export interface QueryResultEditor {
  active: ActiveEdit | null;
  activeBlock?: BlockSnapshot;
  message: MessageFunction;
  bindingFor(subject: QueryEntityRef | undefined, column: ResultColumn): QueryEditBinding | null;
  bindingForDirect(
    subject: QueryEntityRef | undefined,
    field: DirectBlockField,
  ): QueryEditBinding | null;
  isActive(binding: QueryEditBinding, row: ResultViewRow): boolean;
  begin(binding: QueryEditBinding, row: ResultViewRow, anchor: Anchor): void;
  setDraft(value: string): void;
  setComposing(composing: boolean): void;
  preserveDraftForViewChange(): void;
  consumeViewChangeIntent(): boolean;
  commit(close: boolean): Promise<void>;
  retry(): void;
  cancel(): void;
}

function bindingKey(binding: QueryEditBinding): string {
  const owner = `${binding.block.page_id}:${binding.block.id}`;
  return binding.kind === "property"
    ? `${owner}:property:${binding.key}`
    : `${owner}:${binding.kind}`;
}

function blockFrom(state: SessionState, block: BlockRef): BlockSnapshot | undefined {
  const page = findPage(state.snapshot, block.page_id);
  return page ? findBlock(page, block.id) : undefined;
}

/** A frozen box, for an anchor that will not outlive the edit it opens. */
function rectOf(element: HTMLElement): DOMRect {
  return element.getBoundingClientRect();
}

/**
 * One coordinator lives above both result renderers. A view switch therefore
 * replaces presentation without replacing the draft or its canonical target.
 */
export function useQueryResultEditor({
  session,
  state,
  enabled,
  message,
}: {
  session: GraphSession;
  state: SessionState;
  enabled: boolean;
  message: MessageFunction;
}): QueryResultEditor {
  const [active, setActiveState] = useState<ActiveEdit | null>(null);
  const activeRef = useRef<ActiveEdit | null>(null);
  const request = useRef(0);
  const preserveOnNextBlur = useRef(false);

  const setActive = useCallback(
    (next: ActiveEdit | null | ((current: ActiveEdit | null) => ActiveEdit | null)) => {
      setActiveState((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        activeRef.current = resolved;
        return resolved;
      });
    },
    [],
  );
  activeRef.current = active;

  const cancel = useCallback(() => {
    request.current += 1;
    preserveOnNextBlur.current = false;
    setActive(null);
  }, [setActive]);

  useEffect(() => {
    if (!enabled && activeRef.current) cancel();
  }, [cancel, enabled]);

  const bindingForDirect = useCallback(
    (subject: QueryEntityRef | undefined, field: DirectBlockField): QueryEditBinding | null => {
      if (!enabled || subject?.kind !== "block") return null;
      if (field.kind === "content") {
        return { kind: "markdown", block: subject };
      }
      if (field.kind === "property") {
        if (valueTypeOf(field.key) === "document") return null;
        if (!canUserWrite(field.key, "block")) return null;
        return { kind: "property", block: subject, key: field.key };
      }
      if (field.kind === "tags") {
        return { kind: "tags", block: subject };
      }
      return null;
    },
    [enabled],
  );

  const bindingFor = useCallback(
    (subject: QueryEntityRef | undefined, column: ResultColumn): QueryEditBinding | null => {
      if (!column.source) return null;
      if (column.aggregate && column.aggregate !== "list") return null;
      if (
        column.source.kind !== "content"
        && column.source.kind !== "property"
        && column.source.kind !== "tags"
      ) return null;
      return bindingForDirect(subject, column.source);
    },
    [bindingForDirect],
  );

  const begin = useCallback(
    (binding: QueryEditBinding, row: ResultViewRow, anchor: Anchor) => {
      if (!enabled) return;
      const sequence = ++request.current;
      const origin = { row };
      setActive({ phase: "loading", binding, origin, anchor });
      void (async () => {
        try {
          if (!session.getState().hydratedPages.has(binding.block.page_id)) {
            await session.hydratePage(binding.block.page_id);
          }
          if (sequence !== request.current) return;
          const block = blockFrom(session.getState(), binding.block);
          if (!block) throw new Error("query result block no longer exists");
          if (binding.kind === "markdown") {
            setActive({
              phase: "markdown",
              binding,
              origin,
              anchor,
              baseline: block.markdown,
              draft: block.markdown,
              composing: false,
              saving: false,
              closeAfterSave: false,
              error: null,
            });
          } else {
            setActive({ phase: "picker", binding, origin, anchor });
          }
        } catch (cause) {
          if (sequence !== request.current) return;
          setActive({
            phase: "error",
            binding,
            origin,
            anchor,
            error: failureReason(cause, message),
          });
        }
      })();
    },
    [enabled, message, session, setActive],
  );

  const commit = useCallback(
    async (close: boolean) => {
      const current = activeRef.current;
      if (!current || current.phase !== "markdown") return;
      if (current.composing) return;
      if (current.saving) {
        if (close) {
          setActive((latest) => latest?.phase === "markdown"
            ? { ...latest, closeAfterSave: true }
            : latest);
        }
        return;
      }
      const splice = diffSplice(current.baseline, current.draft);
      if (!splice) {
        if (close) cancel();
        return;
      }

      const expected = current.draft;
      const previousBaseline = current.baseline;
      const targetKey = bindingKey(current.binding);
      setActive((latest) => {
        if (!latest || latest.phase !== "markdown" || bindingKey(latest.binding) !== targetKey) {
          return latest;
        }
        return {
          ...latest,
          baseline: expected,
          saving: true,
          closeAfterSave: close || latest.closeAfterSave,
          error: null,
        };
      });

      try {
        await session.execute({
          type: "splice_markdown",
          page_id: current.binding.block.page_id,
          block_id: current.binding.block.id,
          ...splice,
        });
        const canonical = blockFrom(session.getState(), current.binding.block)?.markdown ?? expected;
        setActive((latest) => {
          if (!latest || latest.phase !== "markdown" || bindingKey(latest.binding) !== targetKey) {
            return latest;
          }
          if (latest.draft === expected) {
            if (latest.closeAfterSave) return null;
            return { ...latest, baseline: canonical, draft: canonical, saving: false };
          }
          return { ...latest, saving: false };
        });
      } catch (cause) {
        const canonical = blockFrom(session.getState(), current.binding.block)?.markdown
          ?? previousBaseline;
        setActive((latest) => {
          if (!latest || latest.phase !== "markdown" || bindingKey(latest.binding) !== targetKey) {
            return latest;
          }
          return {
            ...latest,
            baseline: canonical,
            saving: false,
            closeAfterSave: false,
            error: failureReason(cause, message),
          };
        });
      }
    },
    [cancel, message, session, setActive],
  );

  useEffect(() => {
    if (
      !active
      || active.phase !== "markdown"
      || active.composing
      || active.saving
      || active.error
      || active.draft === active.baseline
    ) return;
    const timer = window.setTimeout(() => void commit(false), EDIT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [active, commit]);

  // A remote change can refresh a hydrated block while this editor is clean.
  // Stand down to that authoritative value; a dirty local draft remains local
  // until its own semantic command reconciles it.
  useEffect(() => {
    setActive((current) => {
      if (!current || current.phase !== "markdown" || current.saving) return current;
      const canonical = blockFrom(state, current.binding.block)?.markdown;
      if (canonical === undefined || current.draft !== current.baseline || canonical === current.baseline) {
        return current;
      }
      return { ...current, baseline: canonical, draft: canonical };
    });
  }, [setActive, state]);

  const setDraft = useCallback((value: string) => {
    setActive((current) => current?.phase === "markdown"
      ? { ...current, draft: value, error: null }
      : current);
  }, [setActive]);

  const setComposing = useCallback((composing: boolean) => {
    setActive((current) => current?.phase === "markdown"
      ? { ...current, composing }
      : current);
  }, [setActive]);

  const preserveDraftForViewChange = useCallback(() => {
    preserveOnNextBlur.current = true;
    window.setTimeout(() => {
      preserveOnNextBlur.current = false;
    }, 0);
  }, []);

  const consumeViewChangeIntent = useCallback(() => {
    const preserve = preserveOnNextBlur.current;
    preserveOnNextBlur.current = false;
    return preserve;
  }, []);

  const retry = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    if (current.phase === "error") {
      begin(current.binding, current.origin.row, current.anchor);
      return;
    }
    if (current.phase === "markdown") {
      void commit(false);
    }
  }, [begin, commit]);

  const isActive = useCallback(
    (binding: QueryEditBinding, row: ResultViewRow) => {
      const current = activeRef.current;
      return Boolean(
        current
        && bindingKey(current.binding) === bindingKey(binding)
        && current.origin.row.key === row.key,
      );
    },
    [],
  );

  const activeBlock = useMemo(
    () => active ? blockFrom(state, active.binding.block) : undefined,
    [active, state],
  );

  return {
    active,
    activeBlock,
    message,
    bindingFor,
    bindingForDirect,
    isActive,
    begin,
    setDraft,
    setComposing,
    preserveDraftForViewChange,
    consumeViewChangeIntent,
    commit,
    retry,
    cancel,
  };
}

export function QueryEditPortals({ editor }: { editor: QueryResultEditor }) {
  const active = editor.active;
  const block = editor.activeBlock;
  if (!active || active.phase !== "picker" || !block) return null;
  // A task choice draws its own menu in the cell it belongs to; the generic
  // picker must not open on top of it (see `TaskChoiceCell`).
  if (active.binding.kind === "property" && isTaskChoiceKey(active.binding.key)) return null;
  if (active.binding.kind === "property") {
    return (
      <PropertyPicker
        target={{
          kind: "block",
          id: block.id,
          pageId: active.binding.block.page_id,
          bag: block.properties,
        }}
        anchor={active.anchor}
        initialKey={active.binding.key}
        onClose={editor.cancel}
      />
    );
  }
  return (
    <TagPicker
      pageId={active.binding.block.page_id}
      block={block}
      anchor={active.anchor}
      onClose={editor.cancel}
    />
  );
}

function QueryMarkdownField({
  editor,
  className,
  label,
}: {
  editor: QueryResultEditor;
  className?: string;
  label: string;
}) {
  const active = editor.active;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const markdown = active?.phase === "markdown" ? active : null;

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element || !markdown) return;
    element.style.height = "0";
    element.style.height = `${Math.max(element.scrollHeight, 24)}px`;
  }, [markdown?.draft]);

  if (!markdown) return null;
  return (
    <span className={cn("query-result-editor", className)} data-saving={markdown.saving || undefined}>
      <textarea
        ref={textarea}
        autoFocus
        rows={1}
        className="query-result-input"
        value={markdown.draft}
        dir="auto"
        aria-label={label}
        aria-invalid={Boolean(markdown.error) || undefined}
        data-testid="query-markdown-editor"
        onChange={(event) => editor.setDraft(event.target.value)}
        onCompositionStart={() => editor.setComposing(true)}
        onCompositionEnd={() => editor.setComposing(false)}
        onBlur={(event) => {
          // Opening the saved-view menu is a presentation change. Keep the
          // query-level draft alive so the other renderer adopts it. Radix
          // may focus the menu item directly, so the toolbar marks the intent
          // on pointer down before this blur runs.
          const switchingView = editor.consumeViewChangeIntent()
            || (event.relatedTarget instanceof Element
              && event.relatedTarget.closest('[data-testid="query-view-trigger"]') !== null);
          if (!switchingView) void editor.commit(true);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            editor.cancel();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void editor.commit(true);
          }
        }}
      />
      {markdown.error && (
        <span className="query-result-edit-error" role="alert">
          <span>{markdown.error}</span>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={editor.retry}>
            {editor.message("common.retryShort")}
          </button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={editor.cancel}>
            {editor.message("common.cancel")}
          </button>
        </span>
      )}
    </span>
  );
}

/**
 * A closed enumeration edits in place, from the same menu the outline opens.
 *
 * Status and priority used to route through the generic property picker like
 * every other bound cell, which meant one value had two popups: four radio rows
 * when the reader pressed the mark on a line, and a two-stage key/value panel
 * when they pressed the same value in a table. § Choice forbids two look-alike
 * controls that open different popups; a single value with two of them is the
 * same defect from the other end.
 *
 * `null` when this is not one of the two, or when the block is not hydrated yet —
 * the caller falls back to its own trigger and the picker.
 */
function TaskMenuFor({
  binding,
  block,
  value,
}: {
  binding: Extract<QueryEditBinding, { kind: "property" }>;
  block: BlockSnapshot;
  value: string;
}): ReactNode {
  if (binding.key === TASK_STATUS_KEY) {
    return <TaskStatusMenu pageId={binding.block.page_id} block={block} status={value} />;
  }
  if (binding.key === TASK_PRIORITY_KEY) {
    return <TaskPriorityMenu pageId={binding.block.page_id} block={block} priority={value} />;
  }
  return null;
}

/** Whether a property key is one of the two the menu above serves. A key rather
 *  than a binding, so narrowing a binding stays the caller's own `kind` check:
 *  a guard that says "one of these two properties" also says "not any other
 *  property" on its false branch, which is not true. */
function isTaskChoiceKey(key: string): boolean {
  return key === TASK_STATUS_KEY || key === TASK_PRIORITY_KEY;
}

/**
 * The cell for one of those two, and the reason it is a component rather than a
 * branch: the menu needs the canonical block, and the canonical block is not
 * there yet.
 *
 * A query result names blocks on pages this client has never loaded, so reading
 * one out of the snapshot answers `undefined` for most rows in a real graph. The
 * first version treated that as "not a task choice" and quietly fell through to
 * the generic property picker — which meant the same value opened four radio rows
 * on a one-page graph and a two-stage key/value panel on a real one. § Choice
 * forbids two look-alike controls that open different popups; one value with two
 * of them, chosen by whether a page happens to be resident, is worse.
 *
 * So the menu is *controlled*, and the press runs the editor's own hydrate step
 * first. That step already exists, already reports its failures, and already
 * marks the trigger while it is in flight; the menu simply opens on the far side
 * of it, when there is a block for it to be about.
 */
function TaskChoiceCell({
  binding,
  row,
  column,
  context,
  editor,
  className,
  value,
  current,
  ariaLabel,
}: {
  binding: Extract<QueryEditBinding, { kind: "property" }>;
  row: ResultViewRow;
  column: ResultColumn;
  context: CellContext;
  editor: QueryResultEditor;
  className?: string;
  value: ReactNode;
  current: string;
  ariaLabel?: string;
}) {
  const active = editor.isActive(binding, row) ? editor.active : null;
  const block = active?.phase === "picker" ? editor.activeBlock : undefined;
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu
      modal={false}
      open={block !== undefined}
      onOpenChange={(next) => {
        if (next) editor.begin(binding, row, trigger.current);
        else editor.cancel();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={trigger}
          type="button"
          className={cn("query-edit-trigger", className)}
          data-query-column={column.variable}
          data-active={active ? true : undefined}
          data-testid={`query-edit-${column.variable}`}
          aria-busy={active?.phase === "loading" || undefined}
          aria-label={ariaLabel}
          title={context.message("query.editResult", { column: column.label })}
        >
          {value}
        </button>
      </DropdownMenuTrigger>
      {block && <TaskMenuFor binding={binding} block={block} value={current} />}
    </DropdownMenu>
  );
}

/**
 * A canonical block's content in an entity-style query row.
 *
 * The settled projection is the outline's full Markdown renderer, not the
 * compact phrasing renderer used inside a table cell. Only the edit controller
 * differs: Enter commits this reference edit instead of splitting structure.
 */
export function EditableBlockContent({
  markdown,
  row,
  context,
  editor,
}: {
  markdown: string;
  row: ResultViewRow;
  context: CellContext;
  editor: QueryResultEditor;
}) {
  const binding = editor.bindingForDirect(row.subject, { kind: "content" });
  const current = binding && editor.isActive(binding, row) ? editor.active : null;
  if (current?.phase === "markdown") {
    return (
      <QueryMarkdownField
        editor={editor}
        className="block-line query-block-content"
        label={context.message("outline.blockText")}
      />
    );
  }

  const begin = (anchor: HTMLElement) => {
    if (binding) editor.begin(binding, row, rectOf(anchor));
  };
  const common = {
    "data-active": current ? true : undefined,
    "aria-busy": current?.phase === "loading" || undefined,
  } as const;
  const content = hasMarkdownSyntax(markdown) ? (
    <BlockMarkdown
      markdown={markdown}
      className="block-line outline-markdown query-block-content"
      onActivate={binding ? (_caret, anchor) => anchor && begin(anchor) : undefined}
    />
  ) : binding ? (
    <button
      type="button"
      className="block-line query-block-content"
      dir="auto"
      title={context.message("query.editResult", { column: context.message("query.field.text") })}
      onClick={(event) => begin(event.currentTarget)}
      {...common}
    >
      {markdown}
    </button>
  ) : (
    <span className="block-line query-block-content" dir="auto">{markdown}</span>
  );

  if (current?.phase !== "error") return content;
  return (
    <span className="query-result-edit-problem query-block-content-problem">
      {content}
      <span role="alert">{current.error}</span>
      <button type="button" onClick={editor.retry}>{context.message("common.retryShort")}</button>
      <button type="button" onClick={editor.cancel}>{context.message("common.cancel")}</button>
    </span>
  );
}

/** Status and priority occupy the same hanging-indent controls as the outline. */
export function EditableBlockTaskMark({
  kind,
  value,
  row,
  column,
  context,
  editor,
}: {
  kind: "status" | "priority";
  value: string;
  row: ResultViewRow;
  column?: ResultColumn;
  context: CellContext;
  editor: QueryResultEditor;
}) {
  const key = kind === "status" ? TASK_STATUS_KEY : TASK_PRIORITY_KEY;
  const fallbackLabel = context.message(kind === "status" ? "task.statusLabel" : "task.priority");
  const model: ResultColumn = column ?? {
    variable: `block-${kind}`,
    label: fallbackLabel,
    source: { kind: "property", key },
    ordering: { kind: "ranked", values: [] },
    sortable: true,
    numeric: false,
    width: null,
  };
  const binding = editor.bindingForDirect(row.subject, { kind: "property", key });
  const glyph = kind === "status"
    ? <TaskStatusGlyph status={value} />
    : <PriorityGlyph priority={value} />;
  const label = kind === "status"
    ? context.message("task.statusIs", { status: statusLabel(value, context.message) })
    : context.message("task.priorityIs", { priority: priorityLabel(value, context.message) });
  if (!binding) {
    return (
      <span
        className={kind === "status" ? "task-status-toggle" : "task-priority-toggle"}
        role="img"
        aria-label={label}
      >
        {glyph}
      </span>
    );
  }
  return (
    <TaskChoiceCell
      binding={binding as Extract<QueryEditBinding, { kind: "property" }>}
      row={row}
      column={model}
      context={context}
      editor={editor}
      className={kind === "status" ? "task-status-toggle" : "task-priority-toggle"}
      value={glyph}
      current={value}
      ariaLabel={label}
    />
  );
}

export function EditableCellValue({
  term,
  column,
  context,
  row,
  editor,
  className,
  showOpen = false,
}: {
  term: RdfTerm | undefined;
  column: ResultColumn;
  context: CellContext;
  row: ResultViewRow;
  editor: QueryResultEditor;
  className?: string;
  showOpen?: boolean;
}): ReactNode {
  const binding = editor.bindingFor(row.subject, column);
  const current = binding && editor.isActive(binding, row) ? editor.active : null;
  if (current?.phase === "markdown") {
    return <QueryMarkdownField editor={editor} className={className} label={context.message("outline.blockText")} />;
  }
  const displayContext = binding ? { ...context, onOpen: undefined } : context;
  const value = <CellValue term={term} column={column} context={displayContext} subject={row.subject} />;
  if (!binding) return className ? <span className={className}>{value}</span> : value;

  if (current?.phase === "error") {
    return (
      <span className={cn("query-result-edit-problem", className)}>
        {value}
        <span role="alert">{current.error}</span>
        <button type="button" onClick={editor.retry}>{context.message("common.retryShort")}</button>
        <button type="button" onClick={editor.cancel}>{context.message("common.cancel")}</button>
      </span>
    );
  }

  // A closed enumeration opens its own menu from the cell (see `TaskChoiceCell`).
  if (binding.kind === "property" && isTaskChoiceKey(binding.key)) {
    return (
      <TaskChoiceCell
        binding={binding}
        row={row}
        column={column}
        context={context}
        editor={editor}
        className={className}
        value={value}
        current={term?.kind === "literal" ? term.value : ""}
      />
    );
  }

  const trigger = (
    <button
      type="button"
      className={cn("query-edit-trigger", className)}
      data-query-column={column.variable}
      data-active={current ? true : undefined}
      data-testid={`query-edit-${column.variable}`}
      dir="auto"
      aria-busy={current?.phase === "loading" || undefined}
      title={context.message("query.editResult", { column: column.label })}
      // The *box* the press happened in, not the element it happened on.
      // Beginning an edit hydrates the block this row names, hydrating rebuilds
      // the result, and this button is gone before the panel it opens has
      // measured anything — so the panel would place itself from nothing and
      // land in the middle of the window's top edge. The press had a place on
      // screen; that is the anchor (`ui/anchored` § Anchor).
      onClick={(event) => editor.begin(binding, row, rectOf(event.currentTarget))}
    >
      {value}
    </button>
  );

  if (!showOpen || binding.kind !== "markdown" || !row.subject || !context.onOpen) return trigger;
  return (
    <span className="query-editable-route">
      {trigger}
      <button
        type="button"
        className="query-cell-open"
        aria-label={context.message("query.openResult", {
          name: term?.kind === "literal" && term.value ? term.value : column.label,
        })}
        onClick={() => context.onOpen?.(row.subject!)}
      >
        <ArrowUpRightIcon aria-hidden />
      </button>
    </span>
  );
}

export function EditableStatusValue({
  term,
  column,
  context,
  row,
  editor,
}: {
  term: RdfTerm | undefined;
  column: ResultColumn;
  context: CellContext;
  row: ResultViewRow;
  editor: QueryResultEditor;
}) {
  const binding = editor.bindingFor(row.subject, column);
  if (term?.kind !== "literal" && !binding) return null;
  const status = term?.kind === "literal" ? term.value : "";
  if (!binding) {
    return <span className="query-list-status"><TaskStatusGlyph status={status} /></span>;
  }
  const current = editor.isActive(binding, row) ? editor.active : null;
  // The same menu the outline's own mark opens — a list result is a row of
  // blocks, so pressing the mark on one has to do what pressing it on a line
  // does (see `TaskChoiceCell`).
  if (binding.kind === "property" && isTaskChoiceKey(binding.key)) {
    return (
      <TaskChoiceCell
        binding={binding}
        row={row}
        column={column}
        context={context}
        editor={editor}
        className="query-list-status"
        value={<TaskStatusGlyph status={status} />}
        current={status}
      />
    );
  }
  return (
    <button
      type="button"
      className="query-list-status query-edit-trigger"
      data-query-column={column.variable}
      data-active={current ? true : undefined}
      aria-busy={current?.phase === "loading" || undefined}
      title={context.message("query.editResult", { column: column.label })}
      onClick={(event) => editor.begin(binding, row, event.currentTarget)}
    >
      <TaskStatusGlyph status={status} />
    </button>
  );
}
