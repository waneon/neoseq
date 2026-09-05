// GraphSession owns one open graph on behalf of the UI. It serializes
// commands, reconciles state through the CorePort event/read path, and
// exposes an immutable state object for React (useSyncExternalStore).
//
// The UI never holds a mutable replica of pages/blocks/properties. It keeps
// immutable DTOs from the core: a graph summary plus page/tag outlines hydrated
// on demand and refreshed after commands that affect those owners.

import type {
  CorePort,
  CorePortError,
  CommandResult,
  AuthoredQueryRequest,
  SparqlQueryResult,
  RecoveryDto,
  StorageCapabilitiesDto,
} from "../generated/core-port";
import { CORE_PORT_VERSION } from "../generated/core-port";
import {
  CorePortFailure,
  type OutboxMessage,
  type SavedReceipt,
  type RemoteReceipt,
  type SyncState,
} from "../core-worker";
import type { RemoteGraphConnection } from "./directory";
import {
  SyncAgent,
  type LiveState,
  type PeerPresence,
  type RemoteSyncState,
  type SyncAgentPort,
} from "../features/sync/SyncAgent";
import type { Command } from "./commands";
import { envelope } from "./commands";
import type { GraphChanges, GraphSnapshot, OutlineOwner } from "./snapshot";
import { EMPTY_SNAPSHOT, mergeOutline, mergeSummary, outlineOwnerKey } from "./snapshot";
import { applyContentUpdates } from "./content-patch";
import { acquireLease, type Lease, type LeaseMode } from "./lease";
import { LOCAL_REPOSITORY_ID } from "../features/repositories/directory";
import { randomUUID } from "@/lib/crypto";

const COMMAND_TIMEOUT_MS = 10_000;

export type SaveState =
  | { kind: "saved"; sequence: number }
  | { kind: "saving" }
  | { kind: "unsaved"; code: CorePortError["code"]; message: string; retryable: boolean };

/** Why a ready graph refuses commands. `lease`: another tab of this browser
 * holds the writable lease. `viewer`: the server grants this account read
 * access only. `awaiting_base`: the replica has no server-accepted Base yet
 * and becomes writable once Welcome installs one. */
export type ReadonlyReason = "lease" | "viewer" | "awaiting_base";

export interface SessionState {
  status: "opening" | "ready" | "error" | "closed";
  mode: LeaseMode;
  readonlyReason: ReadonlyReason | null;
  snapshot: GraphSnapshot;
  save: SaveState;
  capabilities: StorageCapabilitiesDto | null;
  recovery: RecoveryDto | null;
  error: CorePortError | null;
  /** Increments on every authoritative summary or outline refresh. */
  revision: number;
  /** Increments only when canonical graph data may have changed. */
  canonicalRevision: number;
  /** The last canonical publication; hydration and status updates do not replace it. */
  lastChange: { commandId: string | null; changes: GraphChanges } | null;
  hydratedOutlines: ReadonlySet<string>;
  sync: RemoteSyncState;
  live: LiveState;
  presence: ReadonlyMap<string, PeerPresence>;
}

/** An answer and the exact session state against which its request ran. */
export interface QueryFrame {
  readonly request: AuthoredQueryRequest;
  readonly result: SparqlQueryResult;
  readonly canonicalRevision: number;
}

export interface SessionPort extends CorePort {
  retryPending(graphHandle: string): Promise<SavedReceipt>;
  storageCapabilities?(graphHandle: string): Promise<StorageCapabilitiesDto>;
  configureSync?(graphHandle: string): Promise<void>;
  syncState?(graphHandle: string): Promise<SyncState>;
  nextOutbox?(graphHandle: string): Promise<OutboxMessage | null>;
  acknowledgeOutbox?(graphHandle: string, messageId: string): Promise<void>;
  importRemote?(graphHandle: string, bytes: number[]): Promise<RemoteReceipt>;
  replaceRemote?(
    graphHandle: string,
    checkpoint: number[] | ArrayBuffer,
    historyEpoch: number,
    serverVersionVector: number[],
  ): Promise<void>;
  encodeSyncMessage?(message: unknown): Promise<ArrayBuffer>;
  decodeSyncMessage?(frame: ArrayBuffer): Promise<unknown>;
  terminate?(): void;
}

type ReconcileScope =
  | { kind: "summary" }
  | { kind: "outlines"; owners: readonly OutlineOwner[] }
  | { kind: "all-hydrated-outlines" };

export class GraphSession {
  private state: SessionState;
  private handle = "";
  private cursor = 0;
  private needsReconcile = false;
  private lease: Lease | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private closeRequested = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private syncAgent: SyncAgent | null = null;
  private readonly sessionId = `neoseq-client:${tabId()}:${randomUUID()}`;

