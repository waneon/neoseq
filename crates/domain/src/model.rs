use crate::{
    BlockId, Cardinality, CommandId, DefaultQueryId, GraphId, LocalDate, PageId, PropertyBag,
    PropertyDocument, PropertyKey, PropertyType, PropertyValue, QueryPlan, QueryViewId, TagId,
};
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutlineOwner {
    Page { id: PageId },
    Tag { id: TagId },
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EntityId {
    Page { id: PageId },
    Block { owner: OutlineOwner, id: BlockId },
}

/// What a property is written on. A tag owns two bags and they mean different
/// things: `Tag` is what the tag *is* — its own metadata, including its query —
/// while `TagDefault` is what the tag copies onto whatever it is added to.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PropertyOwner {
    Page { id: PageId },
    Block { owner: OutlineOwner, id: BlockId },
    Tag { tag_id: TagId },
    TagDefault { tag_id: TagId },
}

/// The thing whose query document is being edited. Graph default queries are
/// not properties, but they deliberately share the same document and commands
/// as page, block, and tag queries.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryOwner {
    Page { id: PageId },
    Block { owner: OutlineOwner, id: BlockId },
    Tag { tag_id: TagId },
    GraphDefault { default_query_id: DefaultQueryId },
}

/// Stable identity of collaborative text governed by a local byte budget.
/// The text itself remains canonical when concurrent edits cross that budget.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TextTarget {
    PageTitle {
        page_id: PageId,
    },
    BlockContent {
        owner: OutlineOwner,
        block_id: BlockId,
    },
    QuerySource {
        owner: QueryOwner,
        view_id: QueryViewId,
    },
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkdownSplice {
    pub block_id: BlockId,
    pub index: usize,
    pub delete: usize,
    pub insert: String,
}

/// One canonical splice in a block's inline-content coordinate space. Plain
/// Unicode scalar values and semantic page-reference atoms each occupy one
/// position, independently of the current page title used to display a
/// reference.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockContentSplice {
    pub block_id: BlockId,
    pub index: usize,
    pub delete: usize,
    pub insert: Vec<InlineContent>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InlineContent {
    Markdown { value: String },
    PageReference { page_id: PageId },
}

