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
  SparqlQueryRequest,
  SparqlQueryResult,
  RecoveryDto,
  StorageCapabilitiesDto,
} from "../generated/core-port";
import { CORE_PORT_VERSION } from "../generated/core-port";
import {
  CorePortFailure,
  type OutboxMessage,
  type SavedReceipt,
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
import type { Command, CommandResult } from "./commands";
import { envelope } from "./commands";
import type { GraphSnapshot, GraphSummary, OutlineOwner, OutlineSnapshot } from "./snapshot";
import { EMPTY_SNAPSHOT, mergeOutline, mergeSummary, outlineOwnerKey } from "./snapshot";
import { acquireLease, type Lease, type LeaseMode } from "./lease";

const COMMAND_TIMEOUT_MS = 10_000;

export type SaveState =
  | { kind: "saved"; sequence: number }
  | { kind: "saving" }
  | { kind: "unsaved"; code: CorePortError["code"]; message: string; retryable: boolean };

export interface SessionState {
  status: "opening" | "ready" | "error" | "closed";
  mode: LeaseMode;
  snapshot: GraphSnapshot;
  save: SaveState;
  capabilities: StorageCapabilitiesDto | null;
  recovery: RecoveryDto | null;
  error: CorePortError | null;
  /** Increments on every authoritative summary or outline refresh. */
  revision: number;
  /** Increments only when canonical graph data may have changed. */
  canonicalRevision: number;
  hydratedOutlines: ReadonlySet<string>;
  sync: RemoteSyncState;
  live: LiveState;
  presence: ReadonlyMap<string, PeerPresence>;
}

export interface SessionPort extends CorePort {
  retryPending(graphHandle: string): Promise<SavedReceipt>;
  storageCapabilities?(graphHandle: string): Promise<StorageCapabilitiesDto>;
  configureSync?(graphHandle: string): Promise<void>;
  syncState?(graphHandle: string): Promise<SyncState>;
  nextOutbox?(graphHandle: string): Promise<OutboxMessage | null>;
  acknowledgeOutbox?(graphHandle: string, messageId: string): Promise<void>;
  importRemote?(graphHandle: string, bytes: number[]): Promise<SavedReceipt>;
  replaceRemote?(
    graphHandle: string,
    checkpoint: number[],
    historyEpoch: number,
    serverVersionVector: number[],
  ): Promise<void>;
  encodeSyncMessage?(message: unknown): Promise<ArrayBuffer>;
  decodeSyncMessage?(frame: ArrayBuffer): Promise<unknown>;
  terminate?(): void;
}

type ReconcileScope =
  | { kind: "summary" }
  | { kind: "outline"; owner: OutlineOwner }
  | { kind: "outlines"; owners: readonly OutlineOwner[] }
  | { kind: "all-hydrated-outlines" };

export class GraphSession {
  private state: SessionState;
  private handle = "";
  private cursor = 0;
  private lease: Lease | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private closeRequested = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private syncAgent: SyncAgent | null = null;
  private readonly sessionId = `web:${tabId()}:${crypto.randomUUID()}`;

  constructor(
    public readonly graphId: string,
    private readonly port: SessionPort,
    private readonly remote: RemoteGraphConnection | null = null,
  ) {
    this.state = {
      status: "opening",
      mode: "exclusive",
      snapshot: EMPTY_SNAPSHOT,
      save: { kind: "saved", sequence: 0 },
      capabilities: null,
      recovery: null,
      error: null,
      revision: 0,
      canonicalRevision: 0,
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
      this.lease = await acquireLease(this.graphId);
      if (this.closeRequested) return;
      const opened = await this.port.openGraph({
        contract_version: CORE_PORT_VERSION,
        locator: { graph_id: this.graphId },
        peer_id: randomPeerId(),
      });
      this.handle = opened.graph_handle;
      if (this.closeRequested) return;
      this.patch({
        status: "ready",
        mode: this.lease.mode,
        snapshot: mergeSummary(opened.summary as GraphSummary),
        capabilities: opened.capabilities,
        recovery: opened.recovery,
      });
      if (this.remote) {
        const syncPort = requireSyncPort(this.port);
        await syncPort.configureSync(this.handle);
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

  async refreshCapabilities(): Promise<void> {
    if (this.state.status !== "ready" || !this.port.storageCapabilities) return;
    const capabilities = await this.port.storageCapabilities(this.handle);
    this.patch({ capabilities });
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
  query(query: SparqlQueryRequest): Promise<SparqlQueryResult> {
    return this.queue.then(async () => {
      if (this.state.status !== "ready") {
        throw new CorePortFailure({
          code: "graph_not_open",
          message: "graph is not open",
          retryable: false,
        });
      }
      const response = await this.port.query({ graph_handle: this.handle, query });
      return response.result;
    });
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

  publishPresence(
    presence: Omit<PeerPresence, "session_id" | "principal" | "expires_at">,
  ): void {
    void this.syncAgent?.publishPresence(presence);
  }

  private async executeNow(command: Command): Promise<CommandResult> {
    if (this.state.status !== "ready") {
      const error = new CorePortFailure({ code: "graph_not_open", message: "graph is not open", retryable: false });
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
    this.patch({ save: { kind: "saving" } });
    try {
      const response = await this.port.execute({
        graph_handle: this.handle,
        command: envelope(this.graphId, command),
        timeout_ms: COMMAND_TIMEOUT_MS,
      });
      const save: SaveState =
        response.save_status.status === "saved_locally"
          ? { kind: "saved", sequence: response.save_status.local_sequence }
          : { kind: "unsaved", code: "dirty_unsaved", message: "the last change is not durable yet", retryable: true };
      await this.reconcile(
        save,
        commandReconcileScope(command, response.result as CommandResult),
        (response.result as CommandResult).changed,
      );
      await this.syncAgent?.wake();
      return response.result as CommandResult;
    } catch (error) {
      const detail = toPortError(error);
      if (detail.code === "dirty_unsaved" || detail.code === "storage_full") {
        // The command applied in memory but is not durable. Show the state
        // and keep the exact bytes pending for retry.
        await this.reconcile(
          {
            kind: "unsaved",
            code: detail.code,
            message: detail.message,
            retryable: detail.retryable,
          },
          commandReconcileScope(command),
          true,
        );
      } else {
        // The command was rejected before applying; canonical state and the
        // previous save state are unchanged.
        this.patch({ save: this.previousStableSave() });
      }
      throw new CorePortFailure(detail);
    }
  }

  private async retryNow(): Promise<void> {
    if (this.state.status !== "ready" || this.state.save.kind !== "unsaved") return;
    this.patch({ save: { kind: "saving" } });
    try {
      const receipt = await this.port.retryPending(this.handle);
      await this.reconcile({ kind: "saved", sequence: receipt.local_sequence });
      await this.syncAgent?.wake();
    } catch (error) {
      const detail = toPortError(error);
      this.patch({
        save: { kind: "unsaved", code: detail.code, message: detail.message, retryable: detail.retryable },
      });
    }
  }

  private applyRemote(bytes: number[]): Promise<void> {
    const run = this.queue.then(async () => {
      const importRemote = this.port.importRemote;
      if (!importRemote) throw new Error("remote import is unavailable");
      await importRemote.call(this.port, this.handle, bytes);
      await this.reconcile(this.state.save, { kind: "all-hydrated-outlines" }, true);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private replaceRemote(
    checkpoint: number[],
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
      snapshot: mergeOutline(this.state.snapshot, response.outline as OutlineSnapshot),
      hydratedOutlines,
      revision: this.state.revision + 1,
    });
  }

  private async hydrateOutlinesNow(owners: readonly OutlineOwner[]): Promise<void> {
    if (this.state.status !== "ready") return;
    const missing = owners.filter((owner) =>
      outlineExists(this.state.snapshot, owner)
      && !this.state.hydratedOutlines.has(outlineOwnerKey(owner)),
    );
    if (missing.length === 0) return;

    let snapshot = this.state.snapshot;
    for (const owner of missing) {
      const response = await this.port.readOutline({ graph_handle: this.handle, owner });
      snapshot = mergeOutline(snapshot, response.outline as OutlineSnapshot);
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
  ): Promise<void> {
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
    let snapshot = mergeSummary(read.summary as GraphSummary, this.state.snapshot);
    const ownersToRead = scope.kind === "all-hydrated-outlines"
      ? [...this.state.hydratedOutlines].map(parseOutlineKey)
      : scope.kind === "outlines"
        ? scope.owners.filter((owner) => this.state.hydratedOutlines.has(outlineOwnerKey(owner)))
      : scope.kind === "outline"
        ? [scope.owner]
        : [];
    for (const owner of ownersToRead) {
      if (!outlineExists(snapshot, owner)) continue;
      const response = await this.port.readOutline({ graph_handle: this.handle, owner });
      snapshot = mergeOutline(snapshot, response.outline as OutlineSnapshot);
    }
    const hydratedOutlines = new Set(
      [...this.state.hydratedOutlines].filter((key) => outlineExists(snapshot, parseOutlineKey(key))),
    );
    for (const owner of ownersToRead) {
      if (outlineExists(snapshot, owner)) hydratedOutlines.add(outlineOwnerKey(owner));
    }
    this.patch({
      snapshot,
      hydratedOutlines,
      save,
      revision: this.state.revision + 1,
      canonicalRevision: canonicalChanged
        ? this.state.canonicalRevision + 1
        : this.state.canonicalRevision,
    });
  }

  private previousStableSave(): SaveState {
    return this.state.save.kind === "saving" ? { kind: "saved", sequence: 0 } : this.state.save;
  }

  private patch(partial: Partial<SessionState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

function commandReconcileScope(command: Command, result?: CommandResult): ReconcileScope {
  switch (command.type) {
    case "batch":
      // A batch deliberately crosses existing ownership boundaries. Re-read
      // every mounted outline as well as the summary rather than guessing
      // which of its independently valid steps dominates reconciliation.
      return { kind: "all-hydrated-outlines" };
    case "ensure_page":
    case "rename_page":
    case "delete_page":
    case "restore_page":
      return { kind: "outline", owner: { kind: "page", id: command.page_id } };
    case "insert_block":
    case "split_block":
    case "insert_outline":
    case "paste_outline":
    case "edit_markdown":
    case "splice_markdown":
    case "splice_markdowns":
    case "move_blocks":
    case "indent_blocks":
    case "outdent_blocks":
    case "delete_blocks":
      return { kind: "outline", owner: command.owner };
    case "add_tag":
    case "remove_tag":
      return {
        kind: "outline",
        owner: command.entity.kind === "block"
          ? command.entity.owner
          : { kind: "page", id: command.entity.id },
      };
    case "ensure_property":
    case "set_property":
    case "set_properties":
    case "clear_property_values":
    case "remove_property":
    case "add_repeated_property":
    case "remove_repeated_property":
      return command.owner.kind === "tag" || command.owner.kind === "tag_default"
        ? { kind: "summary" }
        : {
            kind: "outline",
            owner: command.owner.kind === "block"
              ? command.owner.owner
              : { kind: "page", id: command.owner.id },
          };
    case "set_query_source":
    case "splice_query_source":
    case "set_query_plan":
    case "clear_query_plan":
    case "put_query_view":
    case "remove_query_view":
    case "set_query_default_view":
      return command.owner.kind === "tag" || command.owner.kind === "graph_default"
        ? { kind: "summary" }
        : {
            kind: "outline",
            owner: command.owner.kind === "block"
              ? command.owner.owner
              : { kind: "page", id: command.owner.id },
          };
    case "create_default_query":
    case "rename_default_query":
    case "move_default_query":
    case "delete_default_query":
      return { kind: "summary" };
    case "ensure_journal":
      return result?.created_page
        ? { kind: "outline", owner: { kind: "page", id: result.created_page } }
        : { kind: "summary" };
    case "delete_tag":
      return { kind: "all-hydrated-outlines" };
    case "undo":
    case "redo":
      if (!result) return { kind: "all-hydrated-outlines" };
      if (!result.changed) return { kind: "summary" };
      if (!result.history_effect) {
        throw new Error("changed history command omitted its effect");
      }
      return { kind: "outlines", owners: result.history_effect.affected_outlines };
    case "ensure_tag":
    case "rename_tag":
    case "restore_tag":
      return { kind: "summary" };
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
  return ((words[0] & 0x1fffff) * 0x1_0000_0000 + words[1]) || 1;
}

const TAB_ID_KEY = "neoseq.tab-id.v1";

function tabId(): string {
  const existing = sessionStorage.getItem(TAB_ID_KEY);
  if (existing) return existing;
  const value = crypto.randomUUID();
  sessionStorage.setItem(TAB_ID_KEY, value);
  return value;
}

type RequiredSyncPort = SessionPort & SyncAgentPort & {
  configureSync(graphHandle: string): Promise<void>;
  importRemote(graphHandle: string, bytes: number[]): Promise<SavedReceipt>;
  replaceRemote(
    graphHandle: string,
    checkpoint: number[],
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
