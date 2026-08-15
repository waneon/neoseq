export interface AuthSession {
  principal: string;
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
    return parsed.principal && parsed.token
      ? { principal: parsed.principal, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

export function writeAuthSession(serverUrl: string, session: AuthSession): void {
  sessionStorage.setItem(key(serverUrl), JSON.stringify(session));
  window.dispatchEvent(new CustomEvent("neoseq:auth-changed", { detail: serverUrl }));
}

export function clearAuthSession(serverUrl: string): void {
  sessionStorage.removeItem(key(serverUrl));
  window.dispatchEvent(new CustomEvent("neoseq:auth-changed", { detail: serverUrl }));
}
