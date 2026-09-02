import { afterEach, describe, expect, it } from "vitest";
import { randomUUID, sha256Hex } from "../../src/lib/crypto";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Hides a platform capability the way an insecure browsing context does. */
function withoutPlatform<K extends "randomUUID" | "subtle">(name: K): () => void {
  const platform = globalThis.crypto;
  Object.defineProperty(platform, name, { configurable: true, value: undefined });
  return () => {
    Reflect.deleteProperty(platform, name);
  };
}

describe("crypto primitives without a secure context", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()?.();
  });

  it("generates version 4 UUIDs from raw randomness", () => {
    restores.push(withoutPlatform("randomUUID"));
    expect(typeof crypto.randomUUID).toBe("undefined");

    const ids = new Set(Array.from({ length: 64 }, randomUUID));
    expect(ids.size).toBe(64);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it("matches the platform SHA-256 on every padding boundary", async () => {
    const platform = globalThis.crypto.subtle;
    const payloads = [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 4097].map((length) =>
      Uint8Array.from({ length }, (_, index) => (index * 31 + length) & 0xff),
    );
    const expected = await Promise.all(
      payloads.map(async (bytes) =>
        [...new Uint8Array(await platform.digest("SHA-256", bytes))]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      ),
    );

    restores.push(withoutPlatform("subtle"));
    expect(crypto.subtle).toBeUndefined();

    for (const [index, bytes] of payloads.entries()) {
      expect(await sha256Hex(bytes)).toBe(expected[index]);
      expect(await sha256Hex(bytes.buffer)).toBe(expected[index]);
    }
  });

  it("reproduces the published SHA-256 test vectors", async () => {
    restores.push(withoutPlatform("subtle"));
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      await sha256Hex(
        new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });
});
