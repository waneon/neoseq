// GraphSession owns one open graph on behalf of the UI. It serializes
// commands, reconciles state through the CorePort event/read path, and
// exposes an immutable state object for React (useSyncExternalStore).
//
// The UI never holds a mutable replica of pages/blocks/properties. It keeps
// immutable DTOs from the core: a graph summary plus page snapshots hydrated
// on demand and refreshed after commands that affect those pages.

import type {
  CorePort,
  CorePortError,
  SparqlQueryRequest,
  SparqlQueryResult,
  RecoveryDto,
  StorageCapabilitiesDto,
} from "../generated/core-port";
import { CORE_PORT_VERSION } from "../generated/core-port";
import { CorePortFailure, type SavedReceipt } from "../core-worker";
import type { Command, CommandResult } from "./commands";
import { envelope } from "./commands";
import type { GraphSnapshot, GraphSummary, PageSnapshot } from "./snapshot";
import { EMPTY_SNAPSHOT, mergePage, mergeSummary } from "./snapshot";
import { acquireLease, type Lease, type LeaseMode } from "./lease";
import { diagnostics } from "../diagnostics/coordinator";
import type { DiagnosticActionContext } from "../diagnostics/types";

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
  /** Increments on every authoritative summary or page refresh. */
  revision: number;
  hydratedPages: ReadonlySet<string>;
}

export interface SessionPort extends CorePort {
  retryPending(graphHandle: string): Promise<SavedReceipt>;
  terminate?(): void;
}

export class GraphSession {
  private state: SessionState;
  private handle = "";
  private cursor = 0;
  private lease: Lease | null = null;
  private opening: Promise<void> | null = null;
  private closeRequested = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingCommandCount = 0;
  private listeners = new Set<() => void>();

  constructor(
    public readonly graphId: string,
    private readonly port: SessionPort,
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
      hydratedPages: new Set(),
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
    const span = diagnostics.startSpan("session", "session.open");
    try {
      this.lease = await acquireLease(this.graphId);
      if (this.closeRequested) {
        span.end("cancelled");
        return;
      }
      const opened = await diagnostics.withContext(span.context, () =>
        this.port.openGraph({
          contract_version: CORE_PORT_VERSION,
          locator: { graph_id: this.graphId, location: "local", remote_graph_id: null },
          peer_id: randomPeerId(),
        }));
      this.handle = opened.graph_handle;
      if (this.closeRequested) {
        span.end("cancelled");
        return;
      }
      this.patch({
        status: "ready",
        mode: this.lease.mode,
        snapshot: mergeSummary(opened.summary as GraphSummary),
        capabilities: opened.capabilities,
        recovery: opened.recovery,
      });
      span.end("ok", {
        lease_mode: this.lease.mode,
        checkpoint_sequence: opened.recovery.checkpoint_sequence,
        replayed_update_count: opened.recovery.replayed_updates,
        quarantined_count: opened.recovery.quarantined_records.length,
      });
    } catch (error) {
      span.fail(error);
      if (!this.closeRequested) {
        this.lease?.release();
        this.lease = null;
        this.patch({ status: "error", error: toPortError(error) });
      }
    }
  }

  /**
   * Executes a domain command. Commands are serialized; the returned promise
   * resolves after the authoritative summary/page state has been reconciled.
   */
  execute(
    command: Command,
    action?: DiagnosticActionContext | null,
  ): Promise<CommandResult> {
    this.pendingCommandCount += 1;
    const diagnosticAction = diagnostics.recordCommand(command, action);
    const run = this.queue.then(() => this.executeNow(command, diagnosticAction));
    const tracked = run.finally(() => {
      this.pendingCommandCount = Math.max(0, this.pendingCommandCount - 1);
      this.recordDiagnosticState();
    });
    // Keep the queue alive after failures so later commands still run.
    this.queue = tracked.catch(() => undefined);
    this.recordDiagnosticState();
    return tracked;
  }

