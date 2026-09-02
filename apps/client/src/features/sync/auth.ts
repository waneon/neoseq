import { RemoteApiError } from "./api";

export interface AuthSession {
  /** Stable account id used by sync presence and graph memberships. */
  principal: string;
  username: string;
  token: string;
  /** Absolute Unix expiry reported by the server, in seconds. */
  expires_at: number;
  persistence: "session" | "persistent";
}

const AUTH_PREFIX = "neoseq.remote-auth.v1:";

function key(repositoryId: string): string {
  return `${AUTH_PREFIX}${repositoryId}`;
}

function readStoredSession(
  storage: Storage,
  repositoryId: string,
  persistence: AuthSession["persistence"],
): AuthSession | null {
  const storageKey = key(repositoryId);
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    const { principal, username, token, expires_at: expiresAt } = parsed;
    if (
      typeof principal !== "string" ||
      typeof username !== "string" ||
      typeof token !== "string" ||
      typeof expiresAt !== "number" ||
      expiresAt <= Date.now() / 1_000
    ) {
      storage.removeItem(storageKey);
      return null;
    }
    return {
      principal,
      username,
      token,
      expires_at: expiresAt,
      persistence,
    };
  } catch {
    // A malformed value must not shadow a valid credential in the other store.
    try {
      storage.removeItem(storageKey);
    } catch {
      // Storage can be unavailable under restrictive browser policies.
    }
    return null;
  }
}

/** A client session may be tab-scoped or explicitly remembered on this browser.
 * Passwords never enter either store; only the server's opaque, revocable token
 * and its absolute expiry are retained. */
export function readAuthSession(repositoryId: string): AuthSession | null {
  return (
    readStoredSession(sessionStorage, repositoryId, "session") ??
    readStoredSession(localStorage, repositoryId, "persistent")
  );
}

export function writeAuthSession(repositoryId: string, session: AuthSession): void {
  const target = session.persistence === "persistent" ? localStorage : sessionStorage;
  const other = session.persistence === "persistent" ? sessionStorage : localStorage;
  other.removeItem(key(repositoryId));
  target.setItem(key(repositoryId), JSON.stringify(session));
  window.dispatchEvent(new CustomEvent("neoseq:auth-changed", { detail: repositoryId }));
}

export function clearAuthSession(repositoryId: string): void {
  sessionStorage.removeItem(key(repositoryId));
  localStorage.removeItem(key(repositoryId));
  window.dispatchEvent(new CustomEvent("neoseq:auth-changed", { detail: repositoryId }));
}

/** Confirms a remembered credential before opening a new transport. Network
 * failure preserves offline access; only an authoritative rejection or account
 * mismatch removes the session. */
export async function validateAuthSession(
  repositoryId: string,
  serverUrl: string,
): Promise<AuthSession | null> {
  const session = readAuthSession(repositoryId);
  if (!session || session.persistence !== "persistent") return session;
  try {
    const response = await fetch(new URL("/v1/auth/me", `${serverUrl}/`), {
      headers: { Authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401 || response.status === 403) {
      clearAuthSession(repositoryId);
      return null;
    }
    if (!response.ok) return session;
    const identity = (await response.json()) as {
      account_id?: string;
      purpose?: string;
    };
    if (identity.account_id !== session.principal || identity.purpose !== "client") {
      clearAuthSession(repositoryId);
      return null;
    }
  } catch {
    return session;
  }
  return session;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(AUTH_PREFIX)) return;
    window.dispatchEvent(
      new CustomEvent("neoseq:auth-changed", { detail: event.key.slice(AUTH_PREFIX.length) }),
    );
  });
}

interface LoginResponse {
  access_token: string;
  expires_at: number;
  account: {
    account_id: string;
    username: string;
  };
}

/** A password is exchanged once; only the opaque server session reaches the
 * graph API and WebSocket protocol. */
export async function signIn(
  repositoryId: string,
  serverUrl: string,
  username: string,
  password: string,
  persistent = true,
): Promise<AuthSession> {
  const response = await fetch(new URL("/v1/auth/login", `${serverUrl}/`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, purpose: "client", persistent }),
  });
  if (!response.ok) throw new RemoteApiError(response.status, "sign in failed");
  const body = (await response.json()) as LoginResponse;
  const session: AuthSession = {
    principal: body.account.account_id,
    username: body.account.username,
    token: body.access_token,
    expires_at: body.expires_at,
    persistence: persistent ? "persistent" : "session",
  };
  writeAuthSession(repositoryId, session);
  return session;
}
