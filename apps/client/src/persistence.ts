import type {
  CorePortErrorCode,
  GraphLocatorDto,
  StorageCapabilitiesDto,
} from "./generated/core-port";

const DATABASE = "neoseq-local";
const VERSION = 3;
const STORES = {
  metadata: "metadata",
  updates: "updates",
  checkpoints: "checkpoints",
  quarantine: "quarantine",
  outbox: "outbox",
  syncState: "sync-state",
} as const;

export interface MetadataRecord {
  graph_id: string;
  locator: GraphLocatorDto;
  /** Stable Loro peer identity for this browser replica. */
  replica_id: number;
  /** Server-coordinated history generation. Local-only graphs remain at zero. */
  history_epoch: number;
  schema_version: number;
  next_sequence: number;
  compacted_through: number;
  checkpoint_bytes: number;
  tail_bytes: number;
  tail_count: number;
  created_at: string;
  updated_at: string;
}

export interface UpdateRecord {
  graph_id: string;
  local_sequence: number;
  checksum: string;
  payload: ArrayBuffer;
  created_at: string;
}

export interface CheckpointRecord extends UpdateRecord {
  schema_version: number;
}

export interface QuarantineRecord extends UpdateRecord {
  export_handle: string;
  record_kind: "update" | "checkpoint";
  reason: string;
}

export interface OutboxRecord {
  graph_id: string;
  message_id: string;
  local_sequence: number;
  base_version_vector: ArrayBuffer;
  /** Bootstrap history has no update row. Incremental entries reference updates. */
  payload?: ArrayBuffer;
  created_at: string;
}

export interface ResolvedOutboxRecord extends OutboxRecord {
  payload: ArrayBuffer;
}

export interface SyncStateRecord {
  graph_id: string;
  initialized?: boolean;
}

export interface GraphStorageStats {
  checkpoint_bytes: number;
  checkpoint_count: number;
  update_bytes: number;
  update_count: number;
  outbox_bytes: number;
  outbox_count: number;
  compacted_through: number;
}

export interface RecoveryReadStats {
  checkpoint_records: number;
  checkpoint_bytes: number;
  tail_records: number;
  tail_bytes: number;
}

export interface PersistenceHooks {
  before?(operation: "append" | "checkpoint"): void;
  beforeCommit?(transaction: IDBTransaction): void;
  after?(operation: "append" | "checkpoint"): void;
  afterRecoveryRead?(kind: "checkpoint" | "tail", records: number, bytes: number): void;
}

