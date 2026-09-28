// Component tests exercise the same Rust/Wasm graph implementation as the
// browser. This adapter owns only the CorePort effects that sit outside the
// graph: an in-memory durable checkpoint, event delivery, and explicit fault
// or query-answer injection used by a test.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initSync, WasmGraphCore } from "../../src/wasm/neoseq_core.js";
import type {
  CloseGraphRequest,
  CloseGraphResponse,
  CommandResult,
  CorePortError,
  ExecuteRequest,
  ExecuteResponse,
  GraphEvent,
  GraphEventKind,
  GraphSummary,
  OpenGraphRequest,
  OpenGraphResponse,
  QueryRequest,
  QueryResponse,
  ReadOutlineRequest,
  ReadOutlineResponse,
  ReadRequest,
  ReadResponse,
  SemanticEvent,
  SparqlQueryResult,
  SubscribeRequest,
  SubscribeResponse,
} from "../../src/generated/core-port";
import { CORE_PORT_VERSION } from "../../src/generated/core-port";
import { CorePortFailure, type SavedReceipt, type RemoteReceipt } from "../../src/core-worker";
import { normalizeWasmFailure } from "../../src/core-port/wasm-failure";
import type { Command } from "../../src/core-port/commands";
import type { SessionPort } from "../../src/core-port/session";
import { sha256Hex } from "../../src/lib/crypto";

// `wasm-bindgen --target web` defaults to fetch, which cannot read a file URL
// in Node. Vitest loads the same generated module synchronously from its bytes.
// initSync is idempotent within each Vitest worker.
const wasmCandidates = [
  resolve(process.cwd(), "src/wasm/neoseq_core_bg.wasm"),
  resolve(process.cwd(), "apps/client/src/wasm/neoseq_core_bg.wasm"),
];
const wasmPath = wasmCandidates.find(existsSync);
if (!wasmPath) throw new Error("Wasm test binding is missing; run the wasm:build-dev task");
initSync({
  module: readFileSync(wasmPath),
});

interface StoredGraph {
  snapshot: Uint8Array<ArrayBuffer>;
  localSequence: number;
}

/** The smallest persistence surface needed to close and reopen a test graph. */
export class MemoryGraphStore {
  private readonly graphs = new Map<string, StoredGraph>();

  read(key: string): StoredGraph | undefined {
    const stored = this.graphs.get(key);
    return stored
      ? { snapshot: new Uint8Array(stored.snapshot), localSequence: stored.localSequence }
      : undefined;
  }

  write(key: string, graph: StoredGraph): void {
    this.graphs.set(key, {
      snapshot: new Uint8Array(graph.snapshot),
      localSequence: graph.localSequence,
    });
  }
}

interface PendingSave {
  payload: Uint8Array<ArrayBuffer>;
  semantic: SemanticEvent;
  commandId: string;
}

interface OpenState {
  key: string;
  handle: string;
  core: WasmGraphCore;
  events: GraphEvent[];
  nextCursor: number;
  pending: PendingSave | null;
}