  hydratePage(pageId: string): Promise<void> {
    const run = this.queue.then(() => this.hydratePageNow(pageId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Retries the pending durable write after a storage failure. */
  retry(): Promise<void> {
    const run = this.queue.then(() => this.retryNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Executes against the published derived index after prior mutations settle. */
  query(
    query: SparqlQueryRequest,
    action?: DiagnosticActionContext | null,
  ): Promise<SparqlQueryResult> {
    const diagnosticAction = diagnostics.recordQuery(query, action);
    return this.queue.then(async () => {
      const span = diagnostics.startSpan("session", "session.query", {}, diagnosticAction);
      if (this.state.status !== "ready") {
        const error = new CorePortFailure({
          code: "graph_not_open",
          message: "graph is not open",
          retryable: false,
        });
        span.fail(error);
        throw error;
      }
      try {
        const response = await diagnostics.withContext(span.context, () =>
          this.port.query({ graph_handle: this.handle, query }));
        span.end("ok", {
          result_kind: response.result.kind,
          result_row_count: response.result.kind === "select" ? response.result.rows.length : 1,
          result_column_count: response.result.kind === "select" ? response.result.variables.length : 1,
          result_revision: response.result.revision,
        });
        return response.result;
      } catch (error) {
        span.fail(error);
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    const span = diagnostics.startSpan("session", "session.close");
    this.closeRequested = true;
    await this.opening?.catch(() => undefined);
    await this.queue.catch(() => undefined);
    if (this.handle && this.state.save.kind !== "unsaved") {
      try {
        await diagnostics.withContext(span.context, () =>
          this.port.closeGraph({ graph_handle: this.handle }));
      } catch (error) {
        span.fail(error);
        // Closing is best-effort; recovery replays the update log on reopen.
      }
    }
    this.lease?.release();
    this.lease = null;
    this.port.terminate?.();
    this.patch({ status: "closed" });
    span.end("ok");
  }

  private async executeNow(
    command: Command,
    action: DiagnosticActionContext | null,
  ): Promise<CommandResult> {
    const span = diagnostics.startSpan("session", "session.execute", {
      command_type: command.type,
    }, action);
    if (this.state.status !== "ready") {
      const error = new CorePortFailure({ code: "graph_not_open", message: "graph is not open", retryable: false });
      span.fail(error);
      throw error;
    }
    if (this.state.mode === "readonly") {
      const error = new CorePortFailure({
        code: "invalid_request",
        message: "this graph is opened read-only in this tab",
        retryable: false,
      });
      span.fail(error);
      throw error;
    }
    this.patch({ save: { kind: "saving" } });
    try {
      const response = await diagnostics.withContext(span.context, () =>
        this.port.execute({
          graph_handle: this.handle,
          command: envelope(this.graphId, command),
          timeout_ms: COMMAND_TIMEOUT_MS,
        }));
      const save: SaveState =
        response.save_status.status === "saved_locally"
          ? { kind: "saved", sequence: response.save_status.local_sequence }
          : { kind: "unsaved", code: "dirty_unsaved", message: "the last change is not durable yet", retryable: true };
      await diagnostics.withContext(span.context, () =>
        this.reconcile(
          save,
          commandPageId(command, response.result as CommandResult),
          command.type === "undo" || command.type === "redo",
        ));
      span.end("ok", {
        result_kind: "command_result",
        changed: (response.result as CommandResult).changed,
      });
      return response.result as CommandResult;
    } catch (error) {
      span.fail(error);
      const detail = toPortError(error);
      if (detail.code === "dirty_unsaved" || detail.code === "storage_full") {
        // The command applied in memory but is not durable. Show the state
        // and keep the exact bytes pending for retry.
        await this.reconcile({
          kind: "unsaved",
          code: detail.code,
          message: detail.message,
          retryable: detail.retryable,
        }, commandPageId(command));
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
    const span = diagnostics.startSpan("session", "session.retry");
    this.patch({ save: { kind: "saving" } });
    try {
      const receipt = await diagnostics.withContext(span.context, () =>
        this.port.retryPending(this.handle));
      await diagnostics.withContext(span.context, () =>
        this.reconcile({ kind: "saved", sequence: receipt.local_sequence }));
      span.end("ok");
    } catch (error) {
      span.fail(error);
      const detail = toPortError(error);
      this.patch({
        save: { kind: "unsaved", code: detail.code, message: detail.message, retryable: detail.retryable },
      });
    }
  }

  private async hydratePageNow(pageId: string): Promise<void> {
    if (this.state.status !== "ready") return;
    const span = diagnostics.startSpan("session", "session.hydrate_page");
    let response;
    try {
      response = await diagnostics.withContext(span.context, () =>
        this.port.readPage({ graph_handle: this.handle, page_id: pageId }));
      span.end("ok");
    } catch (error) {
      span.fail(error);
      throw error;
    }
    const hydratedPages = new Set(this.state.hydratedPages);
    hydratedPages.add(pageId);
    this.patch({
      snapshot: mergePage(this.state.snapshot, response.page as PageSnapshot),
      hydratedPages,
      revision: this.state.revision + 1,
    });
  }

  /** Drains events, refreshes graph metadata, then refreshes only the affected page. */
  private async reconcile(
    save: SaveState,
    pageId?: string,
    refreshHydrated = false,
  ): Promise<void> {
    const span = diagnostics.startSpan("session", "session.reconcile");
    const cursorBefore = this.cursor;
    let eventCount = 0;
    let resyncRequired = false;
    let reconcileFallback = false;
    let pageReadCount = 0;
    try {
      try {
        const batch = await diagnostics.withContext(span.context, () =>
          this.port.subscribe({ graph_handle: this.handle, after_cursor: this.cursor }));
        eventCount = batch.events.length;
        resyncRequired = batch.resync_required;
        reconcileFallback = batch.resync_required;
        this.cursor = batch.next_cursor;
      } catch {
        // A failed event poll falls through to the full re-read below.
        reconcileFallback = true;
      }
      const read = await diagnostics.withContext(span.context, () =>
        this.port.read({ graph_handle: this.handle }));
      let snapshot = mergeSummary(read.summary as GraphSummary, this.state.snapshot);
      const pageIdsToRead = refreshHydrated
        ? [...this.state.hydratedPages]
        : pageId
          ? [pageId]
          : [];
      for (const id of pageIdsToRead) {
        if (!snapshot.pages.some((page) => page.id === id)) continue;
        const response = await diagnostics.withContext(span.context, () =>
          this.port.readPage({ graph_handle: this.handle, page_id: id }));
        snapshot = mergePage(snapshot, response.page as PageSnapshot);
        pageReadCount += 1;
      }
      const pageIds = new Set(snapshot.pages.map((page) => page.id));
      const hydratedPages = new Set(
        [...this.state.hydratedPages].filter((id) => pageIds.has(id)),
      );
      for (const id of pageIdsToRead) {
        if (pageIds.has(id)) hydratedPages.add(id);
      }
      this.patch({ snapshot, hydratedPages, save, revision: this.state.revision + 1 });
      span.end("ok", {
        event_count: eventCount,
        page_read_count: pageReadCount,
        cursor_before: cursorBefore,
        cursor_after: this.cursor,
        resync_required: resyncRequired,
        reconcile_fallback: reconcileFallback,
      });
    } catch (error) {
      span.fail(error);
      throw error;
    }
  }

  private previousStableSave(): SaveState {
    return this.state.save.kind === "saving" ? { kind: "saved", sequence: 0 } : this.state.save;
  }

  private patch(partial: Partial<SessionState>): void {
    this.state = { ...this.state, ...partial };
    this.recordDiagnosticState();
    for (const listener of this.listeners) listener();
  }

  private recordDiagnosticState(): void {
    diagnostics.recordSessionState(this.state.snapshot, {
      session_status: this.state.status,
      lease_mode: this.state.mode,
      save_state: this.state.save.kind,
      hydrated_page_count: this.state.hydratedPages.size,
      pending_command_count: this.pendingCommandCount,
      snapshot_revision: this.state.revision,
    });
  }
}

function commandPageId(command: Command, result?: CommandResult): string | undefined {
  switch (command.type) {
    case "ensure_page":
    case "rename_page":
    case "delete_page":
    case "restore_page":
    case "insert_block":
    case "insert_outline":
    case "edit_markdown":
    case "splice_markdown":
    case "move_blocks":
    case "indent_blocks":
    case "outdent_blocks":
    case "delete_blocks":
      return command.page_id;
    case "add_tag":
    case "remove_tag":
      return command.entity.kind === "block" ? command.entity.page_id : command.entity.id;
    case "set_property":
    case "remove_property":
    case "add_repeated_property":
    case "remove_repeated_property":
      return command.entity.kind === "block" ? command.entity.page_id : command.entity.id;
    case "ensure_journal":
      return result?.created_page ?? undefined;
    case "ensure_tag":
    case "rename_tag":
    case "delete_tag":
    case "restore_tag":
    case "set_tag_default":
    case "remove_tag_default":
    case "undo":
    case "redo":
      return undefined;
  }
}

function randomPeerId(): number {
  // 32 random bits keep the peer id an exact JSON number while making
  // concurrent reuse across tabs vanishingly unlikely.
  return crypto.getRandomValues(new Uint32Array(1))[0] + 1;
}

function toPortError(error: unknown): CorePortError {
  if (error instanceof CorePortFailure) return error.detail;
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
