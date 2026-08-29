import {
  IndexedDbGraphRepository,
  StorageError,
  type MetadataRecord,
  type PersistenceHooks,
  type QuarantineRecord,
  type RecoveryReadStats,
  type UpdateRecord,
} from "../persistence";

const DATABASE = "neoseq-local-v1";
const VERSION = 1;

export type FaultPoint =
  | "append_before"
  | "append_after"
  | "checkpoint_before"
  | "checkpoint_after"
  | "abort"
  | "quota";

class FaultController implements PersistenceHooks {
  private fault?: FaultPoint;
  private readonly recoveryReads: RecoveryReadStats = {
    checkpoint_records: 0,
    checkpoint_bytes: 0,
    tail_records: 0,
    tail_bytes: 0,
  };

  injectOnce(fault: FaultPoint): void {
    this.fault = fault;
  }

  before(operation: "append" | "checkpoint"): void {
    this.storageFault();
    if (this.take(`${operation}_before`)) {
      throw operation === "append"
        ? new StorageError("dirty_unsaved", "append failed before commit", true)
        : new StorageError("internal", "checkpoint failed before commit", true);
    }
  }

  beforeCommit(transaction: IDBTransaction): void {
    if (this.take("abort")) transaction.abort();
  }

  after(operation: "append" | "checkpoint"): void {
    if (this.take(`${operation}_after`)) {
      throw operation === "append"
        ? new StorageError("dirty_unsaved", "append failed after commit", true)
        : new StorageError("internal", "checkpoint failed after commit", true);
    }
  }

  afterRecoveryRead(kind: "checkpoint" | "tail", records: number, bytes: number): void {
    if (kind === "checkpoint") {
      this.recoveryReads.checkpoint_records += records;
      this.recoveryReads.checkpoint_bytes += bytes;
    } else {
      this.recoveryReads.tail_records += records;
      this.recoveryReads.tail_bytes += bytes;
    }
  }

  readStats(): RecoveryReadStats {
    return { ...this.recoveryReads };
  }

  private storageFault(): void {
    if (this.take("quota")) {
      throw new StorageError("storage_full", "IndexedDB quota exceeded", true);
    }
  }

  private take(expected: FaultPoint): boolean {
    if (this.fault !== expected) return false;
    this.fault = undefined;
    return true;
  }
}

export class TestIndexedDbGraphRepository extends IndexedDbGraphRepository {
  private readonly faults: FaultController;

  constructor() {
    const faults = new FaultController();
    super(faults);
    this.faults = faults;
  }

  injectOnce(fault: FaultPoint): void {
    this.faults.injectOnce(fault);
  }

  recoveryReadStats(): RecoveryReadStats {
    return this.faults.readStats();
  }

  async setSchemaVersion(graphId: string, schemaVersion: number): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction("metadata", "readwrite");
    const store = transaction.objectStore("metadata");
    const metadata = await request<MetadataRecord | undefined>(store.get(graphId));
    if (!metadata) {
      throw new StorageError("graph_not_open", "graph metadata not found", false);
    }
    store.put({ ...metadata, schema_version: schemaVersion });
    await complete(transaction);
    database.close();
  }

  async corruptUpdate(graphId: string, sequence: number): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction("updates", "readwrite");
    const store = transaction.objectStore("updates");
    const key: [string, number] = [graphId, sequence];
    const value = await request<UpdateRecord | undefined>(store.get(key));
    if (!value) {
      throw new StorageError("storage_corrupt", "update to corrupt was not found", false);
    }
    const source = new Uint8Array(value.payload);
    const truncated = source.slice(0, Math.max(0, source.byteLength - 1));
    store.put({ ...value, payload: truncated.buffer });
    await complete(transaction);
    database.close();
  }

  async quarantineCount(graphId: string): Promise<number> {
    const database = await openDatabase();
    const transaction = database.transaction("quarantine", "readonly");
    const records = await request<QuarantineRecord[]>(
      transaction.objectStore("quarantine").index("by_graph").getAll(graphId),
    );
    await complete(transaction);
    database.close();
    return records.length;
  }

  async exportQuarantine(graphId: string, exportHandle: string): Promise<ArrayBuffer> {
    const database = await openDatabase();
    const transaction = database.transaction("quarantine", "readonly");
    const value = await request<QuarantineRecord | undefined>(
      transaction.objectStore("quarantine").get([graphId, exportHandle]),
    );
    await complete(transaction);
    database.close();
    if (!value) {
      throw new StorageError("storage_corrupt", "quarantine export handle not found", false);
    }
    return value.payload;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, VERSION);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("failed to open test database"));
  });
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("test database request failed"));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("test transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("test transaction failed"));
  });
}
