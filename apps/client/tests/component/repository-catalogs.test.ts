import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  repositoryCatalog,
  useRepositoryCatalogs,
} from "../../src/features/graphs/useRepositoryCatalogs";
import type { Repository } from "../../src/features/repositories/directory";
import type { GraphSummary } from "../../src/core-port/directory";
import type { RemoteGraphListing } from "../../src/features/sync/api";

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
    vi.resetAllMocks();
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

  it("keeps populated catalogs during refresh and applies late responses only to their repository", async () => {
    const localGraph: GraphSummary = {
      id: "g-local",
      repository_id: local.id,
      name: "Local notebook",
      created_at: "2026-01-01",
      kind: "local",
      cached: true,
    };
    const listing: RemoteGraphListing = {
      graph_id: "g-remote",
      display_name: "Shared notebook",
      created_at: "2026-01-02",
      updated_at: "2026-01-02",
      role: "owner",
      status: "active",
      membership_version: 1,
    };
    const cached: GraphSummary = {
      id: listing.graph_id,
      repository_id: remote.id,
      name: listing.display_name,
      created_at: listing.created_at,
      kind: "remote",
      cached: true,
      role: "owner",
      status: "active",
    };
    mocks.readAuthSession.mockReturnValue({ token: "session" });
    mocks.listGraphs.mockImplementation(async (repositoryId: string) =>
      repositoryId === local.id ? [localGraph] : [cached],
    );
    let completeInitial!: (value: { graphs: RemoteGraphListing[] }) => void;
    let completeRefresh!: (value: { graphs: RemoteGraphListing[] }) => void;
    const initial = new Promise((resolve) => {
      completeInitial = resolve;
    });
    const refresh = new Promise((resolve) => {
      completeRefresh = resolve;
    });
    const renamed = { ...listing, display_name: "Renamed shared notebook" };
    mocks.listRemoteGraphs
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce(refresh)
      .mockResolvedValue({ graphs: [renamed] });
    const { result, rerender } = renderHook(
      ({ selected }: { selected: Repository }) => {
        const catalogs = useRepositoryCatalogs(selected);
        return { ...catalogs, selectedCatalog: repositoryCatalog(catalogs.catalogs, selected.id) };
      },
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
    await act(async () => completeInitial({ graphs: [listing] }));
    expect(result.current.catalogs.remote.graphs).toEqual([cached]);
    expect(result.current.selectedCatalog.graphs).toEqual([localGraph]);
    expect(mocks.registerRemoteCatalog).toHaveBeenCalledWith(remote.id, [cached]);

    rerender({ selected: remote });
    await waitFor(() => expect(mocks.listRemoteGraphs).toHaveBeenCalledTimes(2));
    expect(result.current.selectedCatalog).toEqual({
      status: "ready",
      graphs: [cached],
      stale: false,
      refreshing: true,
    });
    rerender({ selected: local });
    await act(async () => completeRefresh({ graphs: [renamed] }));
    const updated = { ...cached, name: "Renamed shared notebook" };
    expect(result.current.catalogs.remote).toEqual({
      status: "ready",
      graphs: [updated],
      stale: false,
      refreshing: false,
    });
    expect(result.current.selectedCatalog.graphs).toEqual([localGraph]);
    expect(result.current.catalogs.local.graphs).toEqual([localGraph]);

    rerender({ selected: remote });
    expect(result.current.selectedCatalog.graphs).toEqual([updated]);
    await waitFor(() => expect(result.current.selectedCatalog.refreshing).toBe(false));
    expect(result.current.selectedCatalog.graphs).toEqual([updated]);
  });
});
