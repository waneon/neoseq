use crate::{
    BlockId, Cardinality, CommandId, GraphId, LocalDate, PageId, PropertyBag, PropertyKey,
    PropertyType, PropertyValue, QueryPlan, QueryViewId, TagId,
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
    SetQuerySource {
        owner: PropertyOwner,
        source: String,
    },
    SpliceQuerySource {
        owner: PropertyOwner,
        index: usize,
        delete: usize,
        insert: String,
    },
    SetQueryPlan {
        owner: PropertyOwner,
        plan: QueryPlan,
        source: String,
    },
    ClearQueryPlan {
        owner: PropertyOwner,
    },
    PutQueryView {
        owner: PropertyOwner,
        view: QueryView,
    },
    RemoveQueryView {
        owner: PropertyOwner,
        view_id: QueryViewId,
    },
    SetQueryDefaultView {
        owner: PropertyOwner,
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
/// which is why it lives beside the other view switches and not in the plan. The
/// query's own ordering — the one that decides which rows a `LIMIT` keeps — stays
/// in the builder's sort row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryViewSort {
    /// The result variable the rows are ordered by.
    pub variable: String,
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
    /// Table rows at the outline's own row height instead of a roomier one.
    #[serde(default)]
    pub compact: bool,
    /// Let cell text wrap instead of truncating on one line.
    #[serde(default)]
    pub wrap: bool,
    /// How the reader has ordered what is on screen, most significant term
    /// first. Empty means the order the query returned.
    #[serde(
        default,
        deserialize_with = "query_view_sorts",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub sort: Vec<QueryViewSort>,
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
    pub quarantined: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphSummary {
    pub schema_version: u32,
    pub graph_id: GraphId,
    pub pages: Vec<PageSummary>,
    pub tags: Vec<TagSummary>,
    pub quarantined: Vec<String>,
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
