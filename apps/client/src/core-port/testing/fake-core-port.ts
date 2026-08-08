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
import type {
  Command,
  CommandEnvelope,
  EntityRef,
  HistoryEffect,
  PropertyOwnerRef,
} from "../commands";
import type {
  BlockSnapshot,
  GraphSnapshot,
  GraphSummary,
  PageSnapshot,
  PropertyField,
  PropertyValue,
  TagSnapshot,
} from "../snapshot";
import {
  sameValue,
  validateFieldShape,
  validateValue,
  validateWriteTarget,
} from "../../entities/properties";
import { canonicalEntityName } from "../../entities/names";
import type { SessionPort } from "../session";

interface GraphEventRecord {
  cursor: number;
  source: "local";
  kind: Record<string, unknown>;
}

interface FakeHistoryEntry {
  scope: HistoryEffect["scope"];
  affectedPages: string[];
  undoCandidates: EntityRef[];
  redoCandidates: EntityRef[];
  redoCreatedBlock?: boolean;
  redoCreatedPage?: boolean;
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
  private historyEntries: FakeHistoryEntry[] = [];
  private futureEntries: FakeHistoryEntry[] = [];
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
      history_effect: null as HistoryEffect | null,
    };
    const timestamp = `t${this.sequence + 1}`;
    const historyEntry = command.type === "undo" || command.type === "redo"
      ? null
      : this.planHistory(command);
    try {
      this.apply(command, result, timestamp);
      if (command.type !== "undo" && command.type !== "redo" && result.changed) {
        this.touchCommand(command, result, timestamp);
      }
    } catch (error) {
      this.restore(before);
      throw error;
    }
    if (command.type !== "undo" && command.type !== "redo" && result.changed) {
      this.history.push(before);
      if (historyEntry) this.historyEntries.push(this.finishHistory(historyEntry, result));
      this.future = [];
      this.futureEntries = [];
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
    const liveTags = new Set(
      this.tags
        .filter((tag) => !hasKey(tag.properties, "builtin.deleted-at"))
        .map((tag) => tag.id),
    );
    return clone({
      schema_version: 1,
      graph_id: this.graphId,
      pages: this.pages
        .filter((page) => !hasKey(page.properties, "builtin.deleted-at"))
        .map((page) => projectLiveTags(page, liveTags)),
      tags: this.tags.filter((tag) => !hasKey(tag.properties, "builtin.deleted-at")),
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

  private apply(
    command: Command,
    result: {
      created_page: string | null;
      created_block: string | null;
      created_tag: string | null;
      changed: boolean;
      history_effect: HistoryEffect | null;
    },
    timestamp: string,
  ): void {
    switch (command.type) {
      case "ensure_page": {
        if (!this.rawPage(command.page_id)) {
          this.assertPageNameAvailable(command.title, command.page_id);
          this.pages.push(newPage(command.page_id, "regular", command.title, null, timestamp));
          result.created_page = command.page_id;
        } else {
          result.changed = false;
        }
        break;
      }
      case "ensure_journal": {
        const id = `journal-${command.date}`;
        if (!this.rawPage(id)) {
          this.pages.push(newPage(id, "journal", null, command.date, timestamp));
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
        setSingle(this.requirePage(command.page_id).properties, "builtin.deleted-at", {
          type: "string",
          value: timestamp,
        });
        break;
      case "restore_page": {
        const page = this.rawPage(command.page_id);
        if (!page) fail("internal", `page does not exist: ${command.page_id}`);
        this.assertPageNameAvailable(page.title, page.id);
        page.properties = page.properties.filter((entry) => entry.key !== "builtin.deleted-at");
        break;
      }
      case "ensure_tag": {
        if (!this.rawTag(command.tag_id)) {
          this.assertTagNameAvailable(command.name, command.tag_id);
          this.tags.push({
            id: command.tag_id,
            name: command.name,
            properties: lifecycle(timestamp),
            defaults: [],
          });
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
        setSingle(this.requireTag(command.tag_id).properties, "builtin.deleted-at", {
          type: "string",
          value: timestamp,
        });
        this.detachTagFromAllNodes(command.tag_id, timestamp);
        break;
      case "restore_tag": {
        const tag = this.rawTag(command.tag_id);
        if (!tag) fail("internal", `tag does not exist: ${command.tag_id}`);
        this.assertTagNameAvailable(tag.name, tag.id);
        tag.properties = tag.properties.filter((entry) => entry.key !== "builtin.deleted-at");
        break;
      }
      case "insert_block": {
        const page = this.requirePage(command.page_id);
        const id = `b-${(this.blockCounter += 1)}`;
        const block: BlockSnapshot = {
          id,
          markdown: command.markdown,
          properties: lifecycle(timestamp),
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
      case "split_block": {
        const target = this.requireBlock(command.page_id, command.block_id);
        const points = Array.from(target.block.markdown);
        if (command.index > points.length) {
          fail("internal", "block split is out of bounds");
        }
        if ((command.index === 0) !== (command.placement === "before")) {
          fail("internal", "a leading split must create a block before the target");
        }
        const id = `b-${(this.blockCounter += 1)}`;
        const block: BlockSnapshot = {
          id,
          markdown: command.index === 0 ? "" : points.slice(command.index).join(""),
          properties: lifecycle(timestamp),
          tags: [],
          children: [],
        };
        if (command.index > 0) {
          target.block.markdown = points.slice(0, command.index).join("");
        }
        if (command.placement === "first_child") {
          target.block.children.unshift(block);
        } else {
          const targetIndex = target.siblings.indexOf(target.block);
          target.siblings.splice(targetIndex + (command.placement === "after" ? 1 : 0), 0, block);
        }
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
            setSingle(block.properties, "builtin.updated-at", {
              type: "string",
              value: timestamp,
            });
          } else {
            const id = `b-${(this.blockCounter += 1)}`;
            block = {
              id,
              markdown: item.markdown,
              properties: lifecycle(timestamp),
              tags: [],
              children: [],
            };
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
      case "ensure_property": {
        const target = propertyOwnerTarget(command.owner);
        const cardinality = command.cardinality === "set" ? "repeated" : "single";
        const issue = validateWriteTarget(command.key, target)
          ?? validateFieldShape(command.key, command.value_type, cardinality);
        if (issue) fail("internal", issue.message);
        ensureField(
          this.propertyOwnerBag(command.owner),
          command.key,
          command.value_type,
          command.cardinality,
        );
        break;
      }
      case "set_property": {
        const target = propertyOwnerTarget(command.owner);
        const issue = validateWriteTarget(command.key, target)
          ?? validateValue(command.key, command.value, "single");
        if (issue) fail("internal", issue.message);
        setSingle(this.propertyOwnerBag(command.owner), command.key, command.value);
        break;
      }
      case "clear_property_values": {
        const issue = validateWriteTarget(command.key, propertyOwnerTarget(command.owner));
        if (issue) fail("internal", issue.message);
        const field = this.propertyOwnerBag(command.owner).find((item) => item.key === command.key);
        if (field) field.values = [];
        break;
      }
      case "remove_property": {
        const issue = validateWriteTarget(command.key, propertyOwnerTarget(command.owner));
        if (issue) fail("internal", issue.message);
        const bag = this.propertyOwnerBag(command.owner);
        removeAll(bag, command.key);
        break;
      }
      case "add_repeated_property": {
        const issue = validateWriteTarget(command.key, propertyOwnerTarget(command.owner))
          ?? validateValue(command.key, command.value, "repeated");
        if (issue) fail("internal", issue.message);
        const bag = this.propertyOwnerBag(command.owner);
        const field = ensureField(bag, command.key, command.value.type, "set");
        if (!field.values.some((value) => sameValue(value, command.value))) {
          field.values.push(command.value);
        }
        break;
      }
      case "remove_repeated_property": {
        const issue = validateWriteTarget(command.key, propertyOwnerTarget(command.owner));
        if (issue) fail("internal", issue.message);
        const field = this.propertyOwnerBag(command.owner).find((item) => item.key === command.key);
        if (field) {
          const index = field.values.findIndex((value) => sameValue(value, command.value));
          if (index >= 0) field.values.splice(index, 1);
        }
        break;
      }
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
        const entry = this.historyEntries.pop();
        if (previous && entry) {
          this.future.push(this.capture());
          this.futureEntries.push(entry);
          this.restore(previous);
          result.history_effect = this.resolveHistory(entry, "undo");
        } else {
          result.changed = false;
        }
        break;
      }
      case "redo": {
        const next = this.future.pop();
        const entry = this.futureEntries.pop();
        if (next && entry) {
          this.history.push(this.capture());
          this.historyEntries.push(entry);
          this.restore(next);
          result.history_effect = this.resolveHistory(entry, "redo");
        } else {
          result.changed = false;
        }
        break;
      }
    }
  }

  private planHistory(command: Exclude<Command, { type: "undo" } | { type: "redo" }>): FakeHistoryEntry {
    const page = (id: string): EntityRef => ({ kind: "page", id });
    const block = (pageId: string, id: string): EntityRef => ({ kind: "block", page_id: pageId, id });
    const entity = (target: EntityRef): FakeHistoryEntry => ({
      scope: target.kind === "page" ? "page" : "entity",
      affectedPages: [target.kind === "page" ? target.id : target.page_id],
      undoCandidates: [clone(target)],
      redoCandidates: [clone(target)],
    });
    const pageEntry = (
      pageId: string,
      undoCandidates: EntityRef[],
      redoCandidates: EntityRef[],
    ): FakeHistoryEntry => ({
      scope: "page",
      affectedPages: [pageId],
      undoCandidates,
      redoCandidates,
    });
    const blockEntry = (
      pageId: string,
      undoCandidates: EntityRef[],
      redoCandidates: EntityRef[],
    ): FakeHistoryEntry => ({
      scope: "entity",
      affectedPages: [pageId],
      undoCandidates,
      redoCandidates,
    });
    const ownerEntry = (owner: PropertyOwnerRef): FakeHistoryEntry => owner.kind === "tag_default"
      ? { scope: "graph", affectedPages: [], undoCandidates: [], redoCandidates: [] }
      : entity(owner);

    switch (command.type) {
      case "ensure_page":
        return { ...pageEntry(command.page_id, [], []), redoCreatedPage: true };
      case "ensure_journal": {
        const pageId = `journal-${command.date}`;
        return pageEntry(pageId, [], [page(pageId)]);
      }
      case "rename_page":
        return pageEntry(command.page_id, [page(command.page_id)], [page(command.page_id)]);
      case "delete_page":
        return pageEntry(command.page_id, [page(command.page_id)], []);
      case "restore_page":
        return pageEntry(command.page_id, [], [page(command.page_id)]);
      case "ensure_tag":
      case "rename_tag":
      case "restore_tag":
        return {
          scope: "graph",
          affectedPages: [],
          undoCandidates: [],
          redoCandidates: [],
        };
      case "delete_tag": {
        const affectedPages = this.pages
          .filter((candidate) => pageHasTag(candidate, command.tag_id))
          .map((candidate) => candidate.id)
          .sort();
        return {
          scope: "graph",
          affectedPages,
          undoCandidates: [],
          redoCandidates: [],
        };
      }
      case "insert_block":
        return {
          ...blockEntry(
            command.page_id,
            command.parent
              ? [block(command.page_id, command.parent), page(command.page_id)]
              : [page(command.page_id)],
            [],
          ),
          redoCreatedBlock: true,
        };
      case "split_block":
        return {
          ...blockEntry(
            command.page_id,
            [block(command.page_id, command.block_id), page(command.page_id)],
            [block(command.page_id, command.block_id)],
          ),
          redoCreatedBlock: true,
        };
      case "insert_outline":
        return {
          ...blockEntry(
            command.page_id,
            command.parent
              ? [block(command.page_id, command.parent), page(command.page_id)]
              : [page(command.page_id)],
            [],
          ),
          redoCreatedBlock: true,
        };
      case "edit_markdown":
      case "splice_markdown":
        return blockEntry(
          command.page_id,
          [block(command.page_id, command.block_id)],
          [block(command.page_id, command.block_id)],
        );
      case "move_blocks":
      case "indent_blocks":
      case "outdent_blocks": {
        const candidates = this.structuralRoots(command.page_id, command.block_ids)
          .map((id) => block(command.page_id, id));
        candidates.push(page(command.page_id));
        return blockEntry(command.page_id, candidates, clone(candidates));
      }
      case "delete_blocks": {
        const roots = this.structuralRoots(command.page_id, command.block_ids);
        const undoCandidates = roots.map((id) => block(command.page_id, id));
        undoCandidates.push(page(command.page_id));
        const first = this.requireBlock(command.page_id, roots[0]);
        const position = first.siblings.indexOf(first.block);
        const redoCandidates: EntityRef[] = [];
        if (position > 0) redoCandidates.push(block(command.page_id, first.siblings[position - 1].id));
        if (first.parent) redoCandidates.push(block(command.page_id, first.parent.id));
        redoCandidates.push(page(command.page_id));
        return blockEntry(command.page_id, undoCandidates, redoCandidates);
      }
      case "ensure_property":
      case "set_property":
      case "clear_property_values":
      case "remove_property":
      case "add_repeated_property":
      case "remove_repeated_property":
        return ownerEntry(command.owner);
      case "add_tag":
      case "remove_tag":
        return entity(command.entity);
    }
  }

  private finishHistory(
    entry: FakeHistoryEntry,
    result: { created_page: string | null; created_block: string | null },
  ): FakeHistoryEntry {
    const finished = clone(entry);
    if (finished.redoCreatedBlock && result.created_block && finished.affectedPages[0]) {
      finished.redoCandidates.unshift({
        kind: "block",
        page_id: finished.affectedPages[0],
        id: result.created_block,
      });
    }
    if (finished.redoCreatedPage && result.created_page) {
      finished.redoCandidates.unshift({ kind: "page", id: result.created_page });
    }
    return finished;
  }

  private resolveHistory(entry: FakeHistoryEntry, direction: "undo" | "redo"): HistoryEffect {
    const candidates = direction === "undo" ? entry.undoCandidates : entry.redoCandidates;
    return {
      scope: entry.scope,
      affected_pages: clone(entry.affectedPages),
      reveal: clone(candidates.find((candidate) => this.isLiveEntity(candidate)) ?? null),
    };
  }

  private isLiveEntity(entity: EntityRef): boolean {
    const page = this.rawPage(entity.kind === "page" ? entity.id : entity.page_id);
    if (!page || hasKey(page.properties, "builtin.deleted-at")) return false;
    return entity.kind === "page" || findIn(page.blocks, null, entity.id, page) !== null;
  }

  private assertPageNameAvailable(name: string, exceptId: string): void {
    const canonical = canonicalEntityName(name);
    if (!canonical) fail("invalid_request", "page name must not be empty");
    const existing = this.pages.find((page) =>
      page.id !== exceptId
      && !hasKey(page.properties, "builtin.deleted-at")
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
      && !hasKey(tag.properties, "builtin.deleted-at")
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
    result: { created_page: string | null; created_block: string | null; created_tag: string | null },
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
      case "split_block":
        if (command.index > 0) this.touchBlock(command.page_id, command.block_id, timestamp);
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
      case "ensure_property":
      case "set_property":
      case "clear_property_values":
      case "remove_property":
      case "add_repeated_property":
      case "remove_repeated_property":
        this.touchPropertyOwner(command.owner, timestamp);
        break;
      case "add_tag":
      case "remove_tag":
        this.touchEntity(command.entity, timestamp);
        break;
      case "ensure_tag":
        if (result.created_tag) this.touchTag(result.created_tag, timestamp);
        break;
      case "rename_tag":
      case "delete_tag":
      case "restore_tag":
        this.touchTag(command.tag_id, timestamp);
        break;
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

  private touchPropertyOwner(owner: PropertyOwnerRef, timestamp: string): void {
    if (owner.kind === "tag_default") {
      this.touchTag(owner.tag_id, timestamp);
    } else {
      this.touchEntity(owner, timestamp);
    }
  }

  private touchPage(pageId: string, timestamp: string): void {
    const page = this.rawPage(pageId);
    if (!page) fail("internal", `page does not exist: ${pageId}`);
    setSingle(page.properties, "builtin.updated-at", {
      type: "string",
      value: timestamp,
    });
  }

  private touchBlock(pageId: string, blockId: string, timestamp: string): void {
    setSingle(this.requireBlock(pageId, blockId).block.properties, "builtin.updated-at", {
      type: "string",
      value: timestamp,
    });
  }

  private touchTag(tagId: string, timestamp: string): void {
    const tag = this.rawTag(tagId);
    if (!tag) fail("internal", `tag does not exist: ${tagId}`);
    setSingle(tag.properties, "builtin.updated-at", {
      type: "string",
      value: timestamp,
    });
  }

  private detachTagFromAllNodes(tagId: string, timestamp: string): void {
    const detachBlocks = (blocks: BlockSnapshot[]): boolean => {
      let pageChanged = false;
      for (const block of blocks) {
        const index = block.tags.indexOf(tagId);
        if (index >= 0) {
          block.tags.splice(index, 1);
          setSingle(block.properties, "builtin.updated-at", {
            type: "string",
            value: timestamp,
          });
          pageChanged = true;
        }
        pageChanged = detachBlocks(block.children) || pageChanged;
      }
      return pageChanged;
    };

    for (const page of this.pages) {
      const index = page.tags.indexOf(tagId);
      const rootChanged = index >= 0;
      if (rootChanged) page.tags.splice(index, 1);
      if (rootChanged || detachBlocks(page.blocks)) {
        setSingle(page.properties, "builtin.updated-at", {
          type: "string",
          value: timestamp,
        });
      }
    }
  }

  private rawTag(id: string): TagSnapshot | undefined {
    return this.tags.find((tag) => tag.id === id);
  }

  private requireTag(id: string): TagSnapshot {
    const tag = this.rawTag(id);
    if (!tag || hasKey(tag.properties, "builtin.deleted-at")) {
      fail("internal", `tag does not exist or is deleted: ${id}`);
    }
    return tag;
  }

  private requirePage(id: string): PageSnapshot {
    const page = this.rawPage(id);
    if (!page) fail("internal", `page does not exist: ${id}`);
    if (hasKey(page.properties, "builtin.deleted-at")) {
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

  private entityBag(entity: { kind: "page"; id: string } | { kind: "block"; page_id: string; id: string }): PropertyField[] {
    return entity.kind === "page"
      ? this.requirePage(entity.id).properties
      : this.requireBlock(entity.page_id, entity.id).block.properties;
  }

  private propertyOwnerBag(owner: PropertyOwnerRef): PropertyField[] {
    if (owner.kind === "tag_default") return this.requireTag(owner.tag_id).defaults;
    return this.entityBag(owner);
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

function projectLiveTags(page: PageSnapshot, liveTags: ReadonlySet<string>): PageSnapshot {
  const projectBlocks = (blocks: BlockSnapshot[]): BlockSnapshot[] => blocks.map((block) => ({
    ...block,
    tags: block.tags.filter((tag) => liveTags.has(tag)),
    children: projectBlocks(block.children),
  }));
  return {
    ...page,
    tags: page.tags.filter((tag) => liveTags.has(tag)),
    blocks: projectBlocks(page.blocks),
  };
}

function pageHasTag(page: PageSnapshot, tagId: string): boolean {
  const blocksHaveTag = (blocks: BlockSnapshot[]): boolean => blocks.some(
    (block) => block.tags.includes(tagId) || blocksHaveTag(block.children),
  );
  return page.tags.includes(tagId) || blocksHaveTag(page.blocks);
}

function newPage(
  id: string,
  kind: "regular" | "journal",
  title: string | null,
  date: string | null,
  timestamp: string,
): PageSnapshot {
  const properties: PropertyField[] = [
    field("builtin.page-kind", "string", "single", [{ type: "string", value: kind }]),
    ...lifecycle(timestamp),
  ];
  if (date !== null) {
    properties.push(field("builtin.journal-date", "date", "single", [{ type: "date", value: date }]));
  }
  properties.sort((a, b) => a.key.localeCompare(b.key));
  return { id, title: title ?? "", properties, tags: [], blocks: [] };
}

function lifecycle(timestamp: string): PropertyField[] {
  return ["builtin.created-at", "builtin.updated-at"].map((key) =>
    field(key, "string", "single", [{ type: "string", value: timestamp }]),
  );
}

function field(
  key: string,
  valueType: PropertyField["value_type"],
  cardinality: PropertyField["cardinality"],
  values: PropertyValue[] = [],
): PropertyField {
  return { key, value_type: valueType, cardinality, values };
}

function hasKey(bag: PropertyField[], key: string): boolean {
  return bag.some((item) => item.key === key);
}

function ensureField(
  bag: PropertyField[],
  key: string,
  valueType: PropertyField["value_type"],
  cardinality: PropertyField["cardinality"],
): PropertyField {
  const existing = bag.find((item) => item.key === key);
  if (existing) {
    if (existing.value_type !== valueType || existing.cardinality !== cardinality) {
      fail("internal", `property shape does not match: ${key}`);
    }
    return existing;
  }
  const created = field(key, valueType, cardinality);
  bag.push(created);
  return created;
}

function setSingle(bag: PropertyField[], key: string, value: PropertyValue): void {
  ensureField(bag, key, value.type, "single").values = [value];
}

function removeAll(bag: PropertyField[], key: string): void {
  for (let index = bag.length - 1; index >= 0; index -= 1) {
    if (bag[index].key === key) bag.splice(index, 1);
  }
}

function propertyOwnerTarget(owner: PropertyOwnerRef): "page" | "block" | "tag_default" {
  return owner.kind;
}

/** Convenience: an already-open session backed by the fake port. */
export async function openFakeSession(graphId = "test-graph") {
  const { GraphSession } = await import("../session");
  const port = new FakeCorePort();
  const session = new GraphSession(graphId, port);
  await session.open();
  return { session, port };
}
