import { CoreWorker } from "./core-worker";
import type { FaultPoint } from "./testing/test-persistence";
import type { GraphStorageStats, RecoveryReadStats } from "./persistence";

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

  installLegacyFixture(
    graphId: string,
    schemaVersion: number,
    snapshot: ArrayBuffer,
  ): Promise<void> {
    return this.request("test_control", {
      action: "install_legacy_fixture",
      graph_id: graphId,
      schema_version: schemaVersion,
      snapshot,
    });
  }

  schemaVersion(graphId: string): Promise<number> {
    return this.request("test_control", { action: "schema_version", graph_id: graphId });
  }

  storageStats(graphId: string): Promise<GraphStorageStats> {
    return this.request("test_control", { action: "storage_stats", graph_id: graphId });
  }

  recoveryReadStats(graphHandle: string): Promise<RecoveryReadStats> {
    return this.request("test_control", {
      action: "recovery_read_stats",
      graph_handle: graphHandle,
    });
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

  queryIndexReady(graphHandle: string): Promise<boolean> {
    return this.request("test_control", {
      action: "query_index_ready",
      graph_handle: graphHandle,
    });
  }

  fixtureUpdate(
    graphId: string,
    checkpoint: number[],
    peerId: number,
    command: unknown,
  ): Promise<number[]> {
    return this.request("test_control", {
      action: "fixture_update",
      graph_id: graphId,
      checkpoint,
      peer_id: peerId,
      command,
    });
  }
}
