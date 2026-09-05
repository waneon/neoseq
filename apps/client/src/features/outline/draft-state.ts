import type { AutoCloserMarker } from "../blocks/editor/auto-pair";
import { useCallback } from "react";
import type { GraphSession } from "../../core-port/session";
import type { OutlineOwner, PageDirectoryEntry, PageReferenceSpan } from "../../core-port/snapshot";
import { useImmediateState } from "../../lib/react";
import { useContentSessions } from "../blocks/editor/content-session";
import type { InlineContentProjection } from "../blocks/editor/inline-content";
import type { InlineContent } from "../../core-port/commands";
import {
  bufferIsClean,
  contentFromProjection,
  createContentBuffer,
  editBuffer,
  projectBuffer,
  settleBuffer,
  spliceBuffer,
  type ContentBuffer,
} from "../blocks/editor/content-buffer";

interface PendingOutlineOperationBase {
  id: string;
  dispatched: boolean;
}

interface PendingCreationOperationBase extends PendingOutlineOperationBase {
  tempId: string;
  /** Block the created row is positioned relative to — a real BlockId or earlier tempId. */
  anchorId: string;
  mode: "before" | "child" | "sibling";
  /** Authoritative content expected on the newly created block. */
  created: InlineContentProjection;
  /** Indent/outdent keys typed before the real id arrived. */
  structural: readonly ("indent" | "outdent")[];
}

export interface PendingInsertOperation extends PendingCreationOperationBase {
  kind: "insert";
}

export interface PendingSplitOperation extends PendingCreationOperationBase {
  kind: "split";
  splitIndex: number;
  /** Complete visible content of the source while the split is pending. */
  source: InlineContentProjection;
}

export interface PendingMergeOperation extends PendingOutlineOperationBase {
  kind: "merge";
  sourceId: string;
  targetId: string;
  /** Complete target content after deleting the boundary. */
  merged: InlineContentProjection;
  /** UTF-16 caret position between the original target and source content. */
  joinCaret: number;
}

export type PendingCreationOperation = PendingInsertOperation | PendingSplitOperation;
export type PendingOutlineOperation = PendingCreationOperation | PendingMergeOperation;

export interface OutlineDraftState {
  buffers: ReadonlyMap<string, ContentBuffer>;
  autoClosers: ReadonlyMap<string, readonly AutoCloserMarker[]>;
  pendingOperations: readonly PendingOutlineOperation[];
}

export const initialOutlineDraftState: OutlineDraftState = {
  buffers: new Map(),
  autoClosers: new Map(),
  pendingOperations: [],
};

/** The surface owns structural projections; semantic buffers belong to graph targets. */
export function useOutlineDraftState(graph: GraphSession, owner: OutlineOwner) {
  const sessions = useContentSessions(graph);
  const [interaction, setInteraction, interactionRef] = useImmediateState({
    autoClosers: initialOutlineDraftState.autoClosers,
    pendingOperations: initialOutlineDraftState.pendingOperations,
  });
  const read = useCallback(
    (): OutlineDraftState => ({
      ...interactionRef.current,
      buffers: sessions.buffers(owner),
    }),
    [owner, sessions],
  );
  const update = useCallback(
    (reduce: (state: OutlineDraftState) => OutlineDraftState) => {
      const next = reduce(read());
      setInteraction({ autoClosers: next.autoClosers, pendingOperations: next.pendingOperations });
      sessions.replace(owner, next.buffers);
    },
    [owner, read, sessions, setInteraction],
  );
  return { state: { ...interaction, buffers: sessions.buffers(owner) }, read, update };
}

export type OutlineDraftAction =
  | {
      type: "edit";
      id: string;
      value: string;
      baselineIfAbsent?: string;
      contentIfAbsent?: readonly InlineContent[];
      autoClosers?: readonly AutoCloserMarker[];
      pageReferencesIfAbsent?: readonly PageReferenceSpan[];
    }
  | {
      type: "splice";
      id: string;
      source: readonly InlineContent[];
      index: number;
      delete: number;
      insert: readonly InlineContent[];
    }
  | { type: "settle"; id: string }
  | { type: "clear"; ids: readonly string[] }
  | { type: "clear-auto-closers"; ids: readonly string[] }
  | { type: "reconcile"; draftIds: readonly string[]; autoCloserIds: readonly string[] }
  | { type: "enqueue"; operation: PendingOutlineOperation }
  | { type: "mark-dispatched"; id: string }
  | { type: "adopt"; tempId: string; blockId: string; typed: string }
  | { type: "discard-head"; tempId: string }
  | { type: "complete-merge"; id: string }
  | { type: "fail-merge"; id: string }
  | { type: "queue-structural"; tempId: string; kind: "indent" | "outdent" }
  | { type: "abandon-pending" };

function without<K, V>(source: ReadonlyMap<K, V>, keys: readonly K[]): Map<K, V> {
  const next = new Map(source);
  for (const key of keys) next.delete(key);
  return next;
}

function withAutoClosers(
  source: ReadonlyMap<string, readonly AutoCloserMarker[]>,
  id: string,
  value: readonly AutoCloserMarker[],
): Map<string, readonly AutoCloserMarker[]> {
  const next = new Map(source);
  if (value.length === 0) next.delete(id);
  else next.set(id, value);
  return next;
}