/// One atomic change inside a property patch. `None` removes the complete
/// field; a value replaces it as the field's single member.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertyChange {
    pub key: PropertyKey,
    pub value: Option<PropertyValue>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    EnsurePage {
        page_id: PageId,
        title: String,
    },
    EnsureJournal {
        date: LocalDate,
    },
    RenamePage {
        page_id: PageId,
        title: String,
    },
    DeletePage {
        page_id: PageId,
    },
    RestorePage {
        page_id: PageId,
    },
    EnsureTag {
        tag_id: TagId,
        name: String,
    },
    RenameTag {
        tag_id: TagId,
        name: String,
    },
    DeleteTag {
        tag_id: TagId,
    },
    RestoreTag {
        tag_id: TagId,
    },
    InsertBlock {
        owner: OutlineOwner,
        parent: Option<BlockId>,
        index: usize,
        markdown: String,
    },
    SplitBlock {
        owner: OutlineOwner,
        block_id: BlockId,
        index: usize,
        placement: SplitPlacement,
    },
    MergeBlockBackward {
        owner: OutlineOwner,
        block_id: BlockId,
    },
    InsertOutline {
        owner: OutlineOwner,
        parent: Option<BlockId>,
        index: usize,
        replace: Option<BlockId>,
        items: Vec<OutlineItem>,
    },
    PasteOutline {
        owner: OutlineOwner,
        parent: Option<BlockId>,
        index: usize,
        replace: Option<BlockId>,
        fragment: OutlineFragment,
    },
    EditMarkdown {
        owner: OutlineOwner,
        block_id: BlockId,
        markdown: String,
    },
    SpliceMarkdown {
        owner: OutlineOwner,
        block_id: BlockId,
        index: usize,
        delete: usize,
        insert: String,
    },
    SpliceMarkdowns {
        owner: OutlineOwner,
        splices: Vec<MarkdownSplice>,
    },
    SpliceBlockContent {
        owner: OutlineOwner,
        block_id: BlockId,
        index: usize,
        delete: usize,
        insert: Vec<InlineContent>,
    },
    SpliceBlockContents {
        owner: OutlineOwner,
        splices: Vec<BlockContentSplice>,
    },
    MoveBlocks {
        block_ids: Vec<BlockId>,
        owner: OutlineOwner,
        parent: Option<BlockId>,
        after: Option<BlockId>,
    },
    IndentBlocks {
        owner: OutlineOwner,
        block_ids: Vec<BlockId>,
    },
    OutdentBlocks {
        owner: OutlineOwner,
        block_ids: Vec<BlockId>,
    },
    DeleteBlocks {
        owner: OutlineOwner,
        block_ids: Vec<BlockId>,
    },
    EnsureProperty {
        owner: PropertyOwner,
        key: PropertyKey,
        value_type: PropertyType,
        cardinality: Cardinality,
    },
    SetProperty {
        owner: PropertyOwner,
        key: PropertyKey,
        value: PropertyValue,
    },
    SetProperties {
        owner: PropertyOwner,
        changes: Vec<PropertyChange>,
    },
    ClearPropertyValues {
        owner: PropertyOwner,
        key: PropertyKey,
    },
    RemoveProperty {
        owner: PropertyOwner,
        key: PropertyKey,
    },
    AddRepeatedProperty {
        owner: PropertyOwner,
        key: PropertyKey,
        value: PropertyValue,
    },
    RemoveRepeatedProperty {
        owner: PropertyOwner,
        key: PropertyKey,
        value: PropertyValue,
    },
    CreateDefaultQuery {
        default_query_id: DefaultQueryId,
        title: String,
        document: PropertyDocument,
    },
    RenameDefaultQuery {
        default_query_id: DefaultQueryId,
        title: String,
    },
    MoveDefaultQuery {
        default_query_id: DefaultQueryId,
        index: usize,
    },
    DeleteDefaultQuery {
        default_query_id: DefaultQueryId,
    },
    SetQuerySource {
        owner: QueryOwner,
        view_id: QueryViewId,
        source: String,
    },
    SpliceQuerySource {
        owner: QueryOwner,
        view_id: QueryViewId,
        index: usize,
        delete: usize,
        insert: String,
    },
    SetQueryPlan {
        owner: QueryOwner,
        view_id: QueryViewId,
        plan: QueryPlan,
    },
    PutQueryView {
        owner: QueryOwner,
        view: QueryView,
    },
    RemoveQueryView {
        owner: QueryOwner,
        view_id: QueryViewId,
    },
    SetQueryDefaultView {
        owner: QueryOwner,
        view_id: QueryViewId,
    },
    AddTag {
        entity: EntityId,
        tag_id: TagId,
    },
    RemoveTag {
        entity: EntityId,
        tag_id: TagId,
    },
    /// A single user intent that crosses existing command families. The core
    /// preflights every step against a staged document, then commits the list
    /// as one transaction and one undo item.
    Batch {
        commands: Vec<Command>,
    },
    Undo,
    Redo,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryViewKind {
    Table,
    List,
}

/// One result column as a saved view presents it. The plan (or a hand-written
/// `SELECT`) decides which variables exist; a view decides their order, their
/// width, and whether they are on screen at all. A variable the view does not
/// mention stays visible at its natural position, so widening a query never
/// hides its new column.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryViewColumn {
    pub variable: String,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub width: Option<u32>,
}

/// One term of the order a saved view lays its rows out in.
///
/// Presentation, not semantics: it reorders the rows the query already returned,
/// which is why it lives beside the other view switches and not in the plan. An
/// order that decides which rows a `LIMIT` keeps belongs to the executable query.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryViewSort {
    /// The result variable the rows are ordered by.
    pub variable: String,
    #[serde(default)]
    pub descending: bool,
}

/// One canonical entity field used to order a list view.
///
/// Unlike a table order, this names a field from the builder's condition
/// vocabulary rather than a projected result variable. A list therefore does
/// not have to ask a table to expose a value before it can order blocks by it.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryViewFieldSort {
    /// Stable client field ID (`content`, `tag`, or `property:<key>`, for example).
    pub field: String,
    #[serde(default)]
    pub descending: bool,
}

