use crate::{
    BlockId, CommandId, GraphId, LocalDate, PageId, PropertyBag, PropertyKey, PropertyValue, TagId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EntityId {
    Page { id: PageId },
    Block { page_id: PageId, id: BlockId },
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
    SetProperty {
        entity: EntityId,
        key: PropertyKey,
        value: PropertyValue,
    },
    RemoveProperty {
        entity: EntityId,
        key: PropertyKey,
    },
    AddRepeatedProperty {
        entity: EntityId,
        key: PropertyKey,
        value: PropertyValue,
    },
    RemoveRepeatedProperty {
        entity: EntityId,
        key: PropertyKey,
        value: PropertyValue,
    },
    SetTagDefault {
        tag_id: TagId,
        key: PropertyKey,
        value: PropertyValue,
    },
    RemoveTagDefault {
        tag_id: TagId,
        key: PropertyKey,
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
}

impl CommandResult {
    pub fn unchanged(command_id: CommandId) -> Self {
        Self {
            command_id,
            created_page: None,
            created_block: None,
            created_tag: None,
            changed: false,
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
