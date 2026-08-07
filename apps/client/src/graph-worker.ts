import init, { WasmGraphCore } from "./wasm/neoseq_core.js";
import { CORE_PORT_VERSION } from "./generated/core-port";
import type {
  CloseGraphRequest,
  CorePortError,
  ExecuteRequest,
  OpenGraphRequest,
  QueryRequest,
  ReadPageRequest,
  ReadRequest,
  SubscribeRequest,
} from "./generated/core-port";
import {
  IndexedDbGraphRepository,
  StorageError,
  validChecksum,
  type FaultPoint,
  type QuarantineRecord,
} from "./persistence";
import { WorkerDiagnosticCollector } from "./diagnostics/worker";
import type {
  DiagnosticAttributes,
  LengthBucket,
  WorkerDiagnosticContext,
} from "./diagnostics/types";

interface Message {
  id: number;
  operation: string;
  payload: unknown;
  diagnostic?: WorkerDiagnosticContext;
}
interface EventRecord { cursor: number; source: "local" | "remote"; kind: Record<string, unknown>; }
interface PendingWrite {
  payload: ArrayBuffer;
  semantic: string;
  commandId: string;
  result: unknown;
  createdAt: string;
}
interface OpenState {
  graphId: string;
  core: WasmGraphCore;
  repository: IndexedDbGraphRepository;
  events: EventRecord[];
  nextCursor: number;
  pending?: PendingWrite;
}

let wasmReady: Promise<unknown> | undefined;
const states = new Map<string, OpenState>();
let testTick = 0;

function ensureWasm(): Promise<unknown> {
  wasmReady ??= init();
  return wasmReady;
}

self.onmessage = async (event: MessageEvent<Message>) => {
  const { id, operation, payload, diagnostic } = event.data;
  const collector = diagnostic ? new WorkerDiagnosticCollector(diagnostic, operation) : undefined;
  try {
    let value: unknown;
    if (import.meta.env.MODE === "test" && operation === "test_control") {
      await ensureWasm();
      value = await testControl(payload as Record<string, unknown>);
    } else {
      switch (operation) {
        case "open_graph": await ensureWasm(); value = await openGraph(payload as OpenGraphRequest, collector); break;
        case "execute": await ensureWasm(); value = await execute(payload as ExecuteRequest, collector); break;
        case "read": await ensureWasm(); value = read(payload as ReadRequest, collector); break;
        case "read_page": await ensureWasm(); value = readPage(payload as ReadPageRequest, collector); break;
        case "query": await ensureWasm(); value = query(payload as QueryRequest, collector); break;
        case "subscribe": await ensureWasm(); value = subscribe(payload as SubscribeRequest, collector); break;
        case "close_graph": await ensureWasm(); value = await closeGraph(payload as CloseGraphRequest, collector); break;
        case "retry_pending": await ensureWasm(); value = await retryPending(payload as { graph_handle: string }, collector); break;
        case "list_graphs": value = await measuredAsync(collector, "storage", "storage.open", () => new IndexedDbGraphRepository().allMetadata()); break;
        case "delete_graph": value = await deleteGraph(payload as { graph_id: string }, collector); break;
        default: throw failure("invalid_request", `unknown operation: ${operation}`, false);
      }
    }
    if (value instanceof ArrayBuffer) {
      self.postMessage({ id, ok: true, value, diagnostic_spans: collector?.finish("ok") }, { transfer: [value] });
    } else {
      self.postMessage({ id, ok: true, value, diagnostic_spans: collector?.finish("ok") });
    }
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: normalizeError(error),
      diagnostic_spans: collector?.finish("error"),
    });
  }
};

