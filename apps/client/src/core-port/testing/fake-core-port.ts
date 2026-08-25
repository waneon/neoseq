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
  ReadOutlineRequest,
  ReadOutlineResponse,
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
  QueryOwnerRef,
} from "../commands";
import type {
  BlockSnapshot,
  DefaultQuerySnapshot,
  GraphSnapshot,
  GraphSummary,
  OutlineOwner,
  OutlineSnapshot,
  PageSnapshot,
  PropertyField,
  PropertyValue,
  TagSnapshot,
} from "../snapshot";
import {
  defaultQueryDocument,
  sameValue,
  validateFieldShape,
  validateValue,
  validateWriteTarget,
  type WritableTarget,
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
  affectedOutlines: OutlineOwner[];
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
  private defaultQueries: DefaultQuerySnapshot[] = [];
  private history: Array<{ pages: PageSnapshot[]; tags: TagSnapshot[]; defaultQueries: DefaultQuerySnapshot[] }> = [];
  private future: Array<{ pages: PageSnapshot[]; tags: TagSnapshot[]; defaultQueries: DefaultQuerySnapshot[] }> = [];
  private historyEntries: FakeHistoryEntry[] = [];
  private futureEntries: FakeHistoryEntry[] = [];
  private events: GraphEventRecord[] = [];
  private nextCursor = 1;
  private sequence = 0;
  private blockCounter = 0;
  private open = false;
  private graphId = "";

  queryResult: SparqlQueryResult | null = null;
  readonly queryRequests: QueryRequest[] = [];

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

  async readOutline(request: ReadOutlineRequest): Promise<ReadOutlineResponse> {
    if (!this.open) fail("graph_not_open", "graph is not open");
    const owner = request.owner as OutlineOwner;
    const outline: OutlineSnapshot = {
      owner,
      blocks: clone(this.requireOutline(owner).blocks),
    };
    return { outline };
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    if (!this.open) fail("graph_not_open", "graph is not open");
    if (this.pendingSave) fail("dirty_unsaved", "retry pending update before querying", true);
    this.queryRequests.push(clone(request));
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
      schema_version: 5,
      graph_id: this.graphId,
      pages: this.pages
        .filter((page) => !hasKey(page.properties, "builtin.deleted-at"))
        .map((page) => projectLiveTags(page, liveTags)),
      tags: this.tags
        .filter((tag) => !hasKey(tag.properties, "builtin.deleted-at"))
        .map((tag) => projectLiveTagRefs(tag, liveTags)),
      settings: { default_queries: this.defaultQueries },
      quarantined: [],
    });
  }

  private summary(): GraphSummary {
    const snapshot = this.snapshot();
    return {
      ...snapshot,
      pages: snapshot.pages.map(({ blocks: _blocks, ...page }) => page),
      tags: snapshot.tags.map(({ blocks: _blocks, ...tag }) => tag),
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
            blocks: [],
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
        const outline = this.requireOutline(command.owner);
        const id = `b-${(this.blockCounter += 1)}`;
        const block: BlockSnapshot = {
          id,
          markdown: command.markdown,
          properties: lifecycle(timestamp),
          tags: [],
          children: [],
        };
        const siblings = command.parent
          ? this.requireBlock(command.owner, command.parent).block.children
          : outline.blocks;
        siblings.splice(Math.min(command.index, siblings.length), 0, block);
        result.created_block = id;
        break;
      }
      case "split_block": {
        const target = this.requireBlock(command.owner, command.block_id);
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
          ? this.requireBlock(command.owner, command.parent).block.children
          : this.requireOutline(command.owner).blocks;
        let baseSiblings = requestedSiblings;
        let baseIndex = command.index;
        const levels: BlockSnapshot[] = [];
        let rootOffset = 0;

        if (command.replace) {
          const target = this.requireBlock(command.owner, command.replace);
          if (target.block.markdown !== "") fail("internal", "outline replacement block is not empty");
          baseSiblings = target.siblings;
          baseIndex = target.siblings.indexOf(target.block);
          rootOffset = 1;
        }

        command.items.forEach((item, position) => {
          let block: BlockSnapshot;
          if (position === 0 && command.replace) {
            block = this.requireBlock(command.owner, command.replace).block;
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
      case "paste_outline": {
        const { fragment } = command;
        if (fragment.items.length === 0 || fragment.items[0].depth !== 0) {
          fail("internal", "outline paste must start at depth zero");
        }
        fragment.items.forEach((item, index) => {
          if (index > 0 && item.depth > fragment.items[index - 1].depth + 1) {
            fail("internal", "outline paste skips a depth");
          }
        });

        const tagMap = new Map<string, string>();
        for (const reference of fragment.tags) {
          let target = fragment.source_graph_id === this.graphId
            ? this.tags.find((tag) => tag.id === reference.id)
            : undefined;
          target ??= this.tags.find((tag) =>
            canonicalEntityName(tag.name) === canonicalEntityName(reference.name)
          );
          if (!target) {
            let id = `t-paste-${this.tags.length + 1}`;
            while (this.tags.some((tag) => tag.id === id)) id += "-copy";
            target = {
              id,
              name: reference.name,
              properties: lifecycle(timestamp),
              defaults: [],
              blocks: [],
            };
            this.tags.push(target);
          }
          tagMap.set(reference.id, target.id);
        }

        const pageMap = new Map<string, string>();
        for (const reference of fragment.pages) {
          let target = fragment.source_graph_id === this.graphId
            ? this.pages.find((page) => page.id === reference.id)
            : undefined;
          target ??= reference.journal_date
            ? this.pages.find((page) => page.properties.some((entry) =>
                entry.key === "builtin.journal-date"
                && entry.values[0]?.type === "date"
                && entry.values[0].value === reference.journal_date
              ))
            : this.pages.find((page) =>
                canonicalEntityName(page.title) === canonicalEntityName(reference.title)
              );
          if (!target) {
            let id = `p-paste-${this.pages.length + 1}`;
            while (this.pages.some((page) => page.id === id)) id += "-copy";
            target = newPage(
              id,
              reference.journal_date ? "journal" : "regular",
              reference.journal_date ? null : reference.title,
              reference.journal_date,
              timestamp,
            );
            this.pages.push(target);
          }
          pageMap.set(reference.id, target.id);
        }

        const requestedSiblings = command.parent
          ? this.requireBlock(command.owner, command.parent).block.children
          : this.requireOutline(command.owner).blocks;
        let baseSiblings = requestedSiblings;
        let baseIndex = command.index;
        const levels: BlockSnapshot[] = [];
        let rootOffset = 0;
        if (command.replace) {
          const target = this.requireBlock(command.owner, command.replace);
          const portable = target.block.properties.filter((entry) =>
            entry.key !== "builtin.created-at" && entry.key !== "builtin.updated-at"
          );
          if (target.block.markdown !== ""
            || portable.length > 0
            || target.block.tags.length > 0
            || target.block.children.length > 0
          ) fail("internal", "outline replacement block contains content or metadata");
          baseSiblings = target.siblings;
          baseIndex = target.siblings.indexOf(target.block);
          rootOffset = 1;
        }
        fragment.items.forEach((item, position) => {
          let block: BlockSnapshot;
          if (position === 0 && command.replace) {
            block = this.requireBlock(command.owner, command.replace).block;
            block.markdown = item.markdown;
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
              if (!parent) fail("internal", "outline paste skips a depth");
              parent.children.push(block);
            }
          }
          block.properties.push(...clone(item.properties).map((entry: PropertyField) => ({
            ...entry,
            values: entry.values.map((value) => value.type === "page"
              ? { ...value, value: pageMap.get(value.value) ?? value.value }
              : value),
          })));
          block.tags = item.tags
            .map((id) => tagMap.get(id))
            .filter((id): id is string => id !== undefined);
          levels[item.depth] = block;
          levels.length = item.depth + 1;
          result.created_block = block.id;
        });
        break;
      }
      case "edit_markdown":
        this.requireBlock(command.owner, command.block_id).block.markdown = command.markdown;
        break;
      case "splice_markdown": {
        const block = this.requireBlock(command.owner, command.block_id).block;
        const points = Array.from(block.markdown);
        if (command.index + command.delete > points.length) {
          fail("internal", "markdown splice is out of bounds");
        }
        points.splice(command.index, command.delete, ...Array.from(command.insert));
        block.markdown = points.join("");
        break;
      }
      case "splice_markdowns":
        for (const splice of command.splices) {
          const block = this.requireBlock(command.owner, splice.block_id).block;
          const points = Array.from(block.markdown);
          if (splice.index + splice.delete > points.length) {
            fail("internal", "markdown splice is out of bounds");
          }
          points.splice(splice.index, splice.delete, ...Array.from(splice.insert));
          block.markdown = points.join("");
        }
        break;
      case "move_blocks": {
        const roots = this.structuralRoots(command.owner, command.block_ids);
        const rootSet = new Set(roots);
        const target = command.parent
          ? this.requireBlock(command.owner, command.parent).block.children
          : this.requireOutline(command.owner).blocks;
        let anchor = command.after === null
          ? null
          : target.find((block) => block.id === command.after) ?? null;
        if (command.after !== null && (!anchor || rootSet.has(anchor.id))) {
          fail("internal", "move anchor is not a stationary target sibling");
        }
        for (const blockId of roots) {
          const { block } = this.requireBlock(command.owner, blockId);
          this.detach(command.owner, blockId);
          const siblings = command.parent
            ? this.requireBlock(command.owner, command.parent).block.children
            : this.requireOutline(command.owner).blocks;
          const anchorIndex = anchor ? siblings.indexOf(anchor) : -1;
          if (anchor && anchorIndex < 0) fail("internal", "move anchor is not a target sibling");
          const index = anchorIndex + 1;
          siblings.splice(index, 0, block);
          anchor = block;
        }
        break;
      }
      case "indent_blocks": {
        for (const blockId of this.structuralRoots(command.owner, command.block_ids)) {
          const found = this.requireBlock(command.owner, blockId);
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
        const roots = this.structuralRoots(command.owner, command.block_ids).reverse();
        for (const blockId of roots) {
          const found = this.requireBlock(command.owner, blockId);
          if (!found.parent) fail("internal", "root block cannot be outdented");
          const parentFound = this.requireBlock(command.owner, found.parent.id);
          found.siblings.splice(found.siblings.indexOf(found.block), 1);
          const grandSiblings = parentFound.siblings;
          grandSiblings.splice(grandSiblings.indexOf(parentFound.block) + 1, 0, found.block);
        }
        break;
      }
      case "delete_blocks":
        for (const blockId of this.structuralRoots(command.owner, command.block_ids)) {
          this.detach(command.owner, blockId);
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
        const field = ensureField(bag, command.key, propertyValueType(command.value), "set");
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
      case "create_default_query":
        if (this.defaultQueries.some((query) => query.id === command.default_query_id)) {
          fail("internal", "default query id already exists");
        }
        if (this.defaultQueries.length >= 8) fail("internal", "too many default queries");
        this.defaultQueries.push({
          id: command.default_query_id,
          title: command.title,
          position: this.defaultQueries.length,
          document: clone(command.document),
        });
        break;
      case "rename_default_query":
        this.requireDefaultQuery(command.default_query_id).title = command.title;
        break;
      case "move_default_query": {
        if (command.index < 0 || command.index >= this.defaultQueries.length) {
          fail("internal", "default query move is out of bounds");
        }
        const from = this.defaultQueries.findIndex((query) => query.id === command.default_query_id);
        if (from < 0) fail("internal", "default query does not exist");
        const [moved] = this.defaultQueries.splice(from, 1);
        this.defaultQueries.splice(command.index, 0, moved);
        this.defaultQueries.forEach((query, position) => { query.position = position; });
        break;
      }
      case "delete_default_query": {
        const index = this.defaultQueries.findIndex((query) => query.id === command.default_query_id);
        if (index < 0) fail("internal", "default query does not exist");
        this.defaultQueries.splice(index, 1);
        this.defaultQueries.forEach((query, position) => { query.position = position; });
        break;
      }
      case "set_query_source": {
        if (command.owner.kind === "graph_default") {
          const view = this.requireQueryView(command.owner, command.view_id);
          view.definition.source = command.source;
          view.definition.plan = null;
          break;
        }
        const bag = this.propertyOwnerBag(command.owner);
        let field = bag.find((item) => item.key === "builtin.query");
        if (!field) {
          if (command.view_id !== "all") fail("internal", "a new query must begin with view all");
          field = {
            key: "builtin.query",
            value_type: "document",
            cardinality: "single",
            values: [{ type: "document", value: defaultQueryDocument(command.source) }],
          };
          bag.push(field);
        } else {
          const value = field.values[0];
          if (value?.type !== "document") fail("internal", "query document is invalid");
          const view = value.value.views.find((item) => item.id === command.view_id);
          if (!view) fail("internal", "query view does not exist");
          view.definition.source = command.source;
          view.definition.plan = null;
        }
        break;
      }
      case "splice_query_source": {
        const view = this.requireQueryView(command.owner, command.view_id);
        const points = Array.from(view.definition.source);
        if (command.index + command.delete > points.length) {
          fail("internal", "query source splice is out of bounds");
        }
        points.splice(command.index, command.delete, ...Array.from(command.insert));
        view.definition.source = points.join("");
        // Writing SPARQL by hand detaches the builder, exactly as the core does.
        view.definition.plan = null;
        break;
      }
      case "set_query_plan": {
        if (command.plan.version < 1) fail("internal", "query plan version must be positive");
        try {
          const parsed: unknown = JSON.parse(command.plan.payload);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            fail("internal", "query plan must be a JSON object");
          }
        } catch {
          fail("internal", "query plan is not JSON");
        }
        if (command.owner.kind === "graph_default") {
          const view = this.requireQueryView(command.owner, command.view_id);
          view.definition.source = command.source;
          view.definition.plan = clone(command.plan);
          break;
        }
        const bag = this.propertyOwnerBag(command.owner);
        let field = bag.find((item) => item.key === "builtin.query");
        if (!field) {
          if (command.view_id !== "all") fail("internal", "a new query must begin with view all");
          field = {
            key: "builtin.query",
            value_type: "document",
            cardinality: "single",
            values: [{ type: "document", value: defaultQueryDocument(command.source) }],
          };
          bag.push(field);
        }
        const value = field.values[0];
        if (value?.type !== "document") fail("internal", "query document is invalid");
        const view = value.value.views.find((item) => item.id === command.view_id);
        if (!view) fail("internal", "query view does not exist");
        view.definition.source = command.source;
        view.definition.plan = clone(command.plan);
        break;
      }
      case "clear_query_plan": {
        this.requireQueryView(command.owner, command.view_id).definition.plan = null;
        break;
      }
      case "put_query_view": {
        const document = this.requireQuery(command.owner);
        const index = document.views.findIndex((view) => view.id === command.view.id);
        if (index >= 0) {
          const definition = document.views[index].definition;
          document.views[index] = { ...clone(command.view), definition };
        }
        else document.views.push(clone(command.view));
        document.views.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
        break;
      }
      case "remove_query_view": {
        const document = this.requireQuery(command.owner);
        if (document.views.length === 1) fail("internal", "the last query view cannot be removed");
        document.views = document.views.filter((view) => view.id !== command.view_id);
        if (document.default_view_id === command.view_id) {
          document.default_view_id = document.views[0].id;
        }
        break;
      }
      case "set_query_default_view": {
        const document = this.requireQuery(command.owner);
        if (!document.views.some((view) => view.id === command.view_id)) {
          fail("internal", "default query view does not exist");
        }
        document.default_view_id = command.view_id;
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
    const block = (owner: OutlineOwner, id: string): EntityRef => ({ kind: "block", owner, id });
    const outlineTarget = (owner: OutlineOwner): EntityRef[] =>
      owner.kind === "page" ? [page(owner.id)] : [];
    const entity = (target: EntityRef): FakeHistoryEntry => ({
      scope: target.kind === "page" ? "outline" : "entity",
      affectedOutlines: [target.kind === "page" ? { kind: "page", id: target.id } : target.owner],
      undoCandidates: [clone(target)],
      redoCandidates: [clone(target)],
    });
    const pageEntry = (
      pageId: string,
      undoCandidates: EntityRef[],
      redoCandidates: EntityRef[],
    ): FakeHistoryEntry => ({
      scope: "outline",
      affectedOutlines: [{ kind: "page", id: pageId }],
      undoCandidates,
      redoCandidates,
    });
    const outlineEntry = (
      owner: OutlineOwner,
      undoCandidates: EntityRef[],
      redoCandidates: EntityRef[],
    ): FakeHistoryEntry => ({
      scope: "entity",
      affectedOutlines: [owner],
      undoCandidates,
      redoCandidates,
    });
    const ownerEntry = (owner: PropertyOwnerRef): FakeHistoryEntry =>
      owner.kind === "tag" || owner.kind === "tag_default"
        ? { scope: "graph", affectedOutlines: [], undoCandidates: [], redoCandidates: [] }
        : entity(owner);
    const queryOwnerEntry = (owner: QueryOwnerRef): FakeHistoryEntry =>
      owner.kind === "graph_default"
        ? { scope: "graph", affectedOutlines: [], undoCandidates: [], redoCandidates: [] }
        : ownerEntry(owner);

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
          affectedOutlines: [],
          undoCandidates: [],
          redoCandidates: [],
        };
      case "delete_tag": {
        const affectedOutlines: OutlineOwner[] = [
          ...this.pages
            .filter((candidate) => pageHasTag(candidate, command.tag_id))
            .map((candidate) => ({ kind: "page", id: candidate.id }) as const),
          ...this.tags
            .filter((candidate) => outlineHasTag(candidate, command.tag_id))
            .map((candidate) => ({ kind: "tag", id: candidate.id }) as const),
        ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
        return {
          scope: "graph",
          affectedOutlines,
          undoCandidates: [],
          redoCandidates: [],
        };
      }
      case "insert_block":
        return {
          ...outlineEntry(
            command.owner,
            command.parent
              ? [block(command.owner, command.parent), ...outlineTarget(command.owner)]
              : outlineTarget(command.owner),
            [],
          ),
          redoCreatedBlock: true,
        };
      case "split_block":
        return {
          ...outlineEntry(
            command.owner,
            [block(command.owner, command.block_id), ...outlineTarget(command.owner)],
            [block(command.owner, command.block_id)],
          ),
          redoCreatedBlock: true,
        };
      case "insert_outline":
      case "paste_outline":
        return {
          ...outlineEntry(
            command.owner,
            command.parent
              ? [block(command.owner, command.parent), ...outlineTarget(command.owner)]
              : outlineTarget(command.owner),
            [],
          ),
          redoCreatedBlock: true,
        };
      case "edit_markdown":
      case "splice_markdown":
        return outlineEntry(
          command.owner,
          [block(command.owner, command.block_id)],
          [block(command.owner, command.block_id)],
        );
      case "splice_markdowns": {
        const candidates = command.splices.map((splice) => block(command.owner, splice.block_id));
        return outlineEntry(command.owner, candidates, clone(candidates));
      }
      case "move_blocks":
      case "indent_blocks":
      case "outdent_blocks": {
        const candidates = this.structuralRoots(command.owner, command.block_ids)
          .map((id) => block(command.owner, id));
        candidates.push(...outlineTarget(command.owner));
        return outlineEntry(command.owner, candidates, clone(candidates));
      }
      case "delete_blocks": {
        const roots = this.structuralRoots(command.owner, command.block_ids);
        const undoCandidates = roots.map((id) => block(command.owner, id));
        undoCandidates.push(...outlineTarget(command.owner));
        const first = this.requireBlock(command.owner, roots[0]);
        const position = first.siblings.indexOf(first.block);
        const redoCandidates: EntityRef[] = [];
        if (position > 0) redoCandidates.push(block(command.owner, first.siblings[position - 1].id));
        if (first.parent) redoCandidates.push(block(command.owner, first.parent.id));
        redoCandidates.push(...outlineTarget(command.owner));
        return outlineEntry(command.owner, undoCandidates, redoCandidates);
      }
      case "ensure_property":
      case "set_property":
      case "clear_property_values":
      case "remove_property":
      case "add_repeated_property":
      case "remove_repeated_property":
        return ownerEntry(command.owner);
      case "set_query_source":
      case "splice_query_source":
      case "set_query_plan":
      case "clear_query_plan":
      case "put_query_view":
      case "remove_query_view":
      case "set_query_default_view":
        return queryOwnerEntry(command.owner);
      case "create_default_query":
      case "rename_default_query":
      case "move_default_query":
      case "delete_default_query":
        return { scope: "graph", affectedOutlines: [], undoCandidates: [], redoCandidates: [] };
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
    if (finished.redoCreatedBlock && result.created_block && finished.affectedOutlines[0]) {
      finished.redoCandidates.unshift({
        kind: "block",
        owner: finished.affectedOutlines[0],
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
      affected_outlines: clone(entry.affectedOutlines),
      reveal: clone(candidates.find((candidate) => this.isLiveEntity(candidate)) ?? null),
    };
  }

  private isLiveEntity(entity: EntityRef): boolean {
    if (entity.kind === "page") {
      const page = this.rawPage(entity.id);
      return Boolean(page && !hasKey(page.properties, "builtin.deleted-at"));
    }
    const outline = entity.owner.kind === "page"
      ? this.rawPage(entity.owner.id)
      : this.rawTag(entity.owner.id);
    return Boolean(
      outline
      && !hasKey(outline.properties, "builtin.deleted-at")
      && findIn(outline.blocks, null, entity.id) !== null,
    );
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
        if (result.created_block) this.touchBlock(command.owner, result.created_block, timestamp);
        this.touchOutline(command.owner, timestamp);
        break;
      case "split_block":
        if (command.index > 0) this.touchBlock(command.owner, command.block_id, timestamp);
        if (result.created_block) this.touchBlock(command.owner, result.created_block, timestamp);
        this.touchOutline(command.owner, timestamp);
        break;
      case "insert_outline":
      case "paste_outline":
        if (result.created_block) this.touchBlock(command.owner, result.created_block, timestamp);
        this.touchOutline(command.owner, timestamp);
        break;
      case "edit_markdown":
      case "splice_markdown":
        this.touchBlock(command.owner, command.block_id, timestamp);
        this.touchOutline(command.owner, timestamp);
        break;
      case "splice_markdowns":
        for (const splice of command.splices) this.touchBlock(command.owner, splice.block_id, timestamp);
        this.touchOutline(command.owner, timestamp);
        break;
      case "move_blocks":
      case "indent_blocks":
      case "outdent_blocks":
        for (const blockId of command.block_ids) this.touchBlock(command.owner, blockId, timestamp);
        this.touchOutline(command.owner, timestamp);
        break;
      case "delete_blocks":
        this.touchOutline(command.owner, timestamp);
        break;
      case "ensure_property":
      case "set_property":
      case "clear_property_values":
      case "remove_property":
      case "add_repeated_property":
      case "remove_repeated_property":
        this.touchPropertyOwner(command.owner, timestamp);
        break;
      case "set_query_source":
      case "splice_query_source":
      case "set_query_plan":
      case "clear_query_plan":
      case "put_query_view":
      case "remove_query_view":
      case "set_query_default_view":
        this.touchQueryOwner(command.owner, timestamp);
        break;
      case "create_default_query":
      case "rename_default_query":
      case "move_default_query":
      case "delete_default_query":
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
    entity: EntityRef,
    timestamp: string,
  ): void {
    if (entity.kind === "page") {
      this.touchPage(entity.id, timestamp);
    } else {
      this.touchBlock(entity.owner, entity.id, timestamp);
      this.touchOutline(entity.owner, timestamp);
    }
  }

  private touchPropertyOwner(owner: PropertyOwnerRef, timestamp: string): void {
    if (owner.kind === "tag" || owner.kind === "tag_default") {
      this.touchTag(owner.tag_id, timestamp);
    } else {
      this.touchEntity(owner, timestamp);
    }
  }

  private touchQueryOwner(owner: QueryOwnerRef, timestamp: string): void {
    if (owner.kind === "graph_default") return;
    this.touchPropertyOwner(owner, timestamp);
  }

  private requireDefaultQuery(id: string): DefaultQuerySnapshot {
    const query = this.defaultQueries.find((entry) => entry.id === id);
    if (!query) fail("internal", `default query does not exist: ${id}`);
    return query;
  }

  private requireQuery(owner: QueryOwnerRef) {
    if (owner.kind === "graph_default") {
      return this.requireDefaultQuery(owner.default_query_id).document;
    }
    const field = this.propertyOwnerBag(owner).find((item) => item.key === "builtin.query");
    const value = field?.values[0];
    if (value?.type !== "document") fail("internal", "query document does not exist");
    return value.value;
  }

  private requireQueryView(owner: QueryOwnerRef, viewId: string) {
    const view = this.requireQuery(owner).views.find((item) => item.id === viewId);
    if (!view) fail("internal", "query view does not exist");
    return view;
  }

  private touchPage(pageId: string, timestamp: string): void {
    const page = this.rawPage(pageId);
    if (!page) fail("internal", `page does not exist: ${pageId}`);
    setSingle(page.properties, "builtin.updated-at", {
      type: "string",
      value: timestamp,
    });
  }

  private touchBlock(owner: OutlineOwner, blockId: string, timestamp: string): void {
    setSingle(this.requireBlock(owner, blockId).block.properties, "builtin.updated-at", {
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

  private touchOutline(owner: OutlineOwner, timestamp: string): void {
    if (owner.kind === "page") this.touchPage(owner.id, timestamp);
    else this.touchTag(owner.id, timestamp);
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
    for (const tag of this.tags) {
      if (detachBlocks(tag.blocks)) {
        setSingle(tag.properties, "builtin.updated-at", {
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

  private requireOutline(owner: OutlineOwner): PageSnapshot | TagSnapshot {
    return owner.kind === "page" ? this.requirePage(owner.id) : this.requireTag(owner.id);
  }

  private requireBlock(owner: OutlineOwner, id: string): {
    block: BlockSnapshot;
    siblings: BlockSnapshot[];
    parent: BlockSnapshot | null;
  } {
    const found = findIn(this.requireOutline(owner).blocks, null, id);
    if (found) return found;
    fail("internal", `block does not exist or is deleted: ${id}`);
  }

  private structuralRoots(owner: OutlineOwner, ids: string[]): string[] {
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
    visit(this.requireOutline(owner).blocks, false);
    if (found.size !== requested.size) fail("internal", "structural command targets a missing block");
    return roots;
  }

  private detach(owner: OutlineOwner, id: string): void {
    const found = this.requireBlock(owner, id);
    found.siblings.splice(found.siblings.indexOf(found.block), 1);
  }

  private entityBag(entity: EntityRef): PropertyField[] {
    return entity.kind === "page"
      ? this.requirePage(entity.id).properties
      : this.requireBlock(entity.owner, entity.id).block.properties;
  }

  private propertyOwnerBag(owner: PropertyOwnerRef): PropertyField[] {
    if (owner.kind === "tag") return this.requireTag(owner.tag_id).properties;
    if (owner.kind === "tag_default") return this.requireTag(owner.tag_id).defaults;
    return this.entityBag(owner);
  }

  private entityTags(entity: EntityRef): string[] {
    return entity.kind === "page"
      ? this.requirePage(entity.id).tags
      : this.requireBlock(entity.owner, entity.id).block.tags;
  }

  private capture(): { pages: PageSnapshot[]; tags: TagSnapshot[]; defaultQueries: DefaultQuerySnapshot[] } {
    return clone({ pages: this.pages, tags: this.tags, defaultQueries: this.defaultQueries });
  }

  private restore(state: { pages: PageSnapshot[]; tags: TagSnapshot[]; defaultQueries: DefaultQuerySnapshot[] }): void {
    this.pages = clone(state.pages);
    this.tags = clone(state.tags);
    this.defaultQueries = clone(state.defaultQueries);
  }
}

function findIn(
  blocks: BlockSnapshot[],
  parent: BlockSnapshot | null,
  id: string,
): { block: BlockSnapshot; siblings: BlockSnapshot[]; parent: BlockSnapshot | null } | null {
  for (const block of blocks) {
    if (block.id === id) return { block, siblings: blocks, parent };
    const nested = findIn(block.children, block, id);
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

function projectLiveTagRefs(tag: TagSnapshot, liveTags: ReadonlySet<string>): TagSnapshot {
  const projectBlocks = (blocks: BlockSnapshot[]): BlockSnapshot[] => blocks.map((block) => ({
    ...block,
    tags: block.tags.filter((id) => liveTags.has(id)),
    children: projectBlocks(block.children),
  }));
  return { ...tag, blocks: projectBlocks(tag.blocks) };
}

function outlineHasTag(outline: { blocks: BlockSnapshot[] }, tagId: string): boolean {
  return outline.blocks.some(
    (block) => block.tags.includes(tagId) || outlineHasTag({ blocks: block.children }, tagId),
  );
}

function pageHasTag(page: PageSnapshot, tagId: string): boolean {
  return page.tags.includes(tagId) || outlineHasTag(page, tagId);
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
  ensureField(bag, key, propertyValueType(value), "single").values = [value];
}

function propertyValueType(value: PropertyValue): PropertyField["value_type"] {
  return value.type === "unsupported_document" ? "document" : value.type;
}

function removeAll(bag: PropertyField[], key: string): void {
  for (let index = bag.length - 1; index >= 0; index -= 1) {
    if (bag[index].key === key) bag.splice(index, 1);
  }
}

function propertyOwnerTarget(owner: PropertyOwnerRef): WritableTarget {
  return owner.kind === "tag" ? "tag_metadata" : owner.kind;
}

/** Convenience: an already-open session backed by the fake port. */
export async function openFakeSession(graphId = "test-graph") {
  const { GraphSession } = await import("../session");
  const port = new FakeCorePort();
  const session = new GraphSession(graphId, port);
  await session.open();
  return { session, port };
}
