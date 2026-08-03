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
import type { MetadataRecord } from "./persistence";

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
  private readonly worker = new Worker(new URL("./graph-worker.ts", import.meta.url), {
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

  terminate(): void {
    this.worker.terminate();
  }

  protected request<T>(operation: string, payload: unknown): Promise<T> {
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
