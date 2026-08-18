use crate::{
    BlockId, Cardinality, CommandId, GraphId, LocalDate, PageId, PropertyBag, PropertyKey,
    PropertyType, PropertyValue, QueryPlan, QueryViewId, TagId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EntityId {
    Page { id: PageId },
    Block { page_id: PageId, id: BlockId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PropertyOwner {
    Page { id: PageId },
    Block { page_id: PageId, id: BlockId },
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
        page_id: PageId,
        parent: Option<BlockId>,
        index: usize,
        markdown: String,
    },
    SplitBlock {
        page_id: PageId,
        block_id: BlockId,
        index: usize,
        placement: SplitPlacement,
    },
    InsertOutline {
        page_id: PageId,
        parent: Option<BlockId>,
        index: usize,
        replace: Option<BlockId>,
        items: Vec<OutlineItem>,
    },
    EditMarkdown {
        page_id: PageId,
        block_id: BlockId,
        markdown: String,
    },
    SpliceMarkdown {
        page_id: PageId,
        block_id: BlockId,
        index: usize,
        delete: usize,
        insert: String,
    },
    MoveBlocks {
        block_ids: Vec<BlockId>,
        page_id: PageId,
        parent: Option<BlockId>,
        index: usize,
    },
    IndentBlocks {
        page_id: PageId,
        block_ids: Vec<BlockId>,
    },
    OutdentBlocks {
        page_id: PageId,
        block_ids: Vec<BlockId>,
    },
    DeleteBlocks {
        page_id: PageId,
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

/// Presentation switches that belong to one saved view rather than to the
/// query. They never change which rows or values the query returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct QueryViewOptions {
    /// Table rows at the outline's own row height instead of a roomier one.
    #[serde(default)]
    pub compact: bool,
    /// Let cell text wrap instead of truncating on one line.
    #[serde(default)]
    pub wrap: bool,
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
    Page,
    Graph,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEffect {
    pub scope: HistoryScope,
    pub affected_pages: Vec<PageId>,
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
    pub tags: Vec<TagSnapshot>,
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
}
