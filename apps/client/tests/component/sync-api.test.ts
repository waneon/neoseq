import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadRemoteCheckpoint, listRemoteGraphs } from "../../src/features/sync/api";

const auth = {
  principal: "account-1",
  username: "owner",
  token: "session",
  expires_at: 4_102_444_800,
  persistence: "persistent" as const,
};

describe("remote graph catalog requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards the caller's abort signal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ graphs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await listRemoteGraphs("https://notes.example.test", auth, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://notes.example.test/v1/graphs"),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("validates checkpoint metadata and bytes from the bulk endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "x-neoseq-history-epoch": "7",
          "x-neoseq-version-vector": "AQID",
          "x-neoseq-checkpoint-checksum":
            "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadRemoteCheckpoint("https://notes.example.test", auth, "graph/a");

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://notes.example.test/v1/graphs/graph%2Fa/checkpoint"),
      expect.objectContaining({ headers: { Authorization: "Bearer session" } }),
    );
    expect(result.history_epoch).toBe(7);
    expect(result.server_version_vector).toEqual([1, 2, 3]);
    expect([...new Uint8Array(result.checkpoint)]).toEqual([1, 2, 3]);
  });
});
