import type { AutoCloserMarker } from "../blocks/editor/auto-pair";
import type { PageReferenceSpan } from "../../core-port/snapshot";
import type { InlineContentProjection } from "../blocks/editor/inline-content";

interface PendingOutlineOperationBase {
  tempId: string;
  /** Block the created row is positioned relative to — a real BlockId or earlier tempId. */
  anchorId: string;
  mode: "before" | "child" | "sibling";
  /** Authoritative content expected on the newly created block. */
  created: InlineContentProjection;
  dispatched: boolean;
  /** Indent/outdent keys typed before the real id arrived. */
  structural: readonly ("indent" | "outdent")[];
}

export interface PendingInsertOperation extends PendingOutlineOperationBase {
  kind: "insert";
}

export interface PendingSplitOperation extends PendingOutlineOperationBase {
  kind: "split";
  splitIndex: number;
  /** Complete visible content of the source while the split is pending. */
  source: InlineContentProjection;
}

export type PendingOutlineOperation = PendingInsertOperation | PendingSplitOperation;

export interface OutlineDraftState {
  drafts: ReadonlyMap<string, string>;
  baselines: ReadonlyMap<string, string>;
  autoClosers: ReadonlyMap<string, readonly AutoCloserMarker[]>;
  /** Semantic spans aligned with the current local baseline. */
  pageReferences: ReadonlyMap<string, readonly PageReferenceSpan[]>;
  pendingOperations: readonly PendingOutlineOperation[];
}

export const initialOutlineDraftState: OutlineDraftState = {
  drafts: new Map(),
  baselines: new Map(),
  autoClosers: new Map(),
  pageReferences: new Map(),
  pendingOperations: [],
};

export type OutlineDraftAction =
  | {
      type: "edit";
      id: string;
      value: string;
      baselineIfAbsent?: string;
      autoClosers?: readonly AutoCloserMarker[];
      pageReferencesIfAbsent?: readonly PageReferenceSpan[];
    }
  | {
      type: "set-baseline";
      id: string;
      value: string;
      pageReferences?: readonly PageReferenceSpan[];
    }
  | { type: "clear"; ids: readonly string[] }
  | { type: "clear-auto-closers"; ids: readonly string[] }
  | {
      type: "reproject";
      entries: readonly {
        id: string;
        baseline: string;
        draft: string;
        pageReferences: readonly PageReferenceSpan[];
      }[];
    }
  | { type: "reconcile"; draftIds: readonly string[]; autoCloserIds: readonly string[] }
  | { type: "enqueue"; operation: PendingOutlineOperation }
  | { type: "mark-dispatched"; tempId: string }
  | { type: "adopt"; tempId: string; blockId: string; typed: string }
  | { type: "discard-head"; tempId: string }
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
): OutlineDraftState {
  switch (action.type) {
    case "edit": {
      const drafts = new Map(state.drafts).set(action.id, action.value);
      const baselines = new Map(state.baselines);
      if (action.baselineIfAbsent !== undefined && !baselines.has(action.id)) {
        baselines.set(action.id, action.baselineIfAbsent);
      }
      const pageReferences = new Map(state.pageReferences);
      if (action.pageReferencesIfAbsent !== undefined && !pageReferences.has(action.id)) {
        pageReferences.set(action.id, action.pageReferencesIfAbsent);
      }
      return {
        ...state,
        drafts,
        baselines,
        pageReferences,
        autoClosers: action.autoClosers === undefined
          ? state.autoClosers
          : withAutoClosers(state.autoClosers, action.id, action.autoClosers),
      };
    }
    case "set-baseline":
      return {
        ...state,
        baselines: new Map(state.baselines).set(action.id, action.value),
        pageReferences: action.pageReferences === undefined
          ? state.pageReferences
          : new Map(state.pageReferences).set(action.id, action.pageReferences),
      };
    case "clear":
      return {
        ...state,
        drafts: without(state.drafts, action.ids),
        baselines: without(state.baselines, action.ids),
        autoClosers: without(state.autoClosers, action.ids),
        pageReferences: without(state.pageReferences, action.ids),
      };
    case "clear-auto-closers":
      return { ...state, autoClosers: without(state.autoClosers, action.ids) };
    case "reproject": {
      const drafts = new Map(state.drafts);
      const baselines = new Map(state.baselines);
      const pageReferences = new Map(state.pageReferences);
      const autoClosers = new Map(state.autoClosers);
      for (const entry of action.entries) {
        drafts.set(entry.id, entry.draft);
        baselines.set(entry.id, entry.baseline);
        pageReferences.set(entry.id, entry.pageReferences);
        autoClosers.delete(entry.id);
      }
      return { ...state, drafts, baselines, pageReferences, autoClosers };
    }
    case "reconcile":
      return {
        ...state,
        drafts: without(state.drafts, action.draftIds),
        baselines: without(state.baselines, action.draftIds),
        autoClosers: without(
          state.autoClosers,
          [...action.draftIds, ...action.autoCloserIds],
        ),
        pageReferences: without(state.pageReferences, action.draftIds),
      };
    case "enqueue":
      return {
        ...state,
        drafts: new Map(state.drafts).set(
          action.operation.tempId,
          action.operation.created.markdown,
        ),
        pendingOperations: [...state.pendingOperations, action.operation],
      };
    case "mark-dispatched":
      return {
        ...state,
        pendingOperations: state.pendingOperations.map((operation) =>
          operation.tempId === action.tempId
            ? { ...operation, dispatched: true }
            : operation),
      };
    case "adopt": {
      const operation = state.pendingOperations[0];
      if (operation?.tempId !== action.tempId) return state;
      const drafts = without(state.drafts, [action.tempId]);
      const baselines = without(state.baselines, [action.tempId]);
      const autoClosers = without(state.autoClosers, [action.tempId]);
      const pageReferences = without(state.pageReferences, [action.tempId]);
      if (action.typed !== operation.created.markdown) {
        drafts.set(action.blockId, action.typed);
        baselines.set(action.blockId, operation.created.markdown);
      }
      const generatedClosers = state.autoClosers.get(action.tempId);
      if (generatedClosers) autoClosers.set(action.blockId, generatedClosers);
      return {
        drafts,
        baselines,
        autoClosers,
        pageReferences,
        pendingOperations: state.pendingOperations
          .slice(1)
          .map((pending) => pending.anchorId === action.tempId
            ? { ...pending, anchorId: action.blockId }
            : pending),
      };
    }
    case "discard-head":
      if (state.pendingOperations[0]?.tempId !== action.tempId) return state;
      return {
        drafts: without(state.drafts, [action.tempId]),
        baselines: without(state.baselines, [action.tempId]),
        autoClosers: without(state.autoClosers, [action.tempId]),
        pageReferences: without(state.pageReferences, [action.tempId]),
        pendingOperations: state.pendingOperations.slice(1),
      };
    case "queue-structural":
      return {
        ...state,
        pendingOperations: state.pendingOperations.map((operation) =>
          operation.tempId === action.tempId
            ? { ...operation, structural: [...operation.structural, action.kind] }
            : operation),
      };
    case "abandon-pending": {
      const ids = state.pendingOperations.map((operation) => operation.tempId);
      return {
        drafts: without(state.drafts, ids),
        baselines: without(state.baselines, ids),
        autoClosers: without(state.autoClosers, ids),
        pageReferences: without(state.pageReferences, ids),
        pendingOperations: [],
      };
    }
  }
}
