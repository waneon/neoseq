import { useEffect, useState } from "react";
import type { QueryView } from "../../core-port/snapshot";
import { useLatest } from "../../lib/react";

/** Saved conditions disclosure follows the document, including remote edits and undo.
 * An untouched view keeps its initial default while its question is being authored.
 * The setter supports temporary inspection when the graph is read-only.
 */
export function useQueryConditions(view: QueryView, defaultOpen: boolean) {
  const fallback = useLatest(defaultOpen);
  const [open, setOpen] = useState(() => view.options.conditions_open ?? defaultOpen);
  useEffect(() => {
    setOpen(view.options.conditions_open ?? fallback.current);
  }, [view.id, view.options.conditions_open, fallback]);
  return [open, setOpen] as const;
}

// Answer folding remains a bounded browser-local reading preference.
const FOLDED_RESULTS_KEY = "neoseq.query-disclosure.v1";

/**
 * The bound keeps deleted query identities from accumulating in browser storage.
 */
const LIMIT = 256;

type Members = Record<string, string[]>;

/**
 * One per-graph list of execution keys, kept in this browser. Membership is the
 * whole state: what it means to be in the list is the caller's to name.
 */
function keySet(storageKey: string) {
  const read = (): Members => {
    try {
      const raw = localStorage.getItem(storageKey);
      const value: unknown = raw ? JSON.parse(raw) : null;
      if (!value || typeof value !== "object") return {};
      const members: Members = {};
      for (const [graphId, keys] of Object.entries(value as Record<string, unknown>)) {
        if (Array.isArray(keys)) {
          members[graphId] = keys.filter((key): key is string => typeof key === "string");
        }
      }
      return members;
    } catch {
      // Private mode, a disabled store, or a corrupt blob: every list is empty,
      // which is the state a graph starts in anyway.
      return {};
    }
  };

  const write = (members: Members): void => {
    try {
      if (Object.keys(members).length === 0) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(members));
    } catch {
      // A blocked write costs the next launch, not this session.
    }
  };

  return {
    has(graphId: string, key: string): boolean {
      return read()[graphId]?.includes(key) ?? false;
    },
    set(graphId: string, key: string, member: boolean): void {
      const members = read();
      const kept = (members[graphId] ?? []).filter((entry) => entry !== key);
      // The newest goes last, so the one dropped at the ceiling is the one the
      // reader touched longest ago.
      const next = member ? [...kept, key].slice(-LIMIT) : kept;
      if (next.length === 0) delete members[graphId];
      else members[graphId] = next;
      write(members);
    },
    clear(): void {
      write({});
    },
  };
}

const foldedResults = keySet(FOLDED_RESULTS_KEY);

export function queryResultsAreOpen(graphId: string, owner: string): boolean {
  return !foldedResults.has(graphId, owner);
}

export function rememberQueryResultsOpen(graphId: string, owner: string, open: boolean): void {
  foldedResults.set(graphId, owner, !open);
}

/**
 * Test seam: forgets folded answers. Answer disclosure is
 * browser-wide, so one test folding an answer would otherwise reach the next.
 */
export function resetQueryDisclosure(): void {
  foldedResults.clear();
}
