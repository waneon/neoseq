// In-memory SessionPort double for component tests. It mirrors the core's
// command semantics (journal idempotence, tag default copy, property
// validation, undo/redo) without instantiating Loro or a Worker.

import type {
  CloseGraphRequest,
  CloseGraphResponse,
  CorePortError,
  ExecuteRequest,
  ExecuteResponse,
  OpenGraphRequest,
  OpenGraphResponse,
  ReadRequest,
  ReadResponse,
  SubscribeRequest,
  SubscribeResponse,
} from "../../generated/core-port";
import { CorePortFailure, type SavedReceipt } from "../../core-worker";
import type { Command, CommandEnvelope } from "../commands";
import type {
  BlockSnapshot,
  GraphSnapshot,
  PageSnapshot,
  PropertyEntry,
  PropertyValue,
} from "../snapshot";
import { sameValue, validateDefault, validateValue } from "../../entities/properties";
import type { SessionPort } from "../session";

interface GraphEventRecord {
  cursor: number;
  source: "local";
  kind: Record<string, unknown>;
}

function fail(code: CorePortError["code"], message: string, retryable = false): never {
  throw new CorePortFailure({ code, message, retryable });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class FakeCorePort implements SessionPort {
  private pages: PageSnapshot[] = [];
  private history: PageSnapshot[][] = [];
  private future: PageSnapshot[][] = [];
  private events: GraphEventRecord[] = [];
  private nextCursor = 1;
  private sequence = 0;
  private blockCounter = 0;
  private open = false;
  private graphId = "";

  /** Set to make the next execute report a non-durable write. */
  failNextSave: CorePortError | null = null;
  /** Optional barrier for deterministic command-ordering component tests. */
  beforeExecute: ((command: Command) => Promise<void>) | null = null;
  private pendingSave = false;

  async openGraph(request: OpenGraphRequest): Promise<OpenGraphResponse> {
    this.open = true;
    this.graphId = request.locator.graph_id;
    return {
      graph_handle: `fake:${this.graphId}`,
      snapshot: this.snapshot(),
      capabilities: { durable: true, persisted: true, quota_bytes: 10_000_000, usage_bytes: 1_000 },
      recovery: { checkpoint_sequence: 0, replayed_updates: 0, quarantined_records: [] },
    };
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    if (!this.open) fail("graph_not_open", "graph is not open");
    const envelope = request.command as CommandEnvelope;
    const command = envelope.command;
    await this.beforeExecute?.(command);
    const before = clone(this.pages);
    const result = {
      command_id: envelope.command_id,
      created_page: null as string | null,
      created_block: null as string | null,
      changed: true,
    };
    this.apply(command, result);
    if (command.type !== "undo" && command.type !== "redo" && result.changed) {
      this.history.push(before);
      this.future = [];
    }
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = null;
      this.pendingSave = true;
      throw new CorePortFailure(error);
    }
    this.sequence += 1;
    this.pushEvent({ type: "semantic", name: command.type, command_id: envelope.command_id });
    this.pushEvent({ type: "saved_locally", local_sequence: this.sequence, checksum: "fake" });
    return {
      result,
      save_status: { status: "saved_locally", local_sequence: this.sequence, checksum: "fake" },
    };
  }

  async read(_request: ReadRequest): Promise<ReadResponse> {
    if (!this.open) fail("graph_not_open", "graph is not open");
    return { snapshot: this.snapshot() };
  }

  async subscribe(request: SubscribeRequest): Promise<SubscribeResponse> {
    return {
      events: this.events.filter((event) => event.cursor > request.after_cursor),
      next_cursor: this.nextCursor - 1,
      resync_required: false,
    };
  }

  async closeGraph(_request: CloseGraphRequest): Promise<CloseGraphResponse> {
    this.open = false;
    return { closed: true };
  }

  async retryPending(_graphHandle: string): Promise<SavedReceipt> {
    if (!this.pendingSave) fail("invalid_request", "nothing pending");
    this.pendingSave = false;
    this.sequence += 1;
    return { status: "saved_locally", local_sequence: this.sequence, checksum: "fake" };
  }

  terminate(): void {
    this.open = false;
  }

  private snapshot(): GraphSnapshot {
    return clone({
      schema_version: 1,
      graph_id: this.graphId,
      pages: this.pages.filter((page) => !hasKey(page.properties, "system.deleted-at")),
      quarantined: [],
    });
  }

  private pushEvent(kind: Record<string, unknown>): void {
    this.events.push({ cursor: this.nextCursor, source: "local", kind });
    this.nextCursor += 1;
  }

  private apply(command: Command, result: { created_page: string | null; created_block: string | null; changed: boolean }): void {
    switch (command.type) {
      case "ensure_page": {
        if (!this.rawPage(command.page_id)) {
          this.pages.push(newPage(command.page_id, "regular", command.title, null));
          result.created_page = command.page_id;
        } else {
          result.changed = false;
        }
        break;
      }
      case "ensure_journal": {
        const id = `journal-${command.date}`;
        if (!this.rawPage(id)) {
          this.pages.push(newPage(id, "journal", null, command.date));
          result.created_page = id;
        } else {
          result.changed = false;
        }
        break;
      }
      case "rename_page":
        setSingle(this.requirePage(command.page_id).properties, "page.title", {
          type: "string",
          value: command.title,
        });
        break;
      case "delete_page":
        setSingle(this.requirePage(command.page_id).properties, "system.deleted-at", {
          type: "string",
          value: "now",
        });
        break;
      case "restore_page": {
        const page = this.rawPage(command.page_id);
        if (!page) fail("internal", `page does not exist: ${command.page_id}`);
        page.properties = page.properties.filter((entry) => entry.key !== "system.deleted-at");
        break;
      }
      case "insert_block": {
        const page = this.requirePage(command.page_id);
        const id = `b-${(this.blockCounter += 1)}`;
        const block: BlockSnapshot = {
          id,
          markdown: command.markdown,
          properties: command.parent
            ? []
            : [{ key: "block.page", value: { type: "page", value: command.page_id } }],
          children: [],
        };
        const siblings = command.parent
          ? this.requireBlock(command.parent).block.children
          : page.blocks;
        siblings.splice(Math.min(command.index, siblings.length), 0, block);
        result.created_block = id;
        break;
      }
      case "edit_markdown":
        this.requireBlock(command.block_id).block.markdown = command.markdown;
        break;
      case "splice_markdown": {
        const block = this.requireBlock(command.block_id).block;
        const points = Array.from(block.markdown);
        if (command.index + command.delete > points.length) {
          fail("internal", "markdown splice is out of bounds");
        }
        points.splice(command.index, command.delete, ...Array.from(command.insert));
        block.markdown = points.join("");
        break;
      }
      case "move_block": {
        const { block } = this.requireBlock(command.block_id);
        this.detach(command.block_id);
        const page = this.requirePage(command.page_id);
        if (command.parent) {
          block.properties = block.properties.filter((entry) => entry.key !== "block.page");
          const siblings = this.requireBlock(command.parent).block.children;
          siblings.splice(Math.min(command.index, siblings.length), 0, block);
        } else {
          setSingle(block.properties, "block.page", { type: "page", value: command.page_id });
          page.blocks.splice(Math.min(command.index, page.blocks.length), 0, block);
        }
        break;
      }
      case "indent_block": {
        const found = this.requireBlock(command.block_id);
        const siblings = found.siblings;
        const position = siblings.indexOf(found.block);
        if (position === 0) fail("internal", "first sibling cannot be indented");
        const target = siblings[position - 1];
        siblings.splice(position, 1);
        found.block.properties = found.block.properties.filter(
          (entry) => entry.key !== "block.page",
        );
        target.children.push(found.block);
        break;
      }
      case "outdent_block": {
        const found = this.requireBlock(command.block_id);
        if (!found.parent) fail("internal", "root block cannot be outdented");
        const parentFound = this.requireBlock(found.parent.id);
        found.siblings.splice(found.siblings.indexOf(found.block), 1);
        const grandSiblings = parentFound.siblings;
        if (parentFound.parent === null) {
          setSingle(found.block.properties, "block.page", {
            type: "page",
            value: parentFound.page.id,
          });
        }
        grandSiblings.splice(grandSiblings.indexOf(parentFound.block) + 1, 0, found.block);
        break;
      }
      case "delete_block":
        this.detach(command.block_id);
        break;
      case "set_property": {
        const issue = validateValue(command.key, command.value, "single");
        if (issue) fail("internal", issue.message);
        setSingle(this.entityBag(command.entity), command.key, command.value);
        break;
      }
      case "remove_property": {
        const bag = this.entityBag(command.entity);
        removeAll(bag, command.key);
        break;
      }
      case "add_repeated_property": {
        const issue = validateValue(command.key, command.value, "repeated");
        if (issue) fail("internal", issue.message);
        const bag = this.entityBag(command.entity);
        if (!bag.some((e) => e.key === command.key && sameValue(e.value, command.value))) {
          bag.push({ key: command.key, value: command.value });
        }
        break;
      }
      case "remove_repeated_property": {
        const bag = this.entityBag(command.entity);
        const index = bag.findIndex(
          (e) => e.key === command.key && sameValue(e.value, command.value),
        );
        if (index >= 0) bag.splice(index, 1);
        break;
      }
      case "set_page_default": {
        const issue = validateDefault(command.key, command.value);
        if (issue) fail("internal", issue.message);
        setSingle(this.requirePage(command.page_id).defaults, command.key, command.value);
        break;
      }
      case "remove_page_default":
        removeAll(this.requirePage(command.page_id).defaults, command.key);
        break;
      case "add_tag": {
        const block = this.requireBlock(command.block_id).block;
        const page = this.requirePage(command.page_id);
        const tag: PropertyValue = { type: "page", value: command.page_id };
        if (!block.properties.some((e) => e.key === "tag" && sameValue(e.value, tag))) {
          block.properties.push({ key: "tag", value: tag });
        }
        for (const entry of page.defaults) {
          if (!hasKey(block.properties, entry.key)) {
            block.properties.push(clone(entry));
          }
        }
        break;
      }
      case "undo": {
        const previous = this.history.pop();
        if (previous) {
          this.future.push(clone(this.pages));
          this.pages = previous;
        } else {
          result.changed = false;
        }
        break;
      }
      case "redo": {
        const next = this.future.pop();
        if (next) {
          this.history.push(clone(this.pages));
          this.pages = next;
        } else {
          result.changed = false;
        }
        break;
      }
    }
  }

  private rawPage(id: string): PageSnapshot | undefined {
    return this.pages.find((page) => page.id === id);
  }

  private requirePage(id: string): PageSnapshot {
    const page = this.rawPage(id);
    if (!page) fail("internal", `page does not exist: ${id}`);
    if (hasKey(page.properties, "system.deleted-at")) {
      fail("internal", `page is deleted: ${id}`);
    }
    return page;
  }

  private requireBlock(id: string): {
    block: BlockSnapshot;
    siblings: BlockSnapshot[];
    parent: BlockSnapshot | null;
    page: PageSnapshot;
  } {
    for (const page of this.pages) {
      const found = findIn(page.blocks, null, id, page);
      if (found) return found;
    }
    fail("internal", `block does not exist or is deleted: ${id}`);
  }

  private detach(id: string): void {
    const found = this.requireBlock(id);
    found.siblings.splice(found.siblings.indexOf(found.block), 1);
  }

  private entityBag(entity: { kind: "page" | "block"; id: string }): PropertyEntry[] {
    return entity.kind === "page"
      ? this.requirePage(entity.id).properties
      : this.requireBlock(entity.id).block.properties;
  }
}

