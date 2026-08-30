import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAuthSession,
  readAuthSession,
  validateAuthSession,
  writeAuthSession,
  type AuthSession,
} from "../../src/features/sync/auth";

const REPOSITORY = "repository-auth-test";
const KEY = `neoseq.remote-auth.v1:${REPOSITORY}`;

function session(persistence: AuthSession["persistence"]): AuthSession {
  return {
    principal: "account-test",
    username: "test-user",
    token: "opaque-test-token",
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    persistence,
  };
}

describe("remote authentication storage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps a remembered session across tab storage loss", () => {
    writeAuthSession(REPOSITORY, session("persistent"));

    expect(localStorage.getItem(KEY)).toContain("opaque-test-token");
    expect(sessionStorage.getItem(KEY)).toBeNull();
    sessionStorage.clear();
    expect(readAuthSession(REPOSITORY)).toMatchObject({ persistence: "persistent" });
  });

  it("keeps an unremembered session in the current tab only", () => {
    writeAuthSession(REPOSITORY, session("session"));

    expect(sessionStorage.getItem(KEY)).toContain("opaque-test-token");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("removes expired and explicitly cleared credentials from both stores", () => {
    writeAuthSession(REPOSITORY, {
      ...session("persistent"),
      expires_at: Math.floor(Date.now() / 1_000) - 1,
    });
    expect(readAuthSession(REPOSITORY)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();

    writeAuthSession(REPOSITORY, session("session"));
    clearAuthSession(REPOSITORY);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("ignores malformed tab storage when a remembered session is valid", () => {
    writeAuthSession(REPOSITORY, session("persistent"));
    sessionStorage.setItem(KEY, "not json");

    expect(readAuthSession(REPOSITORY)).toMatchObject({ persistence: "persistent" });
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("removes a remembered session only after an authoritative rejection", async () => {
    writeAuthSession(REPOSITORY, session("persistent"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    await expect(validateAuthSession(REPOSITORY, "https://sync.example")).resolves.toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("preserves a remembered session when validation cannot reach the server", async () => {
    const remembered = session("persistent");
    writeAuthSession(REPOSITORY, remembered);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );

    await expect(validateAuthSession(REPOSITORY, "https://sync.example")).resolves.toMatchObject({
      token: remembered.token,
    });
    expect(localStorage.getItem(KEY)).toContain(remembered.token);
  });
});
