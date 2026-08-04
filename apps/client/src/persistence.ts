import type { CorePortErrorCode, GraphLocatorDto, StorageCapabilitiesDto } from "./generated/core-port";

const DATABASE = "neoseq-local-v1";
const VERSION = 2;
const STORES = {
  metadata: "metadata",
  updates: "updates",
  checkpoints: "checkpoints",
  quarantine: "quarantine",
} as const;

export interface MetadataRecord {
  graph_id: string;
  locator: GraphLocatorDto;
  schema_version: number;
  next_sequence: number;
  compacted_through: number;
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

export type FaultPoint =
  | "append_before"
  | "append_after"
  | "checkpoint_before"
  | "checkpoint_after"
  | "abort"
  | "quota";

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
  private fault?: FaultPoint;

  injectOnce(fault: FaultPoint): void {
    this.fault = fault;
  }

  async openGraph(locator: GraphLocatorDto, now: string): Promise<MetadataRecord> {
    if (locator.location !== "local") {
      throw new StorageError("invalid_request", "only local graphs are supported", false);
    }
    const database = await openDatabase();
    const transaction = database.transaction(STORES.metadata, "readwrite");
    const store = transaction.objectStore(STORES.metadata);
    const existing = await request<MetadataRecord | undefined>(store.get(locator.graph_id));
    const metadata = existing ?? {
      graph_id: locator.graph_id,
      locator,
      schema_version: 3,
      next_sequence: 1,
      compacted_through: 0,
      created_at: now,
      updated_at: now,
    };
    if (!existing) store.put(metadata);
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

  async appendUpdate(graphId: string, payload: ArrayBuffer, now: string): Promise<{ local_sequence: number; checksum: string }> {
    this.storageFault();
    if (this.takeFault("append_before")) throw new StorageError("dirty_unsaved", "append failed before commit", true);
    const digest = await checksum(payload);
    const database = await openDatabase();
    const transaction = database.transaction([STORES.metadata, STORES.updates], "readwrite");
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
    metadataStore.put({ ...metadata, next_sequence: localSequence + 1, updated_at: now });
    if (this.takeFault("abort")) transaction.abort();
    await complete(transaction);
    database.close();
    if (this.takeFault("append_after")) throw new StorageError("dirty_unsaved", "append failed after commit", true);
    return { local_sequence: localSequence, checksum: digest };
  }

  async updatesAfter(graphId: string, sequence: number): Promise<UpdateRecord[]> {
    const values = await allByGraph<UpdateRecord>(STORES.updates, graphId);
    return values.filter((value) => value.local_sequence > sequence).sort(bySequence);
  }

  async checkpointsDescending(graphId: string): Promise<CheckpointRecord[]> {
    const values = await allByGraph<CheckpointRecord>(STORES.checkpoints, graphId);
    return values.sort((left, right) => right.local_sequence - left.local_sequence);
  }

  async saveCheckpoint(graphId: string, payload: ArrayBuffer, sequence: number, now: string): Promise<string> {
    this.storageFault();
    if (this.takeFault("checkpoint_before")) throw new StorageError("internal", "checkpoint failed before commit", true);
    const digest = await checksum(payload);
    const database = await openDatabase();
    const transaction = database.transaction(STORES.checkpoints, "readwrite");
    transaction.objectStore(STORES.checkpoints).put({
      graph_id: graphId,
      local_sequence: sequence,
      schema_version: 3,
      checksum: digest,
      payload,
      created_at: now,
    } satisfies CheckpointRecord);
    if (this.takeFault("abort")) transaction.abort();
    await complete(transaction);
    database.close();
    if (this.takeFault("checkpoint_after")) throw new StorageError("internal", "checkpoint failed after commit", true);
    return digest;
  }

  async compact(graphId: string, sequence: number): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(
      [STORES.metadata, STORES.updates, STORES.checkpoints],
      "readwrite",
    );
    const metadataStore = transaction.objectStore(STORES.metadata);
    const metadata = await request<MetadataRecord | undefined>(metadataStore.get(graphId));
    if (!metadata) throw new StorageError("graph_not_open", "graph metadata not found", false);
    metadataStore.put({ ...metadata, compacted_through: Math.max(metadata.compacted_through, sequence) });
    await deleteSequences(transaction.objectStore(STORES.updates), graphId, (value) => value <= sequence);
    await deleteSequences(transaction.objectStore(STORES.checkpoints), graphId, (value) => value < sequence);
    await complete(transaction);
    database.close();
  }

