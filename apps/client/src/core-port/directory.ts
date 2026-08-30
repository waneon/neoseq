// The graph directory owns client-local catalog metadata and the mapping from a
// repository-qualified graph reference to its durable browser replica. Canonical
// note data remains in the Worker-owned repository.

import { CoreWorker } from "../core-worker";
import { CORE_PORT_VERSION, type GraphLocatorDto } from "../generated/core-port";
import { LOCAL_REPOSITORY_ID, findRepository } from "../features/repositories/directory";

export interface GraphRef {
  repository_id: string;
  graph_id: string;
}

export interface GraphSummary {
  id: string;
  repository_id: string;
  name: string;
  created_at: string;
  kind: "local" | "remote";
  cached?: boolean;
  role?: "owner" | "editor" | "viewer";
  status?: "active" | "read_only";
}

export interface RemoteGraphConnection {
  repository_id: string;
  server_url: string;
  account_id: string;
  username: string;
  role?: "owner" | "editor" | "viewer";
  status?: "active" | "read_only";
}

interface DirectoryEntry {
  repository_id: string;
  graph_id: string;
  name: string;
  created_at: string;
  role?: "owner" | "editor" | "viewer";
  status?: "active" | "read_only";
}

const DIRECTORY_KEY = "neoseq.graph-directory.v2";
const LEGACY_DIRECTORY_KEY = "neoseq.graph-directory.v1";

function entryKey(ref: GraphRef): string {
  return JSON.stringify([ref.repository_id, ref.graph_id]);
}

function locator(ref: GraphRef): GraphLocatorDto {
  return { repository_id: ref.repository_id, graph_id: ref.graph_id };
}

function readEntries(): Record<string, DirectoryEntry> {
  try {
    const raw = localStorage.getItem(DIRECTORY_KEY);
    if (raw) return JSON.parse(raw) as Record<string, DirectoryEntry>;
    const legacyRaw = localStorage.getItem(LEGACY_DIRECTORY_KEY);
    if (!legacyRaw) return {};
    const legacy = JSON.parse(legacyRaw) as Record<
      string,
      { name: string; created_at: string; kind?: "local" | "remote" }
    >;
    const migrated: Record<string, DirectoryEntry> = {};
    for (const [graphId, entry] of Object.entries(legacy)) {
      // Old remote connections were origin-scoped and cannot be assigned to a
      // repository account safely. Their durable replicas remain discoverable
      // from Worker metadata; only trustworthy local display names migrate.
      if (entry.kind === "remote") continue;
      const next: DirectoryEntry = {
        repository_id: LOCAL_REPOSITORY_ID,
        graph_id: graphId,
        name: entry.name,
        created_at: entry.created_at,
      };
      migrated[entryKey(next)] = next;
    }
    localStorage.setItem(DIRECTORY_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return {};
  }
}

function writeEntries(entries: Record<string, DirectoryEntry>): void {
  localStorage.setItem(DIRECTORY_KEY, JSON.stringify(entries));
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

export function subscribeGraphDirectory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== DIRECTORY_KEY) return;
    for (const listener of listeners) listener();
  });
}

export function registerGraph(name: string): GraphSummary {
  const id = `g-${crypto.randomUUID()}`;
  return registerGraphEntry(LOCAL_REPOSITORY_ID, id, name, new Date().toISOString());
}

export function registerRemoteGraph(
  repositoryId: string,
  id: string,
  name: string,
  createdAt = new Date().toISOString(),
  access?: Pick<GraphSummary, "role" | "status">,
): GraphSummary {
  return registerGraphEntry(repositoryId, id, name, createdAt, access);
}

export function registerRemoteCatalog(
  repositoryId: string,
  graphs: ReadonlyArray<Pick<GraphSummary, "id" | "name" | "created_at" | "role" | "status">>,
): void {
  const entries = readEntries();
  for (const graph of graphs) {
    const ref = { repository_id: repositoryId, graph_id: graph.id };
    entries[entryKey(ref)] = {
      ...ref,
      name: graph.name.trim(),
      created_at: graph.created_at,
      role: graph.role,
      status: graph.status,
    };
  }
  writeEntries(entries);
}

function registerGraphEntry(
  repositoryId: string,
  id: string,
  name: string,
  createdAt: string,
  access?: Pick<GraphSummary, "role" | "status">,
): GraphSummary {
  const entries = readEntries();
  const ref = { repository_id: repositoryId, graph_id: id };
  entries[entryKey(ref)] = {
    ...ref,
    name: name.trim(),
    created_at: createdAt,
    ...access,
  };
  writeEntries(entries);
  return {
    id,
    repository_id: repositoryId,
    name: name.trim(),
    created_at: createdAt,
    kind: repositoryId === LOCAL_REPOSITORY_ID ? "local" : "remote",
    ...access,
  };
}

export function renameGraph(id: string, name: string): void;
export function renameGraph(repositoryId: string, id: string, name: string): void;
export function renameGraph(first: string, second: string, third?: string): void {
  const repositoryId = third === undefined ? LOCAL_REPOSITORY_ID : first;
  const id = third === undefined ? first : second;
  const name = third === undefined ? second : third;
  const entries = readEntries();
  const ref = { repository_id: repositoryId, graph_id: id };
  const key = entryKey(ref);
  entries[key] = {
    ...entries[key],
    ...ref,
    name: name.trim(),
    created_at: entries[key]?.created_at ?? new Date().toISOString(),
  };
  writeEntries(entries);
}

