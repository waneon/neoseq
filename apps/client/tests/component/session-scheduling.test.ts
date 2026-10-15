import { describe, expect, it } from "vitest";
import { GraphSession } from "../../src/core-port/session";
import type { AuthoredQueryRequest } from "../../src/generated/core-port";
import { WasmTestPort } from "./wasm-test-port";

/** Holds the first query in the core until released, and records call order. */
class GatedQueryPort extends WasmTestPort {
  readonly calls: string[] = [];
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private gated = false;

  override async execute(request: Parameters<WasmTestPort["execute"]>[0]) {
    this.calls.push(`execute:${request.command.command.type}`);
    return super.execute(request);
  }

  override async query(request: Parameters<WasmTestPort["query"]>[0]) {
    const source = request.query.kind === "raw_sparql" ? request.query.source : "";
    this.calls.push(`query:${source.match(/# (\w+)/)?.[1]}`);
    if (!this.gated) {
      this.gated = true;
      await this.gate;
    }
    return super.query(request);
  }

  open(): void {
    this.release();
  }
}

const ask = (name: string): AuthoredQueryRequest => ({
  kind: "raw_sparql",
  language: "sparql-1.1/neoseq-v1",
  source: `# ${name}\nASK {}`,
  bindings: {},
});

describe("session scheduling", () => {
  it("runs queued graph work before queries queued earlier", async () => {
    const port = new GatedQueryPort();
    const session = new GraphSession("scheduling-order", port);
    await session.open();

    const running = session.query(ask("running"));
    const waiting = session.query(ask("waiting"));
    const edit = session.execute({ type: "ensure_page", page_id: "page", title: "Page" });
    port.open();
    await Promise.all([running, waiting, edit]);

    expect(port.calls).toEqual(["query:running", "execute:ensure_page", "query:waiting"]);
    await session.close();
  });

  it("drops a query aborted while it waits", async () => {
    const port = new GatedQueryPort();
    const session = new GraphSession("scheduling-abort", port);
    await session.open();

    const running = session.query(ask("running"));
    const superseded = new AbortController();
    const dropped = session.query(ask("dropped"), superseded.signal);
    superseded.abort();
    await expect(dropped).rejects.toMatchObject({ name: "AbortError" });
    port.open();
    await running;

    expect(port.calls).toEqual(["query:running"]);
    await session.close();
  });
});