async function openGraph(request: OpenGraphRequest, collector?: WorkerDiagnosticCollector) {
  if (request.contract_version !== CORE_PORT_VERSION) {
    throw failure("unsupported_contract", "unsupported CorePort contract version", false);
  }
  if (request.locator.location !== "local") {
    throw failure("invalid_request", "only local graph locators are supported", false);
  }
  const handle = `local:${request.locator.graph_id}`;
  if (states.has(handle)) throw failure("graph_already_open", "graph is already open", false);
  const repository = new IndexedDbGraphRepository();
  const metadata = await measuredAsync(collector, "storage", "storage.open", () =>
    repository.openGraph(request.locator, now()));
  if (![3, 4].includes(metadata.schema_version)) {
    throw failure("unsupported_schema", `unsupported schema version ${metadata.schema_version}`, false);
  }
  const recovery = await measuredAsync(
    collector,
    "storage",
    "storage.recover",
    () => recover(repository, request.locator.graph_id, request.peer_id, metadata),
    ({ report }) => ({
      checkpoint_sequence: report.checkpoint_sequence,
      replayed_update_count: report.replayed_updates,
      quarantined_count: report.quarantined_records.length,
    }),
  );
  const state: OpenState = {
    graphId: request.locator.graph_id,
    core: recovery.core,
    repository,
    events: [],
    nextCursor: 1,
  };
  states.set(handle, state);
  return {
    graph_handle: handle,
    summary: measured(collector, "core", "core.read", () => JSON.parse(state.core.summaryJson())),
    capabilities: await measuredAsync(collector, "storage", "storage.capabilities", () => repository.capabilities()),
    recovery: recovery.report,
  };
}

async function recover(
  repository: IndexedDbGraphRepository,
  graphId: string,
  peerId: number,
  metadata: { schema_version: number; next_sequence: number },
) {
  let core: WasmGraphCore | undefined;
  let checkpointSequence = 0;
  const quarantinedRecords: string[] = [];
  const checkpoints = await repository.checkpointsDescending(graphId);
  for (const checkpoint of checkpoints) {
    let reason: string | undefined;
    if (![3, 4].includes(checkpoint.schema_version)) reason = `unsupported-checkpoint-schema:${checkpoint.schema_version}`;
    else if (!(await validChecksum(checkpoint.checksum, checkpoint.payload))) reason = "checkpoint-checksum-mismatch";
    else {
      try {
        core = WasmGraphCore.fromSnapshot(graphId, BigInt(peerId), new Uint8Array(checkpoint.payload));
        checkpointSequence = checkpoint.local_sequence;
        break;
      } catch (error) {
        reason = `invalid-checkpoint:${String(error)}`;
      }
    }
    const exportHandle = `checkpoint-${checkpoint.local_sequence}`;
    await repository.quarantine({ ...checkpoint, export_handle: exportHandle, record_kind: "checkpoint", reason: reason ?? "invalid-checkpoint" });
    quarantinedRecords.push(exportHandle);
  }
  if (!core && checkpoints.length > 0) {
    throw failure("storage_corrupt", "stored graph has checkpoints but none are valid", false);
  }
  if (!core) {
    core = new WasmGraphCore(graphId, BigInt(peerId), now());
    const snapshot = ownedBuffer(core.exportSnapshot());
    await repository.saveCheckpoint(graphId, snapshot, 0, now());
  }
  let replayedUpdates = 0;
  let corruptTail = false;
  for (const update of await repository.updatesAfter(graphId, checkpointSequence)) {
    let reason: string | undefined;
    if (corruptTail) reason = "after-corrupt-tail";
    else if (!(await validChecksum(update.checksum, update.payload))) {
      reason = "update-checksum-mismatch";
      corruptTail = true;
    } else {
      try {
        core.importUpdate(new Uint8Array(update.payload));
        replayedUpdates += 1;
      } catch (error) {
        reason = `invalid-update:${String(error)}`;
        corruptTail = true;
      }
    }
    if (reason) {
      const exportHandle = `update-${update.local_sequence}`;
      await repository.quarantine({ ...update, export_handle: exportHandle, record_kind: "update", reason } satisfies QuarantineRecord);
      quarantinedRecords.push(exportHandle);
    }
  }
  if (metadata.schema_version === 4) {
    const sequence = Math.max(0, metadata.next_sequence - 1);
    const snapshot = ownedBuffer(core.exportSnapshot());
    await repository.saveCheckpoint(graphId, snapshot, sequence, now());
    await repository.setSchemaVersion(graphId, 4);
  }
  return {
    core,
    report: {
      checkpoint_sequence: checkpointSequence,
      replayed_updates: replayedUpdates,
      quarantined_records: quarantinedRecords,
    },
  };
}

