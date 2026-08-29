// The administration API, as this app sees it.
//
// One error shape. A request can fail because the server refused it or because
// the browser never reached the server, and a surface that has to distinguish a
// `TypeError` from a `Response` in order to say which is a surface that will
// eventually get it wrong. A transport failure is reported as status 0.

export type AccountStatus = "active" | "disabled";
export type ServerRole = "user" | "admin";

export interface Account {
  account_id: string;
  username: string;
  status: AccountStatus;
  server_role: ServerRole;
  created_at: string;
}

interface LoginResponse {
  access_token: string;
  account: Account;
}

/**
 * The server's own rule, mirrored so the field can state it before the request
 * is made (`crates/sync-server/src/auth.rs` § PASSWORD_MIN_CHARS). The server
 * remains the authority: this only decides what the form says.
 */
export const PASSWORD_MIN_CHARS = 15;

/** Counts what a person typed, not what UTF-16 needed to store it. */
export function passwordLength(value: string): number {
  return Array.from(value).length;
}

export class ApiError extends Error {
  constructor(
    /** The HTTP status, or 0 when the request never reached the server. */
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The session is gone or was never entitled to this. */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function request<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new ApiError(0, cause instanceof Error ? cause.message : "network request failed");
  }
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new ApiError(response.status, message || `request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function login(username: string, password: string): Promise<LoginResponse> {
  return request("/v1/auth/login", undefined, {
    method: "POST",
    body: JSON.stringify({ username, password, purpose: "admin" }),
  });
}

export function logout(token: string): Promise<void> {
  return request("/v1/auth/logout", token, { method: "POST" });
}

export async function listAccounts(token: string): Promise<Account[]> {
  return (await request<{ accounts: Account[] }>("/v1/admin/accounts", token)).accounts;
}

export function createAccount(
  token: string,
  account: { username: string; password: string; server_role: ServerRole },
): Promise<Account> {
  return request("/v1/admin/accounts", token, {
    method: "POST",
    body: JSON.stringify(account),
  });
}

export function updateAccount(
  token: string,
  accountId: string,
  patch: { status?: AccountStatus; server_role?: ServerRole },
): Promise<Account> {
  return request(`/v1/admin/accounts/${encodeURIComponent(accountId)}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function resetPassword(token: string, accountId: string, password: string): Promise<void> {
  return request(`/v1/admin/accounts/${encodeURIComponent(accountId)}/password`, token, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
}

export function revokeSessions(token: string, accountId: string): Promise<void> {
  return request(`/v1/admin/accounts/${encodeURIComponent(accountId)}/sessions`, token, {
    method: "DELETE",
  });
}
