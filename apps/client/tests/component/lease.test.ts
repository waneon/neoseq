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
});
