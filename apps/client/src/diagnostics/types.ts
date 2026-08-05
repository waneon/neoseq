import type { CorePortErrorCode } from "../generated/core-port";
import type { SparqlQueryRequest } from "../generated/core-port";
import type { Command } from "../core-port/commands";
import type { GraphSnapshot, PageSnapshot, TagSnapshot } from "../core-port/snapshot";

export const DIAGNOSTIC_ARTIFACT_SCHEMA = 1 as const;
export const DIAGNOSTIC_CAPTURE_POLICY = 3 as const;
export const SENSITIVE_PAYLOAD_SCHEMA = 1 as const;

export const DIAGNOSTIC_CAPABILITIES = [
  "ui.action-correlation.v1",
  "ui.feature-checkpoint.v1",
  "ui.editor-relationship.v1",
  "session.reconcile-detail.v1",
  "worker.core-result-detail.v1",
  "storage.boundary-span.v1",
  "query.result-shape.v1",
] as const;

export type DiagnosticCaptureLevel = "standard" | "enhanced";
export type EnhancedCaptureScope = "active_page" | "touched_entities" | "full_graph";
export type SensitiveCategory = "graph_data" | "query_text";

export type DiagnosticCapturePolicy =
  | { readonly level: "standard" }
  | {
      readonly level: "enhanced";
      readonly scope: EnhancedCaptureScope;
      readonly categories: readonly SensitiveCategory[];
    };

export const STANDARD_CAPTURE_POLICY = { level: "standard" } as const satisfies DiagnosticCapturePolicy;
export const DEFAULT_ENHANCED_CAPTURE_POLICY = {
  level: "enhanced",
  scope: "active_page",
  categories: ["graph_data", "query_text"],
} as const satisfies DiagnosticCapturePolicy;

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
export type ValueRelation = "equal" | "different" | "missing" | "unknown";
export type DiagnosticInputMethod =
  | "keyboard"
  | "pointer"
  | "context_menu"
  | "palette"
  | "automatic"
  | "programmatic"
  | "unknown";
export type DiagnosticFeature =
  | "outline"
  | "query"
  | "command_layer"
  | "navigation"
  | "settings"
  | "graph"
  | "domain";
export type DiagnosticActionName =
  | "delete_selection"
  | "indent_selection"
  | "outdent_selection"
  | "move_selection"
  | "insert_block"
  | "undo"
  | "redo"
  | "run_query"
  | "execute_command";
export type DiagnosticCheckpointPhase = "before" | "after" | "failed";

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
  readonly action_id?: string;
  readonly feature?: DiagnosticFeature;
  readonly action?: DiagnosticActionName;
  readonly input_method?: DiagnosticInputMethod;
  readonly checkpoint_phase?: DiagnosticCheckpointPhase;
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
  readonly checkpoint_sequence?: number;
  readonly replayed_update_count?: number;
  readonly queue_depth?: number;
  readonly pending_command_count?: number;
  readonly requested_target_count?: number;
  readonly normalized_root_count?: number;
  readonly affected_block_count?: number;
  readonly explicit_selection_count?: number;
  readonly covered_selection_count?: number;
  readonly selection_root_count?: number;
  readonly visible_row_count?: number;
  readonly collapsed_count?: number;
  readonly pending_row_count?: number;
  readonly pending_intent_count?: number;
  readonly focus_kind?: "none" | "editor" | "pending_editor" | "selection";
  readonly event_count?: number;
  readonly page_read_count?: number;
  readonly cursor_before?: number;
  readonly cursor_after?: number;
  readonly resync_required?: boolean;
  readonly reconcile_fallback?: boolean;
  readonly snapshot_revision?: number;
  readonly changed?: boolean;
  readonly duplicate?: boolean;
  readonly semantic_kind?: string;
  readonly subject_token?: string;
  readonly checkpoint?: "flush" | "reconcile";
  readonly focused?: boolean;
  readonly composing?: boolean;
  readonly draft_state?: "absent" | "clean" | "dirty";
  readonly draft_length?: LengthBucket;
  readonly authoritative_length?: LengthBucket;
  readonly draft_baseline_relation?: ValueRelation;
  readonly draft_authoritative_relation?: ValueRelation;
  readonly save_state?: "saved" | "saving" | "unsaved";
  readonly session_status?: "opening" | "ready" | "error" | "closed";
  readonly lease_mode?: "exclusive" | "readonly";
  readonly route_kind?: "graph_picker" | "journal" | "page" | "settings" | "other";
  readonly render_phase?: "mount" | "update" | "nested-update";
  readonly error_code?: CorePortErrorCode | "worker_error" | "storage_unavailable";
  readonly retryable?: boolean;
  readonly result_kind?: string;
  readonly result_row_count?: number;
  readonly result_column_count?: number;
  readonly result_revision?: number;
  readonly stale_result?: boolean;
  readonly record_count?: number;
  readonly byte_count?: number;
  readonly dropped_count?: number;
  readonly recovered?: boolean;
  readonly reason?: "user" | "limit" | "crash";
  readonly capture_level?: DiagnosticCaptureLevel;
  readonly sensitive_record_count?: number;
  readonly sensitive_byte_count?: number;
  readonly omission_reason?: "outside_scope" | "missing_graph_context";
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

export interface DiagnosticActionContext {
  readonly action_id: string;
  readonly trace_id: string;
}

export interface DiagnosticActionInput {
  readonly feature: DiagnosticFeature;
  readonly action: DiagnosticActionName;
  readonly input_method: DiagnosticInputMethod;
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
  readonly max_sensitive_bytes: number;
  readonly max_records: number;
}

export const DEFAULT_DIAGNOSTIC_LIMITS: DiagnosticLimits = {
  max_duration_ms: 15 * 60 * 1_000,
  max_bytes: 20 * 1024 * 1024,
  max_sensitive_bytes: 50 * 1024 * 1024,
  max_records: 50_000,
};

interface SensitivePayloadBase {
  readonly schema_version: typeof SENSITIVE_PAYLOAD_SCHEMA;
  readonly payload_id: string;
  readonly monotonic_ms: number;
  readonly action_id?: string;
}

export type SensitiveDiagnosticPayload =
  | (SensitivePayloadBase & {
      readonly kind: "command";
      readonly command: Command;
    })
  | (SensitivePayloadBase & {
      readonly kind: "query";
      readonly query: SparqlQueryRequest;
    })
  | (SensitivePayloadBase & {
      readonly kind: "page_snapshot";
      readonly stage: "initial" | "before" | "reconcile" | "final";
      readonly revision: number;
      readonly page: PageSnapshot;
    })
  | (SensitivePayloadBase & {
      readonly kind: "graph_snapshot";
      readonly stage: "initial" | "reconcile" | "final";
      readonly revision: number;
      readonly snapshot: GraphSnapshot;
    })
  | (SensitivePayloadBase & {
      readonly kind: "tag_snapshot";
      readonly stage: "before" | "reconcile" | "final";
      readonly revision: number;
      readonly tag: TagSnapshot;
    });

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
  readonly capture_policy: DiagnosticCapturePolicy;
  readonly sensitive_byte_count: number;
  readonly sensitive_record_count: number;
  readonly sensitive_truncated: boolean;
  readonly limits: DiagnosticLimits;
}

export interface DiagnosticReview {
  readonly session: PersistedDiagnosticSession;
  readonly records: readonly DiagnosticRecord[];
  readonly sensitive_payloads: readonly SensitiveDiagnosticPayload[];
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
