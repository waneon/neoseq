import type { Message as SyncMessage, Welcome, Presence } from "../../generated/domain";
import { CorePortFailure, type OutboxFrame, type SyncState } from "../../core-worker";
import type { RemoteGraphConnection } from "../../core-port/directory";
import type { OutlineOwner } from "../../core-port/snapshot";
import { SCHEMA_VERSION } from "../../generated/graph-schema";
import { PROTOCOL_VERSION, SUBPROTOCOL } from "../../generated/sync-protocol";
import { readAuthSession, validateAuthSession } from "./auth";
import { downloadRemoteCheckpoint, type RemoteCheckpoint } from "./api";
import { randomUUID } from "@/lib/crypto";

export type RemoteSyncState =
  | { kind: "local" }
  | { kind: "pending"; count: number }
  | { kind: "synced" }
  | { kind: "paused"; reason: "auth" | "revoked" | "incompatible" | "history" }
  | { kind: "error"; message: string };

export type LiveState = "local" | "connecting" | "live" | "offline" | "paused";

export interface PeerPresence {
  session_id: string;
  principal: string;
  owner?: OutlineOwner;
  block_id?: string;
  anchor?: number;
  head?: number;
  expires_at: number;
}

export interface SyncAgentState {
  sync: RemoteSyncState;
  live: LiveState;
  presence: ReadonlyMap<string, PeerPresence>;
}

export interface SyncAgentPort {
  syncState(graphHandle: string): Promise<SyncState>;
  nextSyncFrame(graphHandle: string): Promise<OutboxFrame | null>;
  acknowledgeOutbox(graphHandle: string, messageId: string): Promise<void>;
  encodeSyncMessage(message: SyncMessage): Promise<ArrayBuffer>;
  decodeSyncMessage(frame: ArrayBuffer): Promise<SyncMessage>;
}

interface WelcomeTarget {
  applyRemote(bytes: number[] | ArrayBuffer, current?: () => boolean): Promise<void>;
  replaceRemote(
    checkpoint: number[] | ArrayBuffer,
    historyEpoch: number,
    serverVersionVector: number[],
    current?: () => boolean,
  ): Promise<void>;
}

interface SyncAgentDelegate extends WelcomeTarget {
  changed(state: SyncAgentState): void;
}

const MAX_RECONNECT_MS = 30_000;
const PRESENCE_TTL_MS = 10_000;
const HEARTBEAT_MS = 10_000;
const TRANSPORT_TIMEOUT_MS = 60_000;
const CLOSE_PAUSED = 4002;
const CLOSE_INCOMPATIBLE = 4003;
const CLOSE_REPLACED = 4005;

/** One remote graph, one reconnecting transport. Canonical graph state and the
 * durable outbox remain in the Worker; this class only owns the live socket. */
export class SyncAgent {
  private socket: WebSocket | null = null;
  private stopped = false;
  private welcomed = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: string | null = null;
  private incoming: Promise<void> = Promise.resolve();
  private outgoing: Promise<void> = Promise.resolve();
  private transportSessionId = "";
  private transportAbort: AbortController | null = null;
  private historyEpoch: number | null = null;
  private lastReceived = 0;
  private lastHeartbeat = 0;
  private inFlightSince = 0;
  private presence = new Map<string, PeerPresence>();
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private current: SyncAgentState = {
    sync: { kind: "pending", count: 0 },
    live: "connecting",
    presence: this.presence,
  };

  constructor(
    private readonly graphId: string,
    private readonly graphHandle: string,
    private readonly sessionId: string,
    private readonly connection: RemoteGraphConnection,
    private readonly port: SyncAgentPort,
    private readonly delegate: SyncAgentDelegate,
  ) {}

  start(): void {
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    window.addEventListener("neoseq:auth-changed", this.onAuthChanged);
    this.presenceTimer = setInterval(() => {
      this.expirePresence();
      this.maintainConnectivity();
    }, 1_000);
    void this.refreshPending()
      .then(async () => {
        const auth = await validateAuthSession(
          this.connection.repository_id,
          this.connection.server_url,
        );
        if (this.stopped) return;
        if (!auth) {
          this.patch({ sync: { kind: "paused", reason: "auth" }, live: "paused" });
          return;
        }
        this.connect();
      })
      .catch((error: unknown) => this.failToStart(error));
  }

  // A Worker or storage failure before the first connection would otherwise
  // leave the slots on "connecting" forever with nothing to retry. Report it as
  // an ordinary sync error and let the reconnect timer try again.
  private failToStart(error: unknown): void {
    if (this.stopped) return;
    this.patch({ sync: { kind: "error", message: String(error) }, live: "offline" });
    this.scheduleReconnect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    window.removeEventListener("neoseq:auth-changed", this.onAuthChanged);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.abandonSocket("graph closed");
  }

