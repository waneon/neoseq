import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig, neoseqUrl } from "../../src/app/runtime-config";

afterEach(() => vi.unstubAllGlobals());

describe("runtime configuration", () => {
  it("uses the configured canonical Neoseq URL", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "https://NEOSEQ.example.test:443/" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await loadRuntimeConfig();

    expect(neoseqUrl()).toBe("https://neoseq.example.test");
    expect(fetch).toHaveBeenCalledWith("/__neoseq/config.json", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  });

  it("falls back to the browser origin when configuration is unavailable or invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ url: "https://example.test/a-path" }), { status: 200 }),
        ),
    );
    await loadRuntimeConfig();
    expect(neoseqUrl()).toBe(window.location.origin);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await loadRuntimeConfig();
    expect(neoseqUrl()).toBe(window.location.origin);
  });
});