async function execute(request: ExecuteRequest, collector?: WorkerDiagnosticCollector) {
  if (request.timeout_ms === 0) throw failure("command_timeout", "command deadline elapsed before dispatch", true);
  const state = requireState(request.graph_handle);
  if (state.pending) throw failure("dirty_unsaved", "retry pending update before another mutation", true);
  const { execution, update } = measured(
    collector,
    "core",
    "core.execute",
    () => {
      const raw = state.core.executeJson(JSON.stringify(request.command), now());
      return {
        execution: JSON.parse(raw) as { result: unknown; semantic: string; duplicate: boolean },
        update: ownedBuffer(state.core.takeUpdate()),
      };
    },
    ({ execution: completed, update: completedUpdate }) => ({
      semantic_kind: completed.semantic,
      duplicate: completed.duplicate,
      payload_size: sizeBucket(completedUpdate.byteLength),
    }),
  );
  if (execution.duplicate || update.byteLength === 0) {
    const metadata = await state.repository.metadata(state.graphId);
    return {
      result: execution.result,
      save_status: { status: "saved_locally", local_sequence: metadata.next_sequence - 1, checksum: "" },
    };
  }
  const command = request.command as { command_id?: string };
  const pending: PendingWrite = {
    payload: update,
    semantic: execution.semantic,
    commandId: command.command_id ?? "",
    result: execution.result,
    createdAt: now(),
  };
  state.pending = pending;
  try {
    const receipt = await persistPending(state, collector);
    return { result: execution.result, save_status: { status: "saved_locally", ...receipt } };
  } catch (error) {
    if (error instanceof StorageError && error.code === "storage_full") throw error;
    throw failure("dirty_unsaved", error instanceof Error ? error.message : String(error), true);
  }
}

async function persistPending(state: OpenState, collector?: WorkerDiagnosticCollector) {
  const pending = state.pending;
  if (!pending) return { local_sequence: 0, checksum: "" };
  const receipt = await measuredAsync(
    collector,
    "storage",
    "storage.append",
    () => state.repository.appendUpdate(state.graphId, pending.payload, pending.createdAt),
    { payload_size: sizeBucket(pending.payload.byteLength) },
  );
  push(state, "local", { type: "semantic", name: pending.semantic, command_id: pending.commandId });
  push(state, "local", { type: "saved_locally", ...receipt });
  state.pending = undefined;
  return receipt;
}

function read(request: ReadRequest, collector?: WorkerDiagnosticCollector) {
  return { summary: measured(collector, "core", "core.read", () =>
    JSON.parse(requireState(request.graph_handle).core.summaryJson())) };
}

function readPage(request: ReadPageRequest, collector?: WorkerDiagnosticCollector) {
  return {
    page: measured(collector, "core", "core.read_page", () =>
      JSON.parse(requireState(request.graph_handle).core.pageSnapshotJson(request.page_id))),
  };
}

