import type { AutoCloserMarker } from "../blocks/editor/auto-pair";

export interface PendingRow {
  tempId: string;
  /** Block this row is positioned relative to — a real BlockId or earlier tempId. */
  anchorId: string;
  mode: "before" | "child" | "sibling";
  /** Present when Enter atomically splits the anchor; absent for plain insertion. */
  splitIndex?: number;
  /** Authoritative Markdown expected on the newly created block. */
  baseline: string;
  dispatched: boolean;
  /** Indent/outdent keys typed before the real id arrived. */
  structural: readonly ("indent" | "outdent")[];
}

export interface OutlineDraftState {
  drafts: ReadonlyMap<string, string>;
  baselines: ReadonlyMap<string, string>;
  autoClosers: ReadonlyMap<string, readonly AutoCloserMarker[]>;
  pendingRows: readonly PendingRow[];
}

export const initialOutlineDraftState: OutlineDraftState = {
  drafts: new Map(),
  baselines: new Map(),
  autoClosers: new Map(),
  pendingRows: [],
};

export type OutlineDraftAction =
  | {
      type: "edit";
      id: string;
      value: string;
      baselineIfAbsent?: string;
      autoClosers?: readonly AutoCloserMarker[];
    }
  | { type: "set-baseline"; id: string; value: string }
  | { type: "clear"; ids: readonly string[] }
  | { type: "clear-auto-closers"; ids: readonly string[] }
  | { type: "reconcile"; draftIds: readonly string[]; autoCloserIds: readonly string[] }
  | { type: "enqueue"; row: PendingRow; draft: string }
  | { type: "mark-dispatched"; tempId: string }
  | { type: "adopt"; tempId: string; blockId: string; typed: string; baseline: string }
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
      return {
        ...state,
        drafts,
        baselines,
        autoClosers: action.autoClosers === undefined
          ? state.autoClosers
          : withAutoClosers(state.autoClosers, action.id, action.autoClosers),
      };
    }
    case "set-baseline":
      return { ...state, baselines: new Map(state.baselines).set(action.id, action.value) };
    case "clear":
      return {
        ...state,
        drafts: without(state.drafts, action.ids),
        baselines: without(state.baselines, action.ids),
        autoClosers: without(state.autoClosers, action.ids),
      };
    case "clear-auto-closers":
      return { ...state, autoClosers: without(state.autoClosers, action.ids) };
    case "reconcile":
      return {
        ...state,
        drafts: without(state.drafts, action.draftIds),
        baselines: without(state.baselines, action.draftIds),
        autoClosers: without(
          state.autoClosers,
          [...action.draftIds, ...action.autoCloserIds],
        ),
      };
    case "enqueue":
      return {
        ...state,
        drafts: new Map(state.drafts).set(action.row.tempId, action.draft),
        pendingRows: [...state.pendingRows, action.row],
      };
    case "mark-dispatched":
      return {
        ...state,
        pendingRows: state.pendingRows.map((row) =>
          row.tempId === action.tempId ? { ...row, dispatched: true } : row),
      };
    case "adopt": {
      if (state.pendingRows[0]?.tempId !== action.tempId) return state;
      const drafts = without(state.drafts, [action.tempId]);
      const baselines = without(state.baselines, [action.tempId]);
      const autoClosers = without(state.autoClosers, [action.tempId]);
      if (action.typed !== action.baseline) {
        drafts.set(action.blockId, action.typed);
        baselines.set(action.blockId, action.baseline);
      }
      const generatedClosers = state.autoClosers.get(action.tempId);
      if (generatedClosers) autoClosers.set(action.blockId, generatedClosers);
      return {
        drafts,
        baselines,
        autoClosers,
        pendingRows: state.pendingRows
          .slice(1)
          .map((row) => row.anchorId === action.tempId
            ? { ...row, anchorId: action.blockId }
            : row),
      };
    }
    case "discard-head":
      if (state.pendingRows[0]?.tempId !== action.tempId) return state;
      return {
        drafts: without(state.drafts, [action.tempId]),
        baselines: without(state.baselines, [action.tempId]),
        autoClosers: without(state.autoClosers, [action.tempId]),
        pendingRows: state.pendingRows.slice(1),
      };
    case "queue-structural":
      return {
        ...state,
        pendingRows: state.pendingRows.map((row) => row.tempId === action.tempId
          ? { ...row, structural: [...row.structural, action.kind] }
          : row),
      };
    case "abandon-pending": {
      const ids = state.pendingRows.map((row) => row.tempId);
      return {
        drafts: without(state.drafts, ids),
        baselines: without(state.baselines, ids),
        autoClosers: without(state.autoClosers, ids),
        pendingRows: [],
      };
    }
  }
}