/// Presentation switches that belong to one saved view rather than to the
/// query. They never change which rows or values the query returns.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct QueryViewOptions {
    /// Rows at the outline's own row height instead of a roomier one.
    #[serde(default)]
    pub compact: bool,
    /// Let cell text wrap instead of truncating on one line.
    #[serde(default)]
    pub wrap: bool,
    /// How a table orders its projected cells, most significant term first.
    /// Empty means the order the query returned.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sort: Vec<QueryViewSort>,
    /// How a list orders canonical entity fields, most significant term first.
    /// Empty means the order the query returned.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub list_sort: Vec<QueryViewFieldSort>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryDefinition {
    /// Authoritative only when `plan` is absent. Switching a Built definition
    /// to Raw requires `SetQuerySource`, which replaces this value explicitly.
    pub source: String,
    pub language: String,
    #[serde(default)]
    pub plan: Option<QueryPlan>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryView {
    pub id: QueryViewId,
    pub name: String,
    pub definition: QueryDefinition,
    pub kind: QueryViewKind,
    pub position: u32,
    #[serde(default)]
    pub columns: Vec<QueryViewColumn>,
    #[serde(default)]
    pub options: QueryViewOptions,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitPlacement {
    Before,
    After,
    FirstChild,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutlineItem {
    pub depth: usize,
    pub markdown: String,
}

pub const OUTLINE_FRAGMENT_KIND: &str = "neoseq.outline";
pub const OUTLINE_FRAGMENT_VERSION: u32 = 2;

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutlineFragment {
    pub kind: String,
    pub version: u32,
    pub source_graph_id: GraphId,
    pub items: Vec<OutlineFragmentItem>,
    #[serde(default)]
    pub tags: Vec<OutlineFragmentTag>,
    #[serde(default)]
    pub pages: Vec<OutlineFragmentPage>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutlineFragmentItem {
    pub depth: usize,
    pub markdown: String,
    #[serde(default)]
    pub page_references: Vec<PageReferenceSpan>,
    #[serde(default)]
    pub properties: PropertyBag,
    #[serde(default)]
    pub tags: Vec<TagId>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutlineFragmentTag {
    pub id: TagId,
    pub name: String,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutlineFragmentPage {
    pub id: PageId,
    pub title: String,
    pub journal_date: Option<LocalDate>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandEnvelope {
    pub graph_id: GraphId,
    pub command_id: CommandId,
    pub command: Command,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandResult {
    pub command_id: CommandId,
    pub created_page: Option<PageId>,
    pub created_block: Option<BlockId>,
    pub created_tag: Option<TagId>,
    pub history_effect: Option<HistoryEffect>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryScope {
    Entity,
    Outline,
    Graph,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEffect {
    pub scope: HistoryScope,
    pub affected_outlines: Vec<OutlineOwner>,
    pub reveal: Option<EntityId>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockSnapshot {
    pub id: BlockId,
    /// Semantic content; display titles and spans are derived projections.
    pub content: Vec<InlineContent>,
    /// Current editor/read projection. Page-reference atoms are materialized as
    /// `[[current title]]`; canonical storage never duplicates that title.
    pub markdown: String,
    #[serde(default)]
    pub page_references: Vec<PageReferenceSpan>,
    pub properties: PropertyBag,
    pub tags: Vec<TagId>,
    pub children: Vec<BlockSnapshot>,
}

/// A complete authoritative content value and the ordered changes that produced
/// it. Positions count Unicode scalars and page-reference atoms, never titles.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockContentUpdate {
    pub owner: OutlineOwner,
    pub block_id: BlockId,
    pub content: Vec<InlineContent>,
    pub markdown: String,
    pub page_references: Vec<PageReferenceSpan>,
    pub properties: PropertyBag,
    pub mapping: Vec<ContentRangeChange>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentRangeChange {
    pub index: usize,
    pub delete: usize,
    pub insert: usize,
}

/// The read-model consequence of an applied transaction. The core determines
/// this from the prepared transition and observed document changes.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GraphChanges {
    Content {
        blocks: Vec<BlockContentUpdate>,
    },
    /// `None` invalidates every hydrated outline; an empty list affects only
    /// the summary. Unhydrated outlines remain demand reads.
    Refresh {
        outlines: Option<Vec<OutlineOwner>>,
        blocks: Vec<BlockContentUpdate>,
    },
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageReferenceSpan {
    /// Unicode-scalar range in `BlockSnapshot.markdown`.
    pub start: usize,
    pub end: usize,
    /// Position of the one reference atom in canonical block content.
    pub index: usize,
    pub page_id: PageId,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageSnapshot {
    pub id: PageId,
    pub title: String,
    pub properties: PropertyBag,
    pub tags: Vec<TagId>,
    pub blocks: Vec<BlockSnapshot>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutlineSnapshot {
    pub owner: OutlineOwner,
    pub blocks: Vec<BlockSnapshot>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphSnapshot {
    pub schema_version: u32,
    pub graph_id: GraphId,
    pub pages: Vec<PageSnapshot>,
    /// Live and deleted page identity used to materialize references without
    /// hydrating or rewriting the blocks that contain them.
    #[serde(default)]
    pub page_directory: Vec<PageDirectoryEntry>,
    pub tags: Vec<TagSnapshot>,
    pub settings: GraphSettings,
    /// Deterministic, merge-preserving semantic conflicts. These are valid
    /// collaborative states, not corrupt records, and remain visible until a
    /// user resolves the underlying values.
    #[serde(default)]
    pub conflicts: Vec<GraphConflict>,
    pub quarantined: Vec<String>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphSummary {
    pub schema_version: u32,
    pub graph_id: GraphId,
    pub pages: Vec<PageSummary>,
    #[serde(default)]
    pub page_directory: Vec<PageDirectoryEntry>,
    pub tags: Vec<TagSummary>,
    pub settings: GraphSettings,
    #[serde(default)]
    pub conflicts: Vec<GraphConflict>,
    pub quarantined: Vec<String>,
}

/// A semantic disagreement produced by otherwise valid concurrent edits.
///
/// Unlike `quarantined`, a conflict never makes the graph unreadable. Stable
/// entity IDs preserve every participant; the UI may resolve the conflicting
/// attribute with an ordinary command.
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GraphConflict {
    DuplicatePageName {
        canonical_name: String,
        page_ids: Vec<PageId>,
    },
    DuplicateTagName {
        canonical_name: String,
        tag_ids: Vec<TagId>,
    },
    /// Concurrently valid creations exceeded the bounded visible projection.
    /// The entries remain canonical data and are promoted deterministically
    /// when an earlier default query is deleted.
    DefaultQueryOverflow { overflow_ids: Vec<DefaultQueryId> },
    /// More than the locally permitted number of views survived a merge. The
    /// named views remain in the query document and are promoted when an
    /// earlier visible view is removed.
    QueryViewOverflow {
        owner: QueryOwner,
        overflow_ids: Vec<QueryViewId>,
    },
    /// The selected view was concurrently removed or fell outside the visible
    /// window. Readers use the named deterministic fallback without rewriting
    /// the canonical selection.
    QueryDefaultViewUnavailable {
        owner: QueryOwner,
        requested_view_id: QueryViewId,
        fallback_view_id: QueryViewId,
    },
    /// Concurrent text edits crossed a local resource budget. The complete
    /// CRDT text remains canonical; consumers enforce the budget before use.
    TextLimitExceeded {
        target: TextTarget,
        actual_bytes: usize,
        limit: usize,
    },
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageDirectoryEntry {
    pub id: PageId,
    /// Shared source label: the page title, or the ISO date for a journal.
    pub title: String,
    pub journal_date: Option<LocalDate>,
    pub deleted: bool,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct GraphSettings {
    /// The first bounded window in canonical `(position, id)` order. Entries
    /// beyond the local creation limit remain stored and are named by
    /// [`GraphConflict::DefaultQueryOverflow`].
    pub default_queries: Vec<DefaultQuerySnapshot>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DefaultQuerySnapshot {
    pub id: DefaultQueryId,
    pub title: String,
    pub position: u32,
    pub document: PropertyDocument,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageSummary {
    pub id: PageId,
    pub title: String,
    pub properties: PropertyBag,
    pub tags: Vec<TagId>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TagSnapshot {
    pub id: TagId,
    pub name: String,
    pub properties: PropertyBag,
    pub defaults: PropertyBag,
    pub blocks: Vec<BlockSnapshot>,
}

#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TagSummary {
    pub id: TagId,
    pub name: String,
    pub properties: PropertyBag,
    pub defaults: PropertyBag,
}
