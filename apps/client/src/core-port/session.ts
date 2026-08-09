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

type ReconcileScope =
  | { kind: "summary" }
  | { kind: "page"; pageId: string }
  | { kind: "pages"; pageIds: readonly string[] }
  | { kind: "all-hydrated-pages" };

export class GraphSession {
  private state: SessionState;
  private handle = "";
  private cursor = 0;
  private lease: Lease | null = null;
  private opening: Promise<void> | null = null;
  private closeRequested = false;
  private queue: Promise<unknown> = Promise.resolve();
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
   * resolves after the authoritative summary/page state has been reconciled.
   */
  execute(command: Command): Promise<CommandResult> {
    const tracked = this.queue.then(() => this.executeNow(command));
    // Keep the queue alive after failures so later commands still run.
    this.queue = tracked.catch(() => undefined);
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

  async close(): Promise<void> {
    this.closeRequested = true;
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
      );
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
    } catch (error) {
      const detail = toPortError(error);
      this.patch({
        save: { kind: "unsaved", code: detail.code, message: detail.message, retryable: detail.retryable },
      });
    }
  }

  private async hydratePageNow(pageId: string): Promise<void> {
    if (this.state.status !== "ready") return;
    const response = await this.port.readPage({ graph_handle: this.handle, page_id: pageId });
    const hydratedPages = new Set(this.state.hydratedPages);
    hydratedPages.add(pageId);
    this.patch({
      snapshot: mergePage(this.state.snapshot, response.page as PageSnapshot),
      hydratedPages,
      revision: this.state.revision + 1,
    });
  }

  /** Drains events, refreshes graph metadata, then rehydrates the command's impact scope. */
  private async reconcile(
    save: SaveState,
    scope: ReconcileScope = { kind: "summary" },
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
    const pageIdsToRead = scope.kind === "all-hydrated-pages"
      ? [...this.state.hydratedPages]
      : scope.kind === "pages"
        ? scope.pageIds.filter((id) => this.state.hydratedPages.has(id))
      : scope.kind === "page"
        ? [scope.pageId]
        : [];
    for (const id of pageIdsToRead) {
      if (!snapshot.pages.some((page) => page.id === id)) continue;
      const response = await this.port.readPage({ graph_handle: this.handle, page_id: id });
      snapshot = mergePage(snapshot, response.page as PageSnapshot);
    }
    const pageIds = new Set(snapshot.pages.map((page) => page.id));
    const hydratedPages = new Set(
      [...this.state.hydratedPages].filter((id) => pageIds.has(id)),
    );
    for (const id of pageIdsToRead) {
      if (pageIds.has(id)) hydratedPages.add(id);
    }
    this.patch({ snapshot, hydratedPages, save, revision: this.state.revision + 1 });
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
    case "ensure_page":
    case "rename_page":
    case "delete_page":
    case "restore_page":
    case "insert_block":
    case "split_block":
    case "insert_outline":
    case "edit_markdown":
    case "splice_markdown":
    case "move_blocks":
    case "indent_blocks":
    case "outdent_blocks":
    case "delete_blocks":
      return { kind: "page", pageId: command.page_id };
    case "add_tag":
    case "remove_tag":
      return {
        kind: "page",
        pageId: command.entity.kind === "block" ? command.entity.page_id : command.entity.id,
      };
    case "ensure_property":
    case "set_property":
    case "clear_property_values":
    case "remove_property":
    case "add_repeated_property":
    case "remove_repeated_property":
    case "set_query_source":
    case "splice_query_source":
    case "put_query_view":
    case "remove_query_view":
    case "set_query_default_view":
      return command.owner.kind === "tag_default"
        ? { kind: "summary" }
        : {
            kind: "page",
            pageId: command.owner.kind === "block" ? command.owner.page_id : command.owner.id,
          };
    case "ensure_journal":
      return result?.created_page
        ? { kind: "page", pageId: result.created_page }
        : { kind: "summary" };
    case "delete_tag":
      return { kind: "all-hydrated-pages" };
    case "undo":
    case "redo":
      return result?.history_effect
        ? { kind: "pages", pageIds: result.history_effect.affected_pages }
        : { kind: "all-hydrated-pages" };
    case "ensure_tag":
    case "rename_tag":
    case "restore_tag":
      return { kind: "summary" };
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
