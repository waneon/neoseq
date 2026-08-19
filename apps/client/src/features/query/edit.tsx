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
import { PropertyPicker } from "../properties/PropertyPicker";
import { TagPicker } from "../properties/TagPicker";
import { TaskStatusGlyph } from "../tasks/glyphs";
import { failureReason } from "../notify/errors";
import { diffSplice } from "../outline/text-diff";
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

interface EditOrigin {
  row: ResultViewRow;
}

type ActiveEdit =
  | {
      phase: "loading";
      binding: QueryEditBinding;
      origin: EditOrigin;
      anchor: HTMLElement;
    }
  | {
      phase: "error";
      binding: QueryEditBinding;
      origin: EditOrigin;
      anchor: HTMLElement;
      error: string;
    }
  | {
      phase: "markdown";
      binding: Extract<QueryEditBinding, { kind: "markdown" }>;
      origin: EditOrigin;
      anchor: HTMLElement;
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
      anchor: HTMLElement;
    };

export interface QueryResultEditor {
  active: ActiveEdit | null;
  activeBlock?: BlockSnapshot;
  message: MessageFunction;
  bindingFor(subject: QueryEntityRef | undefined, column: ResultColumn): QueryEditBinding | null;
  isActive(binding: QueryEditBinding, row: ResultViewRow): boolean;
  begin(binding: QueryEditBinding, row: ResultViewRow, anchor: HTMLElement): void;
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

  const bindingFor = useCallback(
    (subject: QueryEntityRef | undefined, column: ResultColumn): QueryEditBinding | null => {
      if (!enabled || subject?.kind !== "block" || !column.source) return null;
      if (column.source.kind === "content" && !column.aggregate) {
        return { kind: "markdown", block: subject };
      }
      if (column.source.kind === "property") {
        if (column.aggregate && column.aggregate !== "list") return null;
        if (valueTypeOf(column.source.key) === "document") return null;
        if (!canUserWrite(column.source.key, "block")) return null;
        return { kind: "property", block: subject, key: column.source.key };
      }
      if (column.source.kind === "tags" && (!column.aggregate || column.aggregate === "list")) {
        return { kind: "tags", block: subject };
      }
      return null;
    },
    [enabled],
  );

  const begin = useCallback(
    (binding: QueryEditBinding, row: ResultViewRow, anchor: HTMLElement) => {
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
      onClick={(event) => editor.begin(binding, row, event.currentTarget)}
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
