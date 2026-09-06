import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  repositoryCatalog,
  useRepositoryCatalogs,
} from "../../src/features/graphs/useRepositoryCatalogs";
import type { Repository } from "../../src/features/repositories/directory";

const mocks = vi.hoisted(() => ({
  listGraphs: vi.fn(),
  listRemoteGraphs: vi.fn(),
  readAuthSession: vi.fn(),
  registerRemoteCatalog: vi.fn(),
}));
vi.mock("../../src/core-port/directory", () => ({
  listGraphs: mocks.listGraphs,
  registerRemoteCatalog: mocks.registerRemoteCatalog,
}));
vi.mock("../../src/features/sync/api", async (original) => ({
  ...(await original<typeof import("../../src/features/sync/api")>()),
  listRemoteGraphs: mocks.listRemoteGraphs,
}));
vi.mock("../../src/features/sync/auth", () => ({
  readAuthSession: mocks.readAuthSession,
  clearAuthSession: vi.fn(),
}));

const local: Repository = { id: "local", kind: "local" };
const remote: Repository = {
  id: "remote",
  kind: "remote",
  origin: "https://notes.example.test",
  account_id: "owner",
  username: "owner",
  created_at: "2026-01-01",
};

describe("repository catalog switching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listGraphs.mockResolvedValue([]);
    mocks.readAuthSession.mockReturnValue(null);
  });

  it("keeps the sign-in panel stable when returning to an unauthenticated repository", async () => {
    const states: string[] = [];
    const { result, rerender } = renderHook(
      ({ selected }: { selected: Repository }) => {
        const catalogs = useRepositoryCatalogs(selected);
        if (selected === remote)
          states.push(repositoryCatalog(catalogs.catalogs, remote.id).status);
        return catalogs;
      },
      { initialProps: { selected: remote } },
    );
    await waitFor(() => expect(result.current.catalogs.remote.status).toBe("auth"));
    rerender({ selected: local });
    await waitFor(() => expect(result.current.catalogs.local.status).toBe("ready"));
    states.length = 0;
    await act(async () => rerender({ selected: remote }));
    expect(states).not.toHaveLength(0);
    expect(states.every((status) => status === "auth")).toBe(true);
  });

  it("finishes an in-flight catalog after switching away and preserves it on return", async () => {
    mocks.readAuthSession.mockReturnValue({ token: "session" });
    let complete!: (value: { graphs: [] }) => void;
    mocks.listRemoteGraphs.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ selected }: { selected: Repository }) => useRepositoryCatalogs(selected),
      { initialProps: { selected: remote } },
    );
    await waitFor(() => expect(mocks.listRemoteGraphs).toHaveBeenCalledTimes(1));
    const signal = mocks.listRemoteGraphs.mock.calls[0][2] as AbortSignal;
    rerender({ selected: local });
    expect(signal.aborted).toBe(false);
    rerender({ selected: remote });
    expect(signal.aborted).toBe(false);
    expect(mocks.listRemoteGraphs).toHaveBeenCalledTimes(1);
    rerender({ selected: local });
    await act(async () => complete({ graphs: [] }));
    expect(result.current.catalogs.remote.status).toBe("ready");
    mocks.listRemoteGraphs.mockReturnValue(new Promise(() => {}));
    rerender({ selected: remote });
    expect(result.current.catalogs.remote.status).toBe("ready");
    expect(result.current.catalogs.remote.refreshing).toBe(true);
  });
});
