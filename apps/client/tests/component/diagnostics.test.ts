import { describe, expect, it } from "vitest";
import { buildDiagnosticArtifact } from "../../src/diagnostics/artifact";
import { DiagnosticsCoordinator } from "../../src/diagnostics/coordinator";
import { commandAttributes, queryAttributes } from "../../src/diagnostics/redaction";
import type {
  DiagnosticRecord,
  PersistedDiagnosticSession,
  SensitiveDiagnosticPayload,
} from "../../src/diagnostics/types";
import type {
  DiagnosticStore,
  StoredDiagnosticRecording,
} from "../../src/diagnostics/store";

class MemoryDiagnosticStore implements DiagnosticStore {
  session: PersistedDiagnosticSession | null = null;
  records: DiagnosticRecord[] = [];
  sensitive: SensitiveDiagnosticPayload[] = [];

  async saveSession(session: PersistedDiagnosticSession): Promise<void> {
    this.session = session;
  }

  async appendRecords(_recordingId: string, records: readonly DiagnosticRecord[]): Promise<void> {
    const bySequence = new Map(this.records.map((record) => [record.sequence, record]));
    for (const record of records) bySequence.set(record.sequence, record);
    this.records = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  }

  async appendSensitivePayloads(
    _recordingId: string,
    payloads: readonly SensitiveDiagnosticPayload[],
  ): Promise<void> {
    this.sensitive.push(...payloads);
  }

  async loadRecoverable(): Promise<StoredDiagnosticRecording | null> {
    return this.session
      ? { session: this.session, records: [...this.records], sensitive_payloads: [...this.sensitive] }
      : null;
  }

  async deleteRecording(): Promise<void> {
    this.session = null;
    this.records = [];
    this.sensitive = [];
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
    coordinator.recordEditorState("private-block-id", {
      checkpoint: "reconcile",
      snapshot_revision: 4,
      focused: true,
      draft_state: "clean",
      draft_authoritative_relation: "different",
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
      capture_policy_version: 2,
      redaction_level: "standard",
      contains_user_content: false,
    });
    expect(review.records.find((record) => record.name === "editor_state")?.attributes)
      .toMatchObject({
        subject_token: "E1",
        checkpoint: "reconcile",
        draft_state: "clean",
        draft_authoritative_relation: "different",
      });

    const annotated = await buildDiagnosticArtifact(review, "The editor froze after saving.");
    expect(annotated.manifest).toMatchObject({ contains_user_content: true });
    expect(new TextDecoder().decode(annotated.files.get("events.jsonl"))).toContain(
      "The editor froze after saving.",
    );
  });

  it("keeps enhanced content separate and exports it only after explicit inclusion", async () => {
    const coordinator = new DiagnosticsCoordinator(new MemoryDiagnosticStore());
    const canary = "PRIVATE-ENHANCED-CONTENT";
    coordinator.registerGraphContext({
      graph_id: "graph-private",
      active_page_id: "page-private",
      read: () => ({
        revision: 3,
        snapshot: {
          schema_version: 3,
          graph_id: "graph-private",
          tags: [],
          quarantined: [],
          pages: [{
            id: "page-private",
            title: "Private page",
            properties: [],
            tags: [],
            blocks: [{ id: "block-private", markdown: canary, properties: [], tags: [], children: [] }],
          }],
        },
      }),
    });
    await coordinator.start({
      level: "enhanced",
      scope: "active_page",
      categories: ["graph_data"],
    });
    coordinator.recordCommand({
      type: "edit_markdown",
      page_id: "page-private",
      block_id: "block-private",
      markdown: canary,
    });
    await coordinator.stop();

    const review = coordinator.getState().review!;
    const standardOnly = await buildDiagnosticArtifact(review);
    expect(standardOnly.files.has("sensitive/content.jsonl")).toBe(false);
    expect([...standardOnly.files.values()].some((bytes) =>
      new TextDecoder().decode(bytes).includes(canary))).toBe(false);

    const enhanced = await buildDiagnosticArtifact(review, "", { includeSensitive: true });
    expect(enhanced.manifest).toMatchObject({
      redaction_level: "enhanced",
      contains_sensitive_content: true,
    });
    expect(new TextDecoder().decode(enhanced.files.get("sensitive/content.jsonl"))).toContain(canary);
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
      capture_policy: { level: "standard" },
      sensitive_byte_count: 0,
      sensitive_record_count: 0,
      sensitive_truncated: false,
      limits: {
        max_duration_ms: 1000,
        max_bytes: 1000,
        max_sensitive_bytes: 1000,
        max_records: 10,
      },
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
      max_sensitive_bytes: 100_000,
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