function fail(code: CorePortError["code"], message: string, retryable = false): never {
  throw new CorePortFailure({ code, message, retryable });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function storageKey(request: OpenGraphRequest): string {
  return `${request.locator.repository_id}\u0000${request.locator.graph_id}`;
}

/**
 * A real-core test port. No command tag is interpreted here: commands,
 * history, properties, projections, generated IDs, and semantic events all
 * come directly from WasmGraphCore.
 */
export class WasmTestPort implements SessionPort {
  private state: OpenState | null = null;
  private tick = 0;

  queryResult: SparqlQueryResult | null = null;
  queryFailure: CorePortError | null = null;
  readonly queryRequests: QueryRequest[] = [];

  /** Set to reject the next persistence attempt after the core has applied it. */
  failNextSave: CorePortError | null = null;
  /** Optional pre-dispatch barrier/observer for deterministic ordering tests. */
  beforeExecute: ((command: Command) => void | Promise<void>) | null = null;

  constructor(private readonly store = new MemoryGraphStore()) {}

  get graphHandle(): string {
    return this.requireOpen().handle;
  }

  async openGraph(request: OpenGraphRequest): Promise<OpenGraphResponse> {
    if (request.contract_version !== CORE_PORT_VERSION) {
      fail("unsupported_contract", "unsupported CorePort contract version");
    }
    if (this.state) fail("graph_already_open", "graph is already open");

    const key = storageKey(request);
    const stored = this.store.read(key);
    let core: WasmGraphCore;
    try {
      core = stored
        ? WasmGraphCore.fromSnapshot(
            request.locator.graph_id,
            BigInt(request.peer_id),
            stored.snapshot,
          )
        : new WasmGraphCore(request.locator.graph_id, BigInt(request.peer_id), this.now());
    } catch (error) {
      fail("internal", message(error));
    }
    if (stored) core.resetLocalHistory();

    const handle = `wasm-test:${key}`;
    this.state = {
      key,
      handle,
      core,
      events: [],
      nextCursor: 1,
      pending: null,
    };
    if (!stored) {
      this.store.write(key, { snapshot: ownedBytes(core.exportSnapshot()), localSequence: 0 });
    }
    return {
      graph_handle: handle,
      summary: this.summary(core),
      capabilities: {
        durable: true,
        persisted: true,
        quota_bytes: 10_000_000,
        usage_bytes: stored?.snapshot.byteLength ?? 0,
      },
      recovery: {
        checkpoint_sequence: stored?.localSequence ?? 0,
        replayed_updates: 0,
        quarantined_records: [],
      },
    };
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    if (request.timeout_ms === 0) {
      fail("command_timeout", "command deadline elapsed before dispatch", true);
    }
    const state = this.requireState(request.graph_handle);
    if (state.pending) {
      fail("dirty_unsaved", "retry pending update before another mutation", true);
    }
    await this.beforeExecute?.(request.command.command);

    let execution: {
      result: CommandResult;
      semantic: SemanticEvent;
      changes: ExecuteResponse["changes"];
    };
    try {
      execution = JSON.parse(
        state.core.executeJson(JSON.stringify(request.command), this.now()),
      ) as typeof execution;
    } catch (error) {
      throw new CorePortFailure(normalizeWasmFailure(error, "internal"));
    }
    const payload = ownedBytes(state.core.takeUpdate());
    if (payload.byteLength === 0) {
      return {
        result: execution.result,
        changes: execution.changes,
        save_status: { status: "unchanged" },
      };
    }
    state.pending = {
      payload,
      semantic: execution.semantic,
      commandId: request.command.command_id,
    };
    if (this.failNextSave) {
      const failure = this.failNextSave;
      this.failNextSave = null;
      return {
        result: execution.result,
        changes: execution.changes,
        save_status: { status: "unsaved", error: failure },
      };
    }
    const receipt = await this.persistPending(state);
    return {
      result: execution.result,
      changes: execution.changes,
      save_status: { status: "saved_locally", ...receipt },
    };
  }

  async read(request: ReadRequest): Promise<ReadResponse> {
    return { summary: this.summary(this.requireState(request.graph_handle).core) };
  }

  async readOutline(request: ReadOutlineRequest): Promise<ReadOutlineResponse> {
    const state = this.requireState(request.graph_handle);
    try {
      return {
        outline: JSON.parse(
          state.core.outlineSnapshotJson(JSON.stringify(request.owner)),
        ) as ReadOutlineResponse["outline"],
      };
    } catch (error) {
      fail("invalid_request", message(error));
    }
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    const state = this.requireState(request.graph_handle);
    if (state.pending) fail("dirty_unsaved", "retry pending update before querying", true);
    this.queryRequests.push(clone(request));
    if (this.queryFailure) throw new CorePortFailure(this.queryFailure);
    if (this.queryResult) return { result: clone(this.queryResult) };
    try {
      return { result: JSON.parse(state.core.queryJson(JSON.stringify(request.query))) };
    } catch (error) {
      fail("invalid_query", message(error));
    }
  }

  async subscribe(request: SubscribeRequest): Promise<SubscribeResponse> {
    const state = this.requireState(request.graph_handle);
    const latest = state.nextCursor - 1;
    const oldest = state.events[0]?.cursor ?? state.nextCursor;
    if (request.after_cursor + 1 < oldest) {
      return { events: [], next_cursor: latest, resync_required: true };
    }
    return {
      events: state.events.filter((event) => event.cursor > request.after_cursor),
      next_cursor: latest,
      resync_required: false,
    };
  }

  async closeGraph(request: CloseGraphRequest): Promise<CloseGraphResponse> {
    const state = this.requireState(request.graph_handle);
    if (state.pending) {
      fail("dirty_unsaved", "close rejected while an update is not durable", true);
    }
    state.core.free();
    this.state = null;
    return { closed: true };
  }

  exportSnapshot(): Uint8Array<ArrayBuffer> {
    return ownedBytes(this.requireOpen().core.exportSnapshot());
  }

  async importRemote(graphHandle: string, bytes: number[] | ArrayBuffer): Promise<RemoteReceipt> {
    const state = this.requireState(graphHandle);
    if (state.pending) fail("dirty_unsaved", "retry before importing", true);
    const payload = new Uint8Array(bytes);
    state.core.validateUpdate(payload);
    const changes = JSON.parse(state.core.importUpdate(payload));
    const local_sequence = (this.store.read(state.key)?.localSequence ?? 0) + 1;
    const checksum = await sha256Hex(payload);
    this.store.write(state.key, {
      snapshot: ownedBytes(state.core.exportSnapshot()),
      localSequence: local_sequence,
    });
    state.events.push({
      cursor: state.nextCursor++,
      source: "remote",
      kind: { type: "remote_imported" },
    });
    return { status: "saved_locally", local_sequence, checksum, changes };
  }

  async retryPending(graphHandle: string): Promise<SavedReceipt> {
    const state = this.requireState(graphHandle);
    if (!state.pending) fail("invalid_request", "nothing pending");
    const receipt = await this.persistPending(state);
    return { status: "saved_locally", ...receipt };
  }

  terminate(): void {
    this.state?.core.free();
    this.state = null;
  }

  private async persistPending(state: OpenState) {
    const pending = state.pending;
    if (!pending) fail("invalid_request", "nothing pending");
    const previous = this.store.read(state.key);
    const localSequence = (previous?.localSequence ?? 0) + 1;
    const checksum = await sha256Hex(pending.payload);
    this.store.write(state.key, {
      snapshot: ownedBytes(state.core.exportSnapshot()),
      localSequence,
    });
    this.push(state, { type: "semantic", name: pending.semantic, command_id: pending.commandId });
    this.push(state, { type: "saved_locally", local_sequence: localSequence, checksum });
    state.pending = null;
    return { local_sequence: localSequence, checksum };
  }

  private push(state: OpenState, kind: GraphEventKind): void {
    state.events.push({ cursor: state.nextCursor++, source: "local", kind });
    while (state.events.length > 64) state.events.shift();
  }

  private summary(core: WasmGraphCore): GraphSummary {
    try {
      return JSON.parse(core.summaryJson()) as GraphSummary;
    } catch (error) {
      fail("internal", message(error));
    }
  }

  private requireOpen(): OpenState {
    if (!this.state) fail("graph_not_open", "graph is not open");
    return this.state;
  }

  private requireState(handle: string): OpenState {
    const state = this.requireOpen();
    if (state.handle !== handle) fail("graph_not_open", "graph handle is not open");
    return state;
  }

  private now(): string {
    return `2026-08-03T13:00:${String(this.tick++ % 60).padStart(2, "0")}Z`;
  }
}

/** Convenience: an already-open session backed by the real Wasm core. */
export async function openWasmSession(graphId = "test-graph", store = new MemoryGraphStore()) {
  const { GraphSession } = await import("../../src/core-port/session");
  const port = new WasmTestPort(store);
  const session = new GraphSession(graphId, port);
  await session.open();
  return { session, port, graphHandle: port.graphHandle };
}
