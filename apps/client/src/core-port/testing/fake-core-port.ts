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
  QueryRequest,
  QueryResponse,
  SparqlQueryResult,
  ReadPageRequest,
  ReadPageResponse,
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
  GraphSummary,
  PageSnapshot,
  PropertyEntry,
  PropertyValue,
  TagSnapshot,
} from "../snapshot";
import { sameValue, validateDefault, validateValue } from "../../entities/properties";
import { canonicalEntityName } from "../../entities/names";
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
  private tags: TagSnapshot[] = [];
  private history: Array<{ pages: PageSnapshot[]; tags: TagSnapshot[] }> = [];
  private future: Array<{ pages: PageSnapshot[]; tags: TagSnapshot[] }> = [];
  private events: GraphEventRecord[] = [];
  private nextCursor = 1;
  private sequence = 0;
  private blockCounter = 0;
  private open = false;
  private graphId = "";

  queryResult: SparqlQueryResult | null = null;

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
      summary: this.summary(),
      capabilities: { durable: true, persisted: true, quota_bytes: 10_000_000, usage_bytes: 1_000 },
      recovery: { checkpoint_sequence: 0, replayed_updates: 0, quarantined_records: [] },
    };
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    if (!this.open) fail("graph_not_open", "graph is not open");
    const envelope = request.command as CommandEnvelope;
    const command = envelope.command;
    await this.beforeExecute?.(command);
    const before = this.capture();
    const result = {
      command_id: envelope.command_id,
      created_page: null as string | null,
      created_block: null as string | null,
      created_tag: null as string | null,
      changed: true,
    };
    try {
      this.apply(command, result);
      if (command.type !== "undo" && command.type !== "redo" && result.changed) {
        this.touchCommand(command, result, `t${this.sequence + 1}`);
      }
    } catch (error) {
      this.restore(before);
      throw error;
    }
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
    return { summary: this.summary() };
  }

  async readPage(request: ReadPageRequest): Promise<ReadPageResponse> {
    if (!this.open) fail("graph_not_open", "graph is not open");
    return { page: clone(this.requirePage(request.page_id)) };
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    if (!this.open) fail("graph_not_open", "graph is not open");
    if (this.pendingSave) fail("dirty_unsaved", "retry pending update before querying", true);
    if (this.queryResult) return { result: clone(this.queryResult) };
    const ask = /^\s*(?:PREFIX\s+[^\n]+\s*)*ASK\b/i.test(request.query.source);
    return {
      result: ask
        ? { kind: "ask", value: false, revision: this.sequence, frontier: `fake-${this.sequence}` }
        : {
            kind: "select",
            variables: [],
            rows: [],
            revision: this.sequence,
            frontier: `fake-${this.sequence}`,
          },
    };
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
      schema_version: 3,
      graph_id: this.graphId,
      pages: this.pages.filter((page) => !hasKey(page.properties, "system.deleted-at")),
      tags: this.tags.filter((tag) => !hasKey(tag.properties, "system.deleted-at")),
      quarantined: [],
    });
  }

  private summary(): GraphSummary {
    const snapshot = this.snapshot();
    return {
      ...snapshot,
      pages: snapshot.pages.map(({ blocks: _blocks, ...page }) => page),
    };
  }

  private pushEvent(kind: Record<string, unknown>): void {
    this.events.push({ cursor: this.nextCursor, source: "local", kind });
    this.nextCursor += 1;
  }

  private apply(command: Command, result: { created_page: string | null; created_block: string | null; created_tag: string | null; changed: boolean }): void {
    switch (command.type) {
      case "ensure_page": {
        if (!this.rawPage(command.page_id)) {
          this.assertPageNameAvailable(command.title, command.page_id);
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
        this.assertPageNameAvailable(command.title, command.page_id);
        this.requirePage(command.page_id).title = command.title;
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
        this.assertPageNameAvailable(page.title, page.id);
        page.properties = page.properties.filter((entry) => entry.key !== "system.deleted-at");
        break;
      }
      case "ensure_tag": {
        if (!this.rawTag(command.tag_id)) {
          this.assertTagNameAvailable(command.name, command.tag_id);
          this.tags.push({ id: command.tag_id, name: command.name, properties: [], defaults: [] });
          result.created_tag = command.tag_id;
        } else {
          result.changed = false;
        }
        break;
      }
      case "rename_tag":
        this.assertTagNameAvailable(command.name, command.tag_id);
        this.requireTag(command.tag_id).name = command.name;
        break;
      case "delete_tag":
        setSingle(this.requireTag(command.tag_id).properties, "system.deleted-at", {
          type: "string",
          value: "now",
        });
        break;
      case "restore_tag": {
        const tag = this.rawTag(command.tag_id);
        if (!tag) fail("internal", `tag does not exist: ${command.tag_id}`);
        this.assertTagNameAvailable(tag.name, tag.id);
        tag.properties = tag.properties.filter((entry) => entry.key !== "system.deleted-at");
        break;
      }
      case "insert_block": {
        const page = this.requirePage(command.page_id);
        const id = `b-${(this.blockCounter += 1)}`;
        const block: BlockSnapshot = {
          id,
          markdown: command.markdown,
          properties: [],
          tags: [],
          children: [],
        };
        const siblings = command.parent
          ? this.requireBlock(command.page_id, command.parent).block.children
          : page.blocks;
        siblings.splice(Math.min(command.index, siblings.length), 0, block);
        result.created_block = id;
        break;
      }
      case "insert_outline": {
        if (command.items.length === 0 || command.items[0].depth !== 0) {
          fail("internal", "outline insert must start at depth zero");
        }
        command.items.forEach((item, index) => {
          if (index > 0 && item.depth > command.items[index - 1].depth + 1) {
            fail("internal", "outline insert skips a depth");
          }
        });
        const requestedSiblings = command.parent
          ? this.requireBlock(command.page_id, command.parent).block.children
          : this.requirePage(command.page_id).blocks;
        let baseSiblings = requestedSiblings;
        let baseIndex = command.index;
        const levels: BlockSnapshot[] = [];
        let rootOffset = 0;

        if (command.replace) {
          const target = this.requireBlock(command.page_id, command.replace);
          if (target.block.markdown !== "") fail("internal", "outline replacement block is not empty");
          baseSiblings = target.siblings;
          baseIndex = target.siblings.indexOf(target.block);
          rootOffset = 1;
        }

        command.items.forEach((item, position) => {
          let block: BlockSnapshot;
          if (position === 0 && command.replace) {
            block = this.requireBlock(command.page_id, command.replace).block;
            block.markdown = item.markdown;
          } else {
            const id = `b-${(this.blockCounter += 1)}`;
            block = { id, markdown: item.markdown, properties: [], tags: [], children: [] };
            if (item.depth === 0) {
              baseSiblings.splice(Math.min(baseIndex + rootOffset, baseSiblings.length), 0, block);
              rootOffset += 1;
            } else {
              const parent = levels[item.depth - 1];
              if (!parent) fail("internal", "outline insert skips a depth");
              parent.children.push(block);
            }
          }
          levels[item.depth] = block;
          levels.length = item.depth + 1;
          result.created_block = block.id;
        });
        break;
      }
      case "edit_markdown":
        this.requireBlock(command.page_id, command.block_id).block.markdown = command.markdown;
        break;
      case "splice_markdown": {
        const block = this.requireBlock(command.page_id, command.block_id).block;
        const points = Array.from(block.markdown);
        if (command.index + command.delete > points.length) {
          fail("internal", "markdown splice is out of bounds");
        }
        points.splice(command.index, command.delete, ...Array.from(command.insert));
        block.markdown = points.join("");
        break;
      }
      case "move_blocks": {
        const roots = this.structuralRoots(command.page_id, command.block_ids);
        const rootSet = new Set(roots);
        const target = command.parent
          ? this.requireBlock(command.page_id, command.parent).block.children
          : this.requirePage(command.page_id).blocks;
        const stationary = target.filter((block) => !rootSet.has(block.id));
        let anchor = stationary[Math.min(command.index, stationary.length) - 1] ?? null;
        for (const blockId of roots) {
          const { block } = this.requireBlock(command.page_id, blockId);
          this.detach(command.page_id, blockId);
          const siblings = command.parent
            ? this.requireBlock(command.page_id, command.parent).block.children
            : this.requirePage(command.page_id).blocks;
          const anchorIndex = anchor ? siblings.indexOf(anchor) : -1;
          if (anchor && anchorIndex < 0) fail("internal", "move anchor is not a target sibling");
          const index = anchorIndex + 1;
          siblings.splice(index, 0, block);
          anchor = block;
        }
        break;
      }
      case "indent_blocks": {
        for (const blockId of this.structuralRoots(command.page_id, command.block_ids)) {
          const found = this.requireBlock(command.page_id, blockId);
          const siblings = found.siblings;
          const position = siblings.indexOf(found.block);
          if (position === 0) fail("internal", "first sibling cannot be indented");
          const target = siblings[position - 1];
          siblings.splice(position, 1);
          target.children.push(found.block);
        }
        break;
      }
      case "outdent_blocks": {
        const roots = this.structuralRoots(command.page_id, command.block_ids).reverse();
        for (const blockId of roots) {
          const found = this.requireBlock(command.page_id, blockId);
          if (!found.parent) fail("internal", "root block cannot be outdented");
          const parentFound = this.requireBlock(command.page_id, found.parent.id);
          found.siblings.splice(found.siblings.indexOf(found.block), 1);
          const grandSiblings = parentFound.siblings;
          grandSiblings.splice(grandSiblings.indexOf(parentFound.block) + 1, 0, found.block);
        }
        break;
      }
      case "delete_blocks":
        for (const blockId of this.structuralRoots(command.page_id, command.block_ids)) {
          this.detach(command.page_id, blockId);
        }
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
      case "set_tag_default": {
        const issue = validateDefault(command.key, command.value);
        if (issue) fail("internal", issue.message);
        setSingle(this.requireTag(command.tag_id).defaults, command.key, command.value);
        break;
      }
      case "remove_tag_default":
        removeAll(this.requireTag(command.tag_id).defaults, command.key);
        break;
      case "add_tag": {
        const tags = this.entityTags(command.entity);
        const tag = this.requireTag(command.tag_id);
        if (!tags.includes(command.tag_id)) tags.push(command.tag_id);
        const bag = this.entityBag(command.entity);
        for (const entry of tag.defaults) {
          if (!hasKey(bag, entry.key)) {
            bag.push(clone(entry));
          }
        }
        break;
      }
      case "remove_tag": {
        const tags = this.entityTags(command.entity);
        const index = tags.indexOf(command.tag_id);
        if (index >= 0) tags.splice(index, 1);
        break;
      }
      case "undo": {
        const previous = this.history.pop();
        if (previous) {
          this.future.push(this.capture());
          this.restore(previous);
        } else {
          result.changed = false;
        }
        break;
      }
      case "redo": {
        const next = this.future.pop();
        if (next) {
          this.history.push(this.capture());
          this.restore(next);
        } else {
          result.changed = false;
        }
        break;
      }
    }
  }

  private assertPageNameAvailable(name: string, exceptId: string): void {
    const canonical = canonicalEntityName(name);
    if (!canonical) fail("invalid_request", "page name must not be empty");
    const existing = this.pages.find((page) =>
      page.id !== exceptId
      && !hasKey(page.properties, "system.deleted-at")
      && canonicalEntityName(page.title) === canonical
    );
    if (existing) {
      fail("invalid_request", `page name already exists: ${name} (page ${existing.id})`);
    }
  }

  private assertTagNameAvailable(name: string, exceptId: string): void {
    const canonical = canonicalEntityName(name);
    if (!canonical) fail("invalid_request", "tag name must not be empty");
    const existing = this.tags.find((tag) =>
      tag.id !== exceptId
      && !hasKey(tag.properties, "system.deleted-at")
      && canonicalEntityName(tag.name) === canonical
    );
    if (existing) {
      fail("invalid_request", `tag name already exists: ${name} (tag ${existing.id})`);
    }
  }

  private rawPage(id: string): PageSnapshot | undefined {
    return this.pages.find((page) => page.id === id);
  }

  private touchCommand(
    command: Command,
    result: { created_page: string | null; created_block: string | null },
    timestamp: string,
  ): void {
    switch (command.type) {
      case "ensure_page":
      case "ensure_journal":
        if (result.created_page) this.touchPage(result.created_page, timestamp);
        break;
      case "rename_page":
      case "delete_page":
      case "restore_page":
        this.touchPage(command.page_id, timestamp);
        break;
      case "insert_block":
        if (result.created_block) this.touchBlock(command.page_id, result.created_block, timestamp);
        this.touchPage(command.page_id, timestamp);
        break;
      case "insert_outline":
        if (result.created_block) this.touchBlock(command.page_id, result.created_block, timestamp);
        this.touchPage(command.page_id, timestamp);
        break;
      case "edit_markdown":
      case "splice_markdown":
        this.touchBlock(command.page_id, command.block_id, timestamp);
        this.touchPage(command.page_id, timestamp);
        break;
      case "move_blocks":
      case "indent_blocks":
      case "outdent_blocks":
        for (const blockId of command.block_ids) this.touchBlock(command.page_id, blockId, timestamp);
        this.touchPage(command.page_id, timestamp);
        break;
      case "delete_blocks":
        this.touchPage(command.page_id, timestamp);
        break;
      case "set_property":
      case "remove_property":
      case "add_repeated_property":
      case "remove_repeated_property":
      case "add_tag":
      case "remove_tag":
        this.touchEntity(command.entity, timestamp);
        break;
      case "ensure_tag":
      case "rename_tag":
      case "delete_tag":
      case "restore_tag":
      case "set_tag_default":
      case "remove_tag_default":
      case "undo":
      case "redo":
        break;
    }
  }

  private touchEntity(
    entity: { kind: "page"; id: string } | { kind: "block"; page_id: string; id: string },
    timestamp: string,
  ): void {
    if (entity.kind === "page") {
      this.touchPage(entity.id, timestamp);
    } else {
      this.touchBlock(entity.page_id, entity.id, timestamp);
      this.touchPage(entity.page_id, timestamp);
    }
  }

  private touchPage(pageId: string, timestamp: string): void {
    const page = this.rawPage(pageId);
    if (!page) fail("internal", `page does not exist: ${pageId}`);
    setSingle(page.properties, "system.updated-at", {
      type: "string",
      value: timestamp,
    });
  }

  private touchBlock(pageId: string, blockId: string, timestamp: string): void {
    setSingle(this.requireBlock(pageId, blockId).block.properties, "system.updated-at", {
      type: "string",
      value: timestamp,
    });
  }

  private rawTag(id: string): TagSnapshot | undefined {
    return this.tags.find((tag) => tag.id === id);
  }

  private requireTag(id: string): TagSnapshot {
    const tag = this.rawTag(id);
    if (!tag || hasKey(tag.properties, "system.deleted-at")) {
      fail("internal", `tag does not exist or is deleted: ${id}`);
    }
    return tag;
  }

  private requirePage(id: string): PageSnapshot {
    const page = this.rawPage(id);
    if (!page) fail("internal", `page does not exist: ${id}`);
    if (hasKey(page.properties, "system.deleted-at")) {
      fail("internal", `page is deleted: ${id}`);
    }
    return page;
  }

  private requireBlock(pageId: string, id: string): {
    block: BlockSnapshot;
    siblings: BlockSnapshot[];
    parent: BlockSnapshot | null;
    page: PageSnapshot;
  } {
    const page = this.requirePage(pageId);
    const found = findIn(page.blocks, null, id, page);
    if (found) return found;
    fail("internal", `block does not exist or is deleted: ${id}`);
  }

  private structuralRoots(pageId: string, ids: string[]): string[] {
    if (ids.length === 0) fail("internal", "structural command requires at least one block");
    const requested = new Set(ids);
    const found = new Set<string>();
    const roots: string[] = [];
    const visit = (blocks: BlockSnapshot[], covered: boolean) => {
      for (const block of blocks) {
        const selected = requested.has(block.id);
        if (selected) found.add(block.id);
        if (selected && !covered) roots.push(block.id);
        visit(block.children, covered || selected);
      }
    };
    visit(this.requirePage(pageId).blocks, false);
    if (found.size !== requested.size) fail("internal", "structural command targets a missing block");
    return roots;
  }

  private detach(pageId: string, id: string): void {
    const found = this.requireBlock(pageId, id);
    found.siblings.splice(found.siblings.indexOf(found.block), 1);
  }

  private entityBag(entity: { kind: "page"; id: string } | { kind: "block"; page_id: string; id: string }): PropertyEntry[] {
    return entity.kind === "page"
      ? this.requirePage(entity.id).properties
      : this.requireBlock(entity.page_id, entity.id).block.properties;
  }

  private entityTags(entity: { kind: "page"; id: string } | { kind: "block"; page_id: string; id: string }): string[] {
    return entity.kind === "page"
      ? this.requirePage(entity.id).tags
      : this.requireBlock(entity.page_id, entity.id).block.tags;
  }

  private capture(): { pages: PageSnapshot[]; tags: TagSnapshot[] } {
    return clone({ pages: this.pages, tags: this.tags });
  }

  private restore(state: { pages: PageSnapshot[]; tags: TagSnapshot[] }): void {
    this.pages = clone(state.pages);
    this.tags = clone(state.tags);
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
  if (date !== null) properties.push({ key: "journal.date", value: { type: "date", value: date } });
  properties.sort((a, b) => a.key.localeCompare(b.key));
  return { id, title: title ?? "", properties, tags: [], blocks: [] };
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
