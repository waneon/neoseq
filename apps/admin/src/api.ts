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

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
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
