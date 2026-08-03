use crate::{
    BlockId, CommandId, GraphId, LocalDate, PageId, PropertyBag, PropertyKey, PropertyValue,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum EntityId {
    Page(PageId),
    Block(BlockId),
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
    InsertBlock {
        page_id: PageId,
        parent: Option<BlockId>,
        index: usize,
        markdown: String,
    },
    EditMarkdown {
        block_id: BlockId,
        markdown: String,
    },
    SpliceMarkdown {
        block_id: BlockId,
        index: usize,
        delete: usize,
        insert: String,
    },
    MoveBlock {
        block_id: BlockId,
        page_id: PageId,
        parent: Option<BlockId>,
        index: usize,
    },
    IndentBlock {
        block_id: BlockId,
    },
    OutdentBlock {
        block_id: BlockId,
    },
    DeleteBlock {
        block_id: BlockId,
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
    SetPageDefault {
        page_id: PageId,
        key: PropertyKey,
        value: PropertyValue,
    },
    RemovePageDefault {
        page_id: PageId,
        key: PropertyKey,
    },
    AddTag {
        block_id: BlockId,
        page_id: PageId,
    },
    Undo,
    Redo,
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
    pub changed: bool,
}

impl CommandResult {
    pub fn unchanged(command_id: CommandId) -> Self {
        Self {
            command_id,
            created_page: None,
            created_block: None,
            changed: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockSnapshot {
    pub id: BlockId,
    pub markdown: String,
    pub properties: PropertyBag,
    pub children: Vec<BlockSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageSnapshot {
    pub id: PageId,
    pub properties: PropertyBag,
    pub defaults: PropertyBag,
    pub blocks: Vec<BlockSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphSnapshot {
    pub schema_version: u32,
    pub graph_id: GraphId,
    pub pages: Vec<PageSnapshot>,
    pub quarantined: Vec<String>,
}