  async setSchemaVersion(graphId: string, schemaVersion: number): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(STORES.metadata, "readwrite");
    const store = transaction.objectStore(STORES.metadata);
    const metadata = await request<MetadataRecord | undefined>(store.get(graphId));
    if (!metadata) throw new StorageError("graph_not_open", "graph metadata not found", false);
    store.put({ ...metadata, schema_version: schemaVersion });
    await complete(transaction);
    database.close();
  }

  async quarantine(record: QuarantineRecord): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(STORES.quarantine, "readwrite");
    transaction.objectStore(STORES.quarantine).put(record);
    await complete(transaction);
    database.close();
  }

  async quarantined(graphId: string): Promise<QuarantineRecord[]> {
    return (await allByGraph<QuarantineRecord>(STORES.quarantine, graphId)).sort((a, b) => a.export_handle.localeCompare(b.export_handle));
  }

  async exportQuarantine(graphId: string, exportHandle: string): Promise<ArrayBuffer> {
    const database = await openDatabase();
    const transaction = database.transaction(STORES.quarantine, "readonly");
    const value = await request<QuarantineRecord | undefined>(
      transaction.objectStore(STORES.quarantine).get([graphId, exportHandle]),
    );
    await complete(transaction);
    database.close();
    if (!value) throw new StorageError("storage_corrupt", "quarantine export handle not found", false);
    return value.payload;
  }

  async corruptUpdate(graphId: string, sequence: number): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(STORES.updates, "readwrite");
    const store = transaction.objectStore(STORES.updates);
    const key: [string, number] = [graphId, sequence];
    const value = await request<UpdateRecord | undefined>(store.get(key));
    if (!value) throw new StorageError("storage_corrupt", "update to corrupt was not found", false);
    const source = new Uint8Array(value.payload);
    const truncated = source.slice(0, Math.max(0, source.byteLength - 1));
    store.put({ ...value, payload: truncated.buffer });
    await complete(transaction);
    database.close();
  }

  async deleteLocal(graphId: string): Promise<void> {
    const database = await openDatabase();
    const names = Object.values(STORES);
    const transaction = database.transaction(names, "readwrite");
    transaction.objectStore(STORES.metadata).delete(graphId);
    for (const name of names.filter((name) => name !== STORES.metadata)) {
      const store = transaction.objectStore(name);
      const index = store.index("by_graph");
      const keys = await request<IDBValidKey[]>(index.getAllKeys(graphId));
      keys.forEach((key) => store.delete(key));
    }
    await complete(transaction);
    database.close();
  }

  async capabilities(): Promise<StorageCapabilitiesDto> {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : undefined;
    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    return {
      durable: true,
      persisted,
      quota_bytes: estimate.quota,
      usage_bytes: estimate.usage,
    };
  }

  private storageFault(): void {
    if (this.takeFault("quota")) throw new StorageError("storage_full", "IndexedDB quota exceeded", true);
  }

  private takeFault(expected: FaultPoint): boolean {
    if (this.fault === expected) {
      this.fault = undefined;
      return true;
    }
    return false;
  }
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      const transaction = open.transaction;
      if (!database.objectStoreNames.contains(STORES.metadata)) {
        database.createObjectStore(STORES.metadata, { keyPath: "graph_id" });
      }
      for (const name of [STORES.updates, STORES.checkpoints]) {
        if (!database.objectStoreNames.contains(name)) {
          const store = database.createObjectStore(name, { keyPath: ["graph_id", "local_sequence"] });
          store.createIndex("by_graph", "graph_id", { unique: false });
        }
      }
      if (!database.objectStoreNames.contains(STORES.quarantine)) {
        const quarantine = database.createObjectStore(STORES.quarantine, { keyPath: ["graph_id", "export_handle"] });
        quarantine.createIndex("by_graph", "graph_id", { unique: false });
      }
      if (database.objectStoreNames.contains("outbox")) database.deleteObjectStore("outbox");
      if (database.objectStoreNames.contains("index_cache")) database.deleteObjectStore("index_cache");
      const updates = transaction?.objectStore(STORES.updates);
      if (updates && !updates.indexNames.contains("by_checksum")) {
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
  const values = await request<T[]>(transaction.objectStore(storeName).index("by_graph").getAll(graphId));
  await complete(transaction);
  database.close();
  return values;
}

async function deleteSequences(
  store: IDBObjectStore,
  graphId: string,
  shouldDelete: (sequence: number) => boolean,
): Promise<void> {
  const keys = await request<IDBValidKey[]>(store.index("by_graph").getAllKeys(graphId));
  for (const key of keys) {
    if (Array.isArray(key) && shouldDelete(Number(key[1]))) store.delete(key);
  }
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
    transaction.onabort = () => reject(mapDomError(transaction.error ?? new DOMException("transaction aborted", "AbortError")));
    transaction.onerror = () => reject(mapDomError(transaction.error));
  });
}

function mapDomError(error: DOMException | null): StorageError {
  if (error?.name === "QuotaExceededError") return new StorageError("storage_full", error.message, true);
  if (error?.name === "AbortError") return new StorageError("dirty_unsaved", error.message || "IndexedDB transaction aborted", true);
  return new StorageError("storage_corrupt", error?.message ?? "IndexedDB operation failed", false);
}

export async function checksum(payload: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validChecksum(expected: string, payload: ArrayBuffer): Promise<boolean> {
  return (await checksum(payload)) === expected;
}

function bySequence(left: { local_sequence: number }, right: { local_sequence: number }): number {
  return left.local_sequence - right.local_sequence;
}
