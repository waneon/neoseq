import type { OutboxMessage, SyncState } from "../../core-worker";
import type { RemoteGraphConnection } from "../../core-port/directory";
import type { OutlineOwner } from "../../core-port/snapshot";
import { SCHEMA_VERSION } from "../../generated/graph-schema";
import { PROTOCOL_VERSION, SUBPROTOCOL } from "../../generated/sync-protocol";
import { readAuthSession } from "./auth";

export type RemoteSyncState =
  | { kind: "local" }
  | { kind: "pending"; count: number }
  | { kind: "synced" }
  | { kind: "paused"; reason: "auth" | "revoked" | "incompatible" }
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
  nextOutbox(graphHandle: string): Promise<OutboxMessage | null>;
  acknowledgeOutbox(graphHandle: string, messageId: string): Promise<void>;
  encodeSyncMessage(message: unknown): Promise<ArrayBuffer>;
  decodeSyncMessage(frame: ArrayBuffer): Promise<unknown>;
}

interface SyncAgentDelegate {
  applyRemote(bytes: number[]): Promise<void>;
  replaceRemote(
    checkpoint: number[],
    historyEpoch: number,
    serverVersionVector: number[],
  ): Promise<void>;
  changed(state: SyncAgentState): void;
}

type WireMessage = Record<string, Record<string, unknown>>;

const MAX_RECONNECT_MS = 30_000;
const PRESENCE_TTL_MS = 10_000;
const CLOSE_INVALID_MESSAGE = 4000;
const CLOSE_RESYNC = 4001;
const CLOSE_PAUSED = 4002;
const CLOSE_INCOMPATIBLE = 4003;
const CLOSE_RETRY = 4004;
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
  private transportSessionId = "";
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
    void this.refreshPending().then(() => this.connect());
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    window.removeEventListener("neoseq:auth-changed", this.onAuthChanged);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.socket?.close(1000, "graph closed");
    this.socket = null;
  }

  async wake(): Promise<void> {
    await this.refreshPending();
    await this.flush();
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
    socket.send(frame);
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
    this.transportSessionId = `${this.sessionId}:${crypto.randomUUID()}`;
    const socket = new WebSocket(url, [SUBPROTOCOL, `neoseq.auth.${base64Url(auth.token)}`]);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => void this.hello();
    socket.onmessage = (event) => {
      const frame = event.data as ArrayBuffer;
      this.incoming = this.incoming
        .then(() => this.receive(frame))
        .catch((error: unknown) => {
          this.patch({ sync: { kind: "error", message: String(error) } });
          socket.close(CLOSE_INVALID_MESSAGE, "invalid sync message");
        });
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.welcomed = false;
      this.inFlight = null;
      if (!this.stopped && this.current.live !== "paused") this.scheduleReconnect();
    };
    socket.onerror = () => {
      // `close` owns retry and user-visible state; browser WebSocket errors do
      // not expose a safe diagnostic or HTTP status.
    };
  }

  private async hello(): Promise<void> {
    const state = await this.port.syncState(this.graphHandle);
    const frame = await this.port.encodeSyncMessage({
      Hello: {
        protocol: PROTOCOL_VERSION,
        schema: SCHEMA_VERSION,
        graph_id: this.graphId,
        session_id: this.transportSessionId,
        history_epoch: state.history_epoch,
        has_server_base: state.has_server_base,
        version_vector: state.version_vector,
      },
    });
    this.socket?.send(frame);
  }

  private async receive(frame: ArrayBuffer): Promise<void> {
    const message = (await this.port.decodeSyncMessage(frame)) as WireMessage;
    if (message.Welcome) {
      const welcome = message.Welcome;
      const missing = numberArray(welcome.missing_update);
      const checkpoint = numberArray(welcome.checkpoint);
      if (Boolean(welcome.replace_checkpoint)) {
        if (checkpoint.length === 0) throw new Error("replacement checkpoint is missing");
        await this.delegate.replaceRemote(
          checkpoint,
          Number(welcome.history_epoch),
          numberArray(welcome.server_version_vector),
        );
      } else if (checkpoint.length > 0) {
        await this.delegate.applyRemote(checkpoint);
      }
      if (missing.length > 0) await this.delegate.applyRemote(missing);
      this.welcomed = true;
      this.retry = 0;
      this.patch({ live: "live" });
      await this.refreshPending();
      await this.flush();
      return;
    }
    if (message.Ack) {
      const ack = message.Ack;
      const messageId = String(ack.message_id);
      await this.port.acknowledgeOutbox(this.graphHandle, messageId);
      if (this.inFlight === messageId) this.inFlight = null;
      await this.refreshPending();
      await this.flush();
      return;
    }
    if (message.Update) {
      await this.delegate.applyRemote(numberArray(message.Update.bytes));
      return;
    }
    if (message.Presence) {
      this.receivePresence(message.Presence);
      return;
    }
    if (message.ResyncRequired) {
      this.socket?.close(CLOSE_RESYNC, "resync required");
      return;
    }
    if (message.Error) {
      const code = String(message.Error.code);
      if (["access_denied", "membership_revoked"].includes(code)) {
        this.patch({
          sync: { kind: "paused", reason: code === "membership_revoked" ? "revoked" : "auth" },
          live: "paused",
        });
        this.socket?.close(CLOSE_PAUSED, "sync paused");
      } else if (["unsupported_protocol", "unsupported_schema"].includes(code)) {
        this.patch({ sync: { kind: "paused", reason: "incompatible" }, live: "paused" });
        this.socket?.close(CLOSE_INCOMPATIBLE, "incompatible sync protocol");
      } else if (Boolean(message.Error.recoverable)) {
        this.socket?.close(CLOSE_RETRY, "retryable sync error");
      } else {
        this.patch({ sync: { kind: "error", message: String(message.Error.diagnostic) } });
      }
    }
  }

  private async flush(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.welcomed || this.inFlight) return;
    const next = await this.port.nextOutbox(this.graphHandle);
    if (!next) {
      this.patch({ sync: { kind: "synced" } });
      return;
    }
    const frame = await this.port.encodeSyncMessage({
      Update: {
        history_epoch: next.history_epoch,
        message_id: next.message_id,
        base_version_vector: next.base_version_vector,
        bytes: next.bytes,
      },
    });
    this.inFlight = next.message_id;
    socket.send(frame);
  }

  private async refreshPending(): Promise<void> {
    const state = await this.port.syncState(this.graphHandle);
    if (this.current.sync.kind === "paused") return;
    this.patch({
      sync: state.pending > 0 ? { kind: "pending", count: state.pending } : { kind: "synced" },
    });
  }

  private receivePresence(raw: Record<string, unknown>): void {
    try {
      const decoded = JSON.parse(
        new TextDecoder().decode(new Uint8Array(numberArray(raw.payload))),
      ) as Omit<PeerPresence, "expires_at">;
      if (!decoded.session_id || decoded.session_id === this.transportSessionId) return;
      this.presence.set(decoded.session_id, {
        ...decoded,
        expires_at: Date.now() + Math.min(Number(raw.expires_in_ms), PRESENCE_TTL_MS),
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

  private abandonSocket(reason: string): void {
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
    this.abandonSocket("offline");
    this.scheduleReconnect();
  };
  private onAuthChanged = () => {
    this.abandonSocket("credentials changed");
    this.patch({ live: "connecting", sync: { kind: "pending", count: 0 } });
    void this.refreshPending().then(() => this.connect());
  };
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number) : [];
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
