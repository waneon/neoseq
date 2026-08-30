import init, {
  WasmGraphCore,
  decodeGraphArchive,
  decodeSyncMessageJson,
  emptyVersionVector,
  encodeGraphArchive,
  encodeSyncMessageJson,
} from "./wasm/neoseq_core.js";
import { CORE_PORT_VERSION } from "./generated/core-port";
import { SCHEMA_VERSION } from "./generated/graph-schema";
import type {
  CloseGraphRequest,
  CorePortError,
  ExecuteRequest,
  GraphLocatorDto,
  OpenGraphRequest,
  QueryRequest,
  ReadOutlineRequest,
  ReadRequest,
  SubscribeRequest,
} from "./generated/core-port";
import {
  IndexedDbGraphRepository,
  StorageError,
  graphStorageKey,
  validChecksum,
  type QuarantineRecord,
} from "./persistence";
import { TestIndexedDbGraphRepository, type FaultPoint } from "./testing/test-persistence";

interface Message {
  id: number;
  operation: string;
  payload: unknown;
}
interface EventRecord {
  cursor: number;
  source: "local" | "remote";
  kind: Record<string, unknown>;
}
interface PendingWrite {
  payload: ArrayBuffer;
  semantic: string;
  commandId: string;
  result: unknown;
  createdAt: string;
  messageId: string;
  baseVersionVector: ArrayBuffer;
}
interface OpenState {
  graphId: string;
  storageKey: string;
  replicaId: number;
  core: WasmGraphCore;
  repository: IndexedDbGraphRepository;
  events: EventRecord[];
  nextCursor: number;
  pending?: PendingWrite;
  remote: boolean;
}

const COMPACT_TAIL_UPDATES = 128;
const COMPACT_TAIL_BYTES = 512 * 1024;

let wasmReady: Promise<unknown> | undefined;
const states = new Map<string, OpenState>();
let testTick = 0;

function ensureWasm(): Promise<unknown> {
  wasmReady ??= init();
  return wasmReady;
}

self.onmessage = async (event: MessageEvent<Message>) => {
  const { id, operation, payload } = event.data;
  try {
    let value: unknown;
    if (import.meta.env.MODE === "test" && operation === "test_control") {
      await ensureWasm();
      value = await testControl(payload as Record<string, unknown>);
    } else {
      switch (operation) {
        case "open_graph":
          await ensureWasm();
          value = await openGraph(payload as OpenGraphRequest);
          break;
        case "execute":
          await ensureWasm();
          value = await execute(payload as ExecuteRequest);
          break;
        case "read":
          await ensureWasm();
          value = read(payload as ReadRequest);
          break;
        case "read_outline":
          await ensureWasm();
          value = readOutline(payload as ReadOutlineRequest);
          break;
        case "query":
          await ensureWasm();
          value = query(payload as QueryRequest);
          break;
        case "subscribe":
          await ensureWasm();
          value = subscribe(payload as SubscribeRequest);
          break;
        case "close_graph":
          await ensureWasm();
          value = await closeGraph(payload as CloseGraphRequest);
          break;
        case "retry_pending":
          await ensureWasm();
          value = await retryPending(payload as { graph_handle: string });
          break;
        case "list_graphs":
          value = await createRepository().allMetadata();
          break;
        case "delete_graph":
          value = await deleteGraph(payload as { locator: GraphLocatorDto });
          break;
        case "export_archive":
          await ensureWasm();
          value = exportArchive(
            payload as {
              graph_handle: string;
              suggested_name: string;
            },
          );
          break;
        case "import_archive":
          await ensureWasm();
          value = await importArchive(
            payload as {
              bytes: ArrayBuffer | Uint8Array;
              locator: GraphLocatorDto;
            },
          );
          break;
        case "storage_capabilities":
          value = await storageCapabilities(payload as { graph_handle: string });
          break;
        case "sync_configure":
          value = await configureSync(payload as { graph_handle: string });
          break;
        case "sync_state":
          value = await syncState(payload as { graph_handle: string });
          break;
        case "sync_next":
          value = await syncNext(payload as { graph_handle: string });
          break;
        case "sync_ack":
          value = await syncAck(payload as { graph_handle: string; message_id: string });
          break;
        case "sync_import":
          value = await syncImport(
            payload as { graph_handle: string; bytes: ArrayBuffer | Uint8Array },
          );
          break;
        case "sync_replace":
          value = await syncReplace(
            payload as {
              graph_handle: string;
              checkpoint: ArrayBuffer | Uint8Array;
              history_epoch: number;
              server_version_vector: ArrayBuffer | Uint8Array;
            },
          );
          break;
        case "sync_encode":
          await ensureWasm();
          value = syncEncode(payload);
          break;
        case "sync_decode":
          await ensureWasm();
          value = syncDecode(payload as { frame: ArrayBuffer | Uint8Array });
          break;
        default:
          throw failure("invalid_request", `unknown operation: ${operation}`, false);
      }
    }
    if (value instanceof ArrayBuffer) {
      self.postMessage({ id, ok: true, value }, { transfer: [value] });
    } else {
      self.postMessage({ id, ok: true, value });
    }
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: normalizeError(error),
    });
  }
};

