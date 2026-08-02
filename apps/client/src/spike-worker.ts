import init, {
  core_port_version,
  core_version,
  fixture_hash,
  fixture_snapshot,
  snapshot_hash,
} from "./wasm/neoseq_core.js";

type Request =
  | { id: number; type: "create" }
  | { id: number; type: "restore"; payload: ArrayBuffer };

const ready = init();

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    await ready;
    if (request.type === "create") {
      const snapshot = fixture_snapshot();
      const payload = snapshot.buffer.slice(
        snapshot.byteOffset,
        snapshot.byteOffset + snapshot.byteLength,
      );
      self.postMessage(
        {
          id: request.id,
          ok: true,
          contractVersion: core_port_version(),
          coreVersion: core_version(),
          hash: fixture_hash(),
          payload,
        },
        { transfer: [payload] },
      );
      return;
    }

    self.postMessage({
      id: request.id,
      ok: true,
      hash: snapshot_hash(new Uint8Array(request.payload)),
    });
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
