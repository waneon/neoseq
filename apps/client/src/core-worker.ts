interface WorkerResponse {
  id: number;
  ok: boolean;
  error?: string;
  contractVersion?: number;
  coreVersion?: string;
  hash?: string;
  payload?: ArrayBuffer;
}

export interface CreatedFixture {
  contractVersion: number;
  coreVersion: string;
  hash: string;
  payload: ArrayBuffer;
}

export class CoreWorker {
  private nextId = 1;
  private readonly worker = new Worker(new URL("./spike-worker.ts", import.meta.url), {
    type: "module",
  });

  create(): Promise<CreatedFixture> {
    return this.request<CreatedFixture>({ type: "create" });
  }

  restore(payload: ArrayBuffer): Promise<{ hash: string }> {
    return this.request<{ hash: string }>({ type: "restore", payload }, [payload]);
  }

  close(): void {
    this.worker.terminate();
  }

  private request<T>(
    body: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const workerError = (event: ErrorEvent) => {
        this.worker.removeEventListener("error", workerError);
        reject(new Error(event.message || "worker failed to initialize"));
      };
      const listener = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id) return;
        this.worker.removeEventListener("message", listener);
        this.worker.removeEventListener("error", workerError);
        if (!event.data.ok) {
          reject(new Error(event.data.error ?? "worker request failed"));
          return;
        }
        resolve(event.data as unknown as T);
      };
      this.worker.addEventListener("error", workerError);
      this.worker.addEventListener("message", listener);
      this.worker.postMessage({ id, ...body }, transfer);
    });
  }
}