async function openGraph(request: OpenGraphRequest) {
  if (request.contract_version !== CORE_PORT_VERSION) {
    throw failure("unsupported_contract", "unsupported CorePort contract version", false);
  }
  const storageKey = graphStorageKey(request.locator);
  const handle = `local:${storageKey}`;
  if (states.has(handle)) throw failure("graph_already_open", "graph is already open", false);
  const repository = createRepository();
  const metadata = await repository.openGraph(request.locator, now(), request.peer_id);
  if (metadata.schema_version !== SCHEMA_VERSION) {
    throw failure(
      "unsupported_schema",
      `unsupported schema version ${metadata.schema_version}`,
      false,
    );
  }
  const recovery = await recover(repository, storageKey, request.locator.graph_id, metadata);
  const state: OpenState = {
    graphId: request.locator.graph_id,
    storageKey,
    replicaId: metadata.replica_id,
    core: recovery.core,
    repository,
    events: [],
    nextCursor: 1,
    remote: false,
  };
  states.set(handle, state);
  return {
    graph_handle: handle,
    summary: JSON.parse(state.core.summaryJson()),
    recovery: recovery.report,
  };
}

async function recover(
  repository: IndexedDbGraphRepository,
  storageKey: string,
  graphId: string,
  metadata: { replica_id: number; schema_version: number; next_sequence: number },
) {
  const quarantinedRecords: string[] = [];
  let selected:
    | {
        core: WasmGraphCore;
        payload: ArrayBuffer;
        sequence: number;
      }
    | undefined;
  const checkpoints = await repository.checkpointsDescending(storageKey);
  for (const checkpoint of checkpoints) {
    let reason: string | undefined;
    if (checkpoint.schema_version !== SCHEMA_VERSION)
      reason = `unsupported-checkpoint-schema:${checkpoint.schema_version}`;
    else if (!(await validChecksum(checkpoint.checksum, checkpoint.payload)))
      reason = "checkpoint-checksum-mismatch";
    else {
      try {
        selected = {
          core: WasmGraphCore.fromRecoverySnapshot(
            graphId,
            BigInt(metadata.replica_id),
            new Uint8Array(checkpoint.payload),
          ),
          payload: checkpoint.payload,
          sequence: checkpoint.local_sequence,
        };
        break;
      } catch (error) {
        reason = `invalid-checkpoint:${String(error)}`;
      }
    }
    const exportHandle = `checkpoint-${checkpoint.local_sequence}`;
    await repository.quarantine({
      ...checkpoint,
      export_handle: exportHandle,
      record_kind: "checkpoint",
      reason: reason ?? "invalid-checkpoint",
    });
    quarantinedRecords.push(exportHandle);
  }
  if (!selected && checkpoints.length > 0) {
    throw failure("storage_corrupt", "stored graph has checkpoints but none are valid", false);
  }
  if (!selected) {
    const core = new WasmGraphCore(graphId, BigInt(metadata.replica_id), now());
    const snapshot = ownedBuffer(core.exportGcCheckpoint());
    await repository.installCheckpoint(storageKey, snapshot, 0, SCHEMA_VERSION, now());
    selected = { core, payload: snapshot, sequence: 0 };
  }
  const base = selected;
  const checkpointSequence = base.sequence;
  const updates = await repository.updatesAfter(storageKey, checkpointSequence);
  const checksums = await Promise.all(
    updates.map((update) => validChecksum(update.checksum, update.payload)),
  );
  const createBase = () =>
    WasmGraphCore.fromRecoverySnapshot(
      graphId,
      BigInt(metadata.replica_id),
      new Uint8Array(base.payload),
    );

  let core = base.core;
  let replayedUpdates = 0;
  let validThrough = checkpointSequence;
  let corruptTail: QuarantineRecord[] = [];
  let fastPathComplete = false;
  if (checksums.every(Boolean)) {
    try {
      for (const update of updates) {
        core.stageRecoveryUpdate(new Uint8Array(update.payload));
      }
      core.finishRecovery();
      replayedUpdates = updates.length;
      validThrough = updates.at(-1)?.local_sequence ?? checkpointSequence;
      fastPathComplete = true;
    } catch {
      // The disposable fast-path document may now contain a partial Tail.
      // Recreate the selected Base and use the validating replay below to find
      // the exact durable frontier and quarantine the same suffix as before.
      core = createBase();
    }
  }

  if (!fastPathComplete) {
    let tailCorrupt = false;
    corruptTail = [];
    for (const [index, update] of updates.entries()) {
      let reason: string | undefined;
      if (tailCorrupt) reason = "after-corrupt-tail";
      else if (!checksums[index]) {
        reason = "update-checksum-mismatch";
        tailCorrupt = true;
      } else {
        try {
          core.importRecoveryUpdate(new Uint8Array(update.payload));
          replayedUpdates += 1;
          validThrough = update.local_sequence;
        } catch (error) {
          reason = `invalid-update:${String(error)}`;
          tailCorrupt = true;
        }
      }
      if (reason) {
        const exportHandle = `update-${update.local_sequence}`;
        corruptTail.push({
          ...update,
          export_handle: exportHandle,
          record_kind: "update",
          reason,
        } satisfies QuarantineRecord);
        quarantinedRecords.push(exportHandle);
      }
    }
    core.finishRecovery();
  }
  if (corruptTail.length > 0) {
    await repository.repairCorruptTail(
      storageKey,
      ownedBuffer(core.exportGcCheckpoint()),
      validThrough,
      SCHEMA_VERSION,
      corruptTail,
      now(),
    );
  } else if (metadata.schema_version < SCHEMA_VERSION) {
    await repository.installCheckpoint(
      storageKey,
      ownedBuffer(core.exportGcCheckpoint()),
      validThrough,
      SCHEMA_VERSION,
      now(),
    );
  }
  // Replayed same-replica Tail operations are durable graph state, not local
  // commands from this browser session. Start undo only after recovery reaches
  // its final frontier so Loro and the semantic history stacks share a boundary.
  core.resetLocalHistory();
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
  if (request.timeout_ms === 0)
    throw failure("command_timeout", "command deadline elapsed before dispatch", true);
  const state = requireState(request.graph_handle);
  if (state.pending)
    throw failure("dirty_unsaved", "retry pending update before another mutation", true);
  const baseVersionVector = ownedBuffer(state.core.versionVector());
  const raw = state.core.executeJson(JSON.stringify(request.command), now());
  const execution = JSON.parse(raw) as {
    result: unknown;
    semantic: string;
    duplicate: boolean;
  };
  const update = ownedBuffer(state.core.takeUpdate());
  if (execution.duplicate || update.byteLength === 0) {
    const metadata = await state.repository.metadata(state.storageKey);
    return {
      result: execution.result,
      save_status: {
        status: "saved_locally",
        local_sequence: metadata.next_sequence - 1,
        checksum: "",
      },
    };
  }
  const command = request.command as { command_id?: string };
  const pending: PendingWrite = {
    payload: update,
    semantic: execution.semantic,
    commandId: command.command_id ?? "",
    result: execution.result,
    createdAt: now(),
    messageId: crypto.randomUUID(),
    baseVersionVector,
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
  const receipt = await state.repository.appendUpdate(
    state.storageKey,
    pending.payload,
    pending.createdAt,
    state.remote
      ? {
          message_id: pending.messageId,
          base_version_vector: pending.baseVersionVector,
        }
      : undefined,
  );
  push(state, "local", { type: "semantic", name: pending.semantic, command_id: pending.commandId });
  push(state, "local", { type: "saved_locally", ...receipt });
  state.pending = undefined;
  try {
    await maybeCompact(state);
  } catch {
    // The update is already durable. Maintenance is retried on the next
    // threshold or clean close and must not turn a saved command into an
    // ambiguous dirty write.
  }
  return receipt;
}

async function maybeCompact(state: OpenState, force = false): Promise<void> {
  if (state.pending || state.remote) return;
  const metadata = await state.repository.metadata(state.storageKey);
  const uncompacted = await state.repository.updatesAfter(
    state.storageKey,
    metadata.compacted_through,
  );
  const uncompactedBytes = uncompacted.reduce(
    (total, record) => total + record.payload.byteLength,
    0,
  );
  if (
    !force &&
    uncompacted.length < COMPACT_TAIL_UPDATES &&
    uncompactedBytes < COMPACT_TAIL_BYTES
  ) {
    return;
  }
  const through = metadata.next_sequence - 1;
  const checkpoint = ownedBuffer(state.core.exportGcCheckpoint());
  // Validate the exact bytes before the atomic pointer swap. Recovery never
  // has to discover that a maintenance checkpoint was malformed.
  WasmGraphCore.fromSnapshot(state.graphId, BigInt(state.replicaId), new Uint8Array(checkpoint));
  await state.repository.installCheckpoint(
    state.storageKey,
    checkpoint,
    through,
    SCHEMA_VERSION,
    now(),
  );
}

function read(request: ReadRequest) {
  return { summary: JSON.parse(requireState(request.graph_handle).core.summaryJson()) };
}

function readOutline(request: ReadOutlineRequest) {
  return {
    outline: JSON.parse(
      requireState(request.graph_handle).core.outlineSnapshotJson(JSON.stringify(request.owner)),
    ),
  };
}

function query(request: QueryRequest) {
  const state = requireState(request.graph_handle);
  if (state.pending) {
    throw failure("dirty_unsaved", "retry pending update before querying", true);
  }
  try {
    return { result: JSON.parse(state.core.queryJson(JSON.stringify(request.query))) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const budget = message.toLowerCase().includes("budget");
    throw failure(budget ? "query_budget_exceeded" : "invalid_query", message, false);
  }
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
  if (state.pending)
    throw failure("dirty_unsaved", "close rejected while an update is not durable", true);
  if (state.remote) {
    // Remote history is retained until the server publishes a GC epoch.
    const metadata = await state.repository.metadata(state.storageKey);
    const through = metadata.next_sequence - 1;
    const snapshot = ownedBuffer(state.core.exportSnapshot());
    await state.repository.installCheckpoint(
      state.storageKey,
      snapshot,
      through,
      SCHEMA_VERSION,
      now(),
    );
  } else {
    await maybeCompact(state, true);
  }
  states.delete(request.graph_handle);
  return { closed: true };
}

async function retryPending(payload: { graph_handle: string }) {
  const receipt = await persistPending(requireState(payload.graph_handle));
  return { status: "saved_locally", ...receipt };
}

async function deleteGraph(payload: { locator: GraphLocatorDto }) {
  const storageKey = graphStorageKey(payload.locator);
  for (const state of states.values()) {
    if (state.storageKey === storageKey) {
      throw failure("invalid_request", "close the graph before deleting it", false);
    }
  }
  await createRepository().deleteLocal(storageKey);
  return { deleted: true };
}

function exportArchive(payload: { graph_handle: string; suggested_name: string }): ArrayBuffer {
  const state = requireState(payload.graph_handle);
  if (state.pending) {
    throw failure("dirty_unsaved", "save the pending update before exporting", true);
  }
  try {
    return ownedBuffer(
      encodeGraphArchive(
        state.core.exportSnapshot(),
        state.graphId,
        `archive-${crypto.randomUUID()}`,
        now(),
        payload.suggested_name,
      ),
    );
  } catch (error) {
    throw archiveFailure(error);
  }
}

async function importArchive(payload: {
  bytes: ArrayBuffer | Uint8Array;
  locator: GraphLocatorDto;
}) {
  try {
    const decoded = decodeGraphArchive(asUint8Array(payload.bytes));
    try {
      const manifest = JSON.parse(decoded.manifestJson()) as {
        source: { graph_id: string; document_schema: number };
        suggested_name?: string;
      };
      if (manifest.source.document_schema !== SCHEMA_VERSION) {
        throw failure(
          "unsupported_schema",
          `unsupported schema version ${manifest.source.document_schema}`,
          false,
        );
      }
      const graphId = payload.locator.graph_id;
      const replicaId = randomReplicaId();
      const source = WasmGraphCore.fromSnapshot(
        manifest.source.graph_id,
        BigInt(replicaId),
        decoded.snapshot(),
      );
      let checkpoint: ArrayBuffer;
      try {
        checkpoint = ownedBuffer(source.exportCloneSnapshot(graphId, BigInt(replicaId)));
      } finally {
        source.free();
      }
      // Validate the exact target bytes before making them durable. Opening the
      // imported graph should never be the first time its clone is interpreted.
      const validated = WasmGraphCore.fromSnapshot(
        graphId,
        BigInt(replicaId),
        new Uint8Array(checkpoint),
      );
      validated.free();
      const createdAt = now();
      await createRepository().installImportedGraph(
        payload.locator,
        replicaId,
        SCHEMA_VERSION,
        checkpoint,
        createdAt,
      );
      return {
        graph_id: graphId,
        suggested_name: manifest.suggested_name,
        created_at: createdAt,
      };
    } finally {
      decoded.free();
    }
  } catch (error) {
    if (error instanceof StorageError || isCorePortError(error)) throw error;
    throw archiveFailure(error);
  }
}

async function storageCapabilities(payload: { graph_handle: string }) {
  const state = requireState(payload.graph_handle);
  return state.repository.capabilities(state.storageKey);
}

async function configureSync(payload: { graph_handle: string }) {
  const state = requireState(payload.graph_handle);
  state.remote = true;
  const history = ownedBuffer(state.core.exportAll());
  await state.repository.initializeSync(
    state.storageKey,
    crypto.randomUUID(),
    ownedBuffer(emptyVersionVector()),
    history,
    now(),
  );
  return null;
}

async function syncState(payload: { graph_handle: string }) {
  const state = requireState(payload.graph_handle);
  const outbox = await state.repository.outbox(state.storageKey);
  const metadata = await state.repository.metadata(state.storageKey);
  return {
    version_vector: [...state.core.versionVector()],
    pending: outbox.length,
    replica_id: state.replicaId,
    history_epoch: metadata.history_epoch,
  };
}

async function syncNext(payload: { graph_handle: string }) {
  const state = requireState(payload.graph_handle);
  const next = (await state.repository.outbox(state.storageKey))[0];
  if (!next) return null;
  const metadata = await state.repository.metadata(state.storageKey);
  return {
    message_id: next.message_id,
    local_sequence: next.local_sequence,
    base_version_vector: [...new Uint8Array(next.base_version_vector)],
    bytes: [...new Uint8Array(next.payload)],
    history_epoch: metadata.history_epoch,
  };
}

async function syncAck(payload: { graph_handle: string; message_id: string }) {
  const state = requireState(payload.graph_handle);
  await state.repository.acknowledge(state.storageKey, payload.message_id);
  return null;
}

async function syncImport(payload: { graph_handle: string; bytes: ArrayBuffer | Uint8Array }) {
  const state = requireState(payload.graph_handle);
  if (state.pending) {
    throw failure("dirty_unsaved", "save the local update before importing remote state", true);
  }
  const bytes = asUint8Array(payload.bytes);
  state.core.validateUpdate(bytes);
  const receipt = await state.repository.appendUpdate(state.storageKey, ownedBuffer(bytes), now());
  state.core.importUpdate(bytes);
  push(state, "remote", { type: "semantic", name: "remote_import" });
  push(state, "remote", { type: "saved_locally", ...receipt });
  return receipt;
}

async function syncReplace(payload: {
  graph_handle: string;
  checkpoint: ArrayBuffer | Uint8Array;
  history_epoch: number;
  server_version_vector: ArrayBuffer | Uint8Array;
}) {
  const state = requireState(payload.graph_handle);
  if (state.pending) {
    throw failure("dirty_unsaved", "save the local update before replacing history", true);
  }
  const checkpoint = ownedBuffer(asUint8Array(payload.checkpoint));
  const serverVersionVector = ownedBuffer(asUint8Array(payload.server_version_vector));
  const candidate = WasmGraphCore.fromSnapshot(
    state.graphId,
    BigInt(state.replicaId),
    new Uint8Array(checkpoint),
  );
  // Replay only durable, unacknowledged intent onto the new Base. If any old
  // update cannot be rebased, canonical state remains untouched and reconnect
  // can be retried or surfaced as recovery-required.
  for (const record of await state.repository.outbox(state.storageKey)) {
    candidate.importUpdate(new Uint8Array(record.payload));
  }
  candidate.resetLocalHistory();
  const rebasedTail = ownedBuffer(
    candidate.exportUpdatesSince(new Uint8Array(serverVersionVector)),
  );
  await state.repository.replaceHistory(
    state.storageKey,
    checkpoint,
    payload.history_epoch,
    serverVersionVector,
    rebasedTail,
    crypto.randomUUID(),
    SCHEMA_VERSION,
    now(),
  );
  state.core = candidate;
  push(state, "remote", { type: "semantic", name: "history_epoch_replaced" });
  return null;
}

function syncEncode(payload: unknown): ArrayBuffer {
  return ownedBuffer(encodeSyncMessageJson(JSON.stringify(payload)));
}

function syncDecode(payload: { frame: ArrayBuffer | Uint8Array }): unknown {
  return JSON.parse(decodeSyncMessageJson(asUint8Array(payload.frame)));
}

async function testControl(payload: Record<string, unknown>) {
  const repository = createRepository() as TestIndexedDbGraphRepository;
  switch (payload.action) {
    case "inject": {
      const state = requireState(String(payload.graph_handle));
      (state.repository as TestIndexedDbGraphRepository).injectOnce(payload.fault as FaultPoint);
      return null;
    }
    case "corrupt_update":
      return repository
        .corruptUpdate(String(payload.graph_id), Number(payload.sequence))
        .then(() => null);
    case "quarantine_count":
      return repository.quarantineCount(String(payload.graph_id));
    case "export_quarantine":
      return repository.exportQuarantine(String(payload.graph_id), String(payload.export_handle));
    case "storage_stats":
      return repository.storageStats(String(payload.graph_id));
    case "recovery_read_stats": {
      const state = requireState(String(payload.graph_handle));
      return state.repository instanceof TestIndexedDbGraphRepository
        ? state.repository.recoveryReadStats()
        : null;
    }
    case "replica_id":
      return repository.metadata(String(payload.graph_id)).then((value) => value.replica_id);
    case "gc_checkpoint": {
      const state = requireState(String(payload.graph_handle));
      return {
        checkpoint: [...state.core.exportGcCheckpoint()],
        version_vector: [...state.core.versionVector()],
      };
    }
    case "query_index_ready":
      return requireState(String(payload.graph_handle)).core.queryIndexReady();
    case "fixture_update": {
      const core = WasmGraphCore.fromSnapshot(
        String(payload.graph_id),
        BigInt(Number(payload.peer_id)),
        asUint8Array(payload.checkpoint as ArrayBuffer | Uint8Array | number[]),
      );
      core.executeJson(JSON.stringify(payload.command), now());
      return [...core.takeUpdate()];
    }
    case "set_schema":
      return repository
        .setSchemaVersion(String(payload.graph_id), Number(payload.schema_version))
        .then(() => null);
    default:
      throw failure("invalid_request", "unknown test control action", false);
  }
}

function createRepository(): IndexedDbGraphRepository {
  return import.meta.env.MODE === "test"
    ? new TestIndexedDbGraphRepository()
    : new IndexedDbGraphRepository();
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
  if (error instanceof StorageError)
    return { code: error.code, message: error.message, retryable: error.retryable };
  if (isCorePortError(error)) return error;
  return failure("internal", error instanceof Error ? error.message : String(error), false);
}

function isCorePortError(error: unknown): error is CorePortError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "retryable" in error
  );
}

function archiveFailure(error: unknown): CorePortError {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = message.toLowerCase();
  if (diagnostic.includes("size limit") || diagnostic.includes("too large")) {
    return failure("archive_too_large", message, false);
  }
  if (diagnostic.includes("checksum")) {
    return failure("archive_checksum_mismatch", message, false);
  }
  if (diagnostic.includes("unsupported archive")) {
    return failure("unsupported_archive", message, false);
  }
  if (diagnostic.includes("unsupported schema")) {
    return failure("unsupported_schema", message, false);
  }
  return failure("invalid_archive", message, false);
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function asUint8Array(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function now(): string {
  if (import.meta.env.MODE === "test") {
    return `2026-08-03T13:00:${String(testTick++ % 60).padStart(2, "0")}Z`;
  }
  return new Date().toISOString();
}

function randomReplicaId(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (words[0] & 0x1f_ffff) * 0x1_0000_0000 + words[1];
}
