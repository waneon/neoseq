// Documents this browser opened recently, newest first. How one reader moves
// through a graph is browser-local state, so the list never enters the graph.

import { useEffect, useSyncExternalStore } from "react";

export interface RecentVisit {
  kind: "page" | "tag";
  id: string;
}

const LIMIT = 24;
const listeners = new Set<() => void>();
const cache = new Map<string, RecentVisit[]>();

function storageKey(scope: string): string {
  return `neoseq.recent.${scope}`;
}

function read(scope: string): RecentVisit[] {
  const cached = cache.get(scope);
  if (cached) return cached;
  let visits: RecentVisit[] = [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(scope)) ?? "[]");
    if (Array.isArray(parsed)) {
      visits = parsed.filter(
        (entry): entry is RecentVisit =>
          typeof entry === "object" &&
          entry !== null &&
          (entry.kind === "page" || entry.kind === "tag") &&
          typeof entry.id === "string",
      );
    }
  } catch {
    // Unavailable storage leaves an empty, session-only list.
  }
  cache.set(scope, visits);
  return visits;
}

export function recordVisit(scope: string, visit: RecentVisit): void {
  const current = read(scope);
  if (current[0]?.kind === visit.kind && current[0].id === visit.id) return;
  const next = [visit, ...current.filter((entry) => entry.id !== visit.id)].slice(0, LIMIT);
  cache.set(scope, next);
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify(next));
  } catch {
    // The in-memory list still serves this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRecentVisits(scope: string): RecentVisit[] {
  return useSyncExternalStore(
    subscribe,
    () => read(scope),
    () => read(scope),
  );
}

/** Records the document a route names, once per arrival. */
export function useVisitRecorder(scope: string, visit: RecentVisit | null): void {
  const kind = visit?.kind;
  const id = visit?.id;
  useEffect(() => {
    if (kind && id) recordVisit(scope, { kind, id });
  }, [scope, kind, id]);
}
