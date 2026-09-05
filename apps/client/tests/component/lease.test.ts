import { GraphSession } from "../../src/core-port/session";
import { WasmTestPort } from "./wasm-test-port";

/** A fresh module instance stands in for another tab: each tab keeps its own
 * lease table and speaks to the others only over the BroadcastChannel. */
async function anotherTab() {
  vi.resetModules();
  return import("../../src/core-port/lease");
}

describe("graph lease lifecycle", () => {
  const originalLocks = navigator.locks;

  afterEach(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: originalLocks,
    });
  });

  it("hands an exclusive lease to a StrictMode-style replacement session", async () => {
    const request = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<void> | void,
      ) => callback({ name: "neoseq:graph:test-graph", mode: "exclusive" } as Lock),
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    const discardedPort = new WasmTestPort();
    const discardedOpen = vi.spyOn(discardedPort, "openGraph");
    const discarded = new GraphSession("test-graph", discardedPort);
    const firstOpen = discarded.open();
    const firstClose = discarded.close();

    const activePort = new WasmTestPort();
    const active = new GraphSession("test-graph", activePort);
    const secondOpen = active.open();

    await Promise.all([firstOpen, firstClose, secondOpen]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(discardedOpen).not.toHaveBeenCalled();
    expect(active.getState()).toMatchObject({ status: "ready", mode: "exclusive" });

    await active.close();
  });

  it("elects one writable tab over a BroadcastChannel when Web Locks are unavailable", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const first = await anotherTab();
    const second = await anotherTab();
    const third = await anotherTab();

    const holder = await first.acquireLease({ repository_id: "local", graph_id: "elected-graph" });
    expect(holder.mode).toBe("exclusive");
    const reader = await second.acquireLease({ repository_id: "local", graph_id: "elected-graph" });
    expect(reader.mode).toBe("readonly");

    holder.release();
    reader.release();
    const successor = await third.acquireLease({
      repository_id: "local",
      graph_id: "elected-graph",
    });
    expect(successor.mode).toBe("exclusive");
    successor.release();
  });

  it("settles simultaneous claims on exactly one writable tab", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const tabs = [await anotherTab(), await anotherTab(), await anotherTab()];
    const leases = await Promise.all(
      tabs.map((tab) => tab.acquireLease({ repository_id: "local", graph_id: "contended-graph" })),
    );

    expect(leases.filter((lease) => lease.mode === "exclusive")).toHaveLength(1);
    for (const lease of leases) lease.release();
  });

  it("waits for an HTTP editor before running a directory operation and releases on failure", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const editor = await anotherTab();
    const directory = await anotherTab();
    const locator = { repository_id: "remote", graph_id: "directory-wait" };
    const holder = await editor.acquireLease(locator);
    // An existing read-only session in this tab cannot authorize the operation.
    const reader = await directory.acquireLease(locator);
    expect(reader.mode).toBe("readonly");
    const action = vi.fn(async () => {
      throw new Error("export failed");
    });
    const operation = directory.withGraphLease(locator, action);
    const rejected = expect(operation).rejects.toThrow("export failed");
    // A competing acquisition proves that the original editor still holds it.
    const competing = await (await anotherTab()).acquireLease(locator);
    expect(competing.mode).toBe("readonly");
    expect(action).not.toHaveBeenCalled();
    holder.release();
    await rejected;
    expect(action).toHaveBeenCalledTimes(1);
    reader.release();
    competing.release();
    const successor = await editor.acquireLease(locator);
    expect(successor.mode).toBe("exclusive");
    successor.release();
  });

  it("never reuses a runtime peer id after a tab session closes", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const firstPort = new WasmTestPort();
    const firstOpen = vi.spyOn(firstPort, "openGraph");
    const first = new GraphSession("peer-identity", firstPort);
    await first.open();
    await first.close();

    const secondPort = new WasmTestPort();
    const secondOpen = vi.spyOn(secondPort, "openGraph");
    const second = new GraphSession("peer-identity", secondPort);
    await second.open();

    expect(firstOpen.mock.calls[0][0].peer_id).not.toBe(secondOpen.mock.calls[0][0].peer_id);
    await second.close();
  });

  it("retires one open handle once when deletion and route cleanup close together", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const port = new WasmTestPort();
    const closeGraph = vi.spyOn(port, "closeGraph");
    const session = new GraphSession("single-close", port);
    await session.open();

    await Promise.all([session.close(), session.close()]);

    expect(closeGraph).toHaveBeenCalledTimes(1);
    expect(session.getState().status).toBe("closed");
  });
});
