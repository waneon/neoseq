import { CORE_PORT_VERSION } from "./generated/core-port";
import type { CommandEnvelope, OpenGraphRequest } from "./generated/core-port";
import { SCHEMA_VERSION } from "./generated/graph-schema";
import golden from "../../../fixtures/core-port/current.json";
import { CorePortFailure } from "./core-worker";
import { TestCoreWorker } from "./test-core-worker";
import { randomUUID, sha256Hex } from "@/lib/crypto";

interface Snapshot {
  schema_version: number;
  pages: unknown[];
  tags: Array<{ id: string }>;
  quarantined: string[];
}

function graphId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function openRequest(graph: string, peer: number): OpenGraphRequest {
  return {
    contract_version: CORE_PORT_VERSION,
    locator: { repository_id: "local", graph_id: graph },
    peer_id: peer,
  };
}

function ensurePage(graph: string, commandId: string, pageId: string): CommandEnvelope {
  return {
    graph_id: graph,
    command_id: commandId,
    command: { type: "ensure_page", page_id: pageId, title: pageId },
  };
}

function renamePage(
  graph: string,
  commandId: string,
  pageId: string,
  title: string,
): CommandEnvelope {
  return {
    graph_id: graph,
    command_id: commandId,
    command: { type: "rename_page", page_id: pageId, title },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectCode(
  action: Promise<unknown>,
  code: string,
): Promise<CorePortFailure["detail"]> {
  try {
    await action;
  } catch (error) {
    assert(error instanceof CorePortFailure, `expected CorePortFailure for ${code}`);
    assert(error.detail.code === code, `expected ${code}, received ${error.detail.code}`);
    return error.detail;
  }
  throw new Error(`expected ${code} failure`);
}

export async function runIndexedDbPersistenceCorpus() {
  const graph = graphId("indexeddb-corpus");
  const creator = new TestCoreWorker();
  const opened = await creator.openGraph(openRequest(graph, 201));
  const replicaId = await creator.replicaId(graph);
  assert(opened.summary, "open must expose a canonical summary");
  assert(
    (await creator.storageCapabilities(opened.graph_handle)).durable,
    "capability discovery must expose durable storage",
  );
  const saved = await creator.execute({
    graph_handle: opened.graph_handle,
    command: ensurePage(graph, "create-home", "home"),
    timeout_ms: 1_000,
  });
  assert(saved.save_status.status === "saved_locally", "execute must acknowledge local durability");
  assert(saved.save_status.checksum.length === 64, "saved update checksum must be SHA-256");
  const later = await creator.execute({
    graph_handle: opened.graph_handle,
    command: renamePage(graph, "rename-before-retry", "home", "Home later"),
    timeout_ms: 1_000,
  });
  assert(later.save_status.status === "saved_locally", "later edit must be durable");
  const beforeUnchanged = await creator.storageStats(graph);
  const duplicate = await creator.execute({
    graph_handle: opened.graph_handle,
    command: ensurePage(graph, "create-home", "home"),
    timeout_ms: 1_000,
  });
  assert(
    duplicate.save_status.status === "unchanged",
    "a duplicate must not borrow a later update receipt",
  );
  assert(
    JSON.stringify(duplicate.result) === JSON.stringify(saved.result),
    "a duplicate must return its cached identity metadata",
  );
  assert(
    !("changed" in (duplicate.result as object)),
    "command metadata must not duplicate save-status change authority",
  );
  const noOp = await creator.execute({
    graph_handle: opened.graph_handle,
    command: ensurePage(graph, "ensure-existing-home", "home"),
    timeout_ms: 1_000,
  });
  assert(noOp.save_status.status === "unchanged", "a no-op must not invent a durable update");
  const afterUnchanged = await creator.storageStats(graph);
  assert(
    afterUnchanged.update_count === beforeUnchanged.update_count,
    "duplicate and no-op commands must not append IndexedDB updates",
  );
  for (let index = 0; index < 130; index += 1) {
    await creator.execute({
      graph_handle: opened.graph_handle,
      command: renamePage(graph, `rename-${index}`, "home", `Home ${index % 2}`),
      timeout_ms: 1_000,
    });
  }
  const compacted = await creator.storageStats(graph);
  assert(compacted.compacted_through >= 128, "tail threshold did not install a checkpoint");
  assert(compacted.checkpoint_count === 2, "compaction did not retain exactly one fallback Base");
  assert(compacted.update_count >= 128, "fallback Base lost its covered Tail generation");
  const before = await creator.read({ graph_handle: opened.graph_handle });
  await creator.closeGraph({ graph_handle: opened.graph_handle });
  const reclaimed = await creator.storageStats(graph);
  assert(reclaimed.checkpoint_count === 2, "checkpoint rotation retained more than two Bases");
  assert(reclaimed.update_count < 8, "next checkpoint generation did not reclaim the old Tail");
  creator.terminate();

  const restorer = new TestCoreWorker();
  const reopened = await restorer.openGraph(openRequest(graph, 202));
  const recoveryReads = await restorer.recoveryReadStats(reopened.graph_handle);
  assert(
    (await restorer.replicaId(graph)) === replicaId,
    "browser replica id changed across restart",
  );
  assert(
    JSON.stringify(reopened.summary) === JSON.stringify(before.summary),
    "worker restart changed the canonical summary",
  );
  assert(
    reopened.recovery.checkpoint_sequence >= 128,
    "compacted checkpoint was not selected on reopen",
  );
  assert(
    recoveryReads.tail_records === 0 && recoveryReads.tail_bytes === 0,
    "recovery read updates already covered by the latest checkpoint",
  );
  assert(recoveryReads.checkpoint_records <= 2, "recovery read an unbounded checkpoint history");
  await restorer.closeGraph({ graph_handle: reopened.graph_handle });
  await restorer.deleteGraph(graph);
  restorer.terminate();

  // Keep a real Base+Tail across an abrupt Worker restart. Replayed updates
  // use the persisted replica id, but belong before the new session's undo
  // boundary. The first new edit must undo alone and must not poison the next
  // durable edit.
  const historyGraph = graphId("indexeddb-reopen-undo");
  const historyWriter = new TestCoreWorker();
  const historyOpened = await historyWriter.openGraph(openRequest(historyGraph, 203));
  await historyWriter.execute({
    graph_handle: historyOpened.graph_handle,
    command: ensurePage(historyGraph, "history-home", "home"),
    timeout_ms: 1_000,
  });
  historyWriter.terminate();

  const historyReopened = new TestCoreWorker();
  const recoveredHistory = await historyReopened.openGraph(openRequest(historyGraph, 204));
  assert(
    recoveredHistory.recovery.replayed_updates === 1,
    "history regression did not replay a same-replica Tail",
  );
  await historyReopened.execute({
    graph_handle: recoveredHistory.graph_handle,
    command: renamePage(historyGraph, "transient-after-reopen", "home", "Transient"),
    timeout_ms: 1_000,
  });
  const firstSessionUndo = await historyReopened.execute({
    graph_handle: recoveredHistory.graph_handle,
    command: {
      graph_id: historyGraph,
      command_id: "first-session-undo",
      command: { type: "undo" },
    },
    timeout_ms: 1_000,
  });
  assert(
    firstSessionUndo.save_status.status === "saved_locally",
    "first edit after reopen was not undoable",
  );
  const restoredAfterUndo = await historyReopened.read({
    graph_handle: recoveredHistory.graph_handle,
  });
  assert(
    (restoredAfterUndo.summary as { pages: { title: string }[] }).pages[0].title === "home",
    "first undo after reopen crossed into the durable Tail",
  );
  await historyReopened.execute({
    graph_handle: recoveredHistory.graph_handle,
    command: renamePage(historyGraph, "after-reopen", "home", "After reopen"),
    timeout_ms: 1_000,
  });
  historyReopened.terminate();

  const historyDurable = new TestCoreWorker();
  const durableHistory = await historyDurable.openGraph(openRequest(historyGraph, 205));
  const durablePage = (durableHistory.summary as { pages: { title: string }[] }).pages[0];
  assert(
    durablePage.title === "After reopen",
    "edit after reopen undo did not survive another restart",
  );
  const oldSessionUndo = await historyDurable.execute({
    graph_handle: durableHistory.graph_handle,
    command: {
      graph_id: historyGraph,
      command_id: "old-session-undo",
      command: { type: "undo" },
    },
    timeout_ms: 1_000,
  });
  assert(
    oldSessionUndo.save_status.status === "unchanged",
    "reopen exposed durable Tail as undoable history",
  );
  await historyDurable.execute({
    graph_handle: durableHistory.graph_handle,
    command: renamePage(historyGraph, "current-session", "home", "Current session"),
    timeout_ms: 1_000,
  });
  const currentSessionUndo = await historyDurable.execute({
    graph_handle: durableHistory.graph_handle,
    command: {
      graph_id: historyGraph,
      command_id: "current-session-undo",
      command: { type: "undo" },
    },
    timeout_ms: 1_000,
  });
  assert(
    currentSessionUndo.save_status.status === "saved_locally",
    "new-session edit was not undoable",
  );
  const afterUndo = await historyDurable.read({ graph_handle: durableHistory.graph_handle });
  assert(
    (afterUndo.summary as { pages: { title: string }[] }).pages[0].title === "After reopen",
    "current-session undo crossed the recovery boundary",
  );
  await historyDurable.closeGraph({ graph_handle: durableHistory.graph_handle });
  await historyDurable.deleteGraph(historyGraph);
  historyDurable.terminate();
  return {
    graph,
    local_sequence:
      saved.save_status.status === "saved_locally" ? saved.save_status.local_sequence : 0,
  };
}

export async function runWorkerCorePortCorpus() {
  assert(golden.contract_version === CORE_PORT_VERSION, "golden contract version mismatch");
  assert(
    JSON.stringify(golden.operations) ===
      JSON.stringify([
        "open_graph",
        "execute",
        "read",
        "read_outline",
        "query",
        "subscribe",
        "close_graph",
      ]),
    "golden operations changed",
  );
  const graph = graphId("worker-port");
  const worker = new TestCoreWorker();
  await expectCode(worker.read({ graph_handle: "missing" }), "graph_not_open");
  const unsupported = openRequest(graph, 211);
  unsupported.contract_version += 1;
  await expectCode(worker.openGraph(unsupported), "unsupported_contract");
  const opened = await worker.openGraph(openRequest(graph, 211));
  assert(
    !(await worker.queryIndexReady(opened.graph_handle)),
    "opening a graph eagerly built the derived query index",
  );
  await expectCode(worker.openGraph(openRequest(graph, 212)), "graph_already_open");
  const executed = await worker.execute({
    graph_handle: opened.graph_handle,
    command: ensurePage(graph, "port-home", "home"),
    timeout_ms: 1_000,
  });
  assert(
    executed.save_status.status === golden.transcript.execute,
    "worker save status differs from golden",
  );
  assert(
    !(await worker.queryIndexReady(opened.graph_handle)),
    "a canonical command built an unused query index",
  );
  const read = await worker.read({ graph_handle: opened.graph_handle });
  assert((read.summary as Snapshot).schema_version === 7, "worker read did not return schema v7");
  const outline = await worker.readOutline({
    graph_handle: opened.graph_handle,
    owner: { kind: "page", id: "home" },
  });
  assert(
    (outline.outline as { owner: { id: string } }).owner.id === "home",
    "worker outline read returned the wrong owner",
  );
  const queried = await worker.query({
    graph_handle: opened.graph_handle,
    query: {
      kind: "raw_sparql",
      language: "sparql-1.1/neoseq-v1",
      source: "PREFIX neo: <urn:neoseq:vocab:v1:> SELECT ?page WHERE { ?page a neo:Page }",
    },
  });
  assert(
    queried.result.kind === "select" && queried.result.rows.length === 1,
    "worker query result differs from golden",
  );
  assert(
    await worker.queryIndexReady(opened.graph_handle),
    "the first query did not publish its derived index",
  );
  const subscription = await worker.subscribe({
    graph_handle: opened.graph_handle,
    after_cursor: 0,
  });
  assert(
    subscription.events.length === 2 && !subscription.resync_required,
    "worker subscription transcript differs",
  );
  const eventTypes = subscription.events.map((event) => event.kind.type);
  assert(
    JSON.stringify(eventTypes) === JSON.stringify(golden.transcript.subscribe),
    "worker event types differ from golden",
  );
  assert(
    subscription.events[0]?.kind.type === "semantic" &&
      subscription.events[0].kind.name === "PageEnsured",
    "worker semantic event lost its typed PascalCase spelling",
  );
  await expectCode(
    worker.execute({
      graph_handle: opened.graph_handle,
      command: ensurePage(graph, "timeout", "timeout"),
      timeout_ms: 0,
    }),
    golden.transcript.timeout_error,
  );
  for (let index = 0; index < 33; index += 1) {
    await worker.execute({
      graph_handle: opened.graph_handle,
      command: ensurePage(graph, `overflow-${index}`, `overflow-${index}`),
      timeout_ms: 1_000,
    });
  }
  const overflow = await worker.subscribe({ graph_handle: opened.graph_handle, after_cursor: 0 });
  assert(
    overflow.resync_required && overflow.events.length === 0,
    "subscription overflow did not request resync",
  );
  await worker.closeGraph({ graph_handle: opened.graph_handle });
  await worker.deleteGraph(graph);
  worker.terminate();
  return { operations: golden.operations.length, errors: golden.error_codes.length };
}

export async function runIndexedDbFaultCorpus() {
  const afterGraph = graphId("append-after");
  const after = new TestCoreWorker();
  const afterOpen = await after.openGraph(openRequest(afterGraph, 221));
  await after.injectFault(afterOpen.graph_handle, "append_after");
  await expectCode(
    after.execute({
      graph_handle: afterOpen.graph_handle,
      command: ensurePage(afterGraph, "after-commit", "after"),
      timeout_ms: 1_000,
    }),
    "dirty_unsaved",
  );
  after.terminate();
  const afterRecovery = new TestCoreWorker();
  const recovered = await afterRecovery.openGraph(openRequest(afterGraph, 222));
  assert(
    (recovered.summary as Snapshot).pages.length === 1,
    "after-commit process kill lost durable update",
  );
  await afterRecovery.closeGraph({ graph_handle: recovered.graph_handle });
  await afterRecovery.deleteGraph(afterGraph);
  afterRecovery.terminate();

  const corruptGraph = graphId("corrupt-tail");
  const corruptWriter = new TestCoreWorker();
  const corruptOpen = await corruptWriter.openGraph(openRequest(corruptGraph, 231));
  await corruptWriter.execute({
    graph_handle: corruptOpen.graph_handle,
    command: ensurePage(corruptGraph, "corrupt", "corrupt"),
    timeout_ms: 1_000,
  });
  corruptWriter.terminate();
  const corruptRecovery = new TestCoreWorker();
  await corruptRecovery.corruptUpdate(corruptGraph, 1);
  const recoveredCorrupt = await corruptRecovery.openGraph(openRequest(corruptGraph, 232));
  assert(
    recoveredCorrupt.recovery.quarantined_records[0] === "update-1",
    "corrupt update was not quarantined",
  );
  assert(
    (recoveredCorrupt.summary as Snapshot).pages.length === 0,
    "corrupt update was silently coerced",
  );
  assert(
    (await corruptRecovery.quarantineCount(corruptGraph)) === 1,
    "quarantine payload/export handle missing",
  );
  assert(
    (await corruptRecovery.exportQuarantine(corruptGraph, "update-1")).byteLength > 0,
    "transferable quarantine export is empty",
  );
  await corruptRecovery.execute({
    graph_handle: recoveredCorrupt.graph_handle,
    command: ensurePage(corruptGraph, "usable", "usable"),
    timeout_ms: 1_000,
  });
  await corruptRecovery.closeGraph({ graph_handle: recoveredCorrupt.graph_handle });
  corruptRecovery.terminate();

  const repairedTail = new TestCoreWorker();
  const reopenedTail = await repairedTail.openGraph(openRequest(corruptGraph, 233));
  assert(
    reopenedTail.recovery.quarantined_records.length === 0,
    "repaired Tail was quarantined again",
  );
  assert(
    (reopenedTail.summary as Snapshot).pages.length === 1,
    "post-repair edit did not survive restart",
  );
  assert(
    (await repairedTail.quarantineCount(corruptGraph)) === 1,
    "repair discarded quarantine evidence",
  );
  await repairedTail.closeGraph({ graph_handle: reopenedTail.graph_handle });
  await repairedTail.deleteGraph(corruptGraph);
  repairedTail.terminate();

  const abortGraph = graphId("abort-quota");
  const abortWorker = new TestCoreWorker();
  const abortOpen = await abortWorker.openGraph(openRequest(abortGraph, 241));
  await abortWorker.injectFault(abortOpen.graph_handle, "quota");
  await expectCode(
    abortWorker.execute({
      graph_handle: abortOpen.graph_handle,
      command: ensurePage(abortGraph, "quota", "quota"),
      timeout_ms: 1_000,
    }),
    "storage_full",
  );
  await expectCode(
    abortWorker.closeGraph({ graph_handle: abortOpen.graph_handle }),
    "dirty_unsaved",
  );
  await abortWorker.retryPending(abortOpen.graph_handle);
  await abortWorker.closeGraph({ graph_handle: abortOpen.graph_handle });
  await abortWorker.deleteGraph(abortGraph);
  abortWorker.terminate();

  const transactionGraph = graphId("transaction-abort");
  const transactionWorker = new TestCoreWorker();
  const transactionOpen = await transactionWorker.openGraph(openRequest(transactionGraph, 245));
  await transactionWorker.injectFault(transactionOpen.graph_handle, "abort");
  const aborted = await expectCode(
    transactionWorker.execute({
      graph_handle: transactionOpen.graph_handle,
      command: ensurePage(transactionGraph, "abort", "abort"),
      timeout_ms: 1_000,
    }),
    "dirty_unsaved",
  );
  assert(aborted.retryable, "an aborted transaction must retain its explicit retry route");
  await transactionWorker.retryPending(transactionOpen.graph_handle);
  await transactionWorker.closeGraph({ graph_handle: transactionOpen.graph_handle });
  await transactionWorker.deleteGraph(transactionGraph);
  transactionWorker.terminate();

  const checkpointGraph = graphId("checkpoint-fault");
  const checkpoint = new TestCoreWorker();
  const checkpointOpen = await checkpoint.openGraph(openRequest(checkpointGraph, 251));
  await checkpoint.execute({
    graph_handle: checkpointOpen.graph_handle,
    command: ensurePage(checkpointGraph, "checkpoint", "checkpoint"),
    timeout_ms: 1_000,
  });
  await checkpoint.injectFault(checkpointOpen.graph_handle, "checkpoint_before");
  await expectCode(
    checkpoint.closeGraph({ graph_handle: checkpointOpen.graph_handle }),
    "internal",
  );
  await checkpoint.injectFault(checkpointOpen.graph_handle, "checkpoint_after");
  await expectCode(
    checkpoint.closeGraph({ graph_handle: checkpointOpen.graph_handle }),
    "internal",
  );
  await checkpoint.closeGraph({ graph_handle: checkpointOpen.graph_handle });
  await checkpoint.deleteGraph(checkpointGraph);
  checkpoint.terminate();

  const schemaGraph = graphId("unsupported-schema");
  const schemaWriter = new TestCoreWorker();
  const schemaOpen = await schemaWriter.openGraph(openRequest(schemaGraph, 261));
  await schemaWriter.closeGraph({ graph_handle: schemaOpen.graph_handle });
  await schemaWriter.setSchemaVersion(schemaGraph, SCHEMA_VERSION + 1);
  await expectCode(schemaWriter.openGraph(openRequest(schemaGraph, 262)), "unsupported_schema");
  await schemaWriter.deleteGraph(schemaGraph);
  schemaWriter.terminate();

  return {
    append_after_recovered: true,
    corrupt_quarantined: true,
    quota_typed: true,
    transaction_abort: true,
    checkpoint_phases: true,
    unsupported_schema: true,
  };
}

export async function runRemoteOutboxCorpus() {
  const graph = graphId("remote-outbox");
  const writer = new TestCoreWorker();
  const opened = await writer.openGraph(openRequest(graph, 271));
  const serverBase = await writer.gcCheckpoint(opened.graph_handle);
  const serverTail = await writer.fixtureUpdate(
    graph,
    serverBase.checkpoint,
    901,
    ensurePage(graph, "server-page", "server-page"),
  );
  await writer.configureSync(opened.graph_handle);
  const unbased = await writer.syncState(opened.graph_handle);
  assert(unbased.pending === 0, "sync configuration must not synthesize history updates");
  assert(!unbased.has_server_base, "an unapproved local Base was marked server-owned");
  await writer.replaceRemote(
    opened.graph_handle,
    serverBase.checkpoint,
    0,
    serverBase.version_vector,
  );
  assert(
    (await writer.syncState(opened.graph_handle)).has_server_base,
    "server checkpoint did not establish the replica Base",
  );
  await writer.execute({
    graph_handle: opened.graph_handle,
    command: ensurePage(graph, "offline-page", "offline-page"),
    timeout_ms: 1_000,
  });
  const pending = await writer.syncState(opened.graph_handle);
  assert(
    pending.pending === 1,
    `saved remote edit was not added to the durable outbox: ${JSON.stringify(pending)}`,
  );
  const referenced = await writer.storageStats(graph);
  assert(referenced.outbox_bytes === 0, "incremental outbox duplicated update payload bytes");
  const queued = await writer.nextOutbox(opened.graph_handle);
  assert(queued?.bytes.length, "outbox update bytes are missing");
  assert(
    queued.message_id === (await sha256Hex(new Uint8Array(queued.bytes))),
    "outbox key must be the update content ID",
  );
  const retried = await writer.nextOutbox(opened.graph_handle);
  assert(
    retried?.message_id === queued.message_id,
    "retry changed the identity of unchanged update bytes",
  );
  const encoded = await writer.encodeSyncMessage({
    Update: {
      history_epoch: queued.history_epoch,
      message_id: queued.message_id,
      base_version_vector: queued.base_version_vector,
      bytes: queued.bytes,
    },
  });
  const decoded = (await writer.decodeSyncMessage(encoded)) as { Update?: { message_id?: string } };
  assert(decoded.Update?.message_id === queued.message_id, "browser protocol codec drifted");
  await writer.replaceRemote(
    opened.graph_handle,
    serverBase.checkpoint,
    1,
    serverBase.version_vector,
  );
  const replaced = await writer.syncState(opened.graph_handle);
  assert(replaced.history_epoch === 1, "server history epoch was not installed");
  assert(replaced.has_server_base, "history replacement lost server Base provenance");
  assert(replaced.pending === 1, "unacknowledged local intent was lost during rebase");
  const rebaseUndo = await writer.execute({
    graph_handle: opened.graph_handle,
    command: {
      graph_id: graph,
      command_id: "post-rebase-undo",
      command: { type: "undo" },
    },
    timeout_ms: 1_000,
  });
  assert(
    rebaseUndo.save_status.status === "unchanged",
    "history replacement exposed replayed intent as undoable",
  );
  const rebased = await writer.nextOutbox(opened.graph_handle);
  assert(rebased?.history_epoch === 1, "rebased outbox retained a stale epoch");
  assert(
    rebased.message_id === (await sha256Hex(new Uint8Array(rebased.bytes))),
    "history rebase did not derive its outbox key from the rebased Tail",
  );
  const replacedStats = await writer.storageStats(graph);
  assert(replacedStats.update_count === 1, "rebased intent was not normalized to one tail row");
  assert(replacedStats.outbox_bytes === 0, "rebased outbox duplicated its tail payload");
  await writer.importRemote(opened.graph_handle, serverTail);
  const resynced = await writer.read({ graph_handle: opened.graph_handle });
  assert(
    (resynced.summary as Snapshot).pages.length === 2,
    "checkpoint plus server Tail did not converge",
  );
  writer.terminate();

  const restarted = new TestCoreWorker();
  const reopened = await restarted.openGraph(openRequest(graph, 272));
  await restarted.configureSync(reopened.graph_handle);
  assert(
    (reopened.summary as Snapshot).pages.length === 2,
    "checkpoint plus Tail resync did not survive restart",
  );
  assert(
    (await restarted.syncState(reopened.graph_handle)).pending === 1,
    "restart lost unacknowledged outbox update",
  );
  await restarted.acknowledgeOutbox(reopened.graph_handle, rebased.message_id);
  const acknowledged = await restarted.syncState(reopened.graph_handle);
  assert(acknowledged.pending === 0, "acknowledgement did not remove the outbox update");
  await restarted.closeGraph({ graph_handle: reopened.graph_handle });
  await restarted.deleteGraph(graph);
  restarted.terminate();

  const legacyGraph = graphId("remote-outbox-v5");
  const legacyWriter = new TestCoreWorker();
  const legacyOpen = await legacyWriter.openGraph(openRequest(legacyGraph, 273));
  const legacyBase = await legacyWriter.gcCheckpoint(legacyOpen.graph_handle);
  await legacyWriter.configureSync(legacyOpen.graph_handle);
  await legacyWriter.replaceRemote(
    legacyOpen.graph_handle,
    legacyBase.checkpoint,
    0,
    legacyBase.version_vector,
  );
  const legacyFirst = await legacyWriter.execute({
    graph_handle: legacyOpen.graph_handle,
    command: ensurePage(legacyGraph, "legacy-first", "legacy-first"),
    timeout_ms: 1_000,
  });
  const legacySecond = await legacyWriter.execute({
    graph_handle: legacyOpen.graph_handle,
    command: ensurePage(legacyGraph, "legacy-second", "legacy-second"),
    timeout_ms: 1_000,
  });
  assert(
    legacyFirst.save_status.status === "saved_locally" &&
      legacySecond.save_status.status === "saved_locally",
    "legacy outbox fixture updates were not durable",
  );
  await legacyWriter.swapOutboxKeys(
    legacyGraph,
    legacyFirst.save_status.checksum,
    legacySecond.save_status.checksum,
  );
  legacyWriter.terminate();

  const migratedWriter = new TestCoreWorker();
  const concurrentMigrator = new TestCoreWorker();
  const [migratedOpen, concurrentOpen] = await Promise.all([
    migratedWriter.openGraph(openRequest(legacyGraph, 274)),
    concurrentMigrator.openGraph(openRequest(legacyGraph, 275)),
  ]);
  await Promise.all([
    migratedWriter.configureSync(migratedOpen.graph_handle),
    concurrentMigrator.configureSync(concurrentOpen.graph_handle),
  ]);
  const migratedFirst = await migratedWriter.nextOutbox(migratedOpen.graph_handle);
  assert(
    migratedFirst?.message_id === legacyFirst.save_status.checksum,
    "v5 key swap did not recover the first update content ID",
  );
  const concurrentlyMigratedFirst = await concurrentMigrator.nextOutbox(
    concurrentOpen.graph_handle,
  );
  assert(
    concurrentlyMigratedFirst?.message_id === legacyFirst.save_status.checksum,
    "concurrent v5 migration did not converge on the first content ID",
  );
  concurrentMigrator.terminate();
  await migratedWriter.acknowledgeOutbox(migratedOpen.graph_handle, migratedFirst.message_id);
  const migratedSecond = await migratedWriter.nextOutbox(migratedOpen.graph_handle);
  assert(
    migratedSecond?.message_id === legacySecond.save_status.checksum,
    "v5 key swap did not recover the second update content ID",
  );
  await migratedWriter.acknowledgeOutbox(migratedOpen.graph_handle, migratedSecond.message_id);
  await migratedWriter.closeGraph({ graph_handle: migratedOpen.graph_handle });
  await migratedWriter.deleteGraph(legacyGraph);
  migratedWriter.terminate();

  const corruptGraph = graphId("remote-outbox-corrupt");
  const corruptWriter = new TestCoreWorker();
  const corruptOpen = await corruptWriter.openGraph(openRequest(corruptGraph, 276));
  const corruptBase = await corruptWriter.gcCheckpoint(corruptOpen.graph_handle);
  await corruptWriter.configureSync(corruptOpen.graph_handle);
  await corruptWriter.replaceRemote(
    corruptOpen.graph_handle,
    corruptBase.checkpoint,
    0,
    corruptBase.version_vector,
  );
  await corruptWriter.execute({
    graph_handle: corruptOpen.graph_handle,
    command: ensurePage(corruptGraph, "corrupt-outbox", "corrupt-outbox"),
    timeout_ms: 1_000,
  });
  const corruptQueued = await corruptWriter.nextOutbox(corruptOpen.graph_handle);
  assert(corruptQueued, "corrupt-outbox fixture did not create a Tail record");
  await corruptWriter.corruptUpdate(corruptGraph, corruptQueued.local_sequence);
  await expectCode(corruptWriter.nextOutbox(corruptOpen.graph_handle), "storage_corrupt");
  await corruptWriter.closeGraph({ graph_handle: corruptOpen.graph_handle });
  await corruptWriter.deleteGraph(corruptGraph);
  corruptWriter.terminate();
  return {
    durable_retry: true,
    protocol_codec: true,
    epoch_rebased: true,
    checkpoint_tail_resync: true,
    acknowledged: true,
    corrupt_identity_rejected: true,
  };
}
