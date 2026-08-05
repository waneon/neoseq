import { describe, expect, it } from "vitest";
import { buildDiagnosticArtifact } from "../../src/diagnostics/artifact";
import { DiagnosticsCoordinator } from "../../src/diagnostics/coordinator";
import { commandAttributes, queryAttributes } from "../../src/diagnostics/redaction";
import type {
  DiagnosticRecord,
  PersistedDiagnosticSession,
} from "../../src/diagnostics/types";
import type {
  DiagnosticStore,
  StoredDiagnosticRecording,
} from "../../src/diagnostics/store";

class MemoryDiagnosticStore implements DiagnosticStore {
  session: PersistedDiagnosticSession | null = null;
  records: DiagnosticRecord[] = [];

  async saveSession(session: PersistedDiagnosticSession): Promise<void> {
    this.session = session;
  }

  async appendRecords(_recordingId: string, records: readonly DiagnosticRecord[]): Promise<void> {
    const bySequence = new Map(this.records.map((record) => [record.sequence, record]));
    for (const record of records) bySequence.set(record.sequence, record);
    this.records = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  }

  async loadRecoverable(): Promise<StoredDiagnosticRecording | null> {
    return this.session ? { session: this.session, records: [...this.records] } : null;
  }

  async deleteRecording(): Promise<void> {
    this.session = null;
    this.records = [];
  }
}

describe("diagnostic redaction", () => {
  it("turns content-bearing commands and queries into shape-only metadata", () => {
    const canary = "PRIVATE-CANARY-DO-NOT-LEAK";
    const command = commandAttributes({
      type: "insert_block",
      page_id: `page-${canary}`,
      parent: null,
      index: 0,
      markdown: canary,
    });
    const query = queryAttributes({
      language: "sparql-1.1/neoseq-v1",
      source: `SELECT * WHERE { "${canary}" ?p ?o }`,
      bindings: {
        secret: { kind: "literal", value: canary, datatype: "urn:test" },
      },
    });
    expect(JSON.stringify({ command, query })).not.toContain(canary);
    expect(command).toMatchObject({
      command_type: "insert_block",
      entity_kind: "block",
      text_length: "17-64",
    });
    expect(query).toMatchObject({ source_length: "17-64", binding_count: 1 });
  });

  it("never preserves a custom property key or value", () => {
    const canary = "private-property-canary";
    const attributes = commandAttributes({
      type: "set_property",
      entity: { kind: "page", id: "private-page" },
      key: canary,
      value: { type: "string", value: canary },
    });
    expect(attributes).toEqual({
      command_type: "set_property",
      entity_kind: "page",
      property_kind: "custom",
    });
  });
});

describe("diagnostic recording", () => {
  it("records bounded structured evidence and builds a self-contained artifact", async () => {
    const store = new MemoryDiagnosticStore();
    const coordinator = new DiagnosticsCoordinator(store);
    coordinator.requestStart();
    await coordinator.start();
    coordinator.recordCommand({
      type: "edit_markdown",
      page_id: "private-page-id",
      block_id: "private-block-id",
      markdown: "PRIVATE-CONTENT-CANARY",
    });
    const span = coordinator.startSpan("session", "session.execute", {
      command_type: "edit_markdown",
    });
    span.end("ok");
    await coordinator.stop();

    const review = coordinator.getState().review!;
    const artifact = await buildDiagnosticArtifact(review);
    const allText = [...artifact.files.values()]
      .map((bytes) => new TextDecoder().decode(bytes))
      .join("\n");
    expect(allText).not.toContain("PRIVATE-CONTENT-CANARY");
    expect(allText).not.toContain("private-page-id");
    expect(allText).not.toContain("private-block-id");
    expect(artifact.files.has("manifest.json")).toBe(true);
    expect(artifact.files.has("schemas/record.schema.json")).toBe(true);
    expect(artifact.files.has("checksums.sha256")).toBe(true);
    expect(artifact.blob.type).toBe("application/vnd.neoseq.bug+zip");
    expect(artifact.manifest).toMatchObject({
      artifact_schema_version: 1,
      capture_policy_version: 1,
      redaction_level: "standard",
      contains_user_content: false,
    });

    const annotated = await buildDiagnosticArtifact(review, "The editor froze after saving.");
    expect(annotated.manifest).toMatchObject({ contains_user_content: true });
    expect(new TextDecoder().decode(annotated.files.get("events.jsonl"))).toContain(
      "The editor froze after saving.",
    );
  });

  it("recovers an interrupted persisted recording into review", async () => {
    const store = new MemoryDiagnosticStore();
    store.session = {
      recording_id: "recording-one",
      phase: "recording",
      started_at: new Date().toISOString(),
      started_monotonic_ms: 10,
      byte_count: 100,
      record_count: 1,
      dropped_count: 0,
      limits: { max_duration_ms: 1000, max_bytes: 1000, max_records: 10 },
    };
    store.records = [{
      schema_version: 1,
      sequence: 1,
      monotonic_ms: 0,
      family: "marker",
      source: "ui",
      name: "recording_started",
      attributes: {},
    }];
    const coordinator = new DiagnosticsCoordinator(store);
    await coordinator.recover();
    expect(coordinator.getState()).toMatchObject({
      phase: "review",
      review_open: true,
      review: { recovered: true },
    });
    expect(coordinator.recordsForTesting().at(-1)?.name).toBe("recording_recovered");
  });

  it("reserves space for a terminal marker when a hard limit is reached", async () => {
    const coordinator = new DiagnosticsCoordinator(new MemoryDiagnosticStore(), {
      max_duration_ms: 60_000,
      max_bytes: 100_000,
      max_records: 3,
    });
    await coordinator.start();
    coordinator.recordRoute("journal");
    coordinator.recordRoute("settings");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(coordinator.getState().review?.session.stop_reason).toBe("limit");
    expect(coordinator.recordsForTesting()).toHaveLength(3);
    expect(coordinator.recordsForTesting().at(-1)?.name).toBe("recording_limit_reached");
    expect(coordinator.getState().review?.session.dropped_count).toBe(1);
  });
});