export class StorageError extends Error {
  constructor(
    public readonly code: CorePortErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class IndexedDbGraphRepository {
  constructor(private readonly hooks?: PersistenceHooks) {}

  async openGraph(
    locator: GraphLocatorDto,
    now: string,
    suggestedReplicaId: number,
  ): Promise<MetadataRecord> {
    const database = await openDatabase();
    const transaction = database.transaction(STORES.metadata, "readwrite");
    const store = transaction.objectStore(STORES.metadata);
    const existing = await request<MetadataRecord | undefined>(store.get(locator.graph_id));
    if (existing) {
      await complete(transaction);
      database.close();
      return hasStorageAccounting(existing) ? existing : backfillStorageAccounting(existing);
    }
    const metadata: MetadataRecord = {
      graph_id: locator.graph_id,
      locator,
      replica_id: suggestedReplicaId,
      history_epoch: 0,
      schema_version: 3,
      next_sequence: 1,
      compacted_through: 0,
      checkpoint_bytes: 0,
      tail_bytes: 0,
      tail_count: 0,
      created_at: now,
      updated_at: now,
    };
    store.put(metadata);
    await complete(transaction);
    database.close();
    return metadata;
  }

  async allMetadata(): Promise<MetadataRecord[]> {
    const database = await openDatabase();
    const transaction = database.transaction(STORES.metadata, "readonly");
    const values = await request<MetadataRecord[]>(
      transaction.objectStore(STORES.metadata).getAll(),
    );
    await complete(transaction);
    database.close();
    return values.sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  async metadata(graphId: string): Promise<MetadataRecord> {
    const database = await openDatabase();
    const transaction = database.transaction(STORES.metadata, "readonly");
    const value = await request<MetadataRecord | undefined>(
      transaction.objectStore(STORES.metadata).get(graphId),
    );
    await complete(transaction);
    database.close();
    if (!value) throw new StorageError("graph_not_open", "graph metadata not found", false);
    return value;
  }

  async appendUpdate(
    graphId: string,
    payload: ArrayBuffer,
    now: string,
    outbox?: { message_id: string; base_version_vector: ArrayBuffer },
  ): Promise<{ local_sequence: number; checksum: string }> {
    this.hooks?.before?.("append");
    const digest = await checksum(payload);
    const database = await openDatabase();
    const transaction = database.transaction(
      [STORES.metadata, STORES.updates, STORES.outbox],
      "readwrite",
    );
    const metadataStore = transaction.objectStore(STORES.metadata);
    const updateStore = transaction.objectStore(STORES.updates);
    const existing = await request<UpdateRecord | undefined>(
      updateStore.index("by_checksum").get([graphId, digest]),
    );
    if (existing) {
      await complete(transaction);
      database.close();
      return { local_sequence: existing.local_sequence, checksum: digest };
    }
    const metadata = await request<MetadataRecord | undefined>(metadataStore.get(graphId));
    if (!metadata) {
      transaction.abort();
      throw new StorageError("graph_not_open", "graph metadata not found", false);
    }
    const localSequence = metadata.next_sequence;
    updateStore.put({
      graph_id: graphId,
      local_sequence: localSequence,
      checksum: digest,
      payload,
      created_at: now,
    } satisfies UpdateRecord);
    if (outbox) {
      transaction.objectStore(STORES.outbox).put({
        graph_id: graphId,
        message_id: outbox.message_id,
        local_sequence: localSequence,
        base_version_vector: outbox.base_version_vector,
        created_at: now,
      } satisfies OutboxRecord);
    }
    metadataStore.put({
      ...metadata,
      next_sequence: localSequence + 1,
      tail_bytes: metadata.tail_bytes + payload.byteLength,
      tail_count: metadata.tail_count + 1,
      updated_at: now,
    });
    this.hooks?.beforeCommit?.(transaction);
    await complete(transaction);
    database.close();
    this.hooks?.after?.("append");
    return { local_sequence: localSequence, checksum: digest };
  }

  async outbox(graphId: string): Promise<ResolvedOutboxRecord[]> {
    const database = await openDatabase();
    const transaction = database.transaction([STORES.outbox, STORES.updates], "readonly");
    const records = await request<OutboxRecord[]>(
      transaction.objectStore(STORES.outbox).index("by_graph").getAll(graphId),
    );
    const updateStore = transaction.objectStore(STORES.updates);
    const resolved: ResolvedOutboxRecord[] = [];
    for (const record of records.sort(bySequence)) {
      let payload = record.payload;
      if (!payload) {
        const update = await request<UpdateRecord | undefined>(
          updateStore.get([graphId, record.local_sequence]),
        );
        if (!update) {
          transaction.abort();
          throw new StorageError(
            "storage_corrupt",
            `outbox update ${record.local_sequence} is missing`,
            false,
          );
        }
        payload = update.payload;
      }
      resolved.push({ ...record, payload });
    }
    await complete(transaction);
    database.close();
    return resolved;
  }

  /** Durably queues the replica's existing history before later remote edits.
   * The local checkpoint already owns these bytes, so sequence zero is a
   * transport-only bootstrap record rather than another recovery-log entry. */
  async initializeSync(
    graphId: string,
    messageId: string,
    baseVersionVector: ArrayBuffer,
    payload: ArrayBuffer,
    now: string,
  ): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction([STORES.outbox, STORES.syncState], "readwrite");
    const stateStore = transaction.objectStore(STORES.syncState);
    const current = await request<SyncStateRecord | undefined>(stateStore.get(graphId));
    if (!current?.initialized) {
      transaction.objectStore(STORES.outbox).put({
        graph_id: graphId,
        message_id: messageId,
        local_sequence: 0,
        base_version_vector: baseVersionVector,
        payload,
        created_at: now,
      } satisfies OutboxRecord);
      stateStore.put({
        ...current,
        graph_id: graphId,
        initialized: true,
      } satisfies SyncStateRecord);
    }
    await complete(transaction);
    database.close();
  }

  async acknowledge(graphId: string, messageId: string): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(
      [STORES.metadata, STORES.outbox, STORES.updates, STORES.checkpoints],
      "readwrite",
    );
    const outboxStore = transaction.objectStore(STORES.outbox);
    const record = await request<OutboxRecord | undefined>(outboxStore.get([graphId, messageId]));
    outboxStore.delete([graphId, messageId]);
    if (record && record.local_sequence > 0) {
      const metadata = await request<MetadataRecord | undefined>(
        transaction.objectStore(STORES.metadata).get(graphId),
      );
      const checkpoints = await request<CheckpointRecord[]>(
        transaction.objectStore(STORES.checkpoints).index("by_graph").getAll(graphId),
      );
      const fallbackThrough = checkpoints.reduce(
        (minimum, checkpoint) => Math.min(minimum, checkpoint.local_sequence),
        metadata?.compacted_through ?? 0,
      );
      if (metadata && record.local_sequence <= fallbackThrough) {
        const updateStore = transaction.objectStore(STORES.updates);
        const update = await request<UpdateRecord | undefined>(
          updateStore.get([graphId, record.local_sequence]),
        );
        updateStore.delete([graphId, record.local_sequence]);
        if (update) {
          transaction.objectStore(STORES.metadata).put({
            ...metadata,
            tail_bytes: Math.max(0, metadata.tail_bytes - update.payload.byteLength),
            tail_count: Math.max(0, metadata.tail_count - 1),
          });
        }
      }
    }
    await complete(transaction);
    database.close();
  }

  async syncState(graphId: string): Promise<SyncStateRecord> {
    const database = await openDatabase();
    const transaction = database.transaction(STORES.syncState, "readonly");
    const state = await request<SyncStateRecord | undefined>(
      transaction.objectStore(STORES.syncState).get(graphId),
    );
    await complete(transaction);
    database.close();
    return state ?? { graph_id: graphId };
  }

  async updatesAfter(graphId: string, sequence: number): Promise<UpdateRecord[]> {
    const database = await openDatabase();
    const transaction = database.transaction(STORES.updates, "readonly");
    const range = IDBKeyRange.bound([graphId, sequence + 1], [graphId, Number.MAX_SAFE_INTEGER]);
    const values = await request<UpdateRecord[]>(
      transaction.objectStore(STORES.updates).getAll(range),
    );
    await complete(transaction);
    database.close();
    this.hooks?.afterRecoveryRead?.(
      "tail",
      values.length,
      values.reduce((total, value) => total + value.payload.byteLength, 0),
    );
    return values.sort(bySequence);
  }

  async checkpointsDescending(graphId: string): Promise<CheckpointRecord[]> {
    const values = await allByGraph<CheckpointRecord>(STORES.checkpoints, graphId);
    this.hooks?.afterRecoveryRead?.(
      "checkpoint",
      values.length,
      values.reduce((total, value) => total + value.payload.byteLength, 0),
    );
    return values.sort((left, right) => right.local_sequence - left.local_sequence);
  }

  /** Installs a validated portable copy as a brand-new local graph.
   *
   * The graph ID is generated by the caller for this import. Metadata and the
   * sequence-zero Base land in one transaction, so listing can never expose a
   * graph whose canonical state is only partly present. */
  async installImportedGraph(
    locator: GraphLocatorDto,
    replicaId: number,
    schemaVersion: number,
    checkpoint: ArrayBuffer,
    now: string,
  ): Promise<MetadataRecord> {
    const digest = await checksum(checkpoint);
    const database = await openDatabase();
    const transaction = database.transaction([STORES.metadata, STORES.checkpoints], "readwrite");
    const metadataStore = transaction.objectStore(STORES.metadata);
    const existing = await request<MetadataRecord | undefined>(metadataStore.get(locator.graph_id));
    if (existing) {
      transaction.abort();
      database.close();
      throw new StorageError(
        "graph_already_exists",
        "the generated graph id already exists",
        false,
      );
    }
    const metadata: MetadataRecord = {
      graph_id: locator.graph_id,
      locator,
      replica_id: replicaId,
      history_epoch: 0,
      schema_version: schemaVersion,
      next_sequence: 1,
      compacted_through: 0,
      checkpoint_bytes: checkpoint.byteLength,
      tail_bytes: 0,
      tail_count: 0,
      created_at: now,
      updated_at: now,
    };
    metadataStore.put(metadata);
    transaction.objectStore(STORES.checkpoints).put({
      graph_id: locator.graph_id,
      local_sequence: 0,
      schema_version: schemaVersion,
      checksum: digest,
      payload: checkpoint,
      created_at: now,
    } satisfies CheckpointRecord);
    await complete(transaction);
    database.close();
    return metadata;
  }

  async installCheckpoint(
    graphId: string,
    payload: ArrayBuffer,
    sequence: number,
    schemaVersion: number,
    now: string,
  ): Promise<string> {
    this.hooks?.before?.("checkpoint");
    const digest = await checksum(payload);
    const database = await openDatabase();
    const transaction = database.transaction(
      [STORES.metadata, STORES.updates, STORES.checkpoints, STORES.outbox],
      "readwrite",
    );
    const metadataStore = transaction.objectStore(STORES.metadata);
    const metadata = await request<MetadataRecord | undefined>(metadataStore.get(graphId));
    if (!metadata) {
      transaction.abort();
      throw new StorageError("graph_not_open", "graph metadata not found", false);
    }
    if (sequence < metadata.compacted_through || sequence >= metadata.next_sequence) {
      transaction.abort();
      database.close();
      throw new StorageError(
        "storage_corrupt",
        "checkpoint sequence is outside the durable frontier",
        false,
      );
    }
    const checkpointStore = transaction.objectStore(STORES.checkpoints);
    checkpointStore.put({
      graph_id: graphId,
      local_sequence: sequence,
      schema_version: schemaVersion,
      checksum: digest,
      payload,
      created_at: now,
    } satisfies CheckpointRecord);
    const pinned = new Set(
      (
        await request<OutboxRecord[]>(
          transaction.objectStore(STORES.outbox).index("by_graph").getAll(graphId),
        )
      )
        .map((record) => record.local_sequence)
        .filter((value) => value > 0),
    );
    const retainedCheckpoints = (
      await request<CheckpointRecord[]>(checkpointStore.index("by_graph").getAll(graphId))
    ).sort((left, right) => right.local_sequence - left.local_sequence);
    for (const stale of retainedCheckpoints.slice(2)) {
      checkpointStore.delete([graphId, stale.local_sequence]);
    }
    const fallbackThrough = retainedCheckpoints
      .slice(0, 2)
      .reduce((minimum, record) => Math.min(minimum, record.local_sequence), sequence);
    const updateStore = transaction.objectStore(STORES.updates);
    const updates = await request<UpdateRecord[]>(updateStore.index("by_graph").getAll(graphId));
    let tailBytes = 0;
    let tailCount = 0;
    for (const update of updates) {
      if (update.local_sequence <= fallbackThrough && !pinned.has(update.local_sequence)) {
        updateStore.delete([graphId, update.local_sequence]);
      } else {
        tailBytes += update.payload.byteLength;
        tailCount += 1;
      }
    }
    metadataStore.put({
      ...metadata,
      schema_version: schemaVersion,
      compacted_through: Math.max(metadata.compacted_through, sequence),
      checkpoint_bytes: retainedCheckpoints
        .slice(0, 2)
        .reduce((total, record) => total + record.payload.byteLength, 0),
      tail_bytes: tailBytes,
      tail_count: tailCount,
      updated_at: now,
    });
    this.hooks?.beforeCommit?.(transaction);
    await complete(transaction);
    database.close();
    this.hooks?.after?.("checkpoint");
    return digest;
  }

  /** Publishes the last valid frontier and moves the corrupt suffix to
   * quarantine in the same transaction. Sequence numbers are never reused. */
  async repairCorruptTail(
    graphId: string,
    checkpoint: ArrayBuffer,
    validThrough: number,
    schemaVersion: number,
    records: QuarantineRecord[],
    now: string,
  ): Promise<string> {
    const digest = await checksum(checkpoint);
    const database = await openDatabase();
    const transaction = database.transaction(
      [STORES.metadata, STORES.updates, STORES.checkpoints, STORES.quarantine],
      "readwrite",
    );
    const metadataStore = transaction.objectStore(STORES.metadata);
    const metadata = await request<MetadataRecord | undefined>(metadataStore.get(graphId));
    if (!metadata) {
      transaction.abort();
      throw new StorageError("graph_not_open", "graph metadata not found", false);
    }
    const quarantineStore = transaction.objectStore(STORES.quarantine);
    for (const record of records) quarantineStore.put(record);
    const checkpointStore = transaction.objectStore(STORES.checkpoints);
    checkpointStore.put({
      graph_id: graphId,
      local_sequence: validThrough,
      schema_version: schemaVersion,
      checksum: digest,
      payload: checkpoint,
      created_at: now,
    } satisfies CheckpointRecord);
    const updateStore = transaction.objectStore(STORES.updates);
    const updates = await request<UpdateRecord[]>(updateStore.index("by_graph").getAll(graphId));
    for (const update of updates) {
      if (update.local_sequence > validThrough) {
        updateStore.delete([graphId, update.local_sequence]);
      }
    }
    const checkpoints = (
      await request<CheckpointRecord[]>(checkpointStore.index("by_graph").getAll(graphId))
    ).sort((left, right) => right.local_sequence - left.local_sequence);
    for (const stale of checkpoints.slice(2)) {
      checkpointStore.delete([graphId, stale.local_sequence]);
    }
    const retainedUpdates = updates.filter((update) => update.local_sequence <= validThrough);
    metadataStore.put({
      ...metadata,
      schema_version: schemaVersion,
      compacted_through: validThrough,
      checkpoint_bytes: checkpoints
        .slice(0, 2)
        .reduce((total, record) => total + record.payload.byteLength, 0),
      tail_bytes: retainedUpdates.reduce((total, record) => total + record.payload.byteLength, 0),
      tail_count: retainedUpdates.length,
      updated_at: now,
    });
    await complete(transaction);
    database.close();
    return digest;
  }

  /** Atomically adopts a server-owned history epoch. The server checkpoint is
   * the new Base; any local state absent from it is stored once as a Tail row
   * and referenced by a fresh outbox message. */
  async replaceHistory(
    graphId: string,
    checkpoint: ArrayBuffer,
    historyEpoch: number,
    baseVersionVector: ArrayBuffer,
    rebasedTail: ArrayBuffer,
    messageId: string,
    schemaVersion: number,
    now: string,
  ): Promise<void> {
    this.hooks?.before?.("checkpoint");
    const [checkpointDigest, tailDigest] = await Promise.all([
      checksum(checkpoint),
      rebasedTail.byteLength > 0 ? checksum(rebasedTail) : Promise.resolve(""),
    ]);
    const database = await openDatabase();
    const transaction = database.transaction(
      [STORES.metadata, STORES.updates, STORES.checkpoints, STORES.outbox],
      "readwrite",
    );
    const metadataStore = transaction.objectStore(STORES.metadata);
    const metadata = await request<MetadataRecord | undefined>(metadataStore.get(graphId));
    if (!metadata) {
      transaction.abort();
      throw new StorageError("graph_not_open", "graph metadata not found", false);
    }
    const checkpointSequence = metadata.next_sequence - 1;
    const checkpointStore = transaction.objectStore(STORES.checkpoints);
    const updateStore = transaction.objectStore(STORES.updates);
    const outboxStore = transaction.objectStore(STORES.outbox);
    await Promise.all([
      deleteByGraph(checkpointStore, graphId),
      deleteByGraph(updateStore, graphId),
      deleteByGraph(outboxStore, graphId),
    ]);
    checkpointStore.put({
      graph_id: graphId,
      local_sequence: checkpointSequence,
      schema_version: schemaVersion,
      checksum: checkpointDigest,
      payload: checkpoint,
      created_at: now,
    } satisfies CheckpointRecord);
    let nextSequence = metadata.next_sequence;
    if (rebasedTail.byteLength > 0) {
      const localSequence = nextSequence;
      updateStore.put({
        graph_id: graphId,
        local_sequence: localSequence,
        checksum: tailDigest,
        payload: rebasedTail,
        created_at: now,
      } satisfies UpdateRecord);
      outboxStore.put({
        graph_id: graphId,
        message_id: messageId,
        local_sequence: localSequence,
        base_version_vector: baseVersionVector,
        created_at: now,
      } satisfies OutboxRecord);
      nextSequence += 1;
    }
    metadataStore.put({
      ...metadata,
      history_epoch: historyEpoch,
      schema_version: schemaVersion,
      next_sequence: nextSequence,
      compacted_through: checkpointSequence,
      checkpoint_bytes: checkpoint.byteLength,
      tail_bytes: rebasedTail.byteLength,
      tail_count: rebasedTail.byteLength > 0 ? 1 : 0,
      updated_at: now,
    });
    this.hooks?.beforeCommit?.(transaction);
    await complete(transaction);
    database.close();
    this.hooks?.after?.("checkpoint");
  }

  async quarantine(record: QuarantineRecord): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(STORES.quarantine, "readwrite");
    transaction.objectStore(STORES.quarantine).put(record);
    await complete(transaction);
    database.close();
  }

