// @generated from Rust serialization types by scripts/generate-contracts.mjs; do not edit.
export type Ack = { history_epoch: number, 
/**
 * The acknowledged update's content identity.
 */
message_id: ContentId, server_cursor: number, };
export type BlockContentSplice = { block_id: BlockId, index: number, delete: number, insert: Array<InlineContent>, };
export type BlockContentUpdate = { owner: OutlineOwner, block_id: BlockId, content: Array<InlineContent>, markdown: string, page_references: Array<PageReferenceSpan>, properties: PropertyBag, mapping: Array<ContentRangeChange>, };
export type BlockId = string;
export type BlockSnapshot = { id: BlockId, 
/**
 * Semantic content; display titles and spans are derived projections.
 */
content: Array<InlineContent>, 
/**
 * Current editor/read projection. Page-reference atoms are materialized as
 * `[[current title]]`; canonical storage never duplicates that title.
 */
markdown: string, page_references: Array<PageReferenceSpan>, properties: PropertyBag, tags: Array<TagId>, children: Array<BlockSnapshot>, };
export type Cardinality = "single" | "set";
export type Command = { "type": "ensure_page", page_id: PageId, title: string, } | { "type": "ensure_journal", date: LocalDate, } | { "type": "rename_page", page_id: PageId, title: string, } | { "type": "delete_page", page_id: PageId, } | { "type": "restore_page", page_id: PageId, } | { "type": "ensure_tag", tag_id: TagId, name: string, } | { "type": "rename_tag", tag_id: TagId, name: string, } | { "type": "delete_tag", tag_id: TagId, } | { "type": "restore_tag", tag_id: TagId, } | { "type": "insert_block", owner: OutlineOwner, parent: BlockId | null, index: number, markdown: string, } | { "type": "split_block", owner: OutlineOwner, block_id: BlockId, index: number, placement: SplitPlacement, } | { "type": "merge_block_backward", owner: OutlineOwner, block_id: BlockId, } | { "type": "insert_outline", owner: OutlineOwner, parent: BlockId | null, index: number, replace: BlockId | null, items: Array<OutlineItem>, } | { "type": "paste_outline", owner: OutlineOwner, parent: BlockId | null, index: number, replace: BlockId | null, fragment: OutlineFragment, } | { "type": "edit_markdown", owner: OutlineOwner, block_id: BlockId, markdown: string, } | { "type": "splice_markdown", owner: OutlineOwner, block_id: BlockId, index: number, delete: number, insert: string, } | { "type": "splice_markdowns", owner: OutlineOwner, splices: Array<MarkdownSplice>, } | { "type": "splice_block_content", owner: OutlineOwner, block_id: BlockId, index: number, delete: number, insert: Array<InlineContent>, } | { "type": "splice_block_contents", owner: OutlineOwner, splices: Array<BlockContentSplice>, } | { "type": "move_blocks", block_ids: Array<BlockId>, owner: OutlineOwner, parent: BlockId | null, after: BlockId | null, } | { "type": "indent_blocks", owner: OutlineOwner, block_ids: Array<BlockId>, } | { "type": "outdent_blocks", owner: OutlineOwner, block_ids: Array<BlockId>, } | { "type": "delete_blocks", owner: OutlineOwner, block_ids: Array<BlockId>, } | { "type": "ensure_property", owner: PropertyOwner, key: PropertyKey, value_type: PropertyType, cardinality: Cardinality, } | { "type": "set_property", owner: PropertyOwner, key: PropertyKey, value: PropertyValue, } | { "type": "set_properties", owner: PropertyOwner, changes: Array<PropertyChange>, } | { "type": "clear_property_values", owner: PropertyOwner, key: PropertyKey, } | { "type": "remove_property", owner: PropertyOwner, key: PropertyKey, } | { "type": "add_repeated_property", owner: PropertyOwner, key: PropertyKey, value: PropertyValue, } | { "type": "remove_repeated_property", owner: PropertyOwner, key: PropertyKey, value: PropertyValue, } | { "type": "create_default_query", default_query_id: DefaultQueryId, title: string, document: PropertyDocument, } | { "type": "rename_default_query", default_query_id: DefaultQueryId, title: string, } | { "type": "move_default_query", default_query_id: DefaultQueryId, index: number, } | { "type": "delete_default_query", default_query_id: DefaultQueryId, } | { "type": "set_query_source", owner: QueryOwner, view_id: QueryViewId, source: string, } | { "type": "splice_query_source", owner: QueryOwner, view_id: QueryViewId, index: number, delete: number, insert: string, } | { "type": "set_query_plan", owner: QueryOwner, view_id: QueryViewId, plan: QueryPlan, } | { "type": "put_query_view", owner: QueryOwner, view: QueryView, } | { "type": "remove_query_view", owner: QueryOwner, view_id: QueryViewId, } | { "type": "set_query_default_view", owner: QueryOwner, view_id: QueryViewId, } | { "type": "add_tag", entity: EntityId, tag_id: TagId, } | { "type": "remove_tag", entity: EntityId, tag_id: TagId, } | { "type": "batch", commands: Array<Command>, } | { "type": "undo" } | { "type": "redo" };
export type CommandEnvelope = { graph_id: GraphId, command_id: CommandId, command: Command, };
export type CommandId = string;
export type CommandResult = { command_id: CommandId, created_page: PageId | null, created_block: BlockId | null, created_tag: TagId | null, history_effect: HistoryEffect | null, };
export type ContentId = string;
export type ContentRangeChange = { index: number, delete: number, insert: number, };
export type DefaultQueryId = string;
export type DefaultQuerySnapshot = { id: DefaultQueryId, title: string, position: number, document: PropertyDocument, };
export type EntityId = { "kind": "page", id: PageId, } | { "kind": "block", owner: OutlineOwner, id: BlockId, };
export type ErrorCode = "malformed_frame" | "unsupported_protocol" | "unsupported_schema" | "frame_too_large" | "update_too_large" | "presence_too_large" | "invalid_message" | "invalid_update" | "access_denied" | "membership_revoked" | "rate_limited" | "storage_unavailable" | "graph_limit_exceeded" | "stale_history" | "slow_consumer" | "internal";
export type ErrorMessage = { code: ErrorCode, recoverable: boolean, 
/**
 * Stable, content-free diagnostic suitable for logs and clients.
 */
diagnostic: string, };
export type GraphChanges = { "kind": "content", blocks: Array<BlockContentUpdate>, } | { "kind": "refresh", outlines: Array<OutlineOwner> | null, blocks: Array<BlockContentUpdate>, };
export type GraphConflict = { "kind": "duplicate_page_name", canonical_name: string, page_ids: Array<PageId>, } | { "kind": "duplicate_tag_name", canonical_name: string, tag_ids: Array<TagId>, } | { "kind": "default_query_overflow", overflow_ids: Array<DefaultQueryId>, } | { "kind": "query_view_overflow", owner: QueryOwner, overflow_ids: Array<QueryViewId>, } | { "kind": "query_default_view_unavailable", owner: QueryOwner, requested_view_id: QueryViewId, fallback_view_id: QueryViewId, } | { "kind": "text_limit_exceeded", target: TextTarget, actual_bytes: number, limit: number, };
export type GraphId = string;
export type GraphSettings = { 
/**
 * The first bounded window in canonical `(position, id)` order. Entries
 * beyond the local creation limit remain stored and are named by
 * [`GraphConflict::DefaultQueryOverflow`].
 */
default_queries: Array<DefaultQuerySnapshot>, };
export type GraphSnapshot = { schema_version: number, graph_id: GraphId, pages: Array<PageSnapshot>, 
/**
 * Live and deleted page identity used to materialize references without
 * hydrating or rewriting the blocks that contain them.
 */
page_directory: Array<PageDirectoryEntry>, tags: Array<TagSnapshot>, settings: GraphSettings, 
/**
 * Deterministic, merge-preserving semantic conflicts. These are valid
 * collaborative states, not corrupt records, and remain visible until a
 * user resolves the underlying values.
 */
conflicts: Array<GraphConflict>, quarantined: Array<string>, };
export type GraphSummary = { schema_version: number, graph_id: GraphId, pages: Array<PageSummary>, page_directory: Array<PageDirectoryEntry>, tags: Array<TagSummary>, settings: GraphSettings, conflicts: Array<GraphConflict>, quarantined: Array<string>, };
export type Hello = { protocol: number, schema: number, graph_id: GraphId, session_id: string, 
/**
 * History generation owned by the server checkpoint coordinator.
 */
history_epoch: number, 
/**
 * Whether the local Base was installed from a server-approved checkpoint.
 */
has_server_base: boolean, 
/**
 * Loro's encoded version vector. Transport cursors are never substituted here.
 */
version_vector: Array<number>, };
export type HistoryEffect = { scope: HistoryScope, affected_outlines: Array<OutlineOwner>, reveal: EntityId | null, };
export type HistoryScope = "entity" | "outline" | "graph";
export type InlineContent = { "type": "markdown", value: string, } | { "type": "page_reference", page_id: PageId, };
export type LocalDate = string;
export type MarkdownSplice = { block_id: BlockId, index: number, delete: number, insert: string, };
export type Message = { "Hello": Hello } | { "Welcome": Welcome } | { "Update": Update } | { "Ack": Ack } | { "Presence": Presence } | { "Error": ErrorMessage } | { "ResyncRequired": ResyncRequired } | { "Heartbeat": { nonce: number, } };
export type OutlineFragment = { kind: string, version: number, source_graph_id: GraphId, items: Array<OutlineFragmentItem>, tags: Array<OutlineFragmentTag>, pages: Array<OutlineFragmentPage>, };
export type OutlineFragmentItem = { depth: number, markdown: string, page_references: Array<PageReferenceSpan>, properties: PropertyBag, tags: Array<TagId>, };
export type OutlineFragmentPage = { id: PageId, title: string, journal_date: LocalDate | null, };
export type OutlineFragmentTag = { id: TagId, name: string, };
export type OutlineItem = { depth: number, markdown: string, };
export type OutlineOwner = { "kind": "page", id: PageId, } | { "kind": "tag", id: TagId, };
export type OutlineSnapshot = { owner: OutlineOwner, blocks: Array<BlockSnapshot>, };
export type PageDirectoryEntry = { id: PageId, 
/**
 * Shared source label: the page title, or the ISO date for a journal.
 */
title: string, journal_date: LocalDate | null, deleted: boolean, };
export type PageId = string;
export type PageReferenceSpan = { 
/**
 * Unicode-scalar range in `BlockSnapshot.markdown`.
 */
start: number, end: number, 
/**
 * Position of the one reference atom in canonical block content.
 */
index: number, page_id: PageId, };
export type PageSnapshot = { id: PageId, title: string, properties: PropertyBag, tags: Array<TagId>, blocks: Array<BlockSnapshot>, };
export type PageSummary = { id: PageId, title: string, properties: PropertyBag, tags: Array<TagId>, };
export type Presence = { expires_in_ms: number, payload: Array<number>, };
export type PropertyBag = Array<PropertyField>;
export type PropertyChange = { key: PropertyKey, value: PropertyValue | null, };
export type PropertyDocument = { schema: string, version: number, views: Array<QueryView>, default_view_id: QueryViewId, };
export type PropertyDocumentHeader = { schema: string, version: number, };
export type PropertyField = { key: PropertyKey, value_type: PropertyType, cardinality: Cardinality, values: Array<PropertyValue>, };
export type PropertyKey = string;
export type PropertyOwner = { "kind": "page", id: PageId, } | { "kind": "block", owner: OutlineOwner, id: BlockId, } | { "kind": "tag", tag_id: TagId, } | { "kind": "tag_default", tag_id: TagId, };
export type PropertyType = "number" | "string" | "page" | "checkbox" | "date" | "document";
export type PropertyValue = { "type": "number", "value": number } | { "type": "string", "value": string } | { "type": "page", "value": PageId } | { "type": "checkbox", "value": boolean } | { "type": "date", "value": LocalDate } | { "type": "document", "value": PropertyDocument } | { "type": "unsupported_document", "value": PropertyDocumentHeader };
export type QueryDefinition = { 
/**
 * Authoritative only when `plan` is absent. Switching a Built definition
 * to Raw requires `SetQuerySource`, which replaces this value explicitly.
 */
source: string, language: string, plan: QueryPlan | null, };
export type QueryOwner = { "kind": "page", id: PageId, } | { "kind": "block", owner: OutlineOwner, id: BlockId, } | { "kind": "tag", tag_id: TagId, } | { "kind": "graph_default", default_query_id: DefaultQueryId, };
export type QueryPlan = { version: number, payload: string, };
export type QueryView = { id: QueryViewId, name: string, definition: QueryDefinition, kind: QueryViewKind, position: number, columns: Array<QueryViewColumn>, options: QueryViewOptions, };
export type QueryViewColumn = { variable: string, hidden: boolean, width: number | null, };
export type QueryViewFieldSort = { 
/**
 * Stable client field ID (`content`, `tag`, or `property:<key>`, for example).
 */
field: string, descending: boolean, };
export type QueryViewId = string;
export type QueryViewKind = "table" | "list";
export type QueryViewOptions = { 
/**
 * Whether the conditions editor is expanded. Absent keeps the surface's
 * initial disclosure behavior until the user makes a choice.
 */
conditions_open?: boolean, 
/**
 * Rows at the outline's own row height instead of a roomier one.
 */
compact: boolean, 
/**
 * Let cell text wrap instead of truncating on one line.
 */
wrap: boolean, 
/**
 * How a table orders its projected cells, most significant term first.
 * Empty means the order the query returned.
 */
sort?: Array<QueryViewSort>, 
/**
 * How a list orders canonical entity fields, most significant term first.
 * Empty means the order the query returned.
 */
list_sort?: Array<QueryViewFieldSort>, };
export type QueryViewSort = { 
/**
 * The result variable the rows are ordered by.
 */
variable: string, descending: boolean, };
export type ResyncRequired = { code: ErrorCode, server_cursor: number, history_epoch: number, diagnostic: string, };
export type SplitPlacement = "before" | "after" | "first_child";
export type TagId = string;
export type TagSnapshot = { id: TagId, name: string, properties: PropertyBag, defaults: PropertyBag, blocks: Array<BlockSnapshot>, };
export type TagSummary = { id: TagId, name: string, properties: PropertyBag, defaults: PropertyBag, };
export type TextTarget = { "kind": "page_title", page_id: PageId, } | { "kind": "block_content", owner: OutlineOwner, block_id: BlockId, } | { "kind": "query_source", owner: QueryOwner, view_id: QueryViewId, };
export type Update = { history_epoch: number, 
/**
 * Content-addressed transport identity; must match `bytes`.
 */
message_id: ContentId, base_version_vector: Array<number>, bytes: Array<number>, };
export type Welcome = { history_epoch: number, server_version_vector: Array<number>, payload: WelcomePayload, };
export type WelcomePayload = { "delta": { update: Array<number>, } } | { "merge_download": Record<symbol, never> } | { "replace_inline": { checkpoint: Array<number>, } } | { "replace_download": Record<symbol, never> };
