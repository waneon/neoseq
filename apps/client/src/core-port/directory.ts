// The graph directory owns client-local catalog metadata and the mapping from a
// repository-qualified graph reference to its durable browser replica. Canonical
// note data remains in the Worker-owned repository.

import { withGraphLease } from "./lease";
import { CoreWorker, type PreparedGraphArchive } from "../core-worker";
import { CORE_PORT_VERSION, type GraphLocatorDto } from "../generated/core-port";
import { LOCAL_REPOSITORY_ID, findRepository } from "../features/repositories/directory";
import { randomUUID } from "@/lib/crypto";

export type GraphRef = GraphLocatorDto;

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

export interface PreparedGraphImport extends PreparedGraphArchive {
  repository_id: string;
  name: string;
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

/** One key per graph: tabs registering or renaming different graphs at once
 * write different keys and cannot overwrite each other's entries. */
const ENTRY_PREFIX = "neoseq.graph-directory.v3:";
const SHARED_DIRECTORY_KEY = "neoseq.graph-directory.v2";
const LEGACY_DIRECTORY_KEY = "neoseq.graph-directory.v1";

function entryKey(ref: GraphRef): string {
  return JSON.stringify([ref.repository_id, ref.graph_id]);
}

/** Moves the earlier single-key directories into per-graph keys once. */
function splitSharedDirectory(): void {
  const shared = localStorage.getItem(SHARED_DIRECTORY_KEY);
  const legacy = localStorage.getItem(LEGACY_DIRECTORY_KEY);
  if (shared === null && legacy === null) return;
  const entries: DirectoryEntry[] = [];
  if (shared !== null) {
    entries.push(...Object.values(JSON.parse(shared) as Record<string, DirectoryEntry>));
  } else {
    const old = JSON.parse(legacy!) as Record<
      string,
      { name: string; created_at: string; kind?: "local" | "remote" }
    >;
    for (const [graphId, entry] of Object.entries(old)) {
      // Old remote connections were origin-scoped and cannot be assigned to a
      // repository account safely. Their durable replicas remain discoverable
      // from Worker metadata; only trustworthy local display names migrate.
      if (entry.kind === "remote") continue;
      entries.push({
        repository_id: LOCAL_REPOSITORY_ID,
        graph_id: graphId,
        name: entry.name,
        created_at: entry.created_at,
      });
    }
  }
  for (const entry of entries) {
    const key = ENTRY_PREFIX + entryKey(entry);
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(entry));
  }
  localStorage.removeItem(SHARED_DIRECTORY_KEY);
  localStorage.removeItem(LEGACY_DIRECTORY_KEY);
}

function readEntries(): Record<string, DirectoryEntry> {
  const entries: Record<string, DirectoryEntry> = {};
  try {
    splitSharedDirectory();
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(ENTRY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (raw) entries[key.slice(ENTRY_PREFIX.length)] = JSON.parse(raw) as DirectoryEntry;
    }
  } catch {
    // An unreadable directory names graphs by ID; their replicas remain.
  }
  return entries;
}

function readEntry(ref: GraphRef): DirectoryEntry | undefined {
  try {
    splitSharedDirectory();
    const raw = localStorage.getItem(ENTRY_PREFIX + entryKey(ref));
    return raw ? (JSON.parse(raw) as DirectoryEntry) : undefined;
  } catch {
    return undefined;
  }
}

function writeEntries(entries: readonly DirectoryEntry[]): void {
  for (const entry of entries) {
    localStorage.setItem(ENTRY_PREFIX + entryKey(entry), JSON.stringify(entry));
  }
  for (const listener of listeners) listener();
}

function removeEntry(ref: GraphRef): void {
  localStorage.removeItem(ENTRY_PREFIX + entryKey(ref));
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

export function subscribeGraphDirectory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && !event.key.startsWith(ENTRY_PREFIX)) return;
    for (const listener of listeners) listener();
  });
}

