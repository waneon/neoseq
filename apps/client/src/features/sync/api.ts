import type { AuthSession } from "./auth";

export type RemoteRole = "owner" | "editor" | "viewer";

export interface RemoteGraphMembership {
  account_id: string;
  username: string;
  role: RemoteRole;
  version: number;
}

export interface RemoteGraphListing {
  graph_id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  role: RemoteRole;
  status: "active" | "read_only";
  membership_version: number;
}

export class RemoteApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CreatedRemoteGraph {
  graph_id: string;
  history_epoch: number;
  checkpoint_checksum: string;
}

async function request<T>(
  serverUrl: string,
  auth: AuthSession,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(new URL(path, `${serverUrl}/`), {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new RemoteApiError(response.status, body || `remote request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function createRemoteGraph(
  serverUrl: string,
  auth: AuthSession,
  name: string,
  graphId = `g-${crypto.randomUUID()}`,
): Promise<CreatedRemoteGraph> {
  return request(serverUrl, auth, "/v1/graphs", {
    method: "POST",
    body: JSON.stringify({ graph_id: graphId, name }),
  });
}

export async function createSeededRemoteGraph(
  serverUrl: string,
  auth: AuthSession,
  graphId: string,
  name: string,
  checkpoint: ArrayBuffer,
  checkpointChecksum: string,
): Promise<CreatedRemoteGraph> {
  const body = new FormData();
  body.append("graph_id", graphId);
  body.append("name", name);
  body.append("checkpoint_checksum", checkpointChecksum);
  body.append("checkpoint", new Blob([checkpoint]), "graph.loro");
  const response = await fetch(new URL("/v1/graphs/import", `${serverUrl}/`), {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.token}` },
    body,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new RemoteApiError(
      response.status,
      message || `remote request failed (${response.status})`,
    );
  }
  return response.json() as Promise<CreatedRemoteGraph>;
}

export function listRemoteGraphs(
  serverUrl: string,
  auth: AuthSession,
  signal?: AbortSignal,
): Promise<{ graphs: RemoteGraphListing[] }> {
  return request(serverUrl, auth, "/v1/graphs", { signal });
}

export function listMemberships(
  serverUrl: string,
  auth: AuthSession,
  graphId: string,
): Promise<{ memberships: RemoteGraphMembership[] }> {
  return request(serverUrl, auth, `/v1/graphs/${encodeURIComponent(graphId)}/members`);
}

export function grantMembership(
  serverUrl: string,
  auth: AuthSession,
  graphId: string,
  username: string,
  role: Exclude<RemoteRole, "owner">,
): Promise<void> {
  return request(
    serverUrl,
    auth,
    `/v1/graphs/${encodeURIComponent(graphId)}/members/${encodeURIComponent(username)}`,
    {
      method: "PUT",
      body: JSON.stringify({ role }),
    },
  );
}

export function revokeMembership(
  serverUrl: string,
  auth: AuthSession,
  graphId: string,
  username: string,
): Promise<void> {
  return request(
    serverUrl,
    auth,
    `/v1/graphs/${encodeURIComponent(graphId)}/members/${encodeURIComponent(username)}`,
    {
      method: "DELETE",
    },
  );
}
