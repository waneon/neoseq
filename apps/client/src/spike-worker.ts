import init, { WasmGraphCore } from "./wasm/neoseq_core.js";
import { CORE_PORT_VERSION } from "./generated/core-port";
import type {
  CloseGraphRequest,
  CorePortError,
  ExecuteRequest,
  OpenGraphRequest,
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

interface Message { id: number; operation: string; payload: unknown; }
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

const ready = init();
const states = new Map<string, OpenState>();
let tick = 0;

self.onmessage = async (event: MessageEvent<Message>) => {
  const { id, operation, payload } = event.data;
  try {
    await ready;
    let value: unknown;
    switch (operation) {
      case "open_graph": value = await openGraph(payload as OpenGraphRequest); break;
      case "execute": value = await execute(payload as ExecuteRequest); break;
      case "read": value = read(payload as ReadRequest); break;
      case "subscribe": value = subscribe(payload as SubscribeRequest); break;
      case "close_graph": value = await closeGraph(payload as CloseGraphRequest); break;
      case "retry_pending": value = await retryPending(payload as { graph_handle: string }); break;
      case "list_graphs": value = await new IndexedDbGraphRepository().allMetadata(); break;
      case "delete_graph": value = await deleteGraph(payload as { graph_id: string }); break;
      case "test_control": value = await testControl(payload as Record<string, unknown>); break;
      default: throw failure("invalid_request", `unknown operation: ${operation}`, false);
    }
    if (value instanceof ArrayBuffer) {
      self.postMessage({ id, ok: true, value }, { transfer: [value] });
    } else {
      self.postMessage({ id, ok: true, value });
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: normalizeError(error) });
  }
};

async function openGraph(request: OpenGraphRequest) {
  if (request.contract_version !== CORE_PORT_VERSION) {
    throw failure("unsupported_contract", "unsupported CorePort contract version", false);
  }
  if (request.locator.location !== "local") {
    throw failure("invalid_request", "Step 3 opens local graph locators only", false);
  }
  const handle = `local:${request.locator.graph_id}`;
  if (states.has(handle)) throw failure("graph_already_open", "graph is already open", false);
  const repository = new IndexedDbGraphRepository();
  const metadata = await repository.openGraph(request.locator, now());
  if (metadata.schema_version !== 1) {
    throw failure("unsupported_schema", `unsupported schema version ${metadata.schema_version}`, false);
  }
  const recovery = await recover(repository, request.locator.graph_id, request.peer_id);
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
    snapshot: JSON.parse(state.core.snapshotJson()),
    capabilities: await repository.capabilities(),
    recovery: recovery.report,
  };
}

async function recover(repository: IndexedDbGraphRepository, graphId: string, peerId: number) {
  let core: WasmGraphCore | undefined;
  let checkpointSequence = 0;
  const quarantinedRecords: string[] = [];
  const checkpoints = await repository.checkpointsDescending(graphId);
  for (const checkpoint of checkpoints) {
    let reason: string | undefined;
    if (checkpoint.schema_version !== 1) reason = `unsupported-checkpoint-schema:${checkpoint.schema_version}`;
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
  return {
    core,
    report: {
      checkpoint_sequence: checkpointSequence,
      replayed_updates: replayedUpdates,
      quarantined_records: quarantinedRecords,
    },
  };
}

async function execute(request: ExecuteRequest) {
  if (request.timeout_ms === 0) throw failure("command_timeout", "command deadline elapsed before dispatch", true);
  const state = requireState(request.graph_handle);
  if (state.pending) throw failure("dirty_unsaved", "retry pending update before another mutation", true);
  const raw = state.core.executeJson(JSON.stringify(request.command), now());
  const execution = JSON.parse(raw) as { result: unknown; semantic: string; duplicate: boolean };
  const update = ownedBuffer(state.core.takeUpdate());
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
    const receipt = await persistPending(state);
    return { result: execution.result, save_status: { status: "saved_locally", ...receipt } };
  } catch (error) {
    if (error instanceof StorageError && error.code === "storage_full") throw error;
    throw failure("dirty_unsaved", error instanceof Error ? error.message : String(error), true);
  }
}

async function persistPending(state: OpenState) {
  const pending = state.pending;
  if (!pending) return { local_sequence: 0, checksum: "" };
  const receipt = await state.repository.appendUpdate(state.graphId, pending.payload, pending.createdAt);
  push(state, "local", { type: "semantic", name: pending.semantic, command_id: pending.commandId });
  push(state, "local", { type: "saved_locally", ...receipt });
  state.pending = undefined;
  return receipt;
}

function read(request: ReadRequest) {
  return { snapshot: JSON.parse(requireState(request.graph_handle).core.snapshotJson()) };
}

function subscribe(request: SubscribeRequest) {
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
}

async function closeGraph(request: CloseGraphRequest) {
  const state = requireState(request.graph_handle);
  if (state.pending) throw failure("dirty_unsaved", "close rejected while an update is not durable", true);
  const metadata = await state.repository.metadata(state.graphId);
  const through = metadata.next_sequence - 1;
  await state.repository.saveCheckpoint(state.graphId, ownedBuffer(state.core.exportSnapshot()), through, now());
  await state.repository.markCompacted(state.graphId, through);
  states.delete(request.graph_handle);
  return { closed: true };
}

async function retryPending(payload: { graph_handle: string }) {
  const receipt = await persistPending(requireState(payload.graph_handle));
  return { status: "saved_locally", ...receipt };
}

async function deleteGraph(payload: { graph_id: string }) {
  for (const state of states.values()) {
    if (state.graphId === payload.graph_id) {
      throw failure("invalid_request", "close the graph before deleting it", false);
    }
  }
  await new IndexedDbGraphRepository().deleteLocal(payload.graph_id);
  return { deleted: true };
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
    case "index_cache": {
      const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
      await repository.storeIndexCache(String(payload.graph_id), "step3", bytes);
      return (await repository.loadIndexCache(String(payload.graph_id), "step3"))?.byteLength ?? 0;
    }
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
  while (state.events.length > 4) state.events.shift();
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
  return `2026-08-03T13:00:${String(tick++ % 60).padStart(2, "0")}Z`;
}
