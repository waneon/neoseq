import type {
  CloseGraphRequest,
  CloseGraphResponse,
  CorePort,
  CorePortError,
  ExecuteRequest,
  ExecuteResponse,
  GraphLocatorDto,
  OpenGraphRequest,
  OpenGraphResponse,
  QueryRequest,
  QueryResponse,
  ReadRequest,
  ReadResponse,
  ReadOutlineRequest,
  ReadOutlineResponse,
  SubscribeRequest,
  SubscribeResponse,
  StorageCapabilitiesDto,
} from "./generated/core-port";
import type { MetadataRecord } from "./persistence";

export type GraphMetadata = Pick<
  MetadataRecord,
  "graph_id" | "locator" | "schema_version" | "created_at" | "updated_at"
>;

export interface SavedReceipt {
  status: "saved_locally";
  local_sequence: number;
  checksum: string;
}

export interface SyncState {
  version_vector: number[];
  pending: number;
  replica_id: number;
  history_epoch: number;
}

export interface OutboxMessage {
  message_id: string;
  local_sequence: number;
  base_version_vector: number[];
  bytes: number[];
  history_epoch: number;
}

export interface ImportedGraphArchive {
  graph_id: string;
  suggested_name?: string | null;
  created_at: string;
}

export type WorkerOperation =
  | "open_graph"
  | "execute"
  | "read"
  | "read_outline"
  | "query"
  | "subscribe"
  | "close_graph"
  | "retry_pending"
  | "list_graphs"
  | "delete_graph"
  | "export_archive"
  | "import_archive"
  | "storage_capabilities"
  | "sync_configure"
  | "sync_state"
  | "sync_next"
  | "sync_ack"
  | "sync_import"
  | "sync_replace"
  | "sync_encode"
  | "sync_decode"
  | "test_control";

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

  readOutline(request: ReadOutlineRequest): Promise<ReadOutlineResponse> {
    return this.request("read_outline", request);
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

  deleteGraph(locator: GraphLocatorDto | string): Promise<void> {
    return this.request("delete_graph", {
      locator:
        typeof locator === "string" ? { repository_id: "local", graph_id: locator } : locator,
    });
  }

  exportArchive(graphHandle: string, suggestedName: string): Promise<ArrayBuffer> {
    return this.request("export_archive", {
      graph_handle: graphHandle,
      suggested_name: suggestedName,
    });
  }

  importArchive(
    bytes: ArrayBuffer,
    locator: GraphLocatorDto = {
      repository_id: "local",
      graph_id: `g-${crypto.randomUUID()}`,
    },
  ): Promise<ImportedGraphArchive> {
    return this.request("import_archive", { bytes, locator }, [bytes]);
  }

  storageCapabilities(graphHandle: string): Promise<StorageCapabilitiesDto> {
    return this.request("storage_capabilities", { graph_handle: graphHandle });
  }

  configureSync(graphHandle: string): Promise<void> {
    return this.request("sync_configure", { graph_handle: graphHandle });
  }

  syncState(graphHandle: string): Promise<SyncState> {
    return this.request("sync_state", { graph_handle: graphHandle });
  }

  nextOutbox(graphHandle: string): Promise<OutboxMessage | null> {
    return this.request("sync_next", { graph_handle: graphHandle });
  }

  acknowledgeOutbox(graphHandle: string, messageId: string): Promise<void> {
    return this.request("sync_ack", { graph_handle: graphHandle, message_id: messageId });
  }

  importRemote(graphHandle: string, bytes: number[]): Promise<SavedReceipt> {
    return this.request("sync_import", { graph_handle: graphHandle, bytes });
  }

  replaceRemote(
    graphHandle: string,
    checkpoint: number[],
    historyEpoch: number,
    serverVersionVector: number[],
  ): Promise<void> {
    return this.request("sync_replace", {
      graph_handle: graphHandle,
      checkpoint,
      history_epoch: historyEpoch,
      server_version_vector: serverVersionVector,
    });
  }

  encodeSyncMessage(message: unknown): Promise<ArrayBuffer> {
    return this.request("sync_encode", message);
  }

  decodeSyncMessage(frame: ArrayBuffer): Promise<unknown> {
    return this.request("sync_decode", { frame });
  }

  terminate(): void {
    this.worker.terminate();
  }

  protected request<T>(
    operation: WorkerOperation,
    payload: unknown,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const workerError = (event: ErrorEvent) => {
        cleanup();
        const error = new Error(event.message || "worker failed to initialize");
        reject(error);
      };
      const listener = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id) return;
        cleanup();
        if (!event.data.ok) {
          const error = new CorePortFailure(
            event.data.error ?? {
              code: "internal",
              message: "worker request failed",
              retryable: false,
            },
          );
          reject(error);
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
      this.worker.postMessage({ id, operation, payload }, transfer);
    });
  }
}
