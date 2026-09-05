import type { AutoCloserMarker } from "../blocks/editor/auto-pair";
import { useCallback } from "react";
import type { GraphSession } from "../../core-port/session";
import type { OutlineOwner, PageDirectoryEntry, PageReferenceSpan } from "../../core-port/snapshot";
import { useImmediateState } from "../../lib/react";
import { ContentSessions, useContentSessions } from "../blocks/editor/content-session";
import type { InlineContentProjection } from "../blocks/editor/inline-content";
import type { InlineContent } from "../../core-port/commands";
import {
  bufferIsClean,
  contentFromProjection,
  createContentBuffer,
  settleBuffer,
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

export interface OutlineInteractionState {
  autoClosers: ReadonlyMap<string, readonly AutoCloserMarker[]>;
  pendingOperations: readonly PendingOutlineOperation[];
}

export interface OutlineDraftState extends OutlineInteractionState {
  buffers: ReadonlyMap<string, ContentBuffer>;
}

export const initialOutlineDraftState: OutlineInteractionState = {
  autoClosers: new Map(),
  pendingOperations: [],
};

/** The surface owns structural projections; semantic buffers belong to graph targets. */
export function useOutlineDraftState(graph: GraphSession, owner: OutlineOwner) {
  const sessions = useContentSessions(graph, owner);
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
  const dispatch = useCallback(
    (action: OutlineDraftAction, directory: readonly PageDirectoryEntry[] = []) => {
      setInteraction(
        applyOutlineDraftAction(interactionRef.current, sessions, owner, action, directory),
      );
    },
    [owner, sessions, setInteraction],
  );
  return { state: { ...interaction, buffers: sessions.buffers(owner) }, read, dispatch };
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

export function applyOutlineDraftAction(
  state: OutlineInteractionState,
  sessions: ContentSessions,
  owner: OutlineOwner,
  action: OutlineDraftAction,
  directory: readonly PageDirectoryEntry[] = [],
): OutlineInteractionState {
  const target = (id: string) => sessions.target(owner, id);
  const reset = (ids: readonly string[]) => ids.forEach((id) => target(id).reset());
  switch (action.type) {
    case "edit": {
      const content =
        action.contentIfAbsent ??
        contentFromProjection(action.baselineIfAbsent ?? "", action.pageReferencesIfAbsent ?? []);
      sessions.open(owner, action.id, content).edit(action.value, directory);
      return {
        ...state,
        autoClosers:
          action.autoClosers === undefined
            ? state.autoClosers
            : withAutoClosers(state.autoClosers, action.id, action.autoClosers),
      };
    }
    case "splice":
      sessions
        .open(owner, action.id, action.source)
        .splice(action.index, action.delete, action.insert);
      return state;
    case "settle": {
      const buffer = sessions.buffers(owner).get(action.id);
      if (buffer) target(action.id).replace(settleBuffer(buffer));
      return state;
    }
    case "clear":
      reset(action.ids);
      return { ...state, autoClosers: without(state.autoClosers, action.ids) };
    case "clear-auto-closers":
      return { ...state, autoClosers: without(state.autoClosers, action.ids) };
    case "enqueue": {
      const operation = action.operation;
      const projection = operation.kind === "merge" ? operation.merged : operation.created;
      target(operation.kind === "merge" ? operation.targetId : operation.tempId).replace(
        createContentBuffer(contentFromProjection(projection.markdown, projection.pageReferences)),
      );
      return { ...state, pendingOperations: [...state.pendingOperations, operation] };
    }
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
      target(action.tempId).adopt(action.blockId);
      const autoClosers = without(state.autoClosers, [action.tempId]);
      const generatedClosers = state.autoClosers.get(action.tempId);
      if (generatedClosers) autoClosers.set(action.blockId, generatedClosers);
      return {
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
      reset([action.tempId]);
      return {
        autoClosers: without(state.autoClosers, [action.tempId]),
        pendingOperations: state.pendingOperations.slice(1),
      };
    }
    case "complete-merge": {
      const operation = state.pendingOperations[0];
      if (operation?.kind !== "merge" || operation.id !== action.id) return state;
      const buffer = sessions.buffers(owner).get(operation.targetId);
      const unchanged = !buffer || bufferIsClean(buffer);
      const ids = unchanged ? [operation.targetId] : [];
      reset(ids);
      return {
        ...state,
        autoClosers: without(state.autoClosers, ids),
        pendingOperations: state.pendingOperations.slice(1),
      };
    }
    case "fail-merge": {
      const operation = state.pendingOperations[0];
      if (operation?.kind !== "merge" || operation.id !== action.id) return state;
      reset([operation.targetId]);
      return {
        ...state,
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
      reset(ids);
      return {
        autoClosers: without(state.autoClosers, ids),
        pendingOperations: [],
      };
    }
  }
}
