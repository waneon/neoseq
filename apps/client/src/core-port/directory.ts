// Local graph directory. Canonical note data lives in the core-owned
// repository; the directory only keeps app-level bookkeeping (display
// names) plus the list of locally stored graphs reported by the Worker.

import { CoreWorker } from "../core-worker";

export interface GraphSummary {
  id: string;
  name: string;
  created_at: string;
  kind: "local" | "remote";
}

export interface RemoteGraphConnection {
  server_url: string;
}

interface DirectoryEntry {
  name: string;
  created_at: string;
  kind?: "local" | "remote";
  remote?: RemoteGraphConnection;
}

const DIRECTORY_KEY = "neoseq.graph-directory.v1";

function readEntries(): Record<string, DirectoryEntry> {
  try {
    const raw = localStorage.getItem(DIRECTORY_KEY);
    return raw ? (JSON.parse(raw) as Record<string, DirectoryEntry>) : {};
  } catch {
    return {};
  }
}

function writeEntries(entries: Record<string, DirectoryEntry>): void {
  localStorage.setItem(DIRECTORY_KEY, JSON.stringify(entries));
  for (const listener of listeners) listener();
}

/**
 * The directory is read in two places at once — the rail and the settings dialog
 * that renames from — so a rename has to publish. Without this the rail kept the
 * old name until the next remount, with the new one visible beside it.
 */
const listeners = new Set<() => void>();

export function subscribeGraphDirectory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerGraph(name: string): GraphSummary {
  const entries = readEntries();
  const id = `g-${crypto.randomUUID()}`;
  const created_at = new Date().toISOString();
  entries[id] = { name: name.trim(), created_at };
  writeEntries(entries);
  return { id, name: name.trim(), created_at, kind: "local" };
}

export function registerRemoteGraph(
  id: string,
  name: string,
  serverUrl: string,
): GraphSummary {
  const entries = readEntries();
  const created_at = new Date().toISOString();
  entries[id] = {
    name: name.trim(),
    created_at,
    kind: "remote",
    remote: { server_url: normalizeServerUrl(serverUrl) },
  };
  writeEntries(entries);
  return { id, name: name.trim(), created_at, kind: "remote" };
}

export function renameGraph(id: string, name: string): void {
  const entries = readEntries();
  entries[id] = {
    ...entries[id],
    name: name.trim(),
    created_at: entries[id]?.created_at ?? new Date().toISOString(),
  };
  writeEntries(entries);
}

export function graphName(id: string): string {
  return readEntries()[id]?.name ?? id;
}

export function graphConnection(id: string): RemoteGraphConnection | null {
  const entry = readEntries()[id];
  return entry?.kind === "remote" && entry.remote ? entry.remote : null;
}

/** Union of stored graphs (Worker metadata) and registered names. */
export async function listGraphs(): Promise<GraphSummary[]> {
  const entries = readEntries();
  const worker = new CoreWorker();
  try {
    const stored = await worker.listGraphs();
    const summaries = new Map<string, GraphSummary>();
    for (const metadata of stored) {
      summaries.set(metadata.graph_id, {
        id: metadata.graph_id,
        name: entries[metadata.graph_id]?.name ?? metadata.graph_id,
        created_at: entries[metadata.graph_id]?.created_at ?? metadata.created_at,
        kind: entries[metadata.graph_id]?.kind ?? "local",
      });
    }
    for (const [id, entry] of Object.entries(entries)) {
      if (!summaries.has(id)) {
        summaries.set(id, {
          id,
          name: entry.name,
          created_at: entry.created_at,
          kind: entry.kind ?? "local",
        });
      }
    }
    return [...summaries.values()].sort((left, right) =>
      left.created_at.localeCompare(right.created_at),
    );
  } finally {
    worker.terminate();
  }
}


function normalizeServerUrl(value: string): string {
  const url = new URL(value || window.location.origin, window.location.origin);
  return url.toString().replace(/\/$/, "");
}

export async function deleteGraph(id: string): Promise<void> {
  // Wait for the graph lease so an open session finishes its clean close
  // (checkpoint + compaction) before the stored data is removed.
  await withGraphLease(id, async () => {
    const worker = new CoreWorker();
    try {
      await worker.deleteGraph(id);
    } finally {
      worker.terminate();
    }
  });
  const entries = readEntries();
  delete entries[id];
  writeEntries(entries);
}

async function withGraphLease(id: string, action: () => Promise<void>): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    await action();
    return;
  }
  await navigator.locks.request(`neoseq:graph:${id}`, action);
}

const PENDING_DELETE_KEY = "neoseq.pending-delete.v1";

/** Records a deletion to run once the owning session has closed. */
export function schedulePendingDelete(id: string): void {
  sessionStorage.setItem(PENDING_DELETE_KEY, id);
}

export async function processPendingDelete(): Promise<void> {
  const id = sessionStorage.getItem(PENDING_DELETE_KEY);
  if (!id) return;
  sessionStorage.removeItem(PENDING_DELETE_KEY);
  await deleteGraph(id);
}
