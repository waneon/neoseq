import { afterEach, describe, expect, it, vi } from "vitest";
import { listRemoteGraphs } from "../../src/features/sync/api";

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

    await listRemoteGraphs(
      "https://notes.example.test",
      {
        principal: "account-1",
        username: "owner",
        token: "session",
        expires_at: 4_102_444_800,
        persistence: "persistent",
      },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://notes.example.test/v1/graphs"),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