  async deleteLocal(graphId: string): Promise<void> {
    const database = await openDatabase();
    const names = Object.values(STORES);
    const transaction = database.transaction(names, "readwrite");
    transaction.objectStore(STORES.metadata).delete(graphId);
    transaction.objectStore(STORES.syncState).delete(graphId);
    for (const name of names.filter(
      (name) => name !== STORES.metadata && name !== STORES.syncState,
    )) {
      const store = transaction.objectStore(name);
      const index = store.index("by_graph");
      const keys = await request<IDBValidKey[]>(index.getAllKeys(graphId));
      keys.forEach((key) => store.delete(key));
    }
    await complete(transaction);
    database.close();
  }

  async capabilities(graphId: string): Promise<StorageCapabilitiesDto> {
    const persisted = navigator.storage?.persisted
      ? await navigator.storage.persisted()
      : undefined;
    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    const metadata = await this.metadata(graphId);
    const [outbox, quarantine] = await Promise.all([
      allByGraph<OutboxRecord>(STORES.outbox, graphId),
      allByGraph<QuarantineRecord>(STORES.quarantine, graphId),
    ]);
    const standaloneOutboxBytes = outbox.reduce(
      (total, record) => total + (record.payload?.byteLength ?? 0),
      0,
    );
    const quarantineBytes = quarantine.reduce(
      (total, record) => total + record.payload.byteLength,
      0,
    );
    return {
      durable: true,
      persisted,
      quota_bytes: estimate.quota,
      // This field is graph data, not the origin-wide allocation returned by
      // StorageManager (which also includes the Wasm/font shell cache).
      usage_bytes:
        metadata.checkpoint_bytes + metadata.tail_bytes + standaloneOutboxBytes + quarantineBytes,
    };
  }

