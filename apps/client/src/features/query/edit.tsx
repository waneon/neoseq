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
import { findBlock, findOutline, outlineOwnerKey } from "../../core-port/snapshot";
import { canUserWrite, valueTypeOf } from "../../entities/properties";
import { useI18n, type MessageFunction } from "../../i18n";
import { cn } from "../../lib/utils";
import type { Anchor } from "@/ui/anchored";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { TASK_PRIORITY_KEY, TASK_STATUS_KEY } from "../../entities/tasks";
import { compilePlan } from "../../entities/query-compile";
import { defaultPlan, encodePlan, QUERY_PLAN_VERSION } from "../../entities/query-plan";
import { useCommands } from "../commands/context";
import { bindingMatches, useShortcutBindings } from "../commands/shortcuts";
import { useHistoryActions } from "../history/context";
import { PropertyPicker } from "../properties/PropertyPicker";
import { TagPicker } from "../properties/TagPicker";
import { PriorityGlyph, TaskStatusGlyph } from "../tasks/glyphs";
import { TaskStatusMenu } from "../tasks/StatusControl";
import { TaskPriorityMenu } from "../tasks/PriorityControl";
import { failureReason } from "../notify/errors";
import { useNotify } from "../notify/context";
import { diffSplice } from "../blocks/editor/text-diff";
import {
  transformAutoClosers,
  type AutoCloserMarker,
} from "../blocks/editor/auto-pair";
import { BlockTextArea, type BlockTextEdit } from "../blocks/editor/BlockTextArea";
import {
  BlockSlashMenu,
  BlockTagMenu,
  detectHash,
  detectSlash,
  filterTagOptions,
  removeCompletionToken,
  type BlockCompletionRequest,
  type BlockTagOption,
} from "../blocks/editor/BlockCompletions";
import {
  buildSlashItems,
  filterSlashItems,
  type SlashItem,
} from "../blocks/editor/slash-commands";
import { BlockMarkdown } from "../markdown/BlockMarkdown";
import { hasMarkdownSyntax } from "../markdown/profile";
import { priorityLabel, statusLabel } from "../tasks/labels";
import { useSessionState } from "../shell/session-context";
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
      autoClosers: AutoCloserMarker[];
      saving: boolean;
      closeAfterSave: boolean;
      error: string | null;
    }
  | {
      phase: "picker";
      binding: Extract<QueryEditBinding, { kind: "property" | "tags" }>;
      origin: EditOrigin;
      anchor: Anchor;
      /** A status/priority cell owns a dedicated menu; command routes do not. */
      taskMenu: boolean;
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
  setDraft(value: string, edit?: BlockTextEdit): void;
  setComposing(composing: boolean): void;
  preserveDraftForPresentationChange(): void;
  consumePresentationChangeIntent(): boolean;
  commit(close: boolean): Promise<boolean>;
  acceptSlash(request: BlockCompletionRequest, item: SlashItem): void;
  acceptTag(request: BlockCompletionRequest, option: BlockTagOption): void;
  runHistory(redo: boolean): void;
  retry(): void;
  cancel(): void;
}

function bindingKey(binding: QueryEditBinding): string {
  const owner = `${outlineOwnerKey(binding.block.owner)}:${binding.block.id}`;
  return binding.kind === "property"
    ? `${owner}:property:${binding.key}`
    : `${owner}:${binding.kind}`;
}

