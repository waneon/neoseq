import type { CorePortErrorCode, SparqlQueryRequest } from "../generated/core-port";
import type { Command } from "../core-port/commands";
import type { GraphSnapshot } from "../core-port/snapshot";
import { commandAttributes, queryAttributes } from "./redaction";
import { IndexedDbDiagnosticStore, type DiagnosticStore } from "./store";
import {
  DEFAULT_DIAGNOSTIC_LIMITS,
  DIAGNOSTIC_ARTIFACT_SCHEMA,
  type DiagnosticAttributes,
  type DiagnosticLimits,
  type DiagnosticOperation,
  type DiagnosticOutcome,
  type DiagnosticRecord,
  type DiagnosticsViewState,
  type DiagnosticTraceContext,
  type PersistedDiagnosticSession,
  type WorkerDiagnosticContext,
  type WorkerDiagnosticSpan,
} from "./types";

const encoder = new TextEncoder();
const FLUSH_INTERVAL_MS = 500;
// Keep room for a final limit marker so a capped recording explains its own gap.
const LIMIT_MARKER_RESERVE_BYTES = 1_024;

export interface DiagnosticSpanHandle {
  readonly context: DiagnosticTraceContext | null;
  readonly started_monotonic_ms: number;
  end(outcome?: DiagnosticOutcome, attributes?: DiagnosticAttributes): void;
  fail(error: unknown): void;
}

export class DiagnosticsCoordinator {
  private readonly listeners = new Set<() => void>();
  private state: DiagnosticsViewState = {
    phase: "idle",
    active: null,
    review: null,
    review_open: false,
    crash_recovery_available: false,
    storage_warning: false,
  };
  private session: PersistedDiagnosticSession | null = null;
  private records: DiagnosticRecord[] = [];
  private pending: DiagnosticRecord[] = [];
  private nextSequence = 1;
  private flushTimer: number | null = null;
  private limitTimer: number | null = null;
  private observer: PerformanceObserver | null = null;
  private activeContext: DiagnosticTraceContext | null = null;
  private stopping = false;

  constructor(
    private readonly store: DiagnosticStore = new IndexedDbDiagnosticStore(),
    private readonly limits: DiagnosticLimits = DEFAULT_DIAGNOSTIC_LIMITS,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): DiagnosticsViewState => this.state;

  requestStart(): void {
    if (this.state.phase !== "idle") return;
    this.patch({ phase: "consent" });
  }

  cancelStart(): void {
    if (this.state.phase === "consent") this.patch({ phase: "idle" });
  }

  async start(): Promise<void> {
    if (this.state.phase !== "consent" && this.state.phase !== "idle") return;
    const startedAt = new Date().toISOString();
    this.records = [];
    this.pending = [];
    this.nextSequence = 1;
    this.stopping = false;
    this.session = {
      recording_id: crypto.randomUUID(),
      phase: "recording",
      started_at: startedAt,
      started_monotonic_ms: performance.now(),
      byte_count: 0,
      record_count: 0,
      dropped_count: 0,
      limits: this.limits,
    };
    this.patch({
      phase: "recording",
      active: this.session,
      review: null,
      review_open: false,
      crash_recovery_available: true,
      storage_warning: false,
    });
    this.append("marker", "ui", "recording_started", {});
    try {
      await this.store.saveSession(this.session);
      this.scheduleFlush();
    } catch {
      this.patch({ crash_recovery_available: false, storage_warning: true });
    }
    this.startLongTaskObserver();
    this.limitTimer = window.setTimeout(() => void this.stop("limit"), this.limits.max_duration_ms);
  }

  async recover(): Promise<void> {
    if (this.state.phase !== "idle") return;
    try {
      const stored = await this.store.loadRecoverable();
      if (!stored) return;
      this.records = stored.records;
      this.pending = [];
      this.nextSequence = (this.records.at(-1)?.sequence ?? 0) + 1;
      const lastMonotonic = this.records.at(-1)?.monotonic_ms ?? 0;
      const recoveredRecord: DiagnosticRecord = {
        schema_version: DIAGNOSTIC_ARTIFACT_SCHEMA,
        sequence: this.nextSequence++,
        monotonic_ms: lastMonotonic,
        family: "marker",
        source: "ui",
        name: "recording_recovered",
        attributes: { recovered: true, reason: "crash" },
      };
      this.records.push(recoveredRecord);
      const session = {
        ...stored.session,
        phase: "review" as const,
        stopped_at: stored.session.stopped_at ?? new Date().toISOString(),
        stop_reason: stored.session.stop_reason ?? "crash" as const,
        record_count: this.records.length,
        byte_count: stored.session.byte_count + encodedSize(recoveredRecord),
      };
      this.session = session;
      await this.store.appendRecords(session.recording_id, [recoveredRecord]);
      await this.store.saveSession(session);
      this.patch({
        phase: "review",
        active: null,
        review: { session, records: [...this.records], recovered: true },
        review_open: true,
        crash_recovery_available: true,
      });
    } catch {
      this.patch({ storage_warning: true, crash_recovery_available: false });
    }
  }

