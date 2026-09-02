import type { AuthSession } from "../sync/auth";
import { randomUUID } from "@/lib/crypto";

export const LOCAL_REPOSITORY_ID = "local";

export interface LocalRepository {
  id: typeof LOCAL_REPOSITORY_ID;
  kind: "local";
}

export interface RemoteRepository {
  id: string;
  kind: "remote";
  origin: string;
  account_id: string;
  username: string;
  created_at: string;
}

export type Repository = LocalRepository | RemoteRepository;

const DIRECTORY_KEY = "neoseq.repository-directory.v1";
const LOCAL_REPOSITORY: LocalRepository = { id: LOCAL_REPOSITORY_ID, kind: "local" };
const listeners = new Set<() => void>();

function readRemoteRepositories(): RemoteRepository[] {
  try {
    const raw = localStorage.getItem(DIRECTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<RemoteRepository>[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRemoteRepository);
  } catch {
    return [];
  }
}

function isRemoteRepository(value: Partial<RemoteRepository>): value is RemoteRepository {
  return (
    value.kind === "remote" &&
    typeof value.id === "string" &&
    typeof value.origin === "string" &&
    typeof value.account_id === "string" &&
    typeof value.username === "string" &&
    typeof value.created_at === "string"
  );
}

function writeRemoteRepositories(repositories: RemoteRepository[]): void {
  localStorage.setItem(DIRECTORY_KEY, JSON.stringify(repositories));
  for (const listener of listeners) listener();
}

export function subscribeRepositoryDirectory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== DIRECTORY_KEY) return;
    for (const listener of listeners) listener();
  });
}

export function listRepositories(): Repository[] {
  return [LOCAL_REPOSITORY, ...readRemoteRepositories()];
}

export function findRepository(repositoryId: string): Repository | null {
  if (repositoryId === LOCAL_REPOSITORY_ID) return LOCAL_REPOSITORY;
  return readRemoteRepositories().find(({ id }) => id === repositoryId) ?? null;
}

export function createRepositoryId(): string {
  return `r-${randomUUID()}`;
}

export function registerRemoteRepository(
  repositoryId: string,
  serverUrl: string,
  auth: AuthSession,
): RemoteRepository {
  const origin = normalizeServerOrigin(serverUrl);
  const repositories = readRemoteRepositories();
  const duplicate = repositories.find(
    (repository) => repository.origin === origin && repository.account_id === auth.principal,
  );
  if (duplicate) return duplicate;
  const repository: RemoteRepository = {
    id: repositoryId,
    kind: "remote",
    origin,
    account_id: auth.principal,
    username: auth.username,
    created_at: new Date().toISOString(),
  };
  writeRemoteRepositories([...repositories, repository]);
  return repository;
}

export function removeRemoteRepository(repositoryId: string): void {
  writeRemoteRepositories(readRemoteRepositories().filter(({ id }) => id !== repositoryId));
}

export function repositoryLabel(repository: Repository, localLabel: string): string {
  if (repository.kind === "local") return localLabel;
  const host = new URL(repository.origin).host;
  return `${repository.username}@${host}`;
}

export type ServerUrlProblem = "invalid" | "mixed-content";

export class ServerUrlError extends Error {
  constructor(public readonly problem: ServerUrlProblem) {
    super(problem === "invalid" ? "invalid server URL" : "insecure server from a secure page");
  }
}

/** The origin a typed server URL denotes. Plain HTTP is accepted: a personal
 * appliance on a home network has no certificate, and the browser itself is
 * the only party that can rule it out — a page delivered over HTTPS cannot
 * open an HTTP connection at all, which is the one case reported here. */
export function normalizeServerOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value || window.location.origin, window.location.origin);
  } catch {
    throw new ServerUrlError("invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new ServerUrlError("invalid");
  if (window.location.protocol === "https:" && url.protocol === "http:") {
    throw new ServerUrlError("mixed-content");
  }
  return url.origin;
}