  async storageStats(graphId: string): Promise<GraphStorageStats> {
    const metadata = await this.metadata(graphId);
    const [checkpoints, updates, outbox] = await Promise.all([
      allByGraph<CheckpointRecord>(STORES.checkpoints, graphId),
      allByGraph<UpdateRecord>(STORES.updates, graphId),
      allByGraph<OutboxRecord>(STORES.outbox, graphId),
    ]);
    return {
      checkpoint_bytes: checkpoints.reduce((total, record) => total + record.payload.byteLength, 0),
      checkpoint_count: checkpoints.length,
      update_bytes: updates.reduce((total, record) => total + record.payload.byteLength, 0),
      update_count: updates.length,
      outbox_bytes: outbox.reduce((total, record) => total + (record.payload?.byteLength ?? 0), 0),
      outbox_count: outbox.length,
      compacted_through: metadata.compacted_through,
    };
  }
}

function hasStorageAccounting(metadata: MetadataRecord): boolean {
  return (
    Number.isFinite(metadata.compacted_through) &&
    Number.isFinite(metadata.checkpoint_bytes) &&
    Number.isFinite(metadata.tail_bytes) &&
    Number.isFinite(metadata.tail_count)
  );
}

/** One cold compatibility path for metadata written before storage accounting. */
async function backfillStorageAccounting(metadata: MetadataRecord): Promise<MetadataRecord> {
  const [updates, checkpoints] = await Promise.all([
    allByGraph<UpdateRecord>(STORES.updates, metadata.graph_id),
    allByGraph<CheckpointRecord>(STORES.checkpoints, metadata.graph_id),
  ]);
  const repaired: MetadataRecord = {
    ...metadata,
    compacted_through: metadata.compacted_through ?? 0,
    checkpoint_bytes: checkpoints.reduce((total, value) => total + value.payload.byteLength, 0),
    tail_bytes: updates.reduce((total, value) => total + value.payload.byteLength, 0),
    tail_count: updates.length,
  };
  const database = await openDatabase();
  const transaction = database.transaction(STORES.metadata, "readwrite");
  transaction.objectStore(STORES.metadata).put(repaired);
  await complete(transaction);
  database.close();
  return repaired;
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains(STORES.metadata)) {
        database.createObjectStore(STORES.metadata, { keyPath: "graph_id" });
      }
      for (const name of [STORES.updates, STORES.checkpoints]) {
        const store = database.objectStoreNames.contains(name)
          ? open.transaction!.objectStore(name)
          : database.createObjectStore(name, {
              keyPath: ["graph_id", "local_sequence"],
            });
        if (!store.indexNames.contains("by_graph")) {
          store.createIndex("by_graph", "graph_id", { unique: false });
        }
      }
      const quarantine = database.objectStoreNames.contains(STORES.quarantine)
        ? open.transaction!.objectStore(STORES.quarantine)
        : database.createObjectStore(STORES.quarantine, {
            keyPath: ["graph_id", "export_handle"],
          });
      if (!quarantine.indexNames.contains("by_graph")) {
        quarantine.createIndex("by_graph", "graph_id", { unique: false });
      }
      const outbox = database.objectStoreNames.contains(STORES.outbox)
        ? open.transaction!.objectStore(STORES.outbox)
        : database.createObjectStore(STORES.outbox, {
            keyPath: ["graph_id", "message_id"],
          });
      if (!outbox.indexNames.contains("by_graph")) {
        outbox.createIndex("by_graph", "graph_id", { unique: false });
      }
      if (!database.objectStoreNames.contains(STORES.syncState)) {
        database.createObjectStore(STORES.syncState, { keyPath: "graph_id" });
      }
      const updates = open.transaction!.objectStore(STORES.updates);
      if (!updates.indexNames.contains("by_checksum")) {
        updates.createIndex("by_checksum", ["graph_id", "checksum"], { unique: true });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(mapDomError(open.error));
  });
}