export function outlineDraftReducer(
  state: OutlineDraftState,
  action: OutlineDraftAction,
  directory: readonly PageDirectoryEntry[] = [],
): OutlineDraftState {
  switch (action.type) {
    case "edit": {
      const current =
        state.buffers.get(action.id) ??
        createContentBuffer(
          action.contentIfAbsent ??
            contentFromProjection(
              action.baselineIfAbsent ?? "",
              action.pageReferencesIfAbsent ?? [],
            ),
        );
      const buffer = editBuffer(current, projectBuffer(current, directory), action.value);
      return {
        ...state,
        buffers: new Map(state.buffers).set(action.id, buffer),
        autoClosers:
          action.autoClosers === undefined
            ? state.autoClosers
            : withAutoClosers(state.autoClosers, action.id, action.autoClosers),
      };
    }
    case "splice": {
      const buffer = state.buffers.get(action.id) ?? createContentBuffer(action.source);
      return {
        ...state,
        buffers: new Map(state.buffers).set(
          action.id,
          spliceBuffer(buffer, action.index, action.delete, action.insert),
        ),
      };
    }
    case "settle": {
      const buffer = state.buffers.get(action.id);
      return buffer
        ? { ...state, buffers: new Map(state.buffers).set(action.id, settleBuffer(buffer)) }
        : state;
    }
    case "clear":
      return {
        ...state,
        buffers: without(state.buffers, action.ids),
        autoClosers: without(state.autoClosers, action.ids),
      };
    case "clear-auto-closers":
      return { ...state, autoClosers: without(state.autoClosers, action.ids) };
    case "reconcile":
      return {
        ...state,
        buffers: without(state.buffers, action.draftIds),
        autoClosers: without(state.autoClosers, [...action.draftIds, ...action.autoCloserIds]),
      };
    case "enqueue":
      if (action.operation.kind === "merge") {
        return {
          ...state,
          buffers: new Map(state.buffers).set(
            action.operation.targetId,
            createContentBuffer(
              contentFromProjection(
                action.operation.merged.markdown,
                action.operation.merged.pageReferences,
              ),
            ),
          ),
          pendingOperations: [...state.pendingOperations, action.operation],
        };
      }
      return {
        ...state,
        buffers: new Map(state.buffers).set(
          action.operation.tempId,
          createContentBuffer(
            contentFromProjection(
              action.operation.created.markdown,
              action.operation.created.pageReferences,
            ),
          ),
        ),
        pendingOperations: [...state.pendingOperations, action.operation],
      };
    case "mark-dispatched":
      return {
        ...state,
        pendingOperations: state.pendingOperations.map((operation) =>
          operation.id === action.id ? { ...operation, dispatched: true } : operation,
        ),
      };
    case "adopt": {
      const operation = state.pendingOperations[0];
      if (!operation || operation.kind === "merge" || operation.tempId !== action.tempId) {
        return state;
      }
      const buffers = without(state.buffers, [action.tempId]);
      const autoClosers = without(state.autoClosers, [action.tempId]);
      const buffer = state.buffers.get(action.tempId);
      if (buffer && !bufferIsClean(buffer)) buffers.set(action.blockId, buffer);
      const generatedClosers = state.autoClosers.get(action.tempId);
      if (generatedClosers) autoClosers.set(action.blockId, generatedClosers);
      return {
        buffers,
        autoClosers,
        pendingOperations: state.pendingOperations.slice(1).map((pending) => {
          if (pending.kind === "merge") {
            return {
              ...pending,
              sourceId: pending.sourceId === action.tempId ? action.blockId : pending.sourceId,
              targetId: pending.targetId === action.tempId ? action.blockId : pending.targetId,
            };
          }
          return pending.anchorId === action.tempId
            ? { ...pending, anchorId: action.blockId }
            : pending;
        }),
      };
    }
    case "discard-head": {
      const operation = state.pendingOperations[0];
      if (!operation || operation.kind === "merge" || operation.tempId !== action.tempId) {
        return state;
      }
      return {
        buffers: without(state.buffers, [action.tempId]),
        autoClosers: without(state.autoClosers, [action.tempId]),
        pendingOperations: state.pendingOperations.slice(1),
      };
    }
    case "complete-merge": {
      const operation = state.pendingOperations[0];
      if (operation?.kind !== "merge" || operation.id !== action.id) return state;
      const buffer = state.buffers.get(operation.targetId);
      const unchanged = !buffer || bufferIsClean(buffer);
      const ids = unchanged ? [operation.targetId] : [];
      return {
        ...state,
        buffers: without(state.buffers, ids),
        autoClosers: without(state.autoClosers, ids),
        pendingOperations: state.pendingOperations.slice(1),
      };
    }
    case "fail-merge": {
      const operation = state.pendingOperations[0];
      if (operation?.kind !== "merge" || operation.id !== action.id) return state;
      return {
        ...state,
        buffers: without(state.buffers, [operation.targetId]),
        autoClosers: without(state.autoClosers, [operation.targetId]),
        pendingOperations: state.pendingOperations.slice(1),
      };
    }
    case "queue-structural":
      return {
        ...state,
        pendingOperations: state.pendingOperations.map((operation) =>
          operation.kind !== "merge" && operation.tempId === action.tempId
            ? { ...operation, structural: [...operation.structural, action.kind] }
            : operation,
        ),
      };
    case "abandon-pending": {
      const ids = state.pendingOperations.map((operation) =>
        operation.kind === "merge" ? operation.targetId : operation.tempId,
      );
      return {
        buffers: without(state.buffers, ids),
        autoClosers: without(state.autoClosers, ids),
        pendingOperations: [],
      };
    }
  }
}