export function registerGraph(name: string): GraphSummary {
  const id = `g-${randomUUID()}`;
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
  writeEntries(
    graphs.map((graph) => ({
      repository_id: repositoryId,
      graph_id: graph.id,
      name: graph.name.trim(),
      created_at: graph.created_at,
      role: graph.role,
      status: graph.status,
    })),
  );
}

function registerGraphEntry(
  repositoryId: string,
  id: string,
  name: string,
  createdAt: string,
  access?: Pick<GraphSummary, "role" | "status">,
): GraphSummary {
  writeEntries([
    {
      repository_id: repositoryId,
      graph_id: id,
      name: name.trim(),
      created_at: createdAt,
      ...access,
    },
  ]);
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
  const ref = { repository_id: repositoryId, graph_id: id };
  const existing = readEntry(ref);
  writeEntries([
    {
      ...existing,
      ...ref,
      name: name.trim(),
      created_at: existing?.created_at ?? new Date().toISOString(),
    },
  ]);
}

export function graphName(id: string): string;
export function graphName(repositoryId: string, id: string): string;
export function graphName(first: string, second?: string): string {
  const ref = {
    repository_id: second === undefined ? LOCAL_REPOSITORY_ID : first,
    graph_id: second === undefined ? first : second,
  };
  return readEntry(ref)?.name ?? ref.graph_id;
}

export function graphConnection(
  repositoryId: string,
  graphId: string,
): RemoteGraphConnection | null {
  const repository = findRepository(repositoryId);
  if (repository?.kind !== "remote") return null;
  const entry = readEntry({ repository_id: repositoryId, graph_id: graphId });
  return {
    repository_id: repository.id,
    server_url: repository.origin,
    account_id: repository.account_id,
    username: repository.username,
    role: entry?.role,
    status: entry?.status,
  };
}

/** Whether this browser holds the local graph, by its directory entry or its stored data. */
export async function localGraphExists(id: string): Promise<boolean> {
  if (readEntry({ repository_id: LOCAL_REPOSITORY_ID, graph_id: id })) return true;
  const worker = new CoreWorker();
  try {
    return (await worker.listGraphs()).some(
      (metadata) =>
        (metadata.locator.repository_id || LOCAL_REPOSITORY_ID) === LOCAL_REPOSITORY_ID &&
        metadata.locator.graph_id === id,
    );
  } finally {
    worker.terminate();
  }
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
      await worker.deleteGraph(ref);
    } finally {
      worker.terminate();
    }
  });
  removeEntry(ref);
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
        locator: ref,
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
  graphId = `g-${randomUUID()}`,
): Promise<GraphSummary> {
  const prepared = await prepareGraphArchive(bytes, fallbackName, repositoryId, graphId);
  return installPreparedGraph(prepared);
}

export async function prepareGraphArchive(
  bytes: ArrayBuffer,
  fallbackName: string,
  repositoryId = LOCAL_REPOSITORY_ID,
  graphId = `g-${randomUUID()}`,
): Promise<PreparedGraphImport> {
  const worker = new CoreWorker();
  try {
    const prepared = await worker.prepareArchive(bytes, {
      repository_id: repositoryId,
      graph_id: graphId,
    });
    return {
      ...prepared,
      repository_id: repositoryId,
      name: prepared.suggested_name?.trim() || fallbackName.trim(),
    };
  } finally {
    worker.terminate();
  }
}

export async function installPreparedGraph(
  prepared: PreparedGraphImport,
  serverBase?: Pick<GraphSummary, "role" | "status"> & { history_epoch: number },
): Promise<GraphSummary> {
  const worker = new CoreWorker();
  try {
    await worker.installArchive(
      prepared,
      { repository_id: prepared.repository_id, graph_id: prepared.graph_id },
      serverBase?.history_epoch ?? 0,
      serverBase !== undefined,
    );
    return registerGraphEntry(
      prepared.repository_id,
      prepared.graph_id,
      prepared.name,
      prepared.created_at,
      serverBase,
    );
  } finally {
    worker.terminate();
  }
}

function randomPeerId(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (words[0] & 0x1f_ffff) * 0x1_0000_0000 + words[1];
}