async function allByGraph<T>(storeName: string, graphId: string): Promise<T[]> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const values = await request<T[]>(
    transaction.objectStore(storeName).index("by_graph").getAll(graphId),
  );
  await complete(transaction);
  database.close();
  return values;
}

async function deleteByGraph(store: IDBObjectStore, graphId: string): Promise<void> {
  const keys = await request<IDBValidKey[]>(store.index("by_graph").getAllKeys(graphId));
  keys.forEach((key) => store.delete(key));
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(mapDomError(value.error));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        mapDomError(transaction.error ?? new DOMException("transaction aborted", "AbortError")),
      );
    transaction.onerror = () => reject(mapDomError(transaction.error));
  });
}

function mapDomError(error: DOMException | null): StorageError {
  if (error?.name === "QuotaExceededError")
    return new StorageError("storage_full", error.message, true);
  if (error?.name === "AbortError")
    return new StorageError(
      "dirty_unsaved",
      error.message || "IndexedDB transaction aborted",
      true,
    );
  return new StorageError("storage_corrupt", error?.message ?? "IndexedDB operation failed", false);
}

async function checksum(payload: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validChecksum(expected: string, payload: ArrayBuffer): Promise<boolean> {
  return (await checksum(payload)) === expected;
}

function bySequence(left: { local_sequence: number }, right: { local_sequence: number }): number {
  return left.local_sequence - right.local_sequence;
}
