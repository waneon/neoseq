import {
  DEFAULT_DIAGNOSTIC_LIMITS,
  STANDARD_CAPTURE_POLICY,
  type DiagnosticRecord,
  type PersistedDiagnosticSession,
  type SensitiveDiagnosticPayload,
} from "./types";

const DATABASE = "neoseq-diagnostics";
const VERSION = 2;
const EXPIRY_MS = 24 * 60 * 60 * 1_000;
const SESSIONS = "sessions";
const RECORDS = "records";
const SENSITIVE = "sensitive";

export interface StoredDiagnosticRecording {
  readonly session: PersistedDiagnosticSession;
  readonly records: DiagnosticRecord[];
  readonly sensitive_payloads: SensitiveDiagnosticPayload[];
}

export interface DiagnosticStore {
  saveSession(session: PersistedDiagnosticSession): Promise<void>;
  appendRecords(recordingId: string, records: readonly DiagnosticRecord[]): Promise<void>;
  appendSensitivePayloads(
    recordingId: string,
    payloads: readonly SensitiveDiagnosticPayload[],
  ): Promise<void>;
  loadRecoverable(now?: number): Promise<StoredDiagnosticRecording | null>;
  deleteRecording(recordingId: string): Promise<void>;
}

interface StoredRecord extends DiagnosticRecord {
  readonly recording_id: string;
}

type StoredSensitivePayload = SensitiveDiagnosticPayload & { readonly recording_id: string };

export class IndexedDbDiagnosticStore implements DiagnosticStore {
  async saveSession(session: PersistedDiagnosticSession): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(SESSIONS, "readwrite");
    transaction.objectStore(SESSIONS).put(session);
    await complete(transaction);
    database.close();
  }

  async appendRecords(recordingId: string, records: readonly DiagnosticRecord[]): Promise<void> {
    if (records.length === 0) return;
    const database = await openDatabase();
    const transaction = database.transaction(RECORDS, "readwrite");
    const store = transaction.objectStore(RECORDS);
    for (const record of records) {
      store.put({ ...record, recording_id: recordingId } satisfies StoredRecord);
    }
    await complete(transaction);
    database.close();
  }

  async appendSensitivePayloads(
    recordingId: string,
    payloads: readonly SensitiveDiagnosticPayload[],
  ): Promise<void> {
    if (payloads.length === 0) return;
    const database = await openDatabase();
    const transaction = database.transaction(SENSITIVE, "readwrite");
    const store = transaction.objectStore(SENSITIVE);
    for (const payload of payloads) {
      store.put({ ...payload, recording_id: recordingId } satisfies StoredSensitivePayload);
    }
    await complete(transaction);
    database.close();
  }

  async loadRecoverable(now = Date.now()): Promise<StoredDiagnosticRecording | null> {
    const database = await openDatabase();
    const transaction = database.transaction(SESSIONS, "readonly");
    const sessions = await request<unknown[]>(
      transaction.objectStore(SESSIONS).getAll(),
    );
    await complete(transaction);
    database.close();
    const latest = sessions
      .map(normalizeSession)
      .sort((left, right) => right.started_at.localeCompare(left.started_at))[0];
    if (!latest) return null;
    if (now - Date.parse(latest.started_at) > EXPIRY_MS) {
      await this.deleteRecording(latest.recording_id);
      return null;
    }
    const recordsDatabase = await openDatabase();
    const recordsTransaction = recordsDatabase.transaction([RECORDS, SENSITIVE], "readonly");
    const records = await request<StoredRecord[]>(
      recordsTransaction.objectStore(RECORDS).index("by_recording").getAll(latest.recording_id),
    );
    const sensitivePayloads = await request<StoredSensitivePayload[]>(
      recordsTransaction.objectStore(SENSITIVE).index("by_recording").getAll(latest.recording_id),
    );
    await complete(recordsTransaction);
    recordsDatabase.close();
    return {
      session: latest,
      records: records
        .sort((left, right) => left.sequence - right.sequence)
        .map(({ recording_id: _recordingId, ...record }) => record),
      sensitive_payloads: sensitivePayloads
        .sort((left, right) => left.monotonic_ms - right.monotonic_ms)
        .map(({ recording_id: _recordingId, ...payload }) => payload),
    };
  }

  async deleteRecording(recordingId: string): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction([SESSIONS, RECORDS, SENSITIVE], "readwrite");
    transaction.objectStore(SESSIONS).delete(recordingId);
    const store = transaction.objectStore(RECORDS);
    const keys = await request<IDBValidKey[]>(store.index("by_recording").getAllKeys(recordingId));
    for (const key of keys) store.delete(key);
    const sensitiveStore = transaction.objectStore(SENSITIVE);
    const sensitiveKeys = await request<IDBValidKey[]>(
      sensitiveStore.index("by_recording").getAllKeys(recordingId),
    );
    for (const key of sensitiveKeys) sensitiveStore.delete(key);
    await complete(transaction);
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains(SESSIONS)) {
        database.createObjectStore(SESSIONS, { keyPath: "recording_id" });
      }
      if (!database.objectStoreNames.contains(RECORDS)) {
        const records = database.createObjectStore(RECORDS, {
          keyPath: ["recording_id", "sequence"],
        });
        records.createIndex("by_recording", "recording_id", { unique: false });
      }
      if (!database.objectStoreNames.contains(SENSITIVE)) {
        const sensitive = database.createObjectStore(SENSITIVE, {
          keyPath: ["recording_id", "payload_id"],
        });
        sensitive.createIndex("by_recording", "recording_id", { unique: false });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("diagnostics database failed to open"));
  });
}

function normalizeSession(value: unknown): PersistedDiagnosticSession {
  const session = value as Partial<PersistedDiagnosticSession> & {
    limits?: Partial<PersistedDiagnosticSession["limits"]>;
  };
  return {
    recording_id: String(session.recording_id),
    phase: session.phase === "review" ? "review" : "recording",
    started_at: String(session.started_at),
    started_monotonic_ms: Number(session.started_monotonic_ms ?? 0),
    stopped_at: session.stopped_at,
    stop_reason: session.stop_reason,
    byte_count: Number(session.byte_count ?? 0),
    record_count: Number(session.record_count ?? 0),
    dropped_count: Number(session.dropped_count ?? 0),
    capture_policy: session.capture_policy ?? STANDARD_CAPTURE_POLICY,
    sensitive_byte_count: Number(session.sensitive_byte_count ?? 0),
    sensitive_record_count: Number(session.sensitive_record_count ?? 0),
    sensitive_truncated: session.sensitive_truncated ?? false,
    limits: { ...DEFAULT_DIAGNOSTIC_LIMITS, ...session.limits },
  };
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("diagnostics database request failed"));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("diagnostics transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("diagnostics transaction failed"));
  });
}
