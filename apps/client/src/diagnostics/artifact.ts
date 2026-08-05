import { CORE_PORT_VERSION } from "../generated/core-port";
import {
  DIAGNOSTIC_ARTIFACT_SCHEMA,
  DIAGNOSTIC_CAPTURE_POLICY,
  DIAGNOSTIC_CAPABILITIES,
  type DiagnosticArtifactResult,
  type DiagnosticRecord,
  type DiagnosticReview,
  type SensitiveDiagnosticPayload,
} from "./types";
import { createZip } from "./zip";

const encoder = new TextEncoder();

export async function buildDiagnosticArtifact(
  review: DiagnosticReview,
  annotation = "",
  options: { readonly includeSensitive?: boolean } = {},
): Promise<DiagnosticArtifactResult> {
  const records = [...review.records];
  const note = annotation.trim();
  if (note) {
    records.push({
      schema_version: DIAGNOSTIC_ARTIFACT_SCHEMA,
      sequence: (records.at(-1)?.sequence ?? 0) + 1,
      monotonic_ms: records.at(-1)?.monotonic_ms ?? 0,
      family: "marker",
      source: "ui",
      name: "user_annotation",
      attributes: {},
      annotation: note,
    });
  }
  validateRecordContract(records);

  const streams = {
    events: records.filter((record) => record.family !== "metric" && record.family !== "error"),
    metrics: records.filter((record) => record.family === "metric"),
    errors: records.filter((record) => record.family === "error"),
  };
  const includeSensitive = review.session.capture_policy.level === "enhanced" &&
    options.includeSensitive === true && review.sensitive_payloads.length > 0;
  const summary = buildSummary(records, review, includeSensitive);
  const inventory = [
    ["manifest.json", "diagnostic_metadata"],
    ["summary.json", "diagnostic_metadata"],
    ["events.jsonl", note ? "contains_user_annotation" : "diagnostic_metadata"],
    ["metrics.jsonl", "diagnostic_metadata"],
    ["errors.jsonl", "diagnostic_metadata"],
    ["schemas/manifest.schema.json", "schema"],
    ["schemas/record.schema.json", "schema"],
    ...(includeSensitive
      ? [
          ["sensitive/content.jsonl", "sensitive_user_content"],
          ["schemas/sensitive-record.schema.json", "schema"],
        ]
      : []),
    ["README.md", "instructions"],
    ["checksums.sha256", "integrity"],
  ].map(([path, classification]) => ({ path, classification }));
  const manifest = {
    artifact_schema_version: DIAGNOSTIC_ARTIFACT_SCHEMA,
    capture_policy_version: DIAGNOSTIC_CAPTURE_POLICY,
    media_type: "application/vnd.neoseq.bug+zip",
    recording_id: review.session.recording_id,
    started_at: review.session.started_at,
    stopped_at: review.session.stopped_at,
    duration_ms: durationMs(review),
    stop_reason: review.session.stop_reason,
    recovered: review.recovered,
    redaction_level: review.session.capture_policy.level,
    capture_policy: review.session.capture_policy,
    contains_user_content: note.length > 0 || includeSensitive,
    contains_sensitive_content: includeSensitive,
    application: {
      name: "Neoseq",
      version: appVersion(),
      build_id: buildId(),
      core_port_version: CORE_PORT_VERSION,
      document_schema_version: 3,
      adapter: "web-worker",
    },
    environment: safeEnvironment(),
    instrumentation: {
      ui: true,
      react_profiler: true,
      session: true,
      worker: true,
      core: true,
      query: true,
      indexeddb: true,
      long_tasks: supportsLongTasks(),
      native: false,
      sync_server: false,
      capabilities: DIAGNOSTIC_CAPABILITIES,
      observed: observedCapabilities(records),
    },
    limits: review.session.limits,
    record_count: records.length,
    byte_count_before_zip: review.session.byte_count,
    dropped_count: review.session.dropped_count,
    sensitive_record_count: includeSensitive ? review.sensitive_payloads.length : 0,
    sensitive_byte_count: includeSensitive ? review.session.sensitive_byte_count : 0,
    sensitive_truncated: review.session.sensitive_truncated,
    truncated: review.session.stop_reason === "limit",
    clock: { wall_boundary: "utc", event_clock: "window.performance.monotonic_ms" },
    files: inventory,
  };

  const files = new Map<string, Uint8Array>();
  files.set("manifest.json", json(manifest));
  files.set("summary.json", json(summary));
  files.set("events.jsonl", jsonLines(streams.events));
  files.set("metrics.jsonl", jsonLines(streams.metrics));
  files.set("errors.jsonl", jsonLines(streams.errors));
  files.set("schemas/manifest.schema.json", json(MANIFEST_SCHEMA));
  files.set("schemas/record.schema.json", json(RECORD_SCHEMA));
  if (includeSensitive) {
    files.set("sensitive/content.jsonl", jsonLines(review.sensitive_payloads));
    files.set("schemas/sensitive-record.schema.json", json(SENSITIVE_RECORD_SCHEMA));
  }
  files.set("README.md", encoder.encode(readme(manifest)));

  const checksums: string[] = [];
  for (const [path, data] of files) checksums.push(`${await sha256(data)}  ${path}`);
  files.set("checksums.sha256", encoder.encode(`${checksums.join("\n")}\n`));
  const zip = createZip(files);
  const zipBuffer = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
  const stamp = review.session.started_at.replace(/[:.]/g, "-");
  return {
    blob: new Blob([zipBuffer], { type: "application/vnd.neoseq.bug+zip" }),
    filename: `neoseq-diagnostic-${stamp}.neoseq-bug`,
    manifest,
    files,
  };
}

