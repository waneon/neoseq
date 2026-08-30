import { useCallback, useEffect, useRef, useState } from "react";
import { listGraphs, registerRemoteCatalog, type GraphSummary } from "../../core-port/directory";
import type { Repository } from "../repositories/directory";
import { listRemoteGraphs, RemoteApiError } from "../sync/api";
import { clearAuthSession, readAuthSession } from "../sync/auth";

export type RepositoryCatalogStatus = "idle" | "loading" | "auth" | "ready" | "failed";

export interface RepositoryCatalog {
  status: RepositoryCatalogStatus;
  graphs: GraphSummary[];
  stale: boolean;
  refreshing: boolean;
}

export type RepositoryCatalogs = Record<string, RepositoryCatalog>;

const EMPTY_CATALOG: RepositoryCatalog = {
  status: "idle",
  graphs: [],
  stale: false,
  refreshing: false,
};

export function repositoryCatalog(
  catalogs: RepositoryCatalogs,
  repositoryId: string | undefined,
): RepositoryCatalog {
  if (!repositoryId) return EMPTY_CATALOG;
  return catalogs[repositoryId] ?? EMPTY_CATALOG;
}

async function loadRepositoryCatalog(
  repository: Repository,
  signal: AbortSignal,
): Promise<RepositoryCatalog> {
  if (repository.kind === "local") {
    const graphs = await listGraphs(repository.id);
    signal.throwIfAborted();
    return { status: "ready", graphs, stale: false, refreshing: false };
  }

  const auth = readAuthSession(repository.id);
  if (!auth) return { status: "auth", graphs: [], stale: false, refreshing: false };

  const cached = await listGraphs(repository.id);
  signal.throwIfAborted();
  const cachedIds = new Set(cached.filter((graph) => graph.cached).map((graph) => graph.id));

  try {
    const { graphs } = await listRemoteGraphs(repository.origin, auth, signal);
    signal.throwIfAborted();
    const summaries = graphs
      .map((graph) => ({
        id: graph.graph_id,
        repository_id: repository.id,
        name: graph.display_name,
        created_at: graph.created_at,
        kind: "remote" as const,
        cached: cachedIds.has(graph.graph_id),
        role: graph.role,
        status: graph.status,
      }))
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    registerRemoteCatalog(repository.id, summaries);
    return { status: "ready", graphs: summaries, stale: false, refreshing: false };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RemoteApiError && error.status === 401) {
      clearAuthSession(repository.id);
      return { status: "auth", graphs: [], stale: false, refreshing: false };
    }
    const replicas = cached.filter((graph) => graph.cached);
    if (replicas.length === 0) throw error;
    return { status: "ready", graphs: replicas, stale: true, refreshing: false };
  }
}

export function useRepositoryCatalogs(selected: Repository | undefined, enabled: boolean) {
  const [catalogs, setCatalogs] = useState<RepositoryCatalogs>({});
  const requests = useRef(new Map<string, AbortController>());

  const cancel = useCallback((repositoryId: string) => {
    const request = requests.current.get(repositoryId);
    request?.abort();
    requests.current.delete(repositoryId);
  }, []);

  const refresh = useCallback(
    (repository: Repository) => {
      cancel(repository.id);
      const controller = new AbortController();
      requests.current.set(repository.id, controller);
      setCatalogs((current) => {
        const previous = current[repository.id];
        return {
          ...current,
          [repository.id]:
            previous?.status === "ready" || previous?.graphs.length
              ? { ...previous, refreshing: true }
              : { ...EMPTY_CATALOG, status: "loading" },
        };
      });

      void loadRepositoryCatalog(repository, controller.signal)
        .then((catalog) => {
          if (controller.signal.aborted || requests.current.get(repository.id) !== controller)
            return;
          setCatalogs((current) => ({ ...current, [repository.id]: catalog }));
        })
        .catch(() => {
          if (controller.signal.aborted || requests.current.get(repository.id) !== controller)
            return;
          setCatalogs((current) => {
            const previous = current[repository.id];
            return {
              ...current,
              [repository.id]: previous?.graphs.length
                ? { ...previous, status: "failed", refreshing: false }
                : { ...EMPTY_CATALOG, status: "failed" },
            };
          });
        })
        .finally(() => {
          if (requests.current.get(repository.id) === controller) {
            requests.current.delete(repository.id);
          }
        });
    },
    [cancel],
  );

  useEffect(() => {
    if (!enabled || !selected) return;
    refresh(selected);
    return () => cancel(selected.id);
  }, [cancel, enabled, refresh, selected]);

  useEffect(
    () => () => {
      for (const request of requests.current.values()) request.abort();
      requests.current.clear();
    },
    [],
  );

  const refreshSelected = useCallback(() => {
    if (selected) refresh(selected);
  }, [refresh, selected]);

  return { catalogs, refreshSelected };
}