function query(request: QueryRequest, collector?: WorkerDiagnosticCollector) {
  const state = requireState(request.graph_handle);
  if (state.pending) {
    throw failure("dirty_unsaved", "retry pending update before querying", true);
  }
  try {
    return { result: measured(collector, "query", "core.query", () =>
      JSON.parse(state.core.queryJson(JSON.stringify(request.query)))) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const budget = message.toLowerCase().includes("budget");
    throw failure(budget ? "query_budget_exceeded" : "invalid_query", message, false);
  }
}

function subscribe(request: SubscribeRequest, collector?: WorkerDiagnosticCollector) {
  return measured(collector, "core", "core.subscribe", () => {
  const state = requireState(request.graph_handle);
  const latest = state.nextCursor - 1;
  const oldest = state.events[0]?.cursor ?? state.nextCursor;
  if (request.after_cursor + 1 < oldest) {
    return { events: [], next_cursor: latest, resync_required: true };
  }
  return {
    events: state.events.filter((record) => record.cursor > request.after_cursor),
    next_cursor: latest,
    resync_required: false,
  };
  });
}

async function closeGraph(request: CloseGraphRequest, collector?: WorkerDiagnosticCollector) {
  const state = requireState(request.graph_handle);
  if (state.pending) throw failure("dirty_unsaved", "close rejected while an update is not durable", true);
  const metadata = await state.repository.metadata(state.graphId);
  const through = metadata.next_sequence - 1;
  const snapshot = measured(collector, "core", "core.snapshot", () => ownedBuffer(state.core.exportSnapshot()));
  await measuredAsync(collector, "storage", "storage.checkpoint", () =>
    state.repository.saveCheckpoint(state.graphId, snapshot, through, now()));
  await measuredAsync(collector, "storage", "storage.compact", () =>
    state.repository.compact(state.graphId, through));
  states.delete(request.graph_handle);
  return { closed: true };
}

async function retryPending(payload: { graph_handle: string }, collector?: WorkerDiagnosticCollector) {
  const receipt = await persistPending(requireState(payload.graph_handle), collector);
  return { status: "saved_locally", ...receipt };
}

async function deleteGraph(payload: { graph_id: string }, collector?: WorkerDiagnosticCollector) {
  for (const state of states.values()) {
    if (state.graphId === payload.graph_id) {
      throw failure("invalid_request", "close the graph before deleting it", false);
    }
  }
  await measuredAsync(collector, "storage", "storage.delete", () =>
    new IndexedDbGraphRepository().deleteLocal(payload.graph_id));
  return { deleted: true };
}

function measured<T>(
  collector: WorkerDiagnosticCollector | undefined,
  source: "worker" | "core" | "query" | "storage",
  name: Parameters<WorkerDiagnosticCollector["measure"]>[1],
  run: () => T,
  attributes: DiagnosticAttributes | ((result: T) => DiagnosticAttributes) = {},
): T {
  return collector ? collector.measure(source, name, run, attributes) : run();
}

function measuredAsync<T>(
  collector: WorkerDiagnosticCollector | undefined,
  source: "worker" | "core" | "query" | "storage",
  name: Parameters<WorkerDiagnosticCollector["measureAsync"]>[1],
  run: () => Promise<T>,
  attributes: DiagnosticAttributes | ((result: T) => DiagnosticAttributes) = {},
): Promise<T> {
  return collector ? collector.measureAsync(source, name, run, attributes) : run();
}

function sizeBucket(size: number): LengthBucket {
  if (size <= 0) return "0";
  if (size <= 16) return "1-16";
  if (size <= 64) return "17-64";
  if (size <= 256) return "65-256";
  if (size <= 1_024) return "257-1024";
  return "1025+";
}

async function testControl(payload: Record<string, unknown>) {
  const repository = new IndexedDbGraphRepository();
  switch (payload.action) {
    case "inject": {
      const state = requireState(String(payload.graph_handle));
      state.repository.injectOnce(payload.fault as FaultPoint);
      return null;
    }
    case "retry": return persistPending(requireState(String(payload.graph_handle))).then(() => null);
    case "corrupt_update": return repository.corruptUpdate(String(payload.graph_id), Number(payload.sequence)).then(() => null);
    case "quarantine_count": return (await repository.quarantined(String(payload.graph_id))).length;
    case "export_quarantine": return repository.exportQuarantine(String(payload.graph_id), String(payload.export_handle));
    case "set_schema": return repository.setSchemaVersion(String(payload.graph_id), Number(payload.schema_version)).then(() => null);
    case "delete_local": return repository.deleteLocal(String(payload.graph_id)).then(() => null);
    default: throw failure("invalid_request", "unknown test control action", false);
  }
}

function requireState(handle: string): OpenState {
  const state = states.get(handle);
  if (!state) throw failure("graph_not_open", "graph handle is not open", false);
  return state;
}

function push(state: OpenState, source: "local" | "remote", kind: Record<string, unknown>) {
  state.events.push({ cursor: state.nextCursor++, source, kind });
  while (state.events.length > 64) state.events.shift();
}

function failure(code: CorePortError["code"], message: string, retryable: boolean): CorePortError {
  return { code, message, retryable };
}

function normalizeError(error: unknown): CorePortError {
  if (error instanceof StorageError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (isCorePortError(error)) return error;
  return failure("internal", error instanceof Error ? error.message : String(error), false);
}

function isCorePortError(error: unknown): error is CorePortError {
  return typeof error === "object" && error !== null && "code" in error && "message" in error && "retryable" in error;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function now(): string {
  if (import.meta.env.MODE === "test") {
    return `2026-08-03T13:00:${String(testTick++ % 60).padStart(2, "0")}Z`;
  }
  return new Date().toISOString();
}
