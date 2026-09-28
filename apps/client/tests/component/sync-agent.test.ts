import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SyncAgent, type SyncAgentPort } from "../../src/features/sync/SyncAgent";
import { writeAuthSession } from "../../src/features/sync/auth";
import { CorePortFailure } from "../../src/core-worker";
import type { Message } from "../../src/generated/domain";

const wire = (message: Message) => new TextEncoder().encode(JSON.stringify(message)).buffer;
const decode = (frame: ArrayBuffer): Message => JSON.parse(new TextDecoder().decode(frame));
const welcome: Message = {
  Welcome: { history_epoch: 1, server_version_vector: [], payload: { delta: { update: [] } } },
};

class Socket {
  static OPEN = 1;
  static CLOSING = 2;
  static instances: Socket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Message[] = [];
  constructor() {
    Socket.instances.push(this);
  }
  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }
  receive(message: Message) {
    this.onmessage?.({ data: wire(message) });
  }
  send(frame: ArrayBuffer) {
    this.sent.push(decode(frame));
  }
  // Deliberately never finishes closing: recovery must detach the old socket.
  close() {
    this.readyState = Socket.CLOSING;
  }
  serverClose() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, wasClean: true });
  }
}
const agents: SyncAgent[] = [];
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
  vi.stubGlobal("WebSocket", Socket);
  Socket.instances = [];
  writeAuthSession("remote", {
    principal: "account",
    username: "writer",
    token: "opaque",
    expires_at: Date.now() / 1000 + 3600,
    persistence: "session",
  });
});
afterEach(() => {
  for (const agent of agents.splice(0)) agent.stop();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start() {
  const port = {
    syncState: vi.fn(async () => ({
      version_vector: [],
      pending: 0,
      replica_id: 1,
      history_epoch: 1,
      has_server_base: true,
    })),
    nextSyncFrame: vi.fn<SyncAgentPort["nextSyncFrame"]>(async () => null),
    acknowledgeOutbox: vi.fn(async () => {}),
    encodeSyncMessage: vi.fn(async (message: Message) => wire(message)),
    decodeSyncMessage: vi.fn(async (frame: ArrayBuffer) => decode(frame)),
  };
  const delegate = {
    changed: vi.fn(),
    applyRemote: vi.fn(async () => {}),
    replaceRemote: vi.fn(async () => {}),
  };
  const agent = new SyncAgent(
    "graph",
    "handle",
    "session",
    {
      repository_id: "remote",
      server_url: "https://sync.example.test",
      account_id: "account",
      username: "writer",
    },
    port,
    delegate,
  );
  agents.push(agent);
  agent.start();
  await settle();
  return { agent, port, delegate, socket: Socket.instances[0] };
}

it("replaces a connection that never opens", async () => {
  const { socket, delegate } = await start();
  await vi.advanceTimersByTimeAsync(61_000);
  expect(socket.readyState).toBe(Socket.CLOSING);
  expect(Socket.instances).toHaveLength(2);
  expect(delegate.changed).toHaveBeenCalledWith(expect.objectContaining({ live: "offline" }));
});

it("sends heartbeats and reconnects a silently dead socket", async () => {
  const { socket } = await start();
  socket.open();
  await settle();
  socket.receive(welcome);
  await settle();
  await vi.advanceTimersByTimeAsync(11_000);
  expect(socket.sent.some((message) => "Heartbeat" in message)).toBe(true);
  await vi.advanceTimersByTimeAsync(50_000);
  expect(Socket.instances).toHaveLength(2);
});

it("retries an unacknowledged update even when heartbeats still arrive", async () => {
  const { port, socket } = await start();
  port.nextSyncFrame.mockResolvedValue({
    message_id: "pending",
    frame: wire({ Heartbeat: { nonce: 99 } }),
  });
  socket.open();
  await settle();
  socket.receive(welcome);
  await settle();
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(9_000);
    socket.receive({ Heartbeat: { nonce: i } });
    await settle();
  }
  await vi.advanceTimersByTimeAsync(7_000);
  expect(Socket.instances).toHaveLength(2);
  expect(port.acknowledgeOutbox).not.toHaveBeenCalled();
});

it("does not let old decoding block or mutate a new connection", async () => {
  const { port, socket, delegate } = await start();
  socket.open();
  await settle();
  let release!: (message: Message) => void;
  port.decodeSyncMessage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  socket.receive({
    Welcome: { history_epoch: 1, server_version_vector: [], payload: { delta: { update: [9] } } },
  });
  await settle();
  window.dispatchEvent(new Event("online"));
  await settle();
  const next = Socket.instances[1];
  next.open();
  await settle();
  next.receive(welcome);
  await settle();
  expect(delegate.changed).toHaveBeenLastCalledWith(expect.objectContaining({ live: "live" }));
  release({
    Welcome: { history_epoch: 1, server_version_vector: [], payload: { delta: { update: [9] } } },
  });
  await settle();
  expect(delegate.applyRemote).not.toHaveBeenCalled();
});

it("ignores acknowledgements from another history epoch", async () => {
  const { port, socket } = await start();
  port.nextSyncFrame.mockResolvedValue({
    message_id: "pending",
    frame: wire({ Heartbeat: { nonce: 99 } }),
  });
  socket.open();
  await settle();
  socket.receive(welcome);
  await settle();
  socket.receive({ Ack: { history_epoch: 0, message_id: "pending", server_cursor: 1 } });
  await settle();
  expect(port.acknowledgeOutbox).not.toHaveBeenCalled();
  socket.receive({ Ack: { history_epoch: 1, message_id: "pending", server_cursor: 2 } });
  await settle();
  expect(port.acknowledgeOutbox).toHaveBeenCalledWith("handle", "pending");
});

it("pauses incompatible history without an automatic replacement loop", async () => {
  const { port, socket, delegate } = await start();
  delegate.replaceRemote.mockRejectedValue(
    new CorePortFailure({ code: "resync_required", message: "preserved", retryable: false }),
  );
  socket.open();
  await settle();
  socket.receive({
    Welcome: {
      history_epoch: 2,
      server_version_vector: [],
      payload: { replace_inline: { checkpoint: [1] } },
    },
  });
  await settle();
  expect(delegate.changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ live: "paused", sync: { kind: "paused", reason: "history" } }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  window.dispatchEvent(new Event("online"));
  await settle();
  expect(Socket.instances).toHaveLength(1);
  expect(port.nextSyncFrame).not.toHaveBeenCalled();
});

it("processes a terminal error received immediately before the server closes", async () => {
  const { port, socket, delegate } = await start();
  socket.open();
  await settle();
  let release!: (message: Message) => void;
  port.decodeSyncMessage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const error: Message = {
    Error: { code: "membership_revoked", diagnostic: "revoked", recoverable: false },
  };
  socket.receive(error);
  await settle();
  socket.serverClose();
  release(error);
  await settle();
  expect(delegate.changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ live: "paused", sync: { kind: "paused", reason: "revoked" } }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  expect(Socket.instances).toHaveLength(1);
});

it("bounds the wait for decoding after a server close", async () => {
  const { port, socket } = await start();
  socket.open();
  await settle();
  port.decodeSyncMessage.mockImplementationOnce(() => new Promise(() => {}));
  socket.receive(welcome);
  await settle();
  socket.serverClose();
  await vi.advanceTimersByTimeAsync(61_000);
  expect(Socket.instances).toHaveLength(2);
});