  constructor(
    public readonly graphId: string,
    private readonly port: SessionPort,
    private readonly remote: RemoteGraphConnection | null = null,
    public readonly repositoryId: string = LOCAL_REPOSITORY_ID,
  ) {
    this.state = {
      status: "opening",
      mode: "exclusive",
      readonlyReason: null,
      snapshot: EMPTY_SNAPSHOT,
      save: { kind: "saved", sequence: 0 },
      capabilities: null,
      recovery: null,
      error: null,
      revision: 0,
      canonicalRevision: 0,
      lastChange: null,
      hydratedOutlines: new Set(),
      sync: remote ? { kind: "pending", count: 0 } : { kind: "local" },
      live: remote ? "connecting" : "local",
      presence: new Map(),
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): SessionState => this.state;

  open(): Promise<void> {
    if (!this.opening) this.opening = this.openNow();
    return this.opening;
  }

  private async openNow(): Promise<void> {
    try {
      this.lease = await acquireLease(`${this.repositoryId}:${this.graphId}`);
      if (this.closeRequested) return;
      const opened = await this.port.openGraph({
        contract_version: CORE_PORT_VERSION,
        locator: { repository_id: this.repositoryId, graph_id: this.graphId },
        peer_id: randomPeerId(),
      });
      this.handle = opened.graph_handle;
      if (this.closeRequested) return;
      const remoteReadonly = this.remote?.role === "viewer" || this.remote?.status === "read_only";
      let hasServerBase = true;
      let syncPort: RequiredSyncPort | null = null;
      if (this.remote) {
        syncPort = requireSyncPort(this.port);
        await syncPort.configureSync(this.handle);
        // A local replica without a server-approved Base may contain an empty
        // bootstrap document. Keep it immutable until Welcome atomically
        // installs the authoritative checkpoint.
        hasServerBase = (await syncPort.syncState(this.handle)).has_server_base;
      }
      this.patch({
        status: "ready",
        ...accessFor(remoteReadonly, this.lease.mode, hasServerBase),
        snapshot: mergeSummary(opened.summary),
        capabilities: opened.capabilities ?? null,
        recovery: opened.recovery,
      });
      void this.refreshCapabilities().catch(() => undefined);
      if (this.remote && syncPort) {
        this.syncAgent = new SyncAgent(
          this.graphId,
          this.handle,
          this.sessionId,
          this.remote,
          syncPort,
          {
            applyRemote: (bytes) => this.applyRemote(bytes),
            replaceRemote: (checkpoint, historyEpoch, serverVersionVector) =>
              this.replaceRemote(checkpoint, historyEpoch, serverVersionVector),
            changed: (sync) => this.patch(sync),
          },
        );
        this.syncAgent.start();
      }
    } catch (error) {
      if (!this.closeRequested) {
        this.lease?.release();
        this.lease = null;
        this.patch({ status: "error", error: toPortError(error) });
      }
    }
  }

  /**
   * Executes a domain command. Commands are serialized; the returned promise
   * resolves after the authoritative summary/outline state has been reconciled.
   */
  execute(command: Command): Promise<CommandResult> {
    const tracked = this.queue.then(() => this.executeNow(command));
    // Keep the queue alive after failures so later commands still run.
    this.queue = tracked.catch(() => undefined);
    return tracked;
  }

  /** Lowers an ephemeral edit only after earlier canonical changes are published. */
  executePrepared(prepare: () => Command | null): Promise<CommandResult | null> {
    const tracked = this.queue.then(async () => {
      await this.ensureCurrent();
      const command = prepare();
      return command ? this.executeNow(command) : null;
    });
    this.queue = tracked.catch(() => undefined);
    return tracked;
  }

  async refreshCapabilities(): Promise<void> {
    if (this.state.status !== "ready" || !this.port.storageCapabilities) return;
    const handle = this.handle;
    const capabilities = await this.port.storageCapabilities(handle);
    if (this.state.status === "ready" && this.handle === handle) {
      this.patch({ capabilities });
    }
  }

  hydrateOutline(owner: OutlineOwner): Promise<void> {
    if (this.state.hydratedOutlines.has(outlineOwnerKey(owner))) return Promise.resolve();
    const run = this.queue.then(() => this.hydrateOutlineNow(owner));
    this.queue = run.catch(() => undefined);
    return run;
  }

  hydratePage(pageId: string): Promise<void> {
    return this.hydrateOutline({ kind: "page", id: pageId });
  }

  /**
   * Hydrates several canonical outlines as one session read. Query entity views use
   * this to resolve a set of block references without publishing one partial UI
   * snapshot per owner. Each unique outline is read once and the immutable
   * client snapshot is replaced once at the end.
   */
  hydrateOutlines(owners: readonly OutlineOwner[]): Promise<void> {
    const unique = new Map(owners.map((owner) => [outlineOwnerKey(owner), owner]));
    const missing = [...unique.values()].filter(
      (owner) => !this.state.hydratedOutlines.has(outlineOwnerKey(owner)),
    );
    if (missing.length === 0) return Promise.resolve();
    const run = this.queue.then(() => this.hydrateOutlinesNow(missing));
    this.queue = run.catch(() => undefined);
    return run;
  }

  hydratePages(pageIds: readonly string[]): Promise<void> {
    return this.hydrateOutlines(pageIds.map((id) => ({ kind: "page", id })));
  }

  /** Retries the pending durable write after a storage failure. */
  retry(): Promise<void> {
    const run = this.queue.then(() => this.retryNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Executes against the published derived index after prior mutations settle. */
  query(query: AuthoredQueryRequest): Promise<SparqlQueryResult> {
    return this.queryFrame(query).then((frame) => frame.result);
  }

  queryFrame(query: AuthoredQueryRequest): Promise<QueryFrame> {
    const request = structuredClone(query);
    const run = this.queue.then(async () => {
      await this.ensureCurrent();
      if (this.state.status !== "ready") {
        throw new CorePortFailure({
          code: "graph_not_open",
          message: "graph is not open",
          retryable: false,
        });
      }
      const canonicalRevision = this.state.canonicalRevision;
      const response = await this.port.query({ graph_handle: this.handle, query: request });
      return { request, result: response.result, canonicalRevision };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.closeNow();
    return this.closing;
  }

  private async closeNow(): Promise<void> {
    this.closeRequested = true;
    this.syncAgent?.stop();
    this.syncAgent = null;
    await this.opening?.catch(() => undefined);
    await this.queue.catch(() => undefined);
    if (this.handle && this.state.save.kind !== "unsaved") {
      try {
        await this.port.closeGraph({ graph_handle: this.handle });
      } catch {
        // Closing is best-effort; recovery replays the update log on reopen.
      }
    }
    this.lease?.release();
    this.lease = null;
    this.port.terminate?.();
    this.patch({ status: "closed" });
  }

  publishPresence(presence: Omit<PeerPresence, "session_id" | "principal" | "expires_at">): void {
    void this.syncAgent?.publishPresence(presence);
  }

  private async executeNow(command: Command): Promise<CommandResult> {
    await this.ensureCurrent();
    if (this.state.status !== "ready") {
      const error = new CorePortFailure({
        code: "graph_not_open",
        message: "graph is not open",
        retryable: false,
      });
      throw error;
    }
    if (this.state.mode === "readonly") {
      const error = new CorePortFailure({
        code: "invalid_request",
        message: "this graph is opened read-only in this tab",
        retryable: false,
      });
      throw error;
    }
    // A command rejected before it applies leaves canonical state and the
    // save state it started from untouched, so remember that state here.
    const stableSave = this.state.save;
    let applied: CommandResult | undefined;
    let appliedSave = stableSave;
    this.patch({ save: { kind: "saving" } });
    try {
      const response = await this.port.execute({
        graph_handle: this.handle,
        command: envelope(this.graphId, command),
        timeout_ms: COMMAND_TIMEOUT_MS,
      });
      const result = response.result;
      const status = response.save_status;
      if (status.status === "unchanged") {
        this.patch({ save: stableSave });
        return result;
      }
      const save: SaveState =
        status.status === "saved_locally"
          ? { kind: "saved", sequence: status.local_sequence }
          : { kind: "unsaved", ...status.error };
      applied = result;
      appliedSave = save;
      await this.publishChanges(response.changes, save, result.command_id);
      // Application and durability are independent outcomes. Structural hosts
      // must acknowledge created identities even while exact bytes await retry.
      if (status.status === "saved_locally") await this.syncAgent?.wake();
      return result;
    } catch (error) {
      if (error instanceof CorePortFailure && error.applied) throw error;
      this.patch({ save: appliedSave });
      throw new CorePortFailure(toPortError(error), applied);
    }
  }

  private async publishChanges(
    changes: GraphChanges,
    save: SaveState,
    commandId: string | null,
  ): Promise<void> {
    if (changes.kind === "content" && (await this.consumeLocalEvents())) {
      this.patch({
        snapshot: applyContentUpdates(this.state.snapshot, changes.blocks),
        save,
        revision: this.state.revision + 1,
        canonicalRevision: this.state.canonicalRevision + 1,
        lastChange: { commandId, changes },
      });
      return;
    }
    const scope: ReconcileScope =
      changes.kind === "refresh" && changes.outlines !== null
        ? { kind: "outlines", owners: changes.outlines }
        : { kind: "all-hydrated-outlines" };
    // A missed event invalidates the mapping from the client's old baseline.
    // Refresh publications arrive through the serialized import/command path.
    await this.reconcile(
      save,
      scope,
      true,
      changes.kind === "content" ? null : { commandId, changes },
    );
  }

  private async retryNow(): Promise<void> {
    if (this.state.status !== "ready" || this.state.save.kind !== "unsaved") return;
    this.patch({ save: { kind: "saving" } });
    let saved: SaveState | undefined;
    try {
      const receipt = await this.port.retryPending(this.handle);
      saved = { kind: "saved", sequence: receipt.local_sequence };
      await this.reconcile(saved);
      await this.syncAgent?.wake();
    } catch (error) {
      const detail = toPortError(error);
      // A later read or transport failure cannot revoke a durable receipt.
      this.patch({ save: saved ?? { kind: "unsaved", ...detail } });
    }
  }

  private async ensureCurrent(): Promise<void> {
    if (this.needsReconcile) {
      await this.reconcile(this.state.save, { kind: "all-hydrated-outlines" }, true);
    }
  }

  private applyRemote(bytes: number[]): Promise<void> {
    const run = this.queue.then(async () => {
      const importRemote = this.port.importRemote;
      if (!importRemote) throw new Error("remote import is unavailable");
      const receipt = await importRemote.call(this.port, this.handle, bytes);
      await this.publishChanges(receipt.changes, this.state.save, null);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private replaceRemote(
    checkpoint: number[] | ArrayBuffer,
    historyEpoch: number,
    serverVersionVector: number[],
  ): Promise<void> {
    const run = this.queue.then(async () => {
      const replaceRemote = this.port.replaceRemote;
      if (!replaceRemote) throw new Error("remote history replacement is unavailable");
      await replaceRemote.call(
        this.port,
        this.handle,
        checkpoint,
        historyEpoch,
        serverVersionVector,
      );
      await this.reconcile(this.state.save, { kind: "all-hydrated-outlines" }, true);
      const remoteReadonly = this.remote?.role === "viewer" || this.remote?.status === "read_only";
      this.patch(accessFor(remoteReadonly, this.lease?.mode ?? "readonly"));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async hydrateOutlineNow(owner: OutlineOwner): Promise<void> {
    const key = outlineOwnerKey(owner);
    if (this.state.status !== "ready" || this.state.hydratedOutlines.has(key)) return;
    const response = await this.port.readOutline({ graph_handle: this.handle, owner });
    const hydratedOutlines = new Set(this.state.hydratedOutlines);
    hydratedOutlines.add(key);
    this.patch({
      snapshot: mergeOutline(this.state.snapshot, response.outline),
      hydratedOutlines,
      revision: this.state.revision + 1,
    });
  }

  private async hydrateOutlinesNow(owners: readonly OutlineOwner[]): Promise<void> {
    if (this.state.status !== "ready") return;
    const missing = owners.filter(
      (owner) =>
        outlineExists(this.state.snapshot, owner) &&
        !this.state.hydratedOutlines.has(outlineOwnerKey(owner)),
    );
    if (missing.length === 0) return;

    let snapshot = this.state.snapshot;
    for (const owner of missing) {
      const response = await this.port.readOutline({ graph_handle: this.handle, owner });
      snapshot = mergeOutline(snapshot, response.outline);
    }
    const hydratedOutlines = new Set(this.state.hydratedOutlines);
    for (const owner of missing) hydratedOutlines.add(outlineOwnerKey(owner));
    this.patch({ snapshot, hydratedOutlines, revision: this.state.revision + 1 });
  }

  /** Drains events, refreshes graph metadata, then rehydrates the command's impact scope. */
  private async reconcile(
    save: SaveState,
    scope: ReconcileScope = { kind: "summary" },
    canonicalChanged = false,
    lastChange: SessionState["lastChange"] = null,
  ): Promise<void> {
    if (this.needsReconcile) {
      scope = { kind: "all-hydrated-outlines" };
      canonicalChanged = true;
      lastChange = null;
    }
    this.needsReconcile = true;
    try {
      const batch = await this.port.subscribe({
        graph_handle: this.handle,
        after_cursor: this.cursor,
      });
      this.cursor = batch.next_cursor;
    } catch {
      // A failed event poll falls through to the authoritative re-read below.
    }
    const read = await this.port.read({ graph_handle: this.handle });
    let snapshot = mergeSummary(read.summary, this.state.snapshot);
    const ownersToRead =
      scope.kind === "all-hydrated-outlines"
        ? [...this.state.hydratedOutlines].map(parseOutlineKey)
        : scope.kind === "outlines"
          ? scope.owners.filter((owner) => this.state.hydratedOutlines.has(outlineOwnerKey(owner)))
          : [];
    for (const owner of ownersToRead) {
      if (!outlineExists(snapshot, owner)) continue;
      const response = await this.port.readOutline({ graph_handle: this.handle, owner });
      snapshot = mergeOutline(snapshot, response.outline);
    }
    const hydratedOutlines = new Set(
      [...this.state.hydratedOutlines].filter((key) =>
        outlineExists(snapshot, parseOutlineKey(key)),
      ),
    );
    for (const owner of ownersToRead) {
      if (outlineExists(snapshot, owner)) hydratedOutlines.add(outlineOwnerKey(owner));
    }
    this.needsReconcile = false;
    this.patch({
      snapshot,
      hydratedOutlines,
      save,
      revision: this.state.revision + 1,
      canonicalRevision: canonicalChanged
        ? this.state.canonicalRevision + 1
        : this.state.canonicalRevision,
      lastChange: canonicalChanged ? lastChange : this.state.lastChange,
    });
  }

  /** Advances only over local acknowledgements; remote impact needs a re-read. */
  private async consumeLocalEvents(): Promise<boolean> {
    try {
      const batch = await this.port.subscribe({
        graph_handle: this.handle,
        after_cursor: this.cursor,
      });
      if (batch.resync_required || batch.events.some((event) => event.source === "remote")) {
        return false;
      }
      this.cursor = batch.next_cursor;
      return true;
    } catch {
      return false;
    }
  }

  private patch(partial: Partial<SessionState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

function parseOutlineKey(key: string): OutlineOwner {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if ((kind !== "page" && kind !== "tag") || !id) {
    throw new Error(`invalid outline key: ${key}`);
  }
  return { kind, id };
}

function outlineExists(snapshot: GraphSnapshot, owner: OutlineOwner): boolean {
  return owner.kind === "page"
    ? snapshot.pages.some((page) => page.id === owner.id)
    : snapshot.tags.some((tag) => tag.id === owner.id);
}

function randomPeerId(): number {
  // A 53-bit bootstrap suggestion. The repository persists the first value for
  // this graph and ignores later runtime suggestions.
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (words[0] & 0x1fffff) * 0x1_0000_0000 + words[1] || 1;
}

const TAB_ID_KEY = "neoseq.tab-id.v1";

function tabId(): string {
  const existing = sessionStorage.getItem(TAB_ID_KEY);
  if (existing) return existing;
  const value = randomUUID();
  sessionStorage.setItem(TAB_ID_KEY, value);
  return value;
}

/** The one place the three read-only causes are ranked: the server's word
 * about the account, then this browser's lease, then a replica still waiting
 * for its first server Base. */
function accessFor(
  remoteReadonly: boolean,
  lease: LeaseMode,
  hasServerBase = true,
): Pick<SessionState, "mode" | "readonlyReason"> {
  const readonlyReason: ReadonlyReason | null = remoteReadonly
    ? "viewer"
    : lease === "readonly"
      ? "lease"
      : hasServerBase
        ? null
        : "awaiting_base";
  return { mode: readonlyReason ? "readonly" : "exclusive", readonlyReason };
}

type RequiredSyncPort = SessionPort &
  SyncAgentPort & {
    configureSync(graphHandle: string): Promise<void>;
    importRemote(graphHandle: string, bytes: number[]): Promise<RemoteReceipt>;
    replaceRemote(
      graphHandle: string,
      checkpoint: number[] | ArrayBuffer,
      historyEpoch: number,
      serverVersionVector: number[],
    ): Promise<void>;
  };

function requireSyncPort(port: SessionPort): RequiredSyncPort {
  const methods = [
    "configureSync",
    "syncState",
    "nextOutbox",
    "acknowledgeOutbox",
    "importRemote",
    "replaceRemote",
    "encodeSyncMessage",
    "decodeSyncMessage",
  ] as const;
  for (const method of methods) {
    if (typeof port[method] !== "function") {
      throw new Error(`remote graph requires ${method}`);
    }
  }
  return port as RequiredSyncPort;
}

function toPortError(error: unknown): CorePortError {
  if (error instanceof CorePortFailure) return error.detail;
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
