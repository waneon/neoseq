import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { GraphSession } from "../../core-port/session";
import type {
  SparqlQueryRequest,
  SparqlQueryResult,
} from "../../generated/core-port";
import { useI18n } from "../../i18n";
import { failureReason } from "../notify/errors";
import { useSession, useSessionState } from "../shell/session-context";

/** How long a change to a mounted query waits before it runs again. */
const RUN_DEBOUNCE_MS = 300;

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

  /** Resolves after every query that is currently owned by this store settles. */
  async whenIdle(): Promise<void> {
    while (true) {
      const pending = [...this.entries.values()]
        .flatMap((entry) => entry.pending ? [entry.pending.promise] : []);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
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

/**
 * One answer, kept current.
 *
 * Every surface that asks the graph a question wants the same four things and
 * the same timing: a cached answer painted synchronously, a missing one fetched
 * at once, a changed one coalesced, and the failure read into the reader's own
 * language. The query surface and the editor that authors a standing journal
 * question share this so the count under a journal and the count beside its
 * editor are the same execution rather than two of them.
 *
 * `request` must be memoized by the caller: it is the query's identity here.
 */
export interface QueryAnswer {
  result: SparqlQueryResult | null;
  /** The failure, already read into words. */
  error: string | null;
  loading: boolean;
  /** Runs it now, past the debounce — what `Mod+Enter` in a source editor does. */
  run: (force?: boolean) => void;
}

export function useQueryAnswer(key: string, request: SparqlQueryRequest): QueryAnswer {
  const session = useSession();
  const state = useSessionState();
  const { message } = useI18n();
  const store = queryExecutionStore(session);
  const revision = state.canonicalRevision;
  const signature = useMemo(() => queryExecutionSignature(request), [request]);
  // A blank source is a query nobody has written yet, not a parse failure — it
  // stays quietly at "not run" instead of opening on an error.
  const executable = request.source.trim().length > 0;

  const snapshot = useQueryExecution(store, key, signature, revision);
  const run = useCallback((force = false) => {
    if (!executable) {
      store.clear(key);
      return;
    }
    void store.run(key, signature, revision, request, { force });
  }, [executable, key, request, revision, signature, store]);

  const previous = useRef<{ key: string; identity: string } | null>(null);
  useEffect(() => {
    const identity = JSON.stringify([signature, revision]);
    const last = previous.current;
    previous.current = { key, identity };
    if (!executable) {
      store.clear(key);
      return;
    }
    // Activation is a demand read: a fresh cached answer renders synchronously,
    // while a missing or stale one starts immediately. Only a change observed by
    // an already-mounted query is a stream worth coalescing.
    if (!last || last.key !== key) {
      run();
      return;
    }
    // StrictMode repeats an effect setup without changing its input. The store
    // also deduplicates in-flight work, but avoiding the timer makes the intent
    // explicit and keeps a failed activation from becoming an automatic retry.
    if (last.identity === identity) return;
    const timer = window.setTimeout(run, RUN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [executable, key, revision, run, signature, store]);

  return {
    result: executable ? snapshot.result : null,
    error: executable && snapshot.error !== null
      ? failureReason(snapshot.error, message)
      : null,
    loading: executable && snapshot.loading,
    run,
  };
}
