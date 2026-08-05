import type { CorePortErrorCode } from "../generated/core-port";

export const DIAGNOSTIC_ARTIFACT_SCHEMA = 1 as const;
export const DIAGNOSTIC_CAPTURE_POLICY = 1 as const;

export type DiagnosticSource =
  | "ui"
  | "session"
  | "adapter"
  | "worker"
  | "core"
  | "query"
  | "storage";

export type DiagnosticFamily = "interaction" | "span" | "state" | "metric" | "error" | "marker";
export type DiagnosticOutcome = "ok" | "error" | "cancelled";
export type LengthBucket = "0" | "1-16" | "17-64" | "65-256" | "257-1024" | "1025+";

export type DiagnosticOperation =
  | "session.open"
  | "session.execute"
  | "session.query"
  | "session.hydrate_page"
  | "session.reconcile"
  | "session.retry"
  | "session.close"
  | "adapter.open_graph"
  | "adapter.execute"
  | "adapter.read"
  | "adapter.read_page"
  | "adapter.query"
  | "adapter.subscribe"
  | "adapter.close_graph"
  | "adapter.retry_pending"
  | "adapter.list_graphs"
  | "adapter.delete_graph"
  | "worker.operation"
  | "core.open"
  | "core.execute"
  | "core.read"
  | "core.read_page"
  | "core.query"
  | "core.subscribe"
  | "core.snapshot"
  | "storage.open"
  | "storage.recover"
  | "storage.append"
  | "storage.checkpoint"
  | "storage.compact"
  | "storage.delete"
  | "storage.capabilities";

export interface DiagnosticAttributes {
  readonly operation?: string;
  readonly command_type?: string;
  readonly entity_kind?: "page" | "block" | "tag" | "graph" | "none";
  readonly property_kind?: "well_known" | "custom" | "none";
  readonly text_length?: LengthBucket;
  readonly source_length?: LengthBucket;
  readonly insert_length?: LengthBucket;
  readonly delete_length?: LengthBucket;
  readonly payload_size?: LengthBucket;
  readonly binding_count?: number;
  readonly page_count?: number;
  readonly hydrated_page_count?: number;
  readonly tag_count?: number;
  readonly quarantined_count?: number;
  readonly queue_depth?: number;
  readonly save_state?: "saved" | "saving" | "unsaved";
  readonly session_status?: "opening" | "ready" | "error" | "closed";
  readonly lease_mode?: "exclusive" | "readonly";
  readonly route_kind?: "graph_picker" | "journal" | "page" | "settings" | "other";
  readonly render_phase?: "mount" | "update" | "nested-update";
  readonly error_code?: CorePortErrorCode | "worker_error" | "storage_unavailable";
  readonly retryable?: boolean;
  readonly result_kind?: string;
  readonly record_count?: number;
  readonly byte_count?: number;
  readonly dropped_count?: number;
  readonly recovered?: boolean;
  readonly reason?: "user" | "limit" | "crash";
}

export interface DiagnosticRecord {
  readonly schema_version: typeof DIAGNOSTIC_ARTIFACT_SCHEMA;
  readonly sequence: number;
  readonly monotonic_ms: number;
  readonly family: DiagnosticFamily;
  readonly source: DiagnosticSource;
  readonly name: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly parent_span_id?: string;
  readonly duration_ms?: number;
  readonly outcome?: DiagnosticOutcome;
  readonly attributes: DiagnosticAttributes;
  /** The only user-authored free-form field in a standard artifact. */
  readonly annotation?: string;
}

export interface DiagnosticTraceContext {
  readonly trace_id: string;
  readonly span_id: string;
}

export interface WorkerDiagnosticContext {
  readonly trace_id: string;
  readonly parent_span_id: string;
}

export interface WorkerDiagnosticSpan {
  readonly trace_id: string;
  readonly source: Extract<DiagnosticSource, "worker" | "core" | "query" | "storage">;
  readonly name: DiagnosticOperation;
  readonly span_id: string;
  readonly parent_span_id: string;
  readonly started_offset_ms: number;
  readonly duration_ms: number;
  readonly outcome: DiagnosticOutcome;
  readonly attributes?: DiagnosticAttributes;
}

export interface DiagnosticLimits {
  readonly max_duration_ms: number;
  readonly max_bytes: number;
  readonly max_records: number;
}

export const DEFAULT_DIAGNOSTIC_LIMITS: DiagnosticLimits = {
  max_duration_ms: 15 * 60 * 1_000,
  max_bytes: 20 * 1024 * 1024,
  max_records: 50_000,
};

export interface PersistedDiagnosticSession {
  readonly recording_id: string;
  readonly phase: "recording" | "review";
  readonly started_at: string;
  readonly started_monotonic_ms: number;
  readonly stopped_at?: string;
  readonly stop_reason?: "user" | "limit" | "crash";
  readonly byte_count: number;
  readonly record_count: number;
  readonly dropped_count: number;
  readonly limits: DiagnosticLimits;
}

export interface DiagnosticReview {
  readonly session: PersistedDiagnosticSession;
  readonly records: readonly DiagnosticRecord[];
  readonly recovered: boolean;
}

export type DiagnosticsPhase = "idle" | "consent" | "recording" | "finalizing" | "review";

export interface DiagnosticsViewState {
  readonly phase: DiagnosticsPhase;
  readonly active: PersistedDiagnosticSession | null;
  readonly review: DiagnosticReview | null;
  readonly review_open: boolean;
  readonly crash_recovery_available: boolean;
  readonly storage_warning: boolean;
}

export interface DiagnosticArtifactResult {
  readonly blob: Blob;
  readonly filename: string;
  readonly manifest: Record<string, unknown>;
  readonly files: ReadonlyMap<string, Uint8Array>;
}