  /** Local durability only signals the transport; it never waits for it. */
  wake(): void {
    if (this.stopped) return;
    void this.updateOutbox().catch((error: unknown) => {
      if (this.stopped || this.current.sync.kind === "paused") return;
      this.abandonSocket("outbox unavailable");
      this.patch({ sync: { kind: "error", message: String(error) } });
      this.scheduleReconnect();
    });
  }

  private updateOutbox(): Promise<void> {
    // Local wakes and server acknowledgements share one outgoing sequence,
    // independent of the canonical command queue and incoming remote imports.
    const run = this.outgoing.then(async () => {
      if (this.stopped) return;
      await this.refreshPending();
      await this.flush();
    });
    this.outgoing = run.catch(() => undefined);
    return run;
  }

  async publishPresence(
    value: Omit<PeerPresence, "session_id" | "principal" | "expires_at">,
  ): Promise<void> {
    const socket = this.socket;
    const auth = readAuthSession(this.connection.repository_id);
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.welcomed || !auth) return;
    const payload = new TextEncoder().encode(
      JSON.stringify({
        session_id: this.transportSessionId,
        principal: auth.principal,
        ...value,
      }),
    );
    const frame = await this.port.encodeSyncMessage({
      Presence: {
        expires_in_ms: PRESENCE_TTL_MS,
        payload: [...payload],
      },
    });
    if (this.isCurrent(socket) && socket.readyState === WebSocket.OPEN) socket.send(frame);
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    if (!navigator.onLine) {
      this.scheduleReconnect();
      return;
    }
    const auth = readAuthSession(this.connection.repository_id);
    if (!auth) {
      this.patch({ sync: { kind: "paused", reason: "auth" }, live: "paused" });
      return;
    }
    this.patch({ live: "connecting" });
    const url = new URL("/v1/sync", `${this.connection.server_url}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.transportSessionId = `${this.sessionId}:${randomUUID()}`;
    const socket = new WebSocket(url, [SUBPROTOCOL, `neoseq.auth.${base64Url(auth.token)}`]);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.transportAbort = new AbortController();
    this.incoming = Promise.resolve();
    this.historyEpoch = null;
    this.lastReceived = Date.now();
    socket.onopen = () =>
      void this.hello(socket).catch((error: unknown) => this.transportFailed(socket, error));
    socket.onmessage = (event) => {
      if (!this.isCurrent(socket)) return;
      this.lastReceived = Date.now();
      const frame = event.data as ArrayBuffer;
      this.incoming = this.incoming
        .then(() => this.receive(socket, frame))
        .catch((error: unknown) => this.transportFailed(socket, error));
    };
    socket.onclose = (event) => {
      if (!this.isCurrent(socket)) return;
      console.info("sync transport closed", { code: event.code, clean: event.wasClean });
      this.transportAbort?.abort();
      // Worker decoding can finish after the close event. Drain frames already
      // received so a terminal server error can pause retries. The watchdog
      // still bounds this wait, and a replacement transport invalidates it.
      void this.incoming.then(() => {
        if (!this.isCurrent(socket)) return;
        this.abandonSocket("closed");
        if (this.current.live !== "paused") this.scheduleReconnect();
      });
    };
    socket.onerror = () => {
      // `close` owns retry and user-visible state; browser WebSocket errors do
      // not expose a safe diagnostic or HTTP status.
    };
  }

  private async hello(socket: WebSocket): Promise<void> {
    const sessionId = this.transportSessionId;
    const state = await this.port.syncState(this.graphHandle);
    if (!this.isCurrent(socket)) return;
    this.historyEpoch = state.history_epoch;
    const frame = await this.port.encodeSyncMessage({
      Hello: {
        protocol: PROTOCOL_VERSION,
        schema: SCHEMA_VERSION,
        graph_id: this.graphId,
        session_id: sessionId,
        history_epoch: state.history_epoch,
        has_server_base: state.has_server_base,
        version_vector: state.version_vector,
      },
    });
    if (this.isCurrent(socket) && socket.readyState === WebSocket.OPEN) socket.send(frame);
  }

  private async receive(socket: WebSocket, frame: ArrayBuffer): Promise<void> {
    if (!this.isCurrent(socket)) return;
    const message = await this.port.decodeSyncMessage(frame);
    if (!this.isCurrent(socket)) return;
    const current = () => this.isCurrent(socket);
    if ("Welcome" in message) {
      const welcome = message.Welcome;
      const signal = this.transportAbort!.signal;
      await applyWelcomePayload(
        welcome,
        {
          applyRemote: (bytes) => this.delegate.applyRemote(bytes, current),
          replaceRemote: (bytes, epoch, vector) =>
            this.delegate.replaceRemote(bytes, epoch, vector, current),
        },
        async () => {
          const auth = readAuthSession(this.connection.repository_id);
          if (!auth) throw new Error("checkpoint download requires authentication");
          return downloadRemoteCheckpoint(this.connection.server_url, auth, this.graphId, signal);
        },
        current,
      );
      if (!current()) return;
      this.historyEpoch = welcome.history_epoch;
      this.welcomed = true;
      this.retry = 0;
      this.patch({ live: "live" });
      await this.updateOutbox();
      return;
    }
    if ("Ack" in message) {
      const ack = message.Ack;
      const messageId = ack.message_id;
      if (ack.history_epoch !== this.historyEpoch || messageId !== this.inFlight) return;
      await this.port.acknowledgeOutbox(this.graphHandle, messageId);
      if (!current()) return;
      if (this.inFlight === messageId) this.inFlight = null;
      await this.updateOutbox();
      return;
    }
    if ("Update" in message) {
      if (message.Update.history_epoch !== this.historyEpoch)
        throw new Error("remote history changed");
      await this.delegate.applyRemote(message.Update.bytes, current);
      return;
    }
    if ("Heartbeat" in message) return;
    if ("Presence" in message) {
      this.receivePresence(message.Presence);
      return;
    }
    if ("ResyncRequired" in message) {
      this.abandonSocket("resync required");
      this.scheduleReconnect();
      return;
    }
    if ("Error" in message) {
      const code = message.Error.code;
      if (["access_denied", "membership_revoked"].includes(code)) {
        this.patch({
          sync: { kind: "paused", reason: code === "membership_revoked" ? "revoked" : "auth" },
          live: "paused",
        });
        this.socket?.close(CLOSE_PAUSED, "sync paused");
      } else if (["unsupported_protocol", "unsupported_schema"].includes(code)) {
        this.patch({ sync: { kind: "paused", reason: "incompatible" }, live: "paused" });
        this.socket?.close(CLOSE_INCOMPATIBLE, "incompatible sync protocol");
      } else if (message.Error.recoverable) {
        this.abandonSocket("retryable sync error");
        this.scheduleReconnect();
      } else {
        this.patch({ sync: { kind: "error", message: message.Error.diagnostic } });
      }
    }
  }

  private async flush(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.welcomed || this.inFlight) return;
    const next = await this.port.nextSyncFrame(this.graphHandle);
    // A reconnect can replace the transport during the Worker read. Only the
    // current live transport may claim the next outbox frame.
    if (
      this.stopped ||
      socket !== this.socket ||
      socket.readyState !== WebSocket.OPEN ||
      !this.welcomed ||
      this.inFlight
    )
      return;
    if (!next) {
      this.patch({ sync: { kind: "synced" } });
      return;
    }
    this.inFlight = next.message_id;
    this.inFlightSince = Date.now();
    socket.send(next.frame);
  }

  private async refreshPending(): Promise<void> {
    const state = await this.port.syncState(this.graphHandle);
    if (this.stopped || this.current.sync.kind === "paused") return;
    this.patch({
      sync: state.pending > 0 ? { kind: "pending", count: state.pending } : { kind: "synced" },
    });
  }

  private receivePresence(raw: Presence): void {
    try {
      const decoded = JSON.parse(new TextDecoder().decode(new Uint8Array(raw.payload))) as Omit<
        PeerPresence,
        "expires_at"
      >;
      if (!decoded.session_id || decoded.session_id === this.transportSessionId) return;
      this.presence.set(decoded.session_id, {
        ...decoded,
        expires_at: Date.now() + presenceTtl(raw.expires_in_ms),
      });
      this.patch({ presence: new Map(this.presence) });
    } catch {
      // Presence is lossy by design; malformed ephemeral payloads are ignored.
    }
  }

  private expirePresence(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.presence) {
      if (peer.expires_at <= now) {
        this.presence.delete(id);
        changed = true;
      }
    }
    if (changed) this.patch({ presence: new Map(this.presence) });
  }

  private maintainConnectivity(): void {
    if (this.stopped || this.current.live === "paused") return;
    const socket = this.socket;
    const now = Date.now();
    if (
      socket &&
      (now - this.lastReceived >= TRANSPORT_TIMEOUT_MS ||
        (this.inFlight && now - this.inFlightSince >= TRANSPORT_TIMEOUT_MS))
    ) {
      this.transportFailed(socket, new Error("sync response timeout"));
      return;
    }
    if (socket && this.welcomed && now - this.lastHeartbeat >= HEARTBEAT_MS) {
      this.lastHeartbeat = now;
      void this.port
        .encodeSyncMessage({ Heartbeat: { nonce: now >>> 0 } })
        .then((frame) => {
          if (this.isCurrent(socket) && socket.readyState === WebSocket.OPEN) socket.send(frame);
        })
        .catch((error: unknown) => this.transportFailed(socket, error));
    }
    if (!navigator.onLine) {
      if (this.socket || this.current.live !== "offline") {
        this.abandonSocket("offline");
        this.scheduleReconnect();
      }
      return;
    }
    if (!this.socket && !this.retryTimer && this.current.live === "offline") {
      this.connect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.current.live === "paused") return;
    // During backoff the graph is still locally usable. `connecting` is
    // reserved for an active transport attempt, so bootstrap-only commands
    // are not held indefinitely when the server is unavailable.
    this.patch({ live: "offline" });
    if (this.retryTimer) return;
    const ceiling = Math.min(MAX_RECONNECT_MS, 500 * 2 ** this.retry++);
    const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      if (navigator.onLine) this.connect();
      else this.scheduleReconnect();
    }, delay);
  }

  private patch(partial: Partial<SyncAgentState>): void {
    this.current = { ...this.current, ...partial };
    this.delegate.changed(this.current);
  }

  private isCurrent(socket: WebSocket): boolean {
    return !this.stopped && this.socket === socket;
  }

  private transportFailed(socket: WebSocket, error: unknown): void {
    if (!this.isCurrent(socket)) return;
    this.abandonSocket("sync failed");
    if (error instanceof CorePortFailure && error.detail.code === "resync_required") {
      this.patch({ sync: { kind: "paused", reason: "history" }, live: "paused" });
      return;
    }
    this.patch({ sync: { kind: "error", message: String(error) } });
    this.scheduleReconnect();
  }

  private abandonSocket(reason: string): void {
    this.transportAbort?.abort();
    this.transportAbort = null;
    const stale = this.socket;
    this.socket = null;
    this.welcomed = false;
    this.inFlight = null;
    if (!stale) return;
    stale.onopen = null;
    stale.onmessage = null;
    stale.onclose = null;
    stale.onerror = null;
    if (stale.readyState < WebSocket.CLOSING) stale.close(CLOSE_REPLACED, reason);
  }

  private onOnline = () => {
    if (this.stopped || this.current.live === "paused") return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // A WebSocket can remain permanently CLOSING when the browser goes
    // offline before its close frame is delivered. Detach that transport and
    // reconnect with a fresh wire-session id so a stale server session cannot
    // block recovery.
    this.abandonSocket("network changed");
    this.connect();
  };
  private onOffline = () => {
    if (this.stopped || this.current.live === "paused") return;
    this.abandonSocket("offline");
    this.scheduleReconnect();
  };
  private onAuthChanged = () => {
    this.abandonSocket("credentials changed");
    this.patch({ live: "connecting", sync: { kind: "pending", count: 0 } });
    void this.refreshPending()
      .then(() => this.connect())
      .catch((error: unknown) => this.failToStart(error));
  };
}

/** Applies the single synchronization action carried by a Welcome. Keeping this
 * interpretation separate makes the Rust sum type explicit at the TypeScript
 * boundary instead of recreating a matrix of booleans and empty byte arrays. */
export async function applyWelcomePayload(
  welcome: Welcome,
  target: WelcomeTarget,
  downloadCheckpoint: () => Promise<RemoteCheckpoint>,
  current: () => boolean = () => true,
): Promise<void> {
  const payload = welcome.payload;
  if ("replace_download" in payload || "merge_download" in payload) {
    const downloaded = await downloadCheckpoint();
    if (!current()) return;
    if (downloaded.history_epoch !== welcome.history_epoch)
      throw new Error("checkpoint history changed during download");
    if (checkpointBytes(downloaded.checkpoint) === 0) {
      throw new Error("replacement checkpoint is missing");
    }
    if ("merge_download" in payload) {
      await target.applyRemote(downloaded.checkpoint);
      return;
    }
    await target.replaceRemote(
      downloaded.checkpoint,
      downloaded.history_epoch,
      downloaded.server_version_vector,
    );
    return;
  }

  if ("delta" in payload) {
    const { update } = payload.delta;
    if (update.length > 0) await target.applyRemote(update);
    return;
  }

  if ("replace_inline" in payload) {
    const { checkpoint } = payload.replace_inline;
    if (checkpoint.length === 0) throw new Error("replacement checkpoint is missing");
    await target.replaceRemote(checkpoint, welcome.history_epoch, welcome.server_version_vector);
    return;
  }

  const unreachable: never = payload;
  throw new Error(`unexpected Welcome payload: ${unreachable}`);
}

/** A peer-supplied lifetime, clamped to the protocol ceiling. Anything that is
 * not a finite number expires immediately: a payload that cannot say how long
 * it lives must not live forever. */
function presenceTtl(value: unknown): number {
  const requested = Number(value);
  return Number.isFinite(requested) ? Math.max(0, Math.min(requested, PRESENCE_TTL_MS)) : 0;
}

function checkpointBytes(value: number[] | ArrayBuffer): number {
  return value instanceof ArrayBuffer ? value.byteLength : value.length;
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
