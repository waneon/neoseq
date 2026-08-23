use crate::{
    BlockId, Cardinality, CommandId, DefaultQueryId, GraphId, LocalDate, PageId, PropertyBag,
    PropertyDocument, PropertyKey, PropertyType, PropertyValue, QueryPlan, QueryViewId, TagId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutlineOwner {
    Page { id: PageId },
    Tag { id: TagId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EntityId {
    Page { id: PageId },
    Block { owner: OutlineOwner, id: BlockId },
}

/// What a property is written on. A tag owns two bags and they mean different
/// things: `Tag` is what the tag *is* — its own metadata, including its query —
/// while `TagDefault` is what the tag copies onto whatever it is added to.
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryOwner {
    Page { id: PageId },
    Block { owner: OutlineOwner, id: BlockId },
    Tag { tag_id: TagId },
    GraphDefault { default_query_id: DefaultQueryId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkdownSplice {
    pub block_id: BlockId,
    pub index: usize,
    pub delete: usize,
    pub insert: String,
}

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
    MoveBlocks {
        block_ids: Vec<BlockId>,
        owner: OutlineOwner,
        parent: Option<BlockId>,
        index: usize,
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
        source: String,
    },
    SpliceQuerySource {
        owner: QueryOwner,
        index: usize,
        delete: usize,
        insert: String,
    },
    SetQueryPlan {
        owner: QueryOwner,
        plan: QueryPlan,
        source: String,
    },
    ClearQueryPlan {
        owner: QueryOwner,
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
    Undo,
    Redo,
}

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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryViewFieldSort {
    /// Stable client field ID (`content`, `tag`, or `property:<key>`, for example).
    pub field: String,
    #[serde(default)]
    pub descending: bool,
}

/// Accepts the single sort earlier builds wrote as well as the list this one
/// does, so a reader who had ordered a table keeps that order across the
/// upgrade instead of watching it silently vanish.
fn query_view_sorts<'de, D>(deserializer: D) -> Result<Vec<QueryViewSort>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Declaration order is the order serde tries: a list must be matched as a
    // list before the single-object form is considered.
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        Many(Vec<QueryViewSort>),
        One(QueryViewSort),
    }

    Ok(match Option::<OneOrMany>::deserialize(deserializer)? {
        None => Vec::new(),
        Some(OneOrMany::Many(sorts)) => sorts,
        Some(OneOrMany::One(sort)) => vec![sort],
    })
}

/// Presentation switches that belong to one saved view rather than to the
/// query. They never change which rows or values the query returns.
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
    #[serde(
        default,
        deserialize_with = "query_view_sorts",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub sort: Vec<QueryViewSort>,
    /// How a list orders canonical entity fields, most significant term first.
    /// Empty means the order the query returned.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub list_sort: Vec<QueryViewFieldSort>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryView {
    pub id: QueryViewId,
    pub name: String,
    pub kind: QueryViewKind,
    pub position: u32,
    #[serde(default)]
    pub columns: Vec<QueryViewColumn>,
    #[serde(default)]
    pub options: QueryViewOptions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitPlacement {
    Before,
    After,
    FirstChild,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutlineItem {
    pub depth: usize,
    pub markdown: String,
}

pub const OUTLINE_FRAGMENT_KIND: &str = "neoseq.outline";
pub const OUTLINE_FRAGMENT_VERSION: u32 = 1;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutlineFragmentItem {
    pub depth: usize,
    pub markdown: String,
    #[serde(default)]
    pub properties: PropertyBag,
    #[serde(default)]
    pub tags: Vec<TagId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutlineFragmentTag {
    pub id: TagId,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutlineFragmentPage {
    pub id: PageId,
    pub title: String,
    pub journal_date: Option<LocalDate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandEnvelope {
    pub graph_id: GraphId,
    pub command_id: CommandId,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandResult {
    pub command_id: CommandId,
    pub created_page: Option<PageId>,
    pub created_block: Option<BlockId>,
    pub created_tag: Option<TagId>,
    pub changed: bool,
    pub history_effect: Option<HistoryEffect>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryScope {
    Entity,
    Outline,
    Graph,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEffect {
    pub scope: HistoryScope,
    pub affected_outlines: Vec<OutlineOwner>,
    pub reveal: Option<EntityId>,
}

impl CommandResult {
    pub fn unchanged(command_id: CommandId) -> Self {
        Self {
            command_id,
            created_page: None,
            created_block: None,
            created_tag: None,
            changed: false,
            history_effect: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockSnapshot {
    pub id: BlockId,
    pub markdown: String,
    pub properties: PropertyBag,
    pub tags: Vec<TagId>,
    pub children: Vec<BlockSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageSnapshot {
    pub id: PageId,
    pub title: String,
    pub properties: PropertyBag,
    pub tags: Vec<TagId>,
    pub blocks: Vec<BlockSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutlineSnapshot {
    pub owner: OutlineOwner,
    pub blocks: Vec<BlockSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphSnapshot {
    pub schema_version: u32,
    pub graph_id: GraphId,
    pub pages: Vec<PageSnapshot>,
    pub tags: Vec<TagSnapshot>,
    pub settings: GraphSettings,
    pub quarantined: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphSummary {
    pub schema_version: u32,
    pub graph_id: GraphId,
    pub pages: Vec<PageSummary>,
    pub tags: Vec<TagSummary>,
    pub settings: GraphSettings,
    pub quarantined: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct GraphSettings {
    pub default_queries: Vec<DefaultQuerySnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DefaultQuerySnapshot {
    pub id: DefaultQueryId,
    pub title: String,
    pub position: u32,
    pub document: PropertyDocument,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageSummary {
    pub id: PageId,
    pub title: String,
    pub properties: PropertyBag,
    pub tags: Vec<TagId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TagSnapshot {
    pub id: TagId,
    pub name: String,
    pub properties: PropertyBag,
    pub defaults: PropertyBag,
    pub blocks: Vec<BlockSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TagSummary {
    pub id: TagId,
    pub name: String,
    pub properties: PropertyBag,
    pub defaults: PropertyBag,
}
