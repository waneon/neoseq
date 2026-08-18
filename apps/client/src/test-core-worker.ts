import { CoreWorker } from "./core-worker";
import type { FaultPoint } from "./testing/test-persistence";
import type { GraphStorageStats } from "./persistence";

export class TestCoreWorker extends CoreWorker {
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
    return this.request("test_control", {
      action: "export_quarantine",
      graph_id: graphId,
      export_handle: exportHandle,
    });
  }

  setSchemaVersion(graphId: string, schemaVersion: number): Promise<void> {
    return this.request("test_control", {
      action: "set_schema",
      graph_id: graphId,
      schema_version: schemaVersion,
    });
  }

  storageStats(graphId: string): Promise<GraphStorageStats> {
    return this.request("test_control", { action: "storage_stats", graph_id: graphId });
  }

  replicaId(graphId: string): Promise<number> {
    return this.request("test_control", { action: "replica_id", graph_id: graphId });
  }

  gcCheckpoint(graphHandle: string): Promise<{
    checkpoint: number[];
    version_vector: number[];
  }> {
    return this.request("test_control", {
      action: "gc_checkpoint",
      graph_handle: graphHandle,
    });
  }
}