function findIn(
  blocks: BlockSnapshot[],
  parent: BlockSnapshot | null,
  id: string,
  page: PageSnapshot,
): { block: BlockSnapshot; siblings: BlockSnapshot[]; parent: BlockSnapshot | null; page: PageSnapshot } | null {
  for (const block of blocks) {
    if (block.id === id) return { block, siblings: blocks, parent, page };
    const nested = findIn(block.children, block, id, page);
    if (nested) return nested;
  }
  return null;
}

function newPage(
  id: string,
  kind: "regular" | "journal",
  title: string | null,
  date: string | null,
): PageSnapshot {
  const properties: PropertyEntry[] = [
    { key: "page.kind", value: { type: "string", value: kind } },
    { key: "system.created-at", value: { type: "string", value: "t0" } },
  ];
  if (title !== null) properties.push({ key: "page.title", value: { type: "string", value: title } });
  if (date !== null) properties.push({ key: "journal.date", value: { type: "date", value: date } });
  properties.sort((a, b) => a.key.localeCompare(b.key));
  return { id, properties, defaults: [], blocks: [] };
}

function hasKey(bag: PropertyEntry[], key: string): boolean {
  return bag.some((entry) => entry.key === key);
}

function setSingle(bag: PropertyEntry[], key: string, value: PropertyValue): void {
  const existing = bag.find((entry) => entry.key === key);
  if (existing) existing.value = value;
  else bag.push({ key, value });
}

function removeAll(bag: PropertyEntry[], key: string): void {
  for (let index = bag.length - 1; index >= 0; index -= 1) {
    if (bag[index].key === key) bag.splice(index, 1);
  }
}

/** Convenience: an already-open session backed by the fake port. */
export async function openFakeSession(graphId = "test-graph") {
  const { GraphSession } = await import("../session");
  const port = new FakeCorePort();
  const session = new GraphSession(graphId, port);
  await session.open();
  return { session, port };
}
