// GraphSession owns one open graph on behalf of the UI. It serializes
// commands, reconciles state through the CorePort event/read path, and
// exposes an immutable state object for React (useSyncExternalStore).
//
// The UI never holds a mutable replica of pages/blocks/properties: every
// state change re-reads the authoritative snapshot DTO from the core after
// the semantic event for the command has been observed.

import type {
  CorePort,
  CorePortError,
  RecoveryDto,
  StorageCapabilitiesDto,
} from "../generated/core-port";
import { CORE_PORT_VERSION } from "../generated/core-port";
import { CorePortFailure, type SavedReceipt } from "../core-worker";
import type { Command, CommandResult } from "./commands";
import { envelope } from "./commands";
import type { GraphSnapshot } from "./snapshot";
import { EMPTY_SNAPSHOT } from "./snapshot";
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
  /** Increments on every authoritative snapshot refresh. */
  revision: number;
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
        locator: { graph_id: this.graphId, location: "local", remote_graph_id: null },
        peer_id: randomPeerId(),
      });
      this.handle = opened.graph_handle;
      if (this.closeRequested) return;
      this.patch({
        status: "ready",
        mode: this.lease.mode,
        snapshot: opened.snapshot as GraphSnapshot,
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
   * resolves after the authoritative snapshot has been reconciled.
   */
  execute(command: Command): Promise<CommandResult> {
    const run = this.queue.then(() => this.executeNow(command));
    // Keep the queue alive after failures so later commands still run.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Retries the pending durable write after a storage failure. */
  retry(): Promise<void> {
    const run = this.queue.then(() => this.retryNow());
    this.queue = run.catch(() => undefined);
    return run;
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
      throw new CorePortFailure({ code: "graph_not_open", message: "graph is not open", retryable: false });
    }
    if (this.state.mode === "readonly") {
      throw new CorePortFailure({
        code: "invalid_request",
        message: "this graph is opened read-only in this tab",
        retryable: false,
      });
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
      await this.reconcile(save);
      return response.result as CommandResult;
    } catch (error) {
      const detail = toPortError(error);
      if (detail.code === "dirty_unsaved" || detail.code === "storage_full") {
        // The command applied in memory but is not durable. Show the state
        // and keep the exact bytes pending for retry.
        await this.reconcile({
          kind: "unsaved",
          code: detail.code,
          message: detail.message,
          retryable: detail.retryable,
        });
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

  /** Drains the event stream, then re-reads the authoritative snapshot. */
  private async reconcile(save: SaveState): Promise<void> {
    try {
      const batch = await this.port.subscribe({ graph_handle: this.handle, after_cursor: this.cursor });
      this.cursor = batch.next_cursor;
    } catch {
      // A failed event poll falls through to the full re-read below.
    }
    const read = await this.port.read({ graph_handle: this.handle });
    this.patch({ snapshot: read.snapshot as GraphSnapshot, save, revision: this.state.revision + 1 });
  }

  private previousStableSave(): SaveState {
    return this.state.save.kind === "saving" ? { kind: "saved", sequence: 0 } : this.state.save;
  }

  private patch(partial: Partial<SessionState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
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
