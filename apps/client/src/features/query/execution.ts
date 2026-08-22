import { useCallback, useSyncExternalStore } from "react";
import type { GraphSession } from "../../core-port/session";
import type {
  SparqlQueryRequest,
  SparqlQueryResult,
} from "../../generated/core-port";

/**
 * Query answers outlive their mounted renderer, but never their graph session.
 * This keeps a route change or a virtualized-row remount from turning a result
 * back into an empty first frame.
 */
const stores = new WeakMap<GraphSession, QueryExecutionStore>();
const MAX_CACHED_QUERIES = 64;

interface TaggedResult {
  signature: string;
  canonicalRevision: number;
  value: SparqlQueryResult;
}

interface TaggedError {
  signature: string;
  canonicalRevision: number;
  cause: unknown;
}

interface PendingExecution {
  signature: string;
  canonicalRevision: number;
  token: object;
  promise: Promise<void>;
}

interface QueryExecutionEntry {
  result: TaggedResult | null;
  error: TaggedError | null;
  pending: PendingExecution | null;
}

export interface QueryExecutionSnapshot {
  result: SparqlQueryResult | null;
  error: unknown | null;
  loading: boolean;
}

export class QueryExecutionStore {
  private readonly entries = new Map<string, QueryExecutionEntry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly versions = new Map<string, number>();
  private sequence = 0;

  constructor(private readonly session: GraphSession) {}

  version(owner: string): number {
    return this.versions.get(owner) ?? 0;
  }

  subscribe(owner: string, listener: () => void): () => void {
    const listeners = this.listeners.get(owner) ?? new Set();
    listeners.add(listener);
    this.listeners.set(owner, listeners);
    this.touch(owner);
    return () => {
      const current = this.listeners.get(owner);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(owner);
      this.trim();
    };
  }

  snapshot(
    owner: string,
    signature: string,
    canonicalRevision: number,
  ): QueryExecutionSnapshot {
    const entry = this.entries.get(owner);
    if (!entry) return { result: null, error: null, loading: false };
    const matches = (tagged: { signature: string; canonicalRevision: number }) =>
      tagged.signature === signature && tagged.canonicalRevision === canonicalRevision;
    return {
      // Keep the last answer visible while a changed query or graph revision is
      // waiting to run. This is the same stale-while-revalidate behaviour the
      // mounted QueryBlock had before its result acquired a session lifetime.
      result: entry.result?.value ?? null,
      error: entry.error && matches(entry.error) ? entry.error.cause : null,
      loading: Boolean(entry.pending && matches(entry.pending)),
    };
  }

  clear(owner: string): void {
    const entry = this.entries.get(owner);
    if (!entry) return;
    entry.pending = null;
    this.entries.delete(owner);
    this.bump(owner);
  }

  run(
    owner: string,
    signature: string,
    canonicalRevision: number,
    request: SparqlQueryRequest,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const entry = this.entry(owner);
    const same = (tagged: { signature: string; canonicalRevision: number }) =>
      tagged.signature === signature && tagged.canonicalRevision === canonicalRevision;

    if (entry.pending && same(entry.pending)) return entry.pending.promise;
    if (
      !options.force
      && entry.result
      && same(entry.result)
      && !(entry.error && same(entry.error))
    ) {
      // Returning to a cached identity supersedes work for an identity the
      // component no longer wants. The Promise cannot be cancelled, but its
      // token must not be allowed to replace the answer after this cache hit.
      if (entry.pending) {
        entry.pending = null;
        this.bump(owner);
      }
      this.touch(owner);
      return Promise.resolve();
    }

    const token = {};
    entry.error = null;
    const promise = this.session.query(request).then(
      (result) => {
        const current = this.entries.get(owner);
        if (current?.pending?.token !== token) return;
        current.result = { signature, canonicalRevision, value: result };
        current.error = null;
        current.pending = null;
        this.touch(owner);
        this.bump(owner);
        this.trim();
      },
      (cause: unknown) => {
        const current = this.entries.get(owner);
        if (current?.pending?.token !== token) return;
        current.error = { signature, canonicalRevision, cause };
        current.pending = null;
        this.touch(owner);
        this.bump(owner);
        this.trim();
      },
    );
    entry.pending = { signature, canonicalRevision, token, promise };
    this.touch(owner);
    this.bump(owner);
    return promise;
  }

  private entry(owner: string): QueryExecutionEntry {
    const present = this.entries.get(owner);
    if (present) return present;
    const entry = { result: null, error: null, pending: null };
    this.entries.set(owner, entry);
    return entry;
  }

  private touch(owner: string): void {
    const entry = this.entries.get(owner);
    if (!entry) return;
    this.entries.delete(owner);
    this.entries.set(owner, entry);
  }

  private bump(owner: string): void {
    this.versions.set(owner, ++this.sequence);
    for (const listener of this.listeners.get(owner) ?? []) listener();
  }

  private trim(): void {
    while (this.entries.size > MAX_CACHED_QUERIES) {
      const disposable = [...this.entries].find(([owner, entry]) =>
        !entry.pending && !this.listeners.has(owner));
      if (!disposable) return;
      this.entries.delete(disposable[0]);
      this.versions.delete(disposable[0]);
    }
  }
}

export function queryExecutionStore(session: GraphSession): QueryExecutionStore {
  const present = stores.get(session);
  if (present) return present;
  const store = new QueryExecutionStore(session);
  stores.set(session, store);
  return store;
}

export function queryExecutionSignature(request: SparqlQueryRequest): string {
  return JSON.stringify(canonical(request));
}

export function useQueryExecution(
  store: QueryExecutionStore,
  owner: string,
  signature: string,
  canonicalRevision: number,
): QueryExecutionSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(owner, listener),
    [owner, store],
  );
  const getVersion = useCallback(() => store.version(owner), [owner, store]);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return store.snapshot(owner, signature, canonicalRevision);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]);
  }
  return value;
}
