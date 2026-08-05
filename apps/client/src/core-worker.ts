import type {
  CloseGraphRequest,
  CloseGraphResponse,
  CorePort,
  CorePortError,
  ExecuteRequest,
  ExecuteResponse,
  OpenGraphRequest,
  OpenGraphResponse,
  QueryRequest,
  QueryResponse,
  ReadRequest,
  ReadResponse,
  ReadPageRequest,
  ReadPageResponse,
  SubscribeRequest,
  SubscribeResponse,
} from "./generated/core-port";
import type { MetadataRecord } from "./persistence";
import { diagnostics } from "./diagnostics/coordinator";
import type { DiagnosticOperation, WorkerDiagnosticSpan } from "./diagnostics/types";

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
  diagnostic_spans?: WorkerDiagnosticSpan[];
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

  readPage(request: ReadPageRequest): Promise<ReadPageResponse> {
    return this.request("read_page", request);
  }

  query(request: QueryRequest): Promise<QueryResponse> {
    return this.request("query", request);
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
    const diagnosticOperation = adapterOperation(operation);
    const span = diagnosticOperation
      ? diagnostics.startSpan("adapter", diagnosticOperation, { operation })
      : null;
    const diagnostic = diagnostics.workerContext(span?.context ?? null);
    const adapterStarted = span?.started_monotonic_ms ?? performance.now();
    return new Promise((resolve, reject) => {
      const workerError = (event: ErrorEvent) => {
        cleanup();
        const error = new Error(event.message || "worker failed to initialize");
        span?.fail(error);
        reject(error);
      };
      const listener = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id) return;
        cleanup();
        diagnostics.ingestWorkerSpans(event.data.diagnostic_spans, adapterStarted);
        if (!event.data.ok) {
          const error = new CorePortFailure(event.data.error ?? {
            code: "internal",
            message: "worker request failed",
            retryable: false,
          });
          span?.fail(error);
          reject(error);
          return;
        }
        span?.end("ok");
        resolve(event.data.value as T);
      };
      const cleanup = () => {
        this.worker.removeEventListener("message", listener);
        this.worker.removeEventListener("error", workerError);
      };
      this.worker.addEventListener("message", listener);
      this.worker.addEventListener("error", workerError);
      this.worker.postMessage({ id, operation, payload, diagnostic });
    });
  }
}

function adapterOperation(operation: string): DiagnosticOperation | null {
  const operations: Record<string, DiagnosticOperation> = {
    open_graph: "adapter.open_graph",
    execute: "adapter.execute",
    read: "adapter.read",
    read_page: "adapter.read_page",
    query: "adapter.query",
    subscribe: "adapter.subscribe",
    close_graph: "adapter.close_graph",
    retry_pending: "adapter.retry_pending",
    list_graphs: "adapter.list_graphs",
    delete_graph: "adapter.delete_graph",
  };
  return operations[operation] ?? null;
}
