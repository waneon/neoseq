import { CORE_PORT_VERSION } from "./generated/core-port";
import type { OpenGraphRequest } from "./generated/core-port";
import { CorePortFailure, CoreWorker } from "./core-worker";

interface Snapshot {
  schema_version: number;
  pages: unknown[];
  quarantined: string[];
}

function graphId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function openRequest(graph: string, peer: number): OpenGraphRequest {
  return {
    contract_version: CORE_PORT_VERSION,
    locator: { graph_id: graph, location: "local", remote_graph_id: null },
    peer_id: peer,
  };
}

function ensurePage(graph: string, commandId: string, pageId: string) {
  return {
    graph_id: graph,
    command_id: commandId,
    command: { type: "ensure_page", page_id: pageId, title: pageId },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
  try {
    await action;
  } catch (error) {
    assert(error instanceof CorePortFailure, `expected CorePortFailure for ${code}`);
    assert(error.detail.code === code, `expected ${code}, received ${error.detail.code}`);
    return;
  }
  throw new Error(`expected ${code} failure`);
}

export async function runIndexedDbPersistenceCorpus() {
  const graph = graphId("indexeddb-corpus");
  const creator = new CoreWorker();
  const opened = await creator.openGraph(openRequest(graph, 201));
  assert(opened.snapshot && opened.capabilities.durable, "open must expose durable storage capability");
  const saved = await creator.execute({
    graph_handle: opened.graph_handle,
    command: ensurePage(graph, "create-home", "home"),
    timeout_ms: 1_000,
  });
  assert(saved.save_status.status === "saved_locally", "execute must acknowledge local durability");
  assert(saved.save_status.checksum.length === 64, "saved update checksum must be SHA-256");
  const before = await creator.read({ graph_handle: opened.graph_handle });
  assert(await creator.roundTripIndexCache(graph) === 4, "IndexedDB index cache did not round-trip");
  await creator.closeGraph({ graph_handle: opened.graph_handle });
  creator.terminate();

  const restorer = new CoreWorker();
  const reopened = await restorer.openGraph(openRequest(graph, 202));
  assert(JSON.stringify(reopened.snapshot) === JSON.stringify(before.snapshot), "worker restart changed the canonical snapshot");
  assert(reopened.recovery.checkpoint_sequence === 1, "close checkpoint was not selected on reopen");
  await restorer.closeGraph({ graph_handle: reopened.graph_handle });
  await restorer.deleteLocal(graph);
  restorer.terminate();
  return { graph, local_sequence: saved.save_status.status === "saved_locally" ? saved.save_status.local_sequence : 0 };
}

export async function runWorkerCorePortCorpus() {
  const golden = await fetch("/core-port-v1.json").then((response) => response.json());
  assert(golden.contract_version === CORE_PORT_VERSION, "golden contract version mismatch");
  assert(JSON.stringify(golden.operations) === JSON.stringify(["open_graph", "execute", "read", "subscribe", "close_graph"]), "golden operations changed");
  const graph = graphId("worker-port");
  const worker = new CoreWorker();
  await expectCode(worker.read({ graph_handle: "missing" }), "graph_not_open");
  const unsupported = openRequest(graph, 211);
  unsupported.contract_version += 1;
  await expectCode(worker.openGraph(unsupported), "unsupported_contract");
  const opened = await worker.openGraph(openRequest(graph, 211));
  await expectCode(worker.openGraph(openRequest(graph, 212)), "graph_already_open");
  const executed = await worker.execute({
    graph_handle: opened.graph_handle,
    command: ensurePage(graph, "port-home", "home"),
    timeout_ms: 1_000,
  });
  assert(executed.save_status.status === golden.transcript.execute, "worker save status differs from golden");
  const read = await worker.read({ graph_handle: opened.graph_handle });
  assert((read.snapshot as Snapshot).schema_version === 1, "worker read did not return schema v1");
  const subscription = await worker.subscribe({ graph_handle: opened.graph_handle, after_cursor: 0 });
  assert(subscription.events.length === 2 && !subscription.resync_required, "worker subscription transcript differs");
  const eventTypes = subscription.events.map((event) => (event as { kind: { type: string } }).kind.type);
  assert(JSON.stringify(eventTypes) === JSON.stringify(golden.transcript.subscribe), "worker event types differ from golden");
  await expectCode(worker.execute({
    graph_handle: opened.graph_handle,
    command: ensurePage(graph, "timeout", "timeout"),
    timeout_ms: 0,
  }), golden.transcript.timeout_error);
  for (let index = 0; index < 3; index += 1) {
    await worker.execute({
      graph_handle: opened.graph_handle,
      command: ensurePage(graph, `overflow-${index}`, `overflow-${index}`),
      timeout_ms: 1_000,
    });
  }
  const overflow = await worker.subscribe({ graph_handle: opened.graph_handle, after_cursor: 0 });
  assert(overflow.resync_required && overflow.events.length === 0, "subscription overflow did not request resync");
  await worker.closeGraph({ graph_handle: opened.graph_handle });
  await worker.deleteLocal(graph);
  worker.terminate();
  return { operations: golden.operations.length, errors: golden.error_codes.length };
}

export async function runIndexedDbFaultCorpus() {
  const afterGraph = graphId("append-after");
  const after = new CoreWorker();
  const afterOpen = await after.openGraph(openRequest(afterGraph, 221));
  await after.injectFault(afterOpen.graph_handle, "append_after");
  await expectCode(after.execute({
    graph_handle: afterOpen.graph_handle,
    command: ensurePage(afterGraph, "after-commit", "after"),
    timeout_ms: 1_000,
  }), "dirty_unsaved");
  after.terminate();
  const afterRecovery = new CoreWorker();
  const recovered = await afterRecovery.openGraph(openRequest(afterGraph, 222));
  assert((recovered.snapshot as Snapshot).pages.length === 1, "after-commit process kill lost durable update");
  await afterRecovery.closeGraph({ graph_handle: recovered.graph_handle });
  await afterRecovery.deleteLocal(afterGraph);
  afterRecovery.terminate();

  const corruptGraph = graphId("corrupt-tail");
  const corruptWriter = new CoreWorker();
  const corruptOpen = await corruptWriter.openGraph(openRequest(corruptGraph, 231));
  await corruptWriter.execute({
    graph_handle: corruptOpen.graph_handle,
    command: ensurePage(corruptGraph, "corrupt", "corrupt"),
    timeout_ms: 1_000,
  });
  corruptWriter.terminate();
  const corruptRecovery = new CoreWorker();
  await corruptRecovery.corruptUpdate(corruptGraph, 1);
  const recoveredCorrupt = await corruptRecovery.openGraph(openRequest(corruptGraph, 232));
  assert(recoveredCorrupt.recovery.quarantined_records[0] === "update-1", "corrupt update was not quarantined");
  assert((recoveredCorrupt.snapshot as Snapshot).pages.length === 0, "corrupt update was silently coerced");
  assert(await corruptRecovery.quarantineCount(corruptGraph) === 1, "quarantine payload/export handle missing");
  assert((await corruptRecovery.exportQuarantine(corruptGraph, "update-1")).byteLength > 0, "transferable quarantine export is empty");
  await corruptRecovery.execute({
    graph_handle: recoveredCorrupt.graph_handle,
    command: ensurePage(corruptGraph, "usable", "usable"),
    timeout_ms: 1_000,
  });
  await corruptRecovery.closeGraph({ graph_handle: recoveredCorrupt.graph_handle });
  await corruptRecovery.deleteLocal(corruptGraph);
  corruptRecovery.terminate();

  const abortGraph = graphId("abort-quota");
  const abortWorker = new CoreWorker();
  const abortOpen = await abortWorker.openGraph(openRequest(abortGraph, 241));
  await abortWorker.injectFault(abortOpen.graph_handle, "quota");
  await expectCode(abortWorker.execute({
    graph_handle: abortOpen.graph_handle,
    command: ensurePage(abortGraph, "quota", "quota"),
    timeout_ms: 1_000,
  }), "storage_full");
  await expectCode(abortWorker.closeGraph({ graph_handle: abortOpen.graph_handle }), "dirty_unsaved");
  abortWorker.terminate();

  const transactionGraph = graphId("transaction-abort");
  const transactionWorker = new CoreWorker();
  const transactionOpen = await transactionWorker.openGraph(openRequest(transactionGraph, 245));
  await transactionWorker.injectFault(transactionOpen.graph_handle, "abort");
  await expectCode(transactionWorker.execute({
    graph_handle: transactionOpen.graph_handle,
    command: ensurePage(transactionGraph, "abort", "abort"),
    timeout_ms: 1_000,
  }), "dirty_unsaved");
  await transactionWorker.retryPending(transactionOpen.graph_handle);
  await transactionWorker.closeGraph({ graph_handle: transactionOpen.graph_handle });
  await transactionWorker.deleteLocal(transactionGraph);
  transactionWorker.terminate();

  const checkpointGraph = graphId("checkpoint-fault");
  const checkpoint = new CoreWorker();
  const checkpointOpen = await checkpoint.openGraph(openRequest(checkpointGraph, 251));
  await checkpoint.execute({
    graph_handle: checkpointOpen.graph_handle,
    command: ensurePage(checkpointGraph, "checkpoint", "checkpoint"),
    timeout_ms: 1_000,
  });
  await checkpoint.injectFault(checkpointOpen.graph_handle, "checkpoint_before");
  await expectCode(checkpoint.closeGraph({ graph_handle: checkpointOpen.graph_handle }), "internal");
  await checkpoint.injectFault(checkpointOpen.graph_handle, "checkpoint_after");
  await expectCode(checkpoint.closeGraph({ graph_handle: checkpointOpen.graph_handle }), "internal");
  await checkpoint.closeGraph({ graph_handle: checkpointOpen.graph_handle });
  await checkpoint.deleteLocal(checkpointGraph);
  checkpoint.terminate();

  const schemaGraph = graphId("unsupported-schema");
  const schemaWriter = new CoreWorker();
  const schemaOpen = await schemaWriter.openGraph(openRequest(schemaGraph, 261));
  await schemaWriter.closeGraph({ graph_handle: schemaOpen.graph_handle });
  await schemaWriter.setSchemaVersion(schemaGraph, 2);
  await expectCode(schemaWriter.openGraph(openRequest(schemaGraph, 262)), "unsupported_schema");
  await schemaWriter.deleteLocal(schemaGraph);
  schemaWriter.terminate();
  return { append_after_recovered: true, corrupt_quarantined: true, quota_typed: true, transaction_abort: true, checkpoint_phases: true, unsupported_schema: true };
}
