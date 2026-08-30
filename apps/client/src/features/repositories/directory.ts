import type { AuthSession } from "../sync/auth";

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
  return `r-${crypto.randomUUID()}`;
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

export function repositoryLabel(repository: Repository, localLabel: string): string {
  if (repository.kind === "local") return localLabel;
  const host = new URL(repository.origin).host;
  return `${repository.username}@${host}`;
}

export function normalizeServerOrigin(value: string): string {
  const url = new URL(value || window.location.origin, window.location.origin);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported server protocol");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("remote servers require HTTPS");
  return url.origin;
}
