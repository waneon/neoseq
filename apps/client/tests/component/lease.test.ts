import { FakeCorePort } from "../../src/core-port/testing/fake-core-port";
import { GraphSession } from "../../src/core-port/session";

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

    const discardedPort = new FakeCorePort();
    const discardedOpen = vi.spyOn(discardedPort, "openGraph");
    const discarded = new GraphSession("test-graph", discardedPort);
    const firstOpen = discarded.open();
    const firstClose = discarded.close();

    const activePort = new FakeCorePort();
    const active = new GraphSession("test-graph", activePort);
    const secondOpen = active.open();

    await Promise.all([firstOpen, firstClose, secondOpen]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(discardedOpen).not.toHaveBeenCalled();
    expect(active.getState()).toMatchObject({ status: "ready", mode: "exclusive" });

    await active.close();
  });

  it("never reuses a runtime peer id after a tab session closes", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const firstPort = new FakeCorePort();
    const firstOpen = vi.spyOn(firstPort, "openGraph");
    const first = new GraphSession("peer-identity", firstPort);
    await first.open();
    await first.close();

    const secondPort = new FakeCorePort();
    const secondOpen = vi.spyOn(secondPort, "openGraph");
    const second = new GraphSession("peer-identity", secondPort);
    await second.open();

    expect(firstOpen.mock.calls[0][0].peer_id).not.toBe(secondOpen.mock.calls[0][0].peer_id);
    await second.close();
  });
});