function blockFrom(state: SessionState, block: BlockRef): BlockSnapshot | undefined {
  const outline = findOutline(state.snapshot, block.owner);
  return outline ? findBlock(outline, block.id) : undefined;
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
  const commands = useCommands();
  const history = useHistoryActions();
  const notify = useNotify();
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
      const open = (block: BlockSnapshot) => {
        if (binding.kind === "markdown") {
          setActive({
            phase: "markdown",
            binding,
            origin,
            anchor,
            baseline: block.markdown,
            draft: block.markdown,
            composing: false,
            autoClosers: [],
            saving: false,
            closeAfterSave: false,
            error: null,
          });
        } else {
          setActive({
            phase: "picker",
            binding,
            origin,
            anchor,
            taskMenu: binding.kind === "property" && isTaskChoiceKey(binding.key),
          });
        }
      };

      // A resident result is already canonical. Open it in the focus event so
      // the textarea that received the press stays the editor and keeps the
      // browser's native caret. Only cross-page results pay the async hydrate
      // transition.
      const resident = blockFrom(session.getState(), binding.block);
      if (resident) {
        open(resident);
        return;
      }

      setActive({ phase: "loading", binding, origin, anchor });
      void (async () => {
        try {
          if (!session.getState().hydratedOutlines.has(outlineOwnerKey(binding.block.owner))) {
            await session.hydrateOutline(binding.block.owner);
          }
          if (sequence !== request.current) return;
          const block = blockFrom(session.getState(), binding.block);
          if (!block) throw new Error("query result block no longer exists");
          open(block);
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
    async (close: boolean, draftOverride?: string): Promise<boolean> => {
      const current = activeRef.current;
      if (!current || current.phase !== "markdown") return false;
      if (current.composing) return false;
      if (current.saving) {
        if (close) {
          setActive((latest) => latest?.phase === "markdown"
            ? { ...latest, closeAfterSave: true }
            : latest);
        }
        return false;
      }
      const expected = draftOverride ?? current.draft;
      const splice = diffSplice(current.baseline, expected);
      if (!splice) {
        if (close) cancel();
        return true;
      }

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
          owner: current.binding.block.owner,
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
        return true;
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
        return false;
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
      return { ...current, baseline: canonical, draft: canonical, autoClosers: [] };
    });
  }, [setActive, state]);

  const setDraft = useCallback((value: string, edit?: BlockTextEdit) => {
    setActive((current) => {
      if (current?.phase !== "markdown") return current;
      let autoClosers = transformAutoClosers(
        current.draft,
        value,
        current.autoClosers,
        edit?.preferredStart,
        edit?.preferredEnd,
      );
      if (edit?.autoCloser) {
        autoClosers = [
          ...autoClosers.filter((marker) =>
            marker.offset !== edit.autoCloser?.offset
            || marker.closer !== edit.autoCloser.closer),
          edit.autoCloser,
        ];
      }
      return { ...current, draft: value, autoClosers, error: null };
    });
  }, [setActive]);

  const setComposing = useCallback((composing: boolean) => {
    setActive((current) => current?.phase === "markdown"
      ? { ...current, composing }
      : current);
  }, [setActive]);

  const acceptSlash = useCallback((completion: BlockCompletionRequest, item: SlashItem) => {
    const current = activeRef.current;
    if (!current || current.phase !== "markdown") return;
    const next = removeCompletionToken(current.draft, completion).value;
    setActive({ ...current, draft: next, autoClosers: [], error: null });

    void (async () => {
      if (!(await commit(false, next))) return;
      const owner = {
        kind: "block",
        owner: current.binding.block.owner,
        id: current.binding.block.id,
      } as const;
      try {
        if (item.action.kind === "set") {
          await session.execute({
            type: "set_property",
            owner,
            key: item.action.key,
            value: item.action.value,
          });
          return;
        }
        if (item.action.kind === "query" || item.action.kind === "query-source") {
          const plan = defaultPlan();
          await session.execute(item.action.kind === "query-source"
            ? { type: "set_query_source", owner, source: "" }
            : {
              type: "set_query_plan",
              owner,
              plan: { version: QUERY_PLAN_VERSION, payload: encodePlan(plan) },
              source: compilePlan(plan).source,
            });
          return;
        }
        const latest = activeRef.current;
        if (!latest || latest.phase !== "markdown") return;
        setActive({
          phase: "picker",
          binding: {
            kind: "property",
            block: current.binding.block,
            key: item.action.key ?? "",
          },
          origin: current.origin,
          anchor: completion.anchor.getBoundingClientRect(),
          taskMenu: false,
        });
      } catch (cause) {
        notify.failure(
          item.action.kind === "query" || item.action.kind === "query-source"
            ? message("failure.createQuery")
            : message("failure.setProperty"),
          cause,
        );
      }
    })();
  }, [commit, message, notify, session, setActive]);

  const acceptTag = useCallback((completion: BlockCompletionRequest, option: BlockTagOption) => {
    const current = activeRef.current;
    if (!current || current.phase !== "markdown") return;
    const next = removeCompletionToken(current.draft, completion).value;
    setActive({ ...current, draft: next, autoClosers: [], error: null });
    void (async () => {
      if (!(await commit(false, next)) || option.present) return;
      try {
        await session.execute({
          type: "add_tag",
          entity: {
            kind: "block",
            owner: current.binding.block.owner,
            id: current.binding.block.id,
          },
          tag_id: option.id,
        });
      } catch (cause) {
        notify.failure(message("failure.addTag"), cause);
      }
    })();
  }, [commit, message, notify, session, setActive]);

  const runHistory = useCallback((redo: boolean) => {
    void (async () => {
      if (!(await commit(false))) return;
      await history.run(redo ? "redo" : "undo", { kind: "global-shortcut" });
    })();
  }, [commit, history]);

  const preserveDraftForPresentationChange = useCallback(() => {
    preserveOnNextBlur.current = true;
    window.setTimeout(() => {
      preserveOnNextBlur.current = false;
    }, 0);
  }, []);

  const consumePresentationChangeIntent = useCallback(() => {
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

  const activeBlockKey = activeBlock && active
    ? `${outlineOwnerKey(active.binding.block.owner)}:${active.binding.block.id}`
    : null;
  useEffect(() => {
    if (!activeBlockKey) return;
    return commands.registerBlockProperties((key?: string) => {
      const current = activeRef.current;
      if (!current) return;
      if (current.phase === "markdown") void commit(false);
      const focused = document.activeElement;
      setActive({
        phase: "picker",
        binding: { kind: "property", block: current.binding.block, key: key ?? "" },
        origin: current.origin,
        anchor: focused instanceof HTMLElement ? focused.getBoundingClientRect() : current.anchor,
        taskMenu: false,
      });
    });
  }, [activeBlockKey, commands, commit, setActive]);

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
    preserveDraftForPresentationChange,
    consumePresentationChangeIntent,
    commit,
    acceptSlash,
    acceptTag,
    runHistory,
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
  if (active.taskMenu) return null;
  if (active.binding.kind === "property") {
    return (
      <PropertyPicker
        target={{
          kind: "block",
          id: block.id,
          owner: active.binding.block.owner,
          bag: block.properties,
        }}
        anchor={active.anchor}
        initialKey={active.binding.key || undefined}
        onClose={editor.cancel}
      />
    );
  }
  return (
    <TagPicker
      owner={active.binding.block.owner}
      block={block}
      anchor={active.anchor}
      onClose={editor.cancel}
    />
  );
}

function QueryMarkdownField({
  editor,
  binding,
  row,
  value,
  className,
  label,
  editLabel,
  column,
  preview = false,
}: {
  editor: QueryResultEditor;
  binding: Extract<QueryEditBinding, { kind: "markdown" }>;
  row: ResultViewRow;
  value: string;
  className?: string;
  label: string;
  editLabel?: string;
  column?: ResultColumn;
  preview?: false | "block" | "compact";
}) {
  const state = useSessionState();
  const { compare } = useI18n();
  const bindings = useShortcutBindings();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  const current = editor.isActive(binding, row) ? editor.active : null;
  const markdown = current?.phase === "markdown" ? current : null;
  const block = editor.activeBlock;
  const blockId = binding.block.id;
  const projected = markdown?.draft ?? value;
  const previewMarkdown = Boolean(preview && !current && hasMarkdownSyntax(projected));
  const error = markdown?.error ?? (current?.phase === "error" ? current.error : null);
  const slashItems = useMemo(() => buildSlashItems(editor.message), [editor.message]);
  const [slashRequest, setSlashRequest] = useState<BlockCompletionRequest | null>(null);
  const [slashActive, setSlashActive] = useState(0);
  const [hashRequest, setHashRequest] = useState<BlockCompletionRequest | null>(null);
  const [hashActive, setHashActive] = useState(0);
  const slashResults = useMemo(
    () => slashRequest ? filterSlashItems(slashItems, slashRequest.query) : [],
    [slashItems, slashRequest],
  );
  const hashResults = useMemo(
    () => hashRequest
      ? filterTagOptions(
        state.snapshot.tags,
        hashRequest.query,
        new Set(block?.tags ?? []),
        compare,
      )
      : [],
    [block?.tags, compare, hashRequest, state.snapshot.tags],
  );
  const slashIndex = Math.min(slashActive, Math.max(slashResults.length - 1, 0));
  const hashIndex = Math.min(hashActive, Math.max(hashResults.length - 1, 0));

  const updateCompletions = useCallback((value: string, element: HTMLTextAreaElement) => {
    const slash = detectSlash(value, element.selectionStart, element.selectionEnd);
    setSlashActive(0);
    setSlashRequest(
      slash && filterSlashItems(slashItems, slash.query).length > 0
        ? { blockId, ...slash, anchor: element }
        : null,
    );
    const hash = slash ? null : detectHash(value, element.selectionStart, element.selectionEnd);
    setHashActive(0);
    setHashRequest(
      hash && filterTagOptions(
        state.snapshot.tags,
        hash.query,
        new Set(block?.tags ?? []),
        compare,
      ).length > 0
        ? { blockId, ...hash, anchor: element }
        : null,
    );
  }, [block?.tags, blockId, compare, slashItems, state.snapshot.tags]);

  useEffect(() => {
    if (!slashRequest && !hashRequest) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const node = event.target;
      if (node instanceof Element && node.closest(".slash-menu")) return;
      setSlashRequest(null);
      setHashRequest(null);
    };
    window.addEventListener("pointerdown", closeOnOutsidePress, true);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePress, true);
  }, [hashRequest, slashRequest]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element || previewMarkdown) return;
    element.style.height = "0";
    element.style.height = `${Math.max(element.scrollHeight, 24)}px`;
  }, [previewMarkdown, projected]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element || !markdown || document.activeElement === element) return;
    element.focus({ preventScroll: true });
    const caret = Math.min(pendingCaret.current ?? element.value.length, element.value.length);
    element.setSelectionRange(caret, caret);
    pendingCaret.current = null;
  }, [markdown]);

  const Root = preview === "block" ? "div" : "span";
  return (
    <Root
      className={cn("query-result-editor", className)}
      data-active={current ? true : undefined}
      data-saving={markdown?.saving || undefined}
    >
      <BlockTextArea
        ref={textarea}
        rows={1}
        className="query-result-input"
        value={projected}
        autoClosers={markdown?.autoClosers ?? []}
        data-block-editor
        data-query-column={column?.variable}
        dir="auto"
        spellCheck={false}
        readOnly={!markdown}
        hidden={previewMarkdown}
        tabIndex={previewMarkdown ? -1 : undefined}
        aria-label={label}
        aria-busy={current?.phase === "loading" || undefined}
        aria-invalid={Boolean(error) || undefined}
        aria-controls={slashRequest ? "slash-command-menu" : hashRequest ? "tag-suggest-menu" : undefined}
        aria-activedescendant={
          slashRequest && slashResults[slashIndex]
            ? `slash-opt-${slashResults[slashIndex].id}`
            : hashRequest && hashResults[hashIndex]
              ? `tag-opt-${hashIndex}`
              : undefined
        }
        data-testid={markdown ? "query-markdown-editor" : `query-edit-${column?.variable ?? "text"}`}
        title={editor.message("query.editResult", { column: editLabel ?? column?.label ?? label })}
        onFocus={(event) => {
          if (!current) editor.begin(binding, row, event.currentTarget);
        }}
        onValueChange={(value, element, edit) => {
          if (!markdown) return;
          editor.setDraft(value, edit);
          if (!composing.current) updateCompletions(value, element);
        }}
        onCompositionStart={() => {
          composing.current = true;
          editor.setComposing(true);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          editor.setComposing(false);
          updateCompletions(event.currentTarget.value, event.currentTarget);
        }}
        onBlur={(event) => {
          // Opening the saved-view menu is a presentation change. Keep the
          // query-level draft alive so the other renderer adopts it. Radix
          // may focus the menu item directly, so the toolbar marks the intent
          // on pointer down before this blur runs.
          const changingPresentation = editor.consumePresentationChangeIntent()
            || (event.relatedTarget instanceof Element
              && event.relatedTarget.closest('[data-testid="query-view-trigger"]') !== null);
          if (changingPresentation) return;
          if (markdown) void editor.commit(true);
          else if (current) editor.cancel();
        }}
        onKeyDown={(event) => {
          if (!markdown) return;
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (slashRequest) {
            if (event.key === "Escape") {
              event.preventDefault();
              setSlashRequest(null);
              return;
            }
            if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
              event.preventDefault();
              const chosen = slashResults[slashIndex];
              if (chosen) {
                const caret = removeCompletionToken(markdown.draft, slashRequest).caret;
                editor.acceptSlash(slashRequest, chosen);
                queueMicrotask(() => textarea.current?.setSelectionRange(caret, caret));
              }
              setSlashRequest(null);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSlashActive(event.key === "ArrowDown"
                ? Math.min(slashIndex + 1, slashResults.length - 1)
                : Math.max(slashIndex - 1, 0));
              return;
            }
          }
          if (hashRequest) {
            if (event.key === "Escape") {
              event.preventDefault();
              setHashRequest(null);
              return;
            }
            if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
              event.preventDefault();
              const chosen = hashResults[hashIndex];
              if (chosen) {
                const caret = removeCompletionToken(markdown.draft, hashRequest).caret;
                editor.acceptTag(hashRequest, chosen);
                queueMicrotask(() => textarea.current?.setSelectionRange(caret, caret));
              }
              setHashRequest(null);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setHashActive(event.key === "ArrowDown"
                ? Math.min(hashIndex + 1, hashResults.length - 1)
                : Math.max(hashIndex - 1, 0));
              return;
            }
          }
          const isUndo = bindingMatches(event, bindings.undo);
          const isRedo = bindingMatches(event, bindings.redo);
          if (isUndo || isRedo) {
            event.preventDefault();
            editor.runHistory(isRedo);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            editor.cancel();
            event.currentTarget.blur();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void editor.commit(true).then((saved) => {
              if (saved) textarea.current?.blur();
            });
          }
        }}
      />
      {previewMarkdown && (
        <BlockMarkdown
          markdown={projected}
          variant={preview || "block"}
          className="outline-markdown query-markdown-preview"
          onActivate={(caret, anchor) => {
            pendingCaret.current = caret ?? projected.length;
            const target = anchor ?? textarea.current;
            if (target) editor.begin(binding, row, target);
          }}
        />
      )}
      {slashRequest && (
        <BlockSlashMenu
          request={slashRequest}
          results={slashResults}
          active={slashIndex}
          onHover={setSlashActive}
          onChoose={(item) => {
            if (!markdown) return;
            const caret = removeCompletionToken(markdown.draft, slashRequest).caret;
            editor.acceptSlash(slashRequest, item);
            setSlashRequest(null);
            queueMicrotask(() => textarea.current?.setSelectionRange(caret, caret));
          }}
        />
      )}
      {hashRequest && (
        <BlockTagMenu
          request={hashRequest}
          results={hashResults}
          active={hashIndex}
          onHover={setHashActive}
          onChoose={(option) => {
            if (!markdown) return;
            const caret = removeCompletionToken(markdown.draft, hashRequest).caret;
            editor.acceptTag(hashRequest, option);
            setHashRequest(null);
            queueMicrotask(() => textarea.current?.setSelectionRange(caret, caret));
          }}
        />
      )}
      {error && (
        <span className="query-result-edit-error" role="alert">
          <span>{error}</span>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={editor.retry}>
            {editor.message("common.retryShort")}
          </button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={editor.cancel}>
            {editor.message("common.cancel")}
          </button>
        </span>
      )}
    </Root>
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
    return <TaskStatusMenu owner={binding.block.owner} block={block} status={value} />;
  }
  if (binding.key === TASK_PRIORITY_KEY) {
    return <TaskPriorityMenu owner={binding.block.owner} block={block} priority={value} />;
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
  if (binding?.kind === "markdown") {
    return (
      <QueryMarkdownField
        editor={editor}
        binding={binding}
        row={row}
        value={markdown}
        className="block-line query-block-content"
        label={context.message("outline.blockText")}
        editLabel={context.message("query.field.text")}
        preview="block"
      />
    );
  }

  const content = hasMarkdownSyntax(markdown) ? (
    <BlockMarkdown
      markdown={markdown}
      className="block-line outline-markdown query-block-content"
    />
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
    ordering: { kind: "ranked", values: [], missing: kind === "priority" ? "below" : "last" },
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
  if (binding?.kind === "markdown") {
    const field = (
      <QueryMarkdownField
        editor={editor}
        binding={binding}
        row={row}
        value={term?.kind === "literal" ? term.value : ""}
        className={className}
        label={context.message("outline.blockText")}
        column={column}
        preview="compact"
      />
    );
    if (!showOpen || !row.subject || !context.onOpen) return field;
    return (
      <span className="query-editable-route">
        {field}
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
  return trigger;
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