  async stop(reason: "user" | "limit" = "user"): Promise<void> {
    if (this.state.phase !== "recording" || !this.session || this.stopping) return;
    this.stopping = true;
    this.append("marker", "ui", reason === "limit" ? "recording_limit_reached" : "recording_stopped", {
      reason,
      record_count: this.session.record_count,
      byte_count: this.session.byte_count,
      dropped_count: this.session.dropped_count,
    }, true);
    this.clearRuntimeObservers();
    const session: PersistedDiagnosticSession = {
      ...this.session,
      phase: "review",
      stopped_at: new Date().toISOString(),
      stop_reason: reason,
      record_count: this.records.length,
    };
    this.session = session;
    this.patch({ phase: "finalizing", active: session });
    await this.flush().catch(() => {
      this.patch({ storage_warning: true, crash_recovery_available: false });
    });
    await this.store.saveSession(session).catch(() => {
      this.patch({ storage_warning: true, crash_recovery_available: false });
    });
    this.patch({
      phase: "review",
      active: null,
      review: { session, records: [...this.records], recovered: false },
      review_open: true,
    });
    this.stopping = false;
  }

  async discard(): Promise<void> {
    const recordingId = this.session?.recording_id ?? this.state.review?.session.recording_id;
    this.clearRuntimeObservers();
    if (recordingId) await this.store.deleteRecording(recordingId).catch(() => undefined);
    this.session = null;
    this.records = [];
    this.pending = [];
    this.nextSequence = 1;
    this.stopping = false;
    this.patch({
      phase: "idle",
      active: null,
      review: null,
      review_open: false,
      crash_recovery_available: false,
      storage_warning: false,
    });
  }

  showReview(): void {
    if (this.state.phase === "review" && this.state.review) this.patch({ review_open: true });
  }

  hideReview(): void {
    if (this.state.phase === "review") this.patch({ review_open: false });
  }

  recordCommand(command: Command): void {
    this.append("interaction", "ui", "command", commandAttributes(command));
  }

  recordQuery(query: SparqlQueryRequest): void {
    this.append("interaction", "ui", "query", queryAttributes(query));
  }

  recordRoute(routeKind: NonNullable<DiagnosticAttributes["route_kind"]>): void {
    this.append("state", "ui", "route", { route_kind: routeKind });
  }

  recordSessionState(snapshot: GraphSnapshot, attributes: DiagnosticAttributes): void {
    this.append("state", "session", "session_state", {
      ...attributes,
      page_count: snapshot.pages.length,
      tag_count: snapshot.tags.length,
      quarantined_count: snapshot.quarantined.length,
    });
  }

  recordRender(durationMs: number, phase: "mount" | "update" | "nested-update"): void {
    this.append("metric", "ui", "render_commit", { render_phase: phase }, false, durationMs);
  }

  recordError(source: "session" | "adapter", error: unknown, operation: string): void {
    const detail = safeError(error);
    this.append("error", source, "operation_failed", {
      operation,
      error_code: detail.code,
      retryable: detail.retryable,
    });
  }

  startSpan(
    source: "session" | "adapter",
    name: DiagnosticOperation,
    attributes: DiagnosticAttributes = {},
  ): DiagnosticSpanHandle {
    const started = performance.now();
    if (this.state.phase !== "recording") return noopSpan(started);
    const parent = this.activeContext;
    const context: DiagnosticTraceContext = {
      trace_id: parent?.trace_id ?? crypto.randomUUID(),
      span_id: crypto.randomUUID(),
    };
    let ended = false;
    return {
      context,
      started_monotonic_ms: started,
      end: (outcome = "ok", completion = {}) => {
        if (ended) return;
        ended = true;
        this.appendSpan(source, name, context, parent?.span_id, started, outcome, {
          ...attributes,
          ...completion,
        });
      },
      fail: (error) => {
        if (ended) return;
        const detail = safeError(error);
        this.recordError(source, error, name);
        ended = true;
        this.appendSpan(source, name, context, parent?.span_id, started, "error", {
          ...attributes,
          error_code: detail.code,
          retryable: detail.retryable,
        });
      },
    };
  }

  withContext<T>(context: DiagnosticTraceContext | null, run: () => T): T {
    const previous = this.activeContext;
    this.activeContext = context;
    try {
      return run();
    } finally {
      this.activeContext = previous;
    }
  }

  workerContext(parent: DiagnosticTraceContext | null): WorkerDiagnosticContext | undefined {
    return parent ? { trace_id: parent.trace_id, parent_span_id: parent.span_id } : undefined;
  }

