export interface AuthSession {
  /** Stable account id used by sync presence and graph memberships. */
  principal: string;
  username: string;
  token: string;
}

const AUTH_PREFIX = "neoseq.remote-auth.v1:";

function key(serverUrl: string): string {
  return `${AUTH_PREFIX}${new URL(serverUrl, window.location.origin).origin}`;
}

/** Credentials deliberately live in sessionStorage: reload survives, but a
 * copied URL, local directory export, and a later browser session do not carry
 * the bearer token. */
export function readAuthSession(serverUrl: string): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(key(serverUrl));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    return parsed.principal && parsed.username && parsed.token
      ? { principal: parsed.principal, username: parsed.username, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

export function writeAuthSession(serverUrl: string, session: AuthSession): void {
  sessionStorage.setItem(key(serverUrl), JSON.stringify(session));
  window.dispatchEvent(new CustomEvent("neoseq:auth-changed", { detail: serverUrl }));
}

interface LoginResponse {
  access_token: string;
  account: {
    account_id: string;
    username: string;
  };
}

/** A password is exchanged once; only the opaque server session reaches the
 * graph API and WebSocket protocol. */
export async function signIn(
  serverUrl: string,
  username: string,
  password: string,
): Promise<AuthSession> {
  const response = await fetch(new URL("/v1/auth/login", `${serverUrl}/`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, purpose: "client" }),
  });
  if (!response.ok) throw new Error("sign in failed");
  const body = (await response.json()) as LoginResponse;
  const session = {
    principal: body.account.account_id,
    username: body.account.username,
    token: body.access_token,
  };
  writeAuthSession(serverUrl, session);
  return session;
}
