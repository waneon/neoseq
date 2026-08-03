import type {
  CloseGraphRequest,
  CloseGraphResponse,
  CorePort,
  CorePortError,
  ExecuteRequest,
  ExecuteResponse,
  OpenGraphRequest,
  OpenGraphResponse,
  ReadRequest,
  ReadResponse,
  SubscribeRequest,
  SubscribeResponse,
} from "./generated/core-port";
import type { FaultPoint, MetadataRecord } from "./persistence";

export type GraphMetadata = Pick<
  MetadataRecord,
  "graph_id" | "schema_version" | "created_at" | "updated_at"
>;

export interface SavedReceipt {
  status: "saved_locally";
  local_sequence: number;
  checksum: string;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: CorePortError;
}

export class CorePortFailure extends Error {
  constructor(public readonly detail: CorePortError) {
    super(detail.message);
  }
}

export class CoreWorker implements CorePort {
  private nextId = 1;
  private readonly worker = new Worker(new URL("./spike-worker.ts", import.meta.url), {
    type: "module",
  });

  openGraph(request: OpenGraphRequest): Promise<OpenGraphResponse> {
    return this.request("open_graph", request);
  }

  execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    return this.request("execute", request);
  }

  read(request: ReadRequest): Promise<ReadResponse> {
    return this.request("read", request);
  }

  subscribe(request: SubscribeRequest): Promise<SubscribeResponse> {
    return this.request("subscribe", request);
  }

  closeGraph(request: CloseGraphRequest): Promise<CloseGraphResponse> {
    return this.request("close_graph", request);
  }

  retryPending(graphHandle: string): Promise<SavedReceipt> {
    return this.request("retry_pending", { graph_handle: graphHandle });
  }

  listGraphs(): Promise<GraphMetadata[]> {
    return this.request("list_graphs", {});
  }

  deleteGraph(graphId: string): Promise<void> {
    return this.request("delete_graph", { graph_id: graphId });
  }

  injectFault(graphHandle: string, fault: FaultPoint): Promise<void> {
    return this.request("test_control", { action: "inject", graph_handle: graphHandle, fault });
  }

  corruptUpdate(graphId: string, sequence: number): Promise<void> {
    return this.request("test_control", { action: "corrupt_update", graph_id: graphId, sequence });
  }

  quarantineCount(graphId: string): Promise<number> {
    return this.request("test_control", { action: "quarantine_count", graph_id: graphId });
  }

  exportQuarantine(graphId: string, exportHandle: string): Promise<ArrayBuffer> {
    return this.request("test_control", { action: "export_quarantine", graph_id: graphId, export_handle: exportHandle });
  }

  roundTripIndexCache(graphId: string): Promise<number> {
    return this.request("test_control", { action: "index_cache", graph_id: graphId });
  }

  setSchemaVersion(graphId: string, schemaVersion: number): Promise<void> {
    return this.request("test_control", { action: "set_schema", graph_id: graphId, schema_version: schemaVersion });
  }

  deleteLocal(graphId: string): Promise<void> {
    return this.request("test_control", { action: "delete_local", graph_id: graphId });
  }

  terminate(): void {
    this.worker.terminate();
  }

  private request<T>(operation: string, payload: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const workerError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || "worker failed to initialize"));
      };
      const listener = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id) return;
        cleanup();
        if (!event.data.ok) {
          reject(new CorePortFailure(event.data.error ?? {
            code: "internal",
            message: "worker request failed",
            retryable: false,
          }));
          return;
        }
        resolve(event.data.value as T);
      };
      const cleanup = () => {
        this.worker.removeEventListener("message", listener);
        this.worker.removeEventListener("error", workerError);
      };
      this.worker.addEventListener("message", listener);
      this.worker.addEventListener("error", workerError);
      this.worker.postMessage({ id, operation, payload });
    });
  }
}