export function graphName(id: string): string;
export function graphName(repositoryId: string, id: string): string;
export function graphName(first: string, second?: string): string {
  const ref = {
    repository_id: second === undefined ? LOCAL_REPOSITORY_ID : first,
    graph_id: second === undefined ? first : second,
  };
  return readEntries()[entryKey(ref)]?.name ?? ref.graph_id;
}

export function graphConnection(
  repositoryId: string,
  graphId: string,
): RemoteGraphConnection | null {
  const repository = findRepository(repositoryId);
  if (repository?.kind !== "remote") return null;
  const entry = readEntries()[entryKey({ repository_id: repositoryId, graph_id: graphId })];
  return {
    repository_id: repository.id,
    server_url: repository.origin,
    account_id: repository.account_id,
    username: repository.username,
    role: entry?.role,
    status: entry?.status,
  };
}

export async function listGraphs(repositoryId = LOCAL_REPOSITORY_ID): Promise<GraphSummary[]> {
  const entries = readEntries();
  const worker = new CoreWorker();
  try {
    const stored = await worker.listGraphs();
    const summaries = new Map<string, GraphSummary>();
    for (const metadata of stored) {
      const storedRepositoryId = metadata.locator.repository_id || LOCAL_REPOSITORY_ID;
      if (storedRepositoryId !== repositoryId) continue;
      const id = metadata.locator.graph_id;
      const ref = { repository_id: storedRepositoryId, graph_id: id };
      const entry = entries[entryKey(ref)];
      summaries.set(id, {
        id,
        repository_id: storedRepositoryId,
        name: entry?.name ?? id,
        created_at: entry?.created_at ?? metadata.created_at,
        kind: storedRepositoryId === LOCAL_REPOSITORY_ID ? "local" : "remote",
        cached: true,
        role: entry?.role,
        status: entry?.status,
      });
    }
    for (const entry of Object.values(entries)) {
      if (entry.repository_id !== repositoryId || summaries.has(entry.graph_id)) continue;
      summaries.set(entry.graph_id, {
        id: entry.graph_id,
        repository_id: entry.repository_id,
        name: entry.name,
        created_at: entry.created_at,
        kind: entry.repository_id === LOCAL_REPOSITORY_ID ? "local" : "remote",
        cached: false,
        role: entry.role,
        status: entry.status,
      });
    }
    return [...summaries.values()].sort((left, right) =>
      left.created_at.localeCompare(right.created_at),
    );
  } finally {
    worker.terminate();
  }
}

export async function deleteGraph(id: string): Promise<void>;
export async function deleteGraph(repositoryId: string, id: string): Promise<void>;
export async function deleteGraph(first: string, second?: string): Promise<void> {
  const ref = {
    repository_id: second === undefined ? LOCAL_REPOSITORY_ID : first,
    graph_id: second === undefined ? first : second,
  };
  await withGraphLease(ref, async () => {
    const worker = new CoreWorker();
    try {
      await worker.deleteGraph(locator(ref));
    } finally {
      worker.terminate();
    }
  });
  const entries = readEntries();
  delete entries[entryKey(ref)];
  writeEntries(entries);
}

export async function exportGraphArchive(
  repositoryId: string,
  id: string,
  name: string,
): Promise<ArrayBuffer>;
export async function exportGraphArchive(id: string, name: string): Promise<ArrayBuffer>;
export async function exportGraphArchive(
  first: string,
  second: string,
  third?: string,
): Promise<ArrayBuffer> {
  const ref = {
    repository_id: third === undefined ? LOCAL_REPOSITORY_ID : first,
    graph_id: third === undefined ? first : second,
  };
  const name = third === undefined ? second : third;
  return withGraphLease(ref, async () => {
    const worker = new CoreWorker();
    try {
      const opened = await worker.openGraph({
        contract_version: CORE_PORT_VERSION,
        locator: locator(ref),
        peer_id: randomPeerId(),
      });
      return await worker.exportArchive(opened.graph_handle, name);
    } finally {
      worker.terminate();
    }
  });
}

export async function importGraphArchive(
  bytes: ArrayBuffer,
  fallbackName: string,
  repositoryId = LOCAL_REPOSITORY_ID,
  graphId = `g-${crypto.randomUUID()}`,
): Promise<GraphSummary> {
  const worker = new CoreWorker();
  try {
    const imported = await worker.importArchive(bytes, {
      repository_id: repositoryId,
      graph_id: graphId,
    });
    const name = imported.suggested_name?.trim() || fallbackName.trim();
    return registerGraphEntry(repositoryId, imported.graph_id, name, imported.created_at);
  } finally {
    worker.terminate();
  }
}

async function withGraphLease<T>(ref: GraphRef, action: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return action();
  return navigator.locks.request(`neoseq:graph:${ref.repository_id}:${ref.graph_id}`, action);
}

function randomPeerId(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (words[0] & 0x1f_ffff) * 0x1_0000_0000 + words[1];
}

const PENDING_DELETE_KEY = "neoseq.pending-delete.v2";

export function schedulePendingDelete(id: string): void;
export function schedulePendingDelete(repositoryId: string, id: string): void;
export function schedulePendingDelete(first: string, second?: string): void {
  const ref = {
    repository_id: second === undefined ? LOCAL_REPOSITORY_ID : first,
    graph_id: second === undefined ? first : second,
  };
  sessionStorage.setItem(PENDING_DELETE_KEY, JSON.stringify(ref));
}

export async function processPendingDelete(): Promise<void> {
  const raw = sessionStorage.getItem(PENDING_DELETE_KEY);
  if (!raw) return;
  sessionStorage.removeItem(PENDING_DELETE_KEY);
  const ref = JSON.parse(raw) as GraphRef;
  await deleteGraph(ref.repository_id, ref.graph_id);
}