  ingestWorkerSpans(spans: readonly WorkerDiagnosticSpan[] | undefined, adapterStarted: number): void {
    if (!spans || this.state.phase !== "recording" || !this.session) return;
    for (const span of spans) {
      this.appendRecord({
        schema_version: DIAGNOSTIC_ARTIFACT_SCHEMA,
        sequence: this.nextSequence,
        monotonic_ms: Math.max(
          0,
          adapterStarted - this.session.started_monotonic_ms + span.started_offset_ms,
        ),
        family: "span",
        source: span.source,
        name: span.name,
        span_id: span.span_id,
        parent_span_id: span.parent_span_id,
        duration_ms: rounded(span.duration_ms),
        outcome: span.outcome,
        attributes: span.attributes ?? {},
      }, span.trace_id);
    }
  }

  /** Test-only read; returns only already-redacted records. */
  recordsForTesting(): readonly DiagnosticRecord[] {
    return this.records;
  }

  private appendSpan(
    source: "session" | "adapter",
    name: DiagnosticOperation,
    context: DiagnosticTraceContext,
    parentSpanId: string | undefined,
    started: number,
    outcome: DiagnosticOutcome,
    attributes: DiagnosticAttributes,
  ): void {
    if (!this.session) return;
    this.appendRecord({
      schema_version: DIAGNOSTIC_ARTIFACT_SCHEMA,
      sequence: this.nextSequence,
      monotonic_ms: Math.max(0, started - this.session.started_monotonic_ms),
      family: "span",
      source,
      name,
      trace_id: context.trace_id,
      span_id: context.span_id,
      parent_span_id: parentSpanId,
      duration_ms: rounded(performance.now() - started),
      outcome,
      attributes,
    });
  }

  private append(
    family: DiagnosticRecord["family"],
    source: DiagnosticRecord["source"],
    name: string,
    attributes: DiagnosticAttributes,
    force = false,
    durationMs?: number,
  ): void {
    if ((!force && this.state.phase !== "recording") || !this.session) return;
    this.appendRecord({
      schema_version: DIAGNOSTIC_ARTIFACT_SCHEMA,
      sequence: this.nextSequence,
      monotonic_ms: Math.max(0, performance.now() - this.session.started_monotonic_ms),
      family,
      source,
      name,
      duration_ms: durationMs === undefined ? undefined : rounded(durationMs),
      attributes,
    }, undefined, force);
  }

  private appendRecord(input: DiagnosticRecord, traceId?: string, force = false): void {
    if (!this.session) return;
    const record = traceId ? { ...input, trace_id: traceId } : input;
    const size = encodedSize(record);
    const recordLimit = force
      ? this.limits.max_records
      : Math.max(0, this.limits.max_records - 1);
    const byteLimit = force
      ? this.limits.max_bytes
      : Math.max(0, this.limits.max_bytes - LIMIT_MARKER_RESERVE_BYTES);
    if (this.records.length >= recordLimit || this.session.byte_count + size > byteLimit) {
      this.session = { ...this.session, dropped_count: this.session.dropped_count + 1 };
      if (!this.stopping) void this.stop("limit");
      return;
    }
    this.nextSequence += 1;
    this.records.push(record);
    this.pending.push(record);
    this.session = {
      ...this.session,
      record_count: this.records.length,
      byte_count: this.session.byte_count + size,
    };
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || !this.session || !this.state.crash_recovery_available) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => {
        this.patch({ storage_warning: true, crash_recovery_available: false });
      });
    }, FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (!this.session) return;
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.pending;
    this.pending = [];
    try {
      await this.store.appendRecords(this.session.recording_id, batch);
      await this.store.saveSession(this.session);
    } catch (error) {
      this.pending = [...batch, ...this.pending];
      throw error;
    }
  }

  private startLongTaskObserver(): void {
    if (
      typeof PerformanceObserver === "undefined" ||
      !(PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false)
    ) return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.append("metric", "ui", "long_task", {}, false, entry.duration);
        }
      });
      this.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      this.observer = null;
    }
  }

  private clearRuntimeObservers(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    if (this.limitTimer !== null) window.clearTimeout(this.limitTimer);
    this.flushTimer = null;
    this.limitTimer = null;
    this.observer?.disconnect();
    this.observer = null;
  }

  private patch(partial: Partial<DiagnosticsViewState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

export const diagnostics = new DiagnosticsCoordinator();

function encodedSize(record: DiagnosticRecord): number {
  return encoder.encode(JSON.stringify(record)).length + 1;
}

function rounded(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function safeError(error: unknown): {
  code: CorePortErrorCode | "worker_error";
  retryable: boolean;
} {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { detail?: { code?: CorePortErrorCode; retryable?: boolean } }).detail;
    if (detail?.code) return { code: detail.code, retryable: detail.retryable ?? false };
  }
  return { code: "worker_error", retryable: false };
}

function noopSpan(started: number): DiagnosticSpanHandle {
  return { context: null, started_monotonic_ms: started, end: () => {}, fail: () => {} };
}