export function downloadDiagnosticArtifact(result: DiagnosticArtifactResult): void {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildSummary(
  records: readonly DiagnosticRecord[],
  review: DiagnosticReview,
  includeSensitive: boolean,
) {
  const errorCounts = new Map<string, number>();
  for (const record of records) {
    if (record.family !== "error") continue;
    const code = record.attributes.error_code ?? "unknown";
    errorCounts.set(code, (errorCounts.get(code) ?? 0) + 1);
  }
  const slowest = records
    .filter((record) => record.family === "span" && typeof record.duration_ms === "number")
    .sort((left, right) => (right.duration_ms ?? 0) - (left.duration_ms ?? 0))
    .slice(0, 10)
    .map((record) => ({
      sequence: record.sequence,
      trace_id: record.trace_id,
      source: record.source,
      name: record.name,
      duration_ms: record.duration_ms,
      outcome: record.outcome,
    }));
  const quality = diagnosticQuality(records);
  return {
    duration_ms: durationMs(review),
    record_count: records.length,
    dropped_count: review.session.dropped_count,
    recovered: review.recovered,
    error_counts: Object.fromEntries([...errorCounts].sort(([left], [right]) => left.localeCompare(right))),
    slowest_spans: slowest,
    gaps: [
      ...(review.session.dropped_count > 0 ? ["records_dropped"] : []),
      ...(quality.unlinked_action_count > 0 ? ["unlinked_actions"] : []),
      ...(quality.incomplete_action_count > 0 ? ["incomplete_actions"] : []),
      ...(quality.sensitive_omission_count > 0 ? ["sensitive_payloads_omitted"] : []),
    ],
    diagnostic_quality: quality,
    sensitive: {
      captured_record_count: review.session.sensitive_record_count,
      exported_record_count: includeSensitive ? review.sensitive_payloads.length : 0,
      truncated: review.session.sensitive_truncated,
    },
  };
}

function diagnosticQuality(records: readonly DiagnosticRecord[]) {
  const actions = new Set(
    records
      .filter((record) => record.name === "action")
      .map((record) => record.attributes.action_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const linked = new Set(
    records
      .filter((record) => record.name === "command" || record.name === "query")
      .map((record) => record.attributes.action_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const completed = new Set(
    records
      .filter((record) =>
        record.name === "feature_checkpoint" &&
        (record.attributes.checkpoint_phase === "after" ||
          record.attributes.checkpoint_phase === "failed"))
      .map((record) => record.attributes.action_id)
      .filter((id): id is string => typeof id === "string"),
  );
  return {
    action_count: actions.size,
    unlinked_action_count: [...actions].filter((id) => !linked.has(id)).length,
    incomplete_action_count: [...actions].filter((id) => !completed.has(id)).length,
    sensitive_omission_count: records.filter(
      (record) => record.name === "sensitive_payload_omitted",
    ).length,
  };
}

function observedCapabilities(records: readonly DiagnosticRecord[]): string[] {
  const observed = new Set<string>();
  if (records.some((record) => record.name === "action")) observed.add("ui.action-correlation.v1");
  if (records.some((record) => record.name === "feature_checkpoint")) observed.add("ui.feature-checkpoint.v1");
  if (records.some((record) => record.name === "editor_state")) observed.add("ui.editor-relationship.v1");
  if (records.some((record) => record.name === "session.reconcile" && record.attributes.event_count !== undefined)) {
    observed.add("session.reconcile-detail.v1");
  }
  if (records.some((record) => record.name === "core.execute" && record.attributes.semantic_kind !== undefined)) {
    observed.add("worker.core-result-detail.v1");
  }
  if (records.some((record) => record.source === "storage" && record.family === "span")) {
    observed.add("storage.boundary-span.v1");
  }
  if (records.some((record) => record.name === "session.query" && record.attributes.result_row_count !== undefined)) {
    observed.add("query.result-shape.v1");
  }
  return [...observed].sort();
}

function durationMs(review: DiagnosticReview): number {
  if (review.recovered) {
    return Math.max(0, Math.round(review.records.at(-1)?.monotonic_ms ?? 0));
  }
  const stopped = review.session.stopped_at ? Date.parse(review.session.stopped_at) : Date.now();
  return Math.max(0, stopped - Date.parse(review.session.started_at));
}

function safeEnvironment() {
  const width = typeof window === "undefined" ? 0 : window.innerWidth;
  return {
    browser_family: browserFamily(),
    os_family: osFamily(),
    locale: typeof document === "undefined" ? "unknown" : (document.documentElement.lang || "unknown"),
    utc_offset_minutes: new Date().getTimezoneOffset(),
    viewport_width: width === 0 ? "unknown" : width <= 600 ? "compact" : width <= 1099 ? "medium" : "wide",
  };
}

function browserFamily(): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Firefox\//.test(agent)) return "firefox";
  if (/Edg\//.test(agent)) return "edge";
  if (/Chrome\//.test(agent)) return "chromium";
  if (/Safari\//.test(agent)) return "safari";
  return "unknown";
}

function osFamily(): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Android/.test(agent)) return "android";
  if (/iPhone|iPad/.test(agent)) return "ios";
  if (/Mac OS/.test(agent)) return "macos";
  if (/Windows/.test(agent)) return "windows";
  if (/Linux/.test(agent)) return "linux";
  return "unknown";
}

function supportsLongTasks(): boolean {
  return typeof PerformanceObserver !== "undefined" &&
    (PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false);
}

function appVersion(): string {
  return typeof __NEOSEQ_APP_VERSION__ === "string" ? __NEOSEQ_APP_VERSION__ : "development";
}

function buildId(): string {
  return typeof __NEOSEQ_BUILD_ID__ === "string" ? __NEOSEQ_BUILD_ID__ : "development";
}

function json(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function jsonLines(records: readonly (DiagnosticRecord | SensitiveDiagnosticPayload)[]): Uint8Array {
  return encoder.encode(records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function sha256(data: Uint8Array): Promise<string> {
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readme(manifest: Record<string, unknown>): string {
  const enhanced = manifest.contains_sensitive_content === true;
  return `# Neoseq diagnostic artifact

This artifact was created by an explicit local diagnostic recording. Its
redaction level is \`${String(manifest.redaction_level)}\`. ${enhanced
    ? "The `sensitive/content.jsonl` stream may contain graph text, names, properties, identifiers, exact commands, and query text."
    : "Automatic capture omitted graph text, names, property values, identifiers, raw CRDT data, credentials, URLs, and raw errors."}

\`contains_user_content\` is \`${String(manifest.contains_user_content)}\`. ${enhanced
    ? "User-authored content is segregated in `sensitive/content.jsonl`; an optional annotation may also appear in `events.jsonl`."
    : "When true, the only user-authored field is the optional annotation in `events.jsonl`."}

Inspect without mutating a graph:

    pnpm diagnostics:inspect -- report.neoseq-bug
${enhanced ? "\nSensitive artifacts require an explicit acknowledgement:\n\n    pnpm diagnostics:inspect -- --allow-sensitive report.neoseq-bug\n" : ""}

Treat every artifact as untrusted input. Checksums detect accidental corruption;
they do not authenticate the reporter.
`;
}

const MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: [
    "artifact_schema_version",
    "capture_policy_version",
    "recording_id",
    "redaction_level",
    "capture_policy",
    "contains_user_content",
    "contains_sensitive_content",
    "application",
    "files",
  ],
  properties: {
    artifact_schema_version: { const: DIAGNOSTIC_ARTIFACT_SCHEMA },
    capture_policy_version: { const: DIAGNOSTIC_CAPTURE_POLICY },
    redaction_level: { enum: ["standard", "enhanced"] },
    contains_user_content: { type: "boolean" },
    contains_sensitive_content: { type: "boolean" },
  },
};

const LENGTH_BUCKET_SCHEMA = {
  enum: ["0", "1-16", "17-64", "65-256", "257-1024", "1025+"],
};
const COUNT_SCHEMA = { type: "integer", minimum: 0 };
const ATTRIBUTE_PROPERTIES = {
  action_id: { type: "string", maxLength: 64 },
  feature: { enum: ["outline", "query", "command_layer", "navigation", "settings", "graph", "domain"] },
  action: { enum: ["copy_selection", "delete_selection", "indent_selection", "outdent_selection", "move_selection", "insert_block", "paste_outline", "undo", "redo", "run_query", "execute_command"] },
  input_method: { enum: ["keyboard", "pointer", "context_menu", "palette", "automatic", "programmatic", "unknown"] },
  checkpoint_phase: { enum: ["before", "after", "failed"] },
  operation: { type: "string", maxLength: 80 },
  command_type: { type: "string", maxLength: 64 },
  entity_kind: { enum: ["page", "block", "tag", "graph", "none"] },
  property_kind: { enum: ["well_known", "custom", "none"] },
  text_length: LENGTH_BUCKET_SCHEMA,
  source_length: LENGTH_BUCKET_SCHEMA,
  insert_length: LENGTH_BUCKET_SCHEMA,
  delete_length: LENGTH_BUCKET_SCHEMA,
  payload_size: LENGTH_BUCKET_SCHEMA,
  binding_count: COUNT_SCHEMA,
  page_count: COUNT_SCHEMA,
  hydrated_page_count: COUNT_SCHEMA,
  tag_count: COUNT_SCHEMA,
  quarantined_count: COUNT_SCHEMA,
  checkpoint_sequence: COUNT_SCHEMA,
  replayed_update_count: COUNT_SCHEMA,
  queue_depth: COUNT_SCHEMA,
  pending_command_count: COUNT_SCHEMA,
  requested_target_count: COUNT_SCHEMA,
  normalized_root_count: COUNT_SCHEMA,
  affected_block_count: COUNT_SCHEMA,
  explicit_selection_count: COUNT_SCHEMA,
  covered_selection_count: COUNT_SCHEMA,
  selection_root_count: COUNT_SCHEMA,
  visible_row_count: COUNT_SCHEMA,
  collapsed_count: COUNT_SCHEMA,
  pending_row_count: COUNT_SCHEMA,
  pending_intent_count: COUNT_SCHEMA,
  focus_kind: { enum: ["none", "editor", "pending_editor", "selection"] },
  event_count: COUNT_SCHEMA,
  page_read_count: COUNT_SCHEMA,
  cursor_before: COUNT_SCHEMA,
  cursor_after: COUNT_SCHEMA,
  resync_required: { type: "boolean" },
  reconcile_fallback: { type: "boolean" },
  snapshot_revision: COUNT_SCHEMA,
  changed: { type: "boolean" },
  duplicate: { type: "boolean" },
  semantic_kind: { type: "string", maxLength: 80 },
  subject_token: { type: "string", maxLength: 64 },
  checkpoint: { enum: ["flush", "reconcile"] },
  focused: { type: "boolean" },
  composing: { type: "boolean" },
  draft_state: { enum: ["absent", "clean", "dirty"] },
  draft_length: LENGTH_BUCKET_SCHEMA,
  authoritative_length: LENGTH_BUCKET_SCHEMA,
  draft_baseline_relation: { enum: ["equal", "different", "missing", "unknown"] },
  draft_authoritative_relation: { enum: ["equal", "different", "missing", "unknown"] },
  save_state: { enum: ["saved", "saving", "unsaved"] },
  session_status: { enum: ["opening", "ready", "error", "closed"] },
  lease_mode: { enum: ["exclusive", "readonly"] },
  route_kind: { enum: ["graph_picker", "journal", "page", "settings", "other"] },
  render_phase: { enum: ["mount", "update", "nested-update"] },
  error_code: { type: "string", maxLength: 64 },
  retryable: { type: "boolean" },
  result_kind: { type: "string", maxLength: 64 },
  result_row_count: COUNT_SCHEMA,
  result_column_count: COUNT_SCHEMA,
  result_revision: COUNT_SCHEMA,
  stale_result: { type: "boolean" },
  record_count: COUNT_SCHEMA,
  byte_count: COUNT_SCHEMA,
  dropped_count: COUNT_SCHEMA,
  recovered: { type: "boolean" },
  reason: { enum: ["user", "limit", "crash"] },
  capture_level: { enum: ["standard", "enhanced"] },
  sensitive_record_count: COUNT_SCHEMA,
  sensitive_byte_count: COUNT_SCHEMA,
  omission_reason: { enum: ["outside_scope", "missing_graph_context"] },
};

const RECORD_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "sequence", "monotonic_ms", "family", "source", "name", "attributes"],
  properties: {
    schema_version: { const: DIAGNOSTIC_ARTIFACT_SCHEMA },
    sequence: { type: "integer", minimum: 1 },
    monotonic_ms: { type: "number", minimum: 0 },
    family: { enum: ["interaction", "span", "state", "metric", "error", "marker"] },
    source: { enum: ["ui", "session", "adapter", "worker", "core", "query", "storage"] },
    name: { type: "string", maxLength: 80 },
    trace_id: { type: "string", maxLength: 64 },
    span_id: { type: "string", maxLength: 64 },
    parent_span_id: { type: "string", maxLength: 64 },
    duration_ms: { type: "number", minimum: 0 },
    outcome: { enum: ["ok", "error", "cancelled"] },
    attributes: {
      type: "object",
      additionalProperties: false,
      properties: ATTRIBUTE_PROPERTIES,
    },
    annotation: { type: "string", maxLength: 4_000 },
  },
};

function validateRecordContract(records: readonly DiagnosticRecord[]): void {
  const allowed = new Set(Object.keys(ATTRIBUTE_PROPERTIES));
  for (const record of records) {
    for (const key of Object.keys(record.attributes)) {
      if (!allowed.has(key)) throw new Error(`unsupported diagnostic attribute: ${key}`);
    }
  }
}

const SENSITIVE_RECORD_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["schema_version", "payload_id", "monotonic_ms", "kind"],
  properties: {
    schema_version: { const: 1 },
    payload_id: { type: "string", maxLength: 64 },
    monotonic_ms: { type: "number", minimum: 0 },
    action_id: { type: "string", maxLength: 64 },
    kind: { enum: ["command", "query", "page_snapshot", "tag_snapshot", "graph_snapshot"] },
  },
};
