use domain::{
    BlockId, BlockSnapshot, Cardinality, Command, CommandEnvelope, CommandResult, EntityId,
    GraphId, GraphSnapshot, GraphSummary, PageId, PageSnapshot, PageSummary, PropertyBag,
    PropertyEntry, PropertyError, PropertyKey, PropertyValue, TagId, TagSnapshot, validate_default,
    validate_property,
};
use loro::{
    Container, ExportMode, LoroDoc, LoroEncodeError, LoroError, LoroMap, LoroText, LoroTree,
    LoroValue, TreeID, TreeParentId, UndoManager, ValueOrContainer,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use thiserror::Error;

pub const SCHEMA_VERSION: u32 = 3;
const IDEMPOTENCY_CAPACITY: usize = 1024;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("command targets graph {actual}, runtime owns {expected}")]
    WrongGraph { expected: GraphId, actual: GraphId },
    #[error("page does not exist: {0}")]
    PageNotFound(PageId),
    #[error("page is deleted: {0}")]
    PageDeleted(PageId),
    #[error("tag does not exist: {0}")]
    TagNotFound(TagId),
    #[error("tag is deleted: {0}")]
    TagDeleted(TagId),
    #[error("block does not exist or is deleted: {0}")]
    BlockNotFound(BlockId),
    #[error("invalid block hierarchy: {0}")]
    InvalidHierarchy(String),
    #[error("property {key} is not valid on {entity}")]
    InvalidPropertyTarget { key: String, entity: &'static str },
    #[error("text exceeds the resource limit")]
    TextTooLong,
    #[error("property validation failed: {0}")]
    Property(#[from] PropertyError),
    #[error("invalid property encoding: {0}")]
    PropertyEncoding(#[from] serde_json::Error),
    #[error("Loro operation failed: {0}")]
    Loro(#[from] LoroError),
    #[error("Loro export failed: {0}")]
    Encode(#[from] LoroEncodeError),
    #[error("snapshot graph id is missing or does not match")]
    SnapshotGraphMismatch,
    #[error("unsupported schema version {0}")]
    UnsupportedSchema(i64),
}

#[derive(Debug, Clone)]
pub struct CoreExecution {
    pub result: CommandResult,
    pub update: Vec<u8>,
    pub semantic: String,
    pub duplicate: bool,
}

pub struct GraphCore {
    graph_id: GraphId,
    doc: LoroDoc,
    undo: UndoManager,
    command_results: BTreeMap<String, CommandResult>,
    command_order: VecDeque<String>,
}

impl GraphCore {
    pub fn new(graph_id: GraphId, peer_id: u64, now: &str) -> Result<Self, CoreError> {
        let doc = LoroDoc::new();
        doc.set_peer_id(peer_id)?;
        let meta = doc.get_map("meta");
        meta.insert("graph_id", graph_id.as_str())?;
        meta.insert("schema_version", i64::from(SCHEMA_VERSION))?;
        let _ = meta.ensure_mergeable_map("applied_migrations")?;
        let _ = doc.get_map("pages");
        let _ = doc.get_map("tags");
        doc.set_next_commit_origin("system:init");
        doc.set_next_commit_message(&format!("initialize graph at {now}"));
        doc.commit();
        let undo = UndoManager::new(&doc);
        Ok(Self {
            graph_id,
            doc,
            undo,
            command_results: BTreeMap::new(),
            command_order: VecDeque::new(),
        })
    }

    pub fn from_snapshot(
        graph_id: GraphId,
        peer_id: u64,
        snapshot: &[u8],
    ) -> Result<Self, CoreError> {
        let doc = LoroDoc::from_snapshot(snapshot)?;
        doc.set_peer_id(peer_id)?;
        verify_schema(&doc, &graph_id)?;
        enable_page_outlines(&doc)?;
        let undo = UndoManager::new(&doc);
        Ok(Self {
            graph_id,
            doc,
            undo,
            command_results: BTreeMap::new(),
            command_order: VecDeque::new(),
        })
    }

    pub fn graph_id(&self) -> &GraphId {
        &self.graph_id
    }

    pub fn execute(
        &mut self,
        envelope: CommandEnvelope,
        now: &str,
    ) -> Result<CoreExecution, CoreError> {
        if envelope.graph_id != self.graph_id {
            return Err(CoreError::WrongGraph {
                expected: self.graph_id.clone(),
                actual: envelope.graph_id,
            });
        }
        if let Some(result) = self.command_results.get(envelope.command_id.as_str()) {
            return Ok(CoreExecution {
                result: result.clone(),
                update: Vec::new(),
                semantic: "CommandDeduplicated".to_owned(),
                duplicate: true,
            });
        }

        let before = self.doc.oplog_vv();
        let semantic = semantic_name(&envelope.command).to_owned();
        let mut result = CommandResult {
            command_id: envelope.command_id.clone(),
            created_page: None,
            created_block: None,
            created_tag: None,
            changed: true,
        };

        match &envelope.command {
            Command::Undo => {
                result.changed = self.undo.undo()?;
                self.doc.commit();
            }
            Command::Redo => {
                result.changed = self.undo.redo()?;
                self.doc.commit();
            }
            command => {
                self.validate(command)?;
                self.undo.group_start()?;
                self.doc.set_next_commit_origin("local:command");
                self.doc
                    .set_next_commit_message(envelope.command_id.as_str());
                let apply_result = self.apply(command, now, &mut result);
                if apply_result.is_ok() {
                    self.doc.commit();
                }
                self.undo.group_end();
                apply_result?;
            }
        }

        let update = self.doc.export(ExportMode::updates(&before))?;
        self.remember(envelope.command_id.as_str(), result.clone());
        Ok(CoreExecution {
            result,
            update,
            semantic,
            duplicate: false,
        })
    }

    pub fn import_remote(&mut self, update: &[u8]) -> Result<(), CoreError> {
        self.doc.set_next_commit_origin("remote:import");
        self.doc.import(update)?;
        verify_schema(&self.doc, &self.graph_id)?;
        Ok(())
    }

    pub fn export_snapshot(&self) -> Result<Vec<u8>, CoreError> {
        Ok(self.doc.export(ExportMode::Snapshot)?)
    }

    pub fn export_all(&self) -> Result<Vec<u8>, CoreError> {
        Ok(self.doc.export(ExportMode::all_updates())?)
    }

    pub fn snapshot(&self) -> Result<GraphSnapshot, CoreError> {
        let pages = self.doc.get_map("pages");
        let mut snapshots = BTreeMap::<PageId, PageSnapshot>::new();
        let mut quarantined = Vec::new();

        pages.for_each(|raw_id, value| {
            let Ok(page_id) = PageId::new(raw_id) else {
                quarantined.push(format!("page:{raw_id}:invalid-id"));
                return;
            };
            let Some(page) = value_into_map(value) else {
                quarantined.push(format!("page:{raw_id}:not-map"));
                return;
            };
            if let Some(snapshot) = page_metadata(&page_id, &page, &mut quarantined) {
                snapshots.insert(page_id, snapshot);
            }
        });

        for (page_id, snapshot) in &mut snapshots {
            let page = self.require_page(page_id)?;
            let Some(outline) = page.get("outline").and_then(value_into_tree) else {
                quarantined.push(format!("page:{page_id}:outline:missing-or-invalid"));
                continue;
            };
            for root in outline.roots() {
                snapshot
                    .blocks
                    .push(block_snapshot(&outline, root, &mut quarantined)?);
            }
        }

        let tags = tag_snapshots(&self.doc, &mut quarantined);
        quarantined.sort();
        Ok(GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            graph_id: self.graph_id.clone(),
            pages: snapshots.into_values().collect(),
            tags,
            quarantined,
        })
    }

    pub fn summary(&self) -> Result<GraphSummary, CoreError> {
        let snapshot = self.snapshot_metadata()?;
        Ok(GraphSummary {
            schema_version: snapshot.schema_version,
            graph_id: snapshot.graph_id,
            pages: snapshot
                .pages
                .into_iter()
                .map(|page| PageSummary {
                    id: page.id,
                    title: page.title,
                    properties: page.properties,
                    tags: page.tags,
                })
                .collect(),
            tags: snapshot.tags,
            quarantined: snapshot.quarantined,
        })
    }

    pub fn page_snapshot(&self, page_id: &PageId) -> Result<PageSnapshot, CoreError> {
        let page = self.require_live_page(page_id)?;
        let mut quarantined = Vec::new();
        let mut snapshot = page_metadata(page_id, &page, &mut quarantined)
            .ok_or_else(|| CoreError::PageDeleted(page_id.clone()))?;
        let outline = page
            .get("outline")
            .and_then(value_into_tree)
            .ok_or_else(|| CoreError::InvalidHierarchy("page outline is missing".to_owned()))?;
        for root in outline.roots() {
            snapshot
                .blocks
                .push(block_snapshot(&outline, root, &mut quarantined)?);
        }
        Ok(snapshot)
    }

    fn snapshot_metadata(&self) -> Result<GraphSnapshot, CoreError> {
        let pages = self.doc.get_map("pages");
        let mut snapshots = BTreeMap::<PageId, PageSnapshot>::new();
        let mut quarantined = Vec::new();
        pages.for_each(|raw_id, value| {
            let Ok(page_id) = PageId::new(raw_id) else {
                quarantined.push(format!("page:{raw_id}:invalid-id"));
                return;
            };
            let Some(page) = value_into_map(value) else {
                quarantined.push(format!("page:{raw_id}:not-map"));
                return;
            };
            if let Some(snapshot) = page_metadata(&page_id, &page, &mut quarantined) {
                snapshots.insert(page_id, snapshot);
            }
        });
        let tags = tag_snapshots(&self.doc, &mut quarantined);
        quarantined.sort();
        Ok(GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            graph_id: self.graph_id.clone(),
            pages: snapshots.into_values().collect(),
            tags,
            quarantined,
        })
    }

    pub fn canonical_json(&self) -> Result<String, CoreError> {
        Ok(serde_json::to_string(&self.snapshot()?)?)
    }

    pub fn fingerprint(&self) -> Result<String, CoreError> {
        let digest = Sha256::digest(self.canonical_json()?.as_bytes());
        Ok(hex::encode(digest))
    }

    fn remember(&mut self, id: &str, result: CommandResult) {
        if self.command_results.contains_key(id) {
            return;
        }
        self.command_results.insert(id.to_owned(), result);
        self.command_order.push_back(id.to_owned());
        if self.command_order.len() > IDEMPOTENCY_CAPACITY
            && let Some(expired) = self.command_order.pop_front()
        {
            self.command_results.remove(&expired);
        }
    }

    fn validate(&self, command: &Command) -> Result<(), CoreError> {
        match command {
            Command::EnsurePage { title, .. } | Command::EnsureTag { name: title, .. } => {
                validate_text(title, 1024)?;
            }
            Command::RenamePage { page_id, title } => {
                validate_text(title, 1024)?;
                self.require_page(page_id)?;
            }
            Command::RenameTag { tag_id, name } => {
                validate_text(name, 1024)?;
                self.require_tag(tag_id)?;
            }
            Command::InsertBlock {
                page_id,
                parent,
                markdown,
                ..
            } => {
                self.require_live_page(page_id)?;
                validate_text(markdown, 1_048_576)?;
                if let Some(parent) = parent {
                    self.require_block(page_id, parent)?;
                }
            }
            Command::EditMarkdown {
                page_id,
                block_id,
                markdown,
            } => {
                self.require_block(page_id, block_id)?;
                validate_text(markdown, 1_048_576)?;
            }
            Command::SpliceMarkdown {
                page_id,
                block_id,
                insert,
                ..
            } => {
                self.require_block(page_id, block_id)?;
                validate_text(insert, 1_048_576)?;
            }
            Command::MoveBlock {
                block_id,
                page_id,
                parent,
                ..
            } => {
                self.require_live_page(page_id)?;
                let block = self.require_block(page_id, block_id)?;
                if let Some(parent) = parent {
                    let parent = self.require_block(page_id, parent)?;
                    if parent == block || self.is_descendant(page_id, parent, block)? {
                        return Err(CoreError::InvalidHierarchy(
                            "move would create a cycle".into(),
                        ));
                    }
                }
            }
            Command::IndentBlock { page_id, block_id }
            | Command::OutdentBlock { page_id, block_id }
            | Command::DeleteBlock { page_id, block_id } => {
                self.require_block(page_id, block_id)?;
            }
            Command::DeletePage { page_id } | Command::RestorePage { page_id } => {
                self.require_page(page_id)?;
            }
            Command::DeleteTag { tag_id }
            | Command::RestoreTag { tag_id }
            | Command::RemoveTagDefault { tag_id, .. } => {
                self.require_tag(tag_id)?;
            }
            Command::SetProperty { entity, key, value } => {
                self.validate_entity(entity)?;
                validate_target(entity, key)?;
                validate_property(key, value, Cardinality::Single)?;
            }
            Command::AddRepeatedProperty { entity, key, value }
            | Command::RemoveRepeatedProperty { entity, key, value } => {
                self.validate_entity(entity)?;
                validate_target(entity, key)?;
                validate_property(key, value, Cardinality::Repeated)?;
            }
            Command::RemoveProperty { entity, key } => {
                self.validate_entity(entity)?;
                validate_target(entity, key)?;
            }
            Command::SetTagDefault { tag_id, key, value } => {
                self.require_tag(tag_id)?;
                validate_default(key, value)?;
            }
            Command::AddTag { entity, tag_id } => {
                self.validate_entity(entity)?;
                self.require_live_tag(tag_id)?;
            }
            Command::RemoveTag { entity, tag_id } => {
                self.validate_entity(entity)?;
                self.require_tag(tag_id)?;
            }
            Command::EnsureJournal { .. } | Command::Undo | Command::Redo => {}
        }
        Ok(())
    }

    fn apply(
        &mut self,
        command: &Command,
        now: &str,
        result: &mut CommandResult,
    ) -> Result<(), CoreError> {
        match command {
            Command::EnsurePage { page_id, title } => {
                result.created_page =
                    self.ensure_page(page_id, "regular", Some(title), None, now)?;
                result.changed = result.created_page.is_some();
            }
            Command::EnsureJournal { date } => {
                let page_id = PageId::journal(&self.graph_id, date);
                result.created_page =
                    self.ensure_page(&page_id, "journal", None, Some(date.clone()), now)?;
                result.changed = result.created_page.is_some();
            }
            Command::RenamePage { page_id, title } => {
                replace_text(
                    &self.page_root(page_id)?.ensure_mergeable_text("content")?,
                    title,
                )?;
            }
            Command::DeletePage { page_id } => {
                let bag = self.page_properties(page_id)?;
                set_single(
                    &bag,
                    &key("system.deleted-at"),
                    &PropertyValue::String(now.to_owned()),
                )?;
            }
            Command::RestorePage { page_id } => {
                self.page_properties(page_id)?
                    .delete(&single_slot(&key("system.deleted-at")))?;
            }
            Command::EnsureTag { tag_id, name } => {
                result.created_tag = self.ensure_tag(tag_id, name, now)?;
                result.changed = result.created_tag.is_some();
            }
            Command::RenameTag { tag_id, name } => {
                self.require_tag(tag_id)?.insert("name", name.as_str())?;
            }
            Command::DeleteTag { tag_id } => {
                set_single(
                    &self.tag_bag(tag_id, "properties")?,
                    &key("system.deleted-at"),
                    &PropertyValue::String(now.to_owned()),
                )?;
            }
            Command::RestoreTag { tag_id } => {
                self.tag_bag(tag_id, "properties")?
                    .delete(&single_slot(&key("system.deleted-at")))?;
            }
            Command::InsertBlock {
                page_id,
                parent,
                index,
                markdown,
            } => {
                let outline = self.page_outline(page_id)?;
                let parent_tree = parent.as_ref().map(tree_id).transpose()?;
                let available = parent_tree.map_or_else(
                    || outline.roots().len(),
                    |parent| outline.children(parent).map_or(0, |items| items.len()),
                );
                let tree_index = (*index).min(available);
                let node = outline.create_at(parent_tree, tree_index)?;
                let meta = outline.get_meta(node)?;
                initialize_node(&meta, markdown)?;
                result.created_block = Some(block_id(node));
            }
            Command::EditMarkdown {
                page_id,
                block_id,
                markdown,
            } => {
                let text = self.block_text(page_id, block_id)?;
                if text.len_unicode() > 0 {
                    text.delete(0, text.len_unicode())?;
                }
                text.insert(0, markdown)?;
            }
            Command::SpliceMarkdown {
                page_id,
                block_id,
                index,
                delete,
                insert,
            } => {
                let text = self.block_text(page_id, block_id)?;
                if index.saturating_add(*delete) > text.len_unicode() {
                    return Err(CoreError::InvalidHierarchy(
                        "markdown splice is out of bounds".into(),
                    ));
                }
                if *delete > 0 {
                    text.delete(*index, *delete)?;
                }
                if !insert.is_empty() {
                    text.insert(*index, insert)?;
                }
            }
            Command::MoveBlock {
                block_id,
                page_id,
                parent,
                index,
            } => {
                self.move_block(block_id, page_id, parent.as_ref(), *index)?;
            }
            Command::IndentBlock { page_id, block_id } => self.indent(page_id, block_id)?,
            Command::OutdentBlock { page_id, block_id } => self.outdent(page_id, block_id)?,
            Command::DeleteBlock { page_id, block_id } => {
                self.touch_block(page_id, block_id, now)?;
                self.page_outline(page_id)?.delete(tree_id(block_id)?)?
            }
            Command::SetProperty { entity, key, value } => {
                set_single(&self.entity_bag(entity)?, key, value)?;
            }
            Command::RemoveProperty { entity, key } => {
                self.entity_bag(entity)?.delete(&single_slot(key))?;
            }
            Command::AddRepeatedProperty { entity, key, value } => {
                set_repeated(&self.entity_bag(entity)?, key, value)?;
            }
            Command::RemoveRepeatedProperty { entity, key, value } => {
                self.entity_bag(entity)?
                    .delete(&repeated_slot(key, value)?)?;
            }
            Command::SetTagDefault { tag_id, key, value } => {
                set_single(&self.tag_bag(tag_id, "defaults")?, key, value)?;
            }
            Command::RemoveTagDefault { tag_id, key } => {
                self.tag_bag(tag_id, "defaults")?
                    .delete(&single_slot(key))?;
            }
            Command::AddTag { entity, tag_id } => {
                self.entity_tags(entity)?.insert(tag_id.as_str(), true)?;
                let entity_bag = self.entity_bag(entity)?;
                for entry in decode_bag(&self.tag_bag(tag_id, "defaults")?).0 {
                    if !bag_contains_key(&entity_bag, &entry.key) {
                        set_single(&entity_bag, &entry.key, &entry.value)?;
                    }
                }
            }
            Command::RemoveTag { entity, tag_id } => {
                self.entity_tags(entity)?.delete(tag_id.as_str())?;
            }
            Command::Undo | Command::Redo => unreachable!("handled before apply"),
        }
        if result.changed {
            self.touch_command(command, result, now)?;
        }
        Ok(())
    }

    fn touch_command(
        &self,
        command: &Command,
        result: &CommandResult,
        now: &str,
    ) -> Result<(), CoreError> {
        match command {
            Command::EnsurePage { .. } | Command::EnsureJournal { .. } => {
                if let Some(page_id) = &result.created_page {
                    self.touch_page(page_id, now)?;
                }
            }
            Command::RenamePage { page_id, .. }
            | Command::DeletePage { page_id }
            | Command::RestorePage { page_id } => self.touch_page(page_id, now)?,
            Command::InsertBlock { page_id, .. } => {
                if let Some(block_id) = &result.created_block {
                    self.touch_block(page_id, block_id, now)?;
                }
                self.touch_page(page_id, now)?;
            }
            Command::EditMarkdown {
                page_id, block_id, ..
            }
            | Command::SpliceMarkdown {
                page_id, block_id, ..
            }
            | Command::MoveBlock {
                page_id, block_id, ..
            }
            | Command::IndentBlock { page_id, block_id }
            | Command::OutdentBlock { page_id, block_id } => {
                self.touch_block(page_id, block_id, now)?;
                self.touch_page(page_id, now)?;
            }
            Command::DeleteBlock { page_id, .. } => self.touch_page(page_id, now)?,
            Command::SetProperty { entity, .. }
            | Command::RemoveProperty { entity, .. }
            | Command::AddRepeatedProperty { entity, .. }
            | Command::RemoveRepeatedProperty { entity, .. }
            | Command::AddTag { entity, .. }
            | Command::RemoveTag { entity, .. } => self.touch_entity(entity, now)?,
            Command::EnsureTag { .. }
            | Command::RenameTag { .. }
            | Command::DeleteTag { .. }
            | Command::RestoreTag { .. }
            | Command::SetTagDefault { .. }
            | Command::RemoveTagDefault { .. }
            | Command::Undo
            | Command::Redo => {}
        }
        Ok(())
    }

    fn touch_entity(&self, entity: &EntityId, now: &str) -> Result<(), CoreError> {
        match entity {
            EntityId::Page { id } => self.touch_page(id, now),
            EntityId::Block { page_id, id } => {
                self.touch_block(page_id, id, now)?;
                self.touch_page(page_id, now)
            }
        }
    }

    fn touch_page(&self, page_id: &PageId, now: &str) -> Result<(), CoreError> {
        set_single(
            &self.page_properties(page_id)?,
            &key("system.updated-at"),
            &PropertyValue::String(now.to_owned()),
        )
    }

    fn touch_block(
        &self,
        page_id: &PageId,
        block_id: &BlockId,
        now: &str,
    ) -> Result<(), CoreError> {
        set_single(
            &self.block_bag(page_id, block_id)?,
            &key("system.updated-at"),
            &PropertyValue::String(now.to_owned()),
        )
    }

    fn ensure_page(
        &self,
        page_id: &PageId,
        kind: &str,
        title: Option<&str>,
        date: Option<domain::LocalDate>,
        now: &str,
    ) -> Result<Option<PageId>, CoreError> {
        let pages = self.doc.get_map("pages");
        let existed = pages.get(page_id.as_str()).is_some();
        let page = pages.ensure_mergeable_map(page_id.as_str())?;
        let root = page.ensure_mergeable_map("root")?;
        initialize_node(&root, "")?;
        let properties = root.ensure_mergeable_map("properties")?;
        let outline = page.ensure_mergeable_tree("outline")?;
        outline.enable_fractional_index(0);
        if !existed {
            replace_text(
                &root.ensure_mergeable_text("content")?,
                title.unwrap_or_default(),
            )?;
            set_single(
                &properties,
                &key("page.kind"),
                &PropertyValue::String(kind.to_owned()),
            )?;
            if let Some(date) = date {
                set_single(
                    &properties,
                    &key("journal.date"),
                    &PropertyValue::Date(date),
                )?;
            }
            set_single(
                &properties,
                &key("system.created-at"),
                &PropertyValue::String(now.to_owned()),
            )?;
            Ok(Some(page_id.clone()))
        } else {
            Ok(None)
        }
    }

    fn ensure_tag(
        &self,
        tag_id: &TagId,
        name: &str,
        now: &str,
    ) -> Result<Option<TagId>, CoreError> {
        let tags = self.doc.get_map("tags");
        let existed = tags.get(tag_id.as_str()).is_some();
        let tag = tags.ensure_mergeable_map(tag_id.as_str())?;
        let properties = tag.ensure_mergeable_map("properties")?;
        let _ = tag.ensure_mergeable_map("defaults")?;
        if existed {
            return Ok(None);
        }
        tag.insert("name", name)?;
        set_single(
            &properties,
            &key("system.created-at"),
            &PropertyValue::String(now.to_owned()),
        )?;
        Ok(Some(tag_id.clone()))
    }

    fn move_block(
        &self,
        block_id: &BlockId,
        page_id: &PageId,
        parent: Option<&BlockId>,
        index: usize,
    ) -> Result<(), CoreError> {
        let outline = self.page_outline(page_id)?;
        let block = tree_id(block_id)?;
        let parent = parent.map(tree_id).transpose()?;
        let available = parent.map_or_else(
            || {
                outline
                    .roots()
                    .into_iter()
                    .filter(|item| *item != block)
                    .count()
            },
            |parent| {
                outline
                    .children(parent)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|item| *item != block)
                    .count()
            },
        );
        outline.mov_to(block, parent, index.min(available))?;
        Ok(())
    }

    fn indent(&self, page_id: &PageId, block_id: &BlockId) -> Result<(), CoreError> {
        let outline = self.page_outline(page_id)?;
        let block = tree_id(block_id)?;
        let parent = outline
            .parent(block)
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        let siblings = outline.children(parent).unwrap_or_default();
        let position = siblings
            .iter()
            .position(|item| *item == block)
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        if position == 0 {
            return Err(CoreError::InvalidHierarchy(
                "first sibling cannot be indented".into(),
            ));
        }
        let new_parent = siblings[position - 1];
        outline.mov(block, new_parent)?;
        Ok(())
    }

    fn outdent(&self, page_id: &PageId, block_id: &BlockId) -> Result<(), CoreError> {
        let outline = self.page_outline(page_id)?;
        let block = tree_id(block_id)?;
        let Some(TreeParentId::Node(parent)) = outline.parent(block) else {
            return Err(CoreError::InvalidHierarchy(
                "root block cannot be outdented".into(),
            ));
        };
        outline
            .parent(parent)
            .ok_or_else(|| CoreError::InvalidHierarchy("missing grandparent".into()))?;
        outline.mov_after(block, parent)?;
        Ok(())
    }

    fn require_page(&self, page_id: &PageId) -> Result<LoroMap, CoreError> {
        self.doc
            .get_map("pages")
            .get(page_id.as_str())
            .and_then(value_into_map)
            .ok_or_else(|| CoreError::PageNotFound(page_id.clone()))
    }

    fn require_live_page(&self, page_id: &PageId) -> Result<LoroMap, CoreError> {
        let page = self.require_page(page_id)?;
        if bag_contains_key(
            &page
                .ensure_mergeable_map("root")?
                .ensure_mergeable_map("properties")?,
            &key("system.deleted-at"),
        ) {
            return Err(CoreError::PageDeleted(page_id.clone()));
        }
        Ok(page)
    }

    fn page_outline(&self, page_id: &PageId) -> Result<LoroTree, CoreError> {
        let outline = self
            .require_page(page_id)?
            .get("outline")
            .and_then(value_into_tree)
            .ok_or_else(|| CoreError::InvalidHierarchy("page outline is missing".to_owned()))?;
        outline.enable_fractional_index(0);
        Ok(outline)
    }

    fn require_block(&self, page_id: &PageId, block_id: &BlockId) -> Result<TreeID, CoreError> {
        let outline = self.page_outline(page_id)?;
        require_block_in(&outline, block_id)
    }

    fn page_properties(&self, page_id: &PageId) -> Result<LoroMap, CoreError> {
        Ok(self
            .page_root(page_id)?
            .ensure_mergeable_map("properties")?)
    }

    fn page_root(&self, page_id: &PageId) -> Result<LoroMap, CoreError> {
        self.require_page(page_id)?
            .get("root")
            .and_then(value_into_map)
            .ok_or_else(|| CoreError::InvalidHierarchy("page root node is missing".to_owned()))
    }

    fn require_tag(&self, tag_id: &TagId) -> Result<LoroMap, CoreError> {
        self.doc
            .get_map("tags")
            .get(tag_id.as_str())
            .and_then(value_into_map)
            .ok_or_else(|| CoreError::TagNotFound(tag_id.clone()))
    }

    fn require_live_tag(&self, tag_id: &TagId) -> Result<LoroMap, CoreError> {
        let tag = self.require_tag(tag_id)?;
        if bag_contains_key(
            &tag.ensure_mergeable_map("properties")?,
            &key("system.deleted-at"),
        ) {
            return Err(CoreError::TagDeleted(tag_id.clone()));
        }
        Ok(tag)
    }

    fn tag_bag(&self, tag_id: &TagId, name: &str) -> Result<LoroMap, CoreError> {
        Ok(self.require_tag(tag_id)?.ensure_mergeable_map(name)?)
    }

    fn block_bag(&self, page_id: &PageId, block_id: &BlockId) -> Result<LoroMap, CoreError> {
        let outline = self.page_outline(page_id)?;
        Ok(outline
            .get_meta(require_block_in(&outline, block_id)?)?
            .ensure_mergeable_map("properties")?)
    }

    fn block_text(&self, page_id: &PageId, block_id: &BlockId) -> Result<LoroText, CoreError> {
        let outline = self.page_outline(page_id)?;
        Ok(outline
            .get_meta(require_block_in(&outline, block_id)?)?
            .ensure_mergeable_text("content")?)
    }

    fn entity_bag(&self, entity: &EntityId) -> Result<LoroMap, CoreError> {
        match entity {
            EntityId::Page { id } => self.page_properties(id),
            EntityId::Block { page_id, id } => self.block_bag(page_id, id),
        }
    }

    fn entity_tags(&self, entity: &EntityId) -> Result<LoroMap, CoreError> {
        match entity {
            EntityId::Page { id } => Ok(self.page_root(id)?.ensure_mergeable_map("tag_refs")?),
            EntityId::Block { page_id, id } => {
                let outline = self.page_outline(page_id)?;
                Ok(outline
                    .get_meta(require_block_in(&outline, id)?)?
                    .ensure_mergeable_map("tag_refs")?)
            }
        }
    }

    fn validate_entity(&self, entity: &EntityId) -> Result<(), CoreError> {
        match entity {
            EntityId::Page { id } => {
                self.require_page(id)?;
            }
            EntityId::Block { page_id, id } => {
                self.require_block(page_id, id)?;
            }
        }
        Ok(())
    }

    fn is_descendant(
        &self,
        page_id: &PageId,
        mut candidate: TreeID,
        ancestor: TreeID,
    ) -> Result<bool, CoreError> {
        let outline = self.page_outline(page_id)?;
        loop {
            match outline.parent(candidate) {
                Some(TreeParentId::Node(parent)) if parent == ancestor => return Ok(true),
                Some(TreeParentId::Node(parent)) => candidate = parent,
                _ => return Ok(false),
            }
        }
    }
}

fn verify_schema(doc: &LoroDoc, graph_id: &GraphId) -> Result<(), CoreError> {
    let meta = doc.get_map("meta");
    match map_string(&meta, "graph_id") {
        Some(value) if value == graph_id.as_str() => {}
        _ => return Err(CoreError::SnapshotGraphMismatch),
    }
    match map_i64(&meta, "schema_version") {
        Some(value) if value == i64::from(SCHEMA_VERSION) => Ok(()),
        Some(value) => Err(CoreError::UnsupportedSchema(value)),
        None => Err(CoreError::UnsupportedSchema(0)),
    }
}

fn validate_text(value: &str, max: usize) -> Result<(), CoreError> {
    if value.len() > max {
        Err(CoreError::TextTooLong)
    } else {
        Ok(())
    }
}

fn validate_target(entity: &EntityId, key: &PropertyKey) -> Result<(), CoreError> {
    let valid = valid_target_kind(matches!(entity, EntityId::Page { .. }), key);
    if valid {
        Ok(())
    } else {
        Err(CoreError::InvalidPropertyTarget {
            key: key.to_string(),
            entity: match entity {
                EntityId::Page { .. } => "page",
                EntityId::Block { .. } => "block",
            },
        })
    }
}

fn valid_target_kind(page: bool, key: &PropertyKey) -> bool {
    if matches!(key.as_str(), "block.page" | "page.title" | "tag") {
        return false;
    }
    if page {
        true
    } else {
        key.as_str() == "system.updated-at"
            || (!key.as_str().starts_with("page.")
                && key.as_str() != "journal.date"
                && !key.as_str().starts_with("system."))
    }
}

fn semantic_name(command: &Command) -> &'static str {
    match command {
        Command::EnsurePage { .. } => "PageEnsured",
        Command::EnsureJournal { .. } => "JournalEnsured",
        Command::RenamePage { .. } => "PageRenamed",
        Command::DeletePage { .. } => "PageDeleted",
        Command::RestorePage { .. } => "PageRestored",
        Command::EnsureTag { .. } => "TagEnsured",
        Command::RenameTag { .. } => "TagRenamed",
        Command::DeleteTag { .. } => "TagDeleted",
        Command::RestoreTag { .. } => "TagRestored",
        Command::InsertBlock { .. } => "BlockInserted",
        Command::EditMarkdown { .. } | Command::SpliceMarkdown { .. } => "BlockTextChanged",
        Command::MoveBlock { .. } | Command::IndentBlock { .. } | Command::OutdentBlock { .. } => {
            "SubtreeMoved"
        }
        Command::DeleteBlock { .. } => "SubtreeDeleted",
        Command::SetTagDefault { .. } | Command::RemoveTagDefault { .. } => "TagDefaultsChanged",
        Command::AddTag { .. } => "TagAddedAndDefaultsMaterialized",
        Command::RemoveTag { .. } => "TagRemoved",
        Command::SetProperty { .. }
        | Command::RemoveProperty { .. }
        | Command::AddRepeatedProperty { .. }
        | Command::RemoveRepeatedProperty { .. } => "PropertiesChanged",
        Command::Undo => "LocalUndo",
        Command::Redo => "LocalRedo",
    }
}

fn key(value: &str) -> PropertyKey {
    PropertyKey::new(value).expect("static key")
}
fn block_id(value: TreeID) -> BlockId {
    BlockId::new(value.to_string()).expect("Loro tree id")
}
fn tree_id(value: &BlockId) -> Result<TreeID, CoreError> {
    TreeID::try_from(value.as_str()).map_err(CoreError::Loro)
}

fn require_block_in(outline: &LoroTree, block_id: &BlockId) -> Result<TreeID, CoreError> {
    let tree = tree_id(block_id).map_err(|_| CoreError::BlockNotFound(block_id.clone()))?;
    if !outline.contains(tree) || outline.is_node_deleted(&tree)? {
        return Err(CoreError::BlockNotFound(block_id.clone()));
    }
    Ok(tree)
}

fn single_slot(key: &PropertyKey) -> String {
    format!("s:{}", key.as_str())
}

fn repeated_slot(key: &PropertyKey, value: &PropertyValue) -> Result<String, CoreError> {
    let encoded = serde_json::to_vec(value)?;
    Ok(format!(
        "r:{}:{}",
        key.as_str(),
        hex::encode(Sha256::digest(encoded))
    ))
}

fn initialize_node(node: &LoroMap, content: &str) -> Result<(), CoreError> {
    let text = node.ensure_mergeable_text("content")?;
    if text.len_unicode() == 0 && !content.is_empty() {
        text.insert(0, content)?;
    }
    let _ = node.ensure_mergeable_map("properties")?;
    let _ = node.ensure_mergeable_map("tag_refs")?;
    Ok(())
}

fn replace_text(text: &LoroText, content: &str) -> Result<(), CoreError> {
    if text.len_unicode() > 0 {
        text.delete(0, text.len_unicode())?;
    }
    if !content.is_empty() {
        text.insert(0, content)?;
    }
    Ok(())
}

fn encode_entry(key: &PropertyKey, value: &PropertyValue) -> Result<String, CoreError> {
    Ok(serde_json::to_string(&PropertyEntry {
        key: key.clone(),
        value: value.clone(),
    })?)
}

fn set_single(map: &LoroMap, key: &PropertyKey, value: &PropertyValue) -> Result<(), CoreError> {
    map.insert(&single_slot(key), encode_entry(key, value)?)?;
    Ok(())
}

fn set_repeated(map: &LoroMap, key: &PropertyKey, value: &PropertyValue) -> Result<(), CoreError> {
    map.insert(&repeated_slot(key, value)?, encode_entry(key, value)?)?;
    Ok(())
}

fn bag_contains_key(map: &LoroMap, key: &PropertyKey) -> bool {
    map.get(&single_slot(key)).is_some() || {
        let prefix = format!("r:{}:", key.as_str());
        let mut found = false;
        map.for_each(|slot, _| found |= slot.starts_with(&prefix));
        found
    }
}

fn bag_has_key(bag: &PropertyBag, key: &str) -> bool {
    bag.iter().any(|entry| entry.key.as_str() == key)
}

fn decode_bag_child(page: &LoroMap, name: &str) -> (PropertyBag, Vec<String>) {
    match page.get(name).and_then(value_into_map) {
        Some(map) => decode_bag(&map),
        None => (
            Vec::new(),
            vec![format!("property-bag:{name}:missing-or-invalid")],
        ),
    }
}

fn decode_bag(map: &LoroMap) -> (PropertyBag, Vec<String>) {
    let mut entries = Vec::new();
    let mut issues = Vec::new();
    map.for_each(|slot, value| {
        let Some(encoded) = value_into_string(value) else {
            issues.push(format!("property-slot:{slot}:not-atomic-string"));
            return;
        };
        let Ok(entry) = serde_json::from_str::<PropertyEntry>(&encoded) else {
            issues.push(format!("property-slot:{slot}:invalid-entry"));
            return;
        };
        let cardinality = if slot.starts_with("s:") {
            Cardinality::Single
        } else if slot.starts_with("r:") {
            Cardinality::Repeated
        } else {
            issues.push(format!("property-slot:{slot}:invalid-slot"));
            return;
        };
        if validate_property(&entry.key, &entry.value, cardinality).is_err() {
            issues.push(format!("property-slot:{slot}:contract-violation"));
            return;
        }
        entries.push(entry);
    });
    entries.sort_by(|left, right| {
        left.key.cmp(&right.key).then_with(|| {
            serde_json::to_string(&left.value)
                .unwrap_or_default()
                .cmp(&serde_json::to_string(&right.value).unwrap_or_default())
        })
    });
    issues.sort();
    (entries, issues)
}

fn page_metadata(
    page_id: &PageId,
    page: &LoroMap,
    quarantined: &mut Vec<String>,
) -> Option<PageSnapshot> {
    let Some(root) = page.get("root").and_then(value_into_map) else {
        quarantined.push(format!("page:{page_id}:root:missing-or-invalid"));
        return None;
    };
    let title = match root.get("content") {
        Some(ValueOrContainer::Container(Container::Text(text))) => text.to_string(),
        _ => {
            quarantined.push(format!("page:{page_id}:root:missing-content"));
            String::new()
        }
    };
    let (mut properties, mut issues) = decode_bag_child(&root, "properties");
    quarantined.append(&mut issues);
    properties.retain(|entry| {
        if valid_target_kind(true, &entry.key) {
            true
        } else {
            quarantined.push(format!(
                "page:{page_id}:property:{}:invalid-target",
                entry.key
            ));
            false
        }
    });
    if bag_has_key(&properties, "system.deleted-at") {
        return None;
    }
    let tags = decode_tag_refs(&root, &format!("page:{page_id}"), quarantined);
    Some(PageSnapshot {
        id: page_id.clone(),
        title,
        properties,
        tags,
        blocks: Vec::new(),
    })
}

fn tag_snapshots(doc: &LoroDoc, quarantined: &mut Vec<String>) -> Vec<TagSnapshot> {
    let tags = doc.get_map("tags");
    let mut snapshots = BTreeMap::new();
    tags.for_each(|raw_id, value| {
        let Ok(tag_id) = TagId::new(raw_id) else {
            quarantined.push(format!("tag:{raw_id}:invalid-id"));
            return;
        };
        let Some(tag) = value_into_map(value) else {
            quarantined.push(format!("tag:{raw_id}:not-map"));
            return;
        };
        let Some(name) = map_string(&tag, "name") else {
            quarantined.push(format!("tag:{raw_id}:missing-name"));
            return;
        };
        let (mut properties, mut issues) = decode_bag_child(&tag, "properties");
        quarantined.append(&mut issues);
        if bag_has_key(&properties, "system.deleted-at") {
            return;
        }
        properties.retain(|entry| entry.key.as_str().starts_with("system."));
        let (mut defaults, mut issues) = decode_bag_child(&tag, "defaults");
        quarantined.append(&mut issues);
        defaults.retain(|entry| validate_default(&entry.key, &entry.value).is_ok());
        snapshots.insert(
            tag_id.clone(),
            TagSnapshot {
                id: tag_id,
                name,
                properties,
                defaults,
            },
        );
    });
    snapshots.into_values().collect()
}

fn decode_tag_refs(node: &LoroMap, owner: &str, quarantined: &mut Vec<String>) -> Vec<TagId> {
    let Some(refs) = node.get("tag_refs").and_then(value_into_map) else {
        quarantined.push(format!("{owner}:tag-refs:missing-or-invalid"));
        return Vec::new();
    };
    let mut tags = Vec::new();
    refs.for_each(|raw_id, value| {
        let valid = matches!(value, ValueOrContainer::Value(LoroValue::Bool(true)));
        match (TagId::new(raw_id), valid) {
            (Ok(tag_id), true) => tags.push(tag_id),
            _ => quarantined.push(format!("{owner}:tag-ref:{raw_id}:invalid")),
        }
    });
    tags.sort();
    tags
}

fn block_snapshot(
    outline: &LoroTree,
    node: TreeID,
    quarantined: &mut Vec<String>,
) -> Result<BlockSnapshot, CoreError> {
    let meta = outline.get_meta(node)?;
    let markdown = match meta.get("content") {
        Some(ValueOrContainer::Container(Container::Text(text))) => text.to_string(),
        _ => {
            quarantined.push(format!("block:{node}:missing-content"));
            String::new()
        }
    };
    let (mut properties, mut issues) = decode_bag_child(&meta, "properties");
    quarantined.append(&mut issues);
    properties.retain(|entry| {
        let valid = valid_target_kind(false, &entry.key);
        if !valid {
            quarantined.push(format!(
                "block:{node}:property:{}:invalid-target",
                entry.key
            ));
        }
        valid
    });
    let tags = decode_tag_refs(&meta, &format!("block:{node}"), quarantined);
    let mut children = Vec::new();
    for child in outline.children(node).unwrap_or_default() {
        children.push(block_snapshot(outline, child, quarantined)?);
    }
    Ok(BlockSnapshot {
        id: block_id(node),
        markdown,
        properties,
        tags,
        children,
    })
}

fn value_into_map(value: ValueOrContainer) -> Option<LoroMap> {
    match value {
        ValueOrContainer::Container(Container::Map(map)) => Some(map),
        _ => None,
    }
}

fn value_into_tree(value: ValueOrContainer) -> Option<LoroTree> {
    match value {
        ValueOrContainer::Container(Container::Tree(tree)) => Some(tree),
        _ => None,
    }
}

fn enable_page_outlines(doc: &LoroDoc) -> Result<(), CoreError> {
    let pages = doc.get_map("pages");
    let mut outlines = Vec::new();
    pages.for_each(|_, value| {
        if let Some(page) = value_into_map(value)
            && let Some(outline) = page.get("outline").and_then(value_into_tree)
        {
            outlines.push(outline);
        }
    });
    for outline in outlines {
        outline.enable_fractional_index(0);
    }
    Ok(())
}

fn value_into_string(value: ValueOrContainer) -> Option<String> {
    match value {
        ValueOrContainer::Value(LoroValue::String(value)) => Some((*value).clone()),
        _ => None,
    }
}

fn map_string(map: &LoroMap, key: &str) -> Option<String> {
    map.get(key).and_then(value_into_string)
}
fn map_i64(map: &LoroMap, key: &str) -> Option<i64> {
    match map.get(key) {
        Some(ValueOrContainer::Value(LoroValue::I64(value))) => Some(value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{CommandId, LocalDate};

    fn graph() -> GraphId {
        GraphId::new("test-graph").unwrap()
    }
    fn envelope(id: &str, command: Command) -> CommandEnvelope {
        CommandEnvelope {
            graph_id: graph(),
            command_id: CommandId::new(id).unwrap(),
            command,
        }
    }
    fn page() -> PageId {
        PageId::new("home").unwrap()
    }
    fn insert_root(
        core: &mut GraphCore,
        command_id: &str,
        page_id: &PageId,
        index: usize,
        markdown: &str,
    ) -> BlockId {
        core.execute(
            envelope(
                command_id,
                Command::InsertBlock {
                    page_id: page_id.clone(),
                    parent: None,
                    index,
                    markdown: markdown.into(),
                },
            ),
            "t2",
        )
        .unwrap()
        .result
        .created_block
        .unwrap()
    }

    fn ensure_regular_page(core: &mut GraphCore, command_id: &str, page_id: &PageId) {
        core.execute(
            envelope(
                command_id,
                Command::EnsurePage {
                    page_id: page_id.clone(),
                    title: page_id.as_str().into(),
                },
            ),
            "t1",
        )
        .unwrap();
    }

    #[test]
    fn model_round_trip_all_values_unknown_and_tag_defaults() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let tag = TagId::new("project").unwrap();
        core.execute(
            envelope(
                "p",
                Command::EnsurePage {
                    page_id: page(),
                    title: "Home".into(),
                },
            ),
            "t1",
        )
        .unwrap();
        core.execute(
            envelope(
                "ensure-tag",
                Command::EnsureTag {
                    tag_id: tag.clone(),
                    name: "Project".into(),
                },
            ),
            "t1",
        )
        .unwrap();
        let block = core
            .execute(
                envelope(
                    "b",
                    Command::InsertBlock {
                        page_id: page(),
                        parent: None,
                        index: 0,
                        markdown: "hello".into(),
                    },
                ),
                "t2",
            )
            .unwrap()
            .result
            .created_block
            .unwrap();
        let defaults = [
            ("task.status", PropertyValue::String("todo".into())),
            ("custom.number", PropertyValue::Number(1.25)),
            ("custom.text", PropertyValue::String("value".into())),
            ("custom.flag", PropertyValue::Checkbox(true)),
            (
                "custom.date",
                PropertyValue::Date(LocalDate::new("2026-08-03").unwrap()),
            ),
            ("custom.page", PropertyValue::Page(page())),
        ];
        for (index, (raw_key, value)) in defaults.into_iter().enumerate() {
            core.execute(
                envelope(
                    &format!("d{index}"),
                    Command::SetTagDefault {
                        tag_id: tag.clone(),
                        key: key(raw_key),
                        value,
                    },
                ),
                "t3",
            )
            .unwrap();
        }
        core.execute(
            envelope(
                "tag",
                Command::AddTag {
                    entity: EntityId::Block {
                        page_id: page(),
                        id: block.clone(),
                    },
                    tag_id: tag.clone(),
                },
            ),
            "t4",
        )
        .unwrap();
        core.execute(
            envelope(
                "direct",
                Command::SetProperty {
                    entity: EntityId::Block {
                        page_id: page(),
                        id: block.clone(),
                    },
                    key: key("task.status"),
                    value: PropertyValue::String("doing".into()),
                },
            ),
            "t5",
        )
        .unwrap();
        core.execute(
            envelope(
                "tag-again",
                Command::AddTag {
                    entity: EntityId::Block {
                        page_id: page(),
                        id: block.clone(),
                    },
                    tag_id: tag.clone(),
                },
            ),
            "t6",
        )
        .unwrap();
        core.execute(
            envelope(
                "change-default",
                Command::SetTagDefault {
                    tag_id: tag,
                    key: key("custom.number"),
                    value: PropertyValue::Number(9.0),
                },
            ),
            "t7",
        )
        .unwrap();
        for (id, label) in [("repeat-one", "one"), ("repeat-two", "two")] {
            core.execute(
                envelope(
                    id,
                    Command::AddRepeatedProperty {
                        entity: EntityId::Block {
                            page_id: page(),
                            id: block.clone(),
                        },
                        key: key("custom.labels"),
                        value: PropertyValue::String(label.into()),
                    },
                ),
                "t8",
            )
            .unwrap();
        }
        core.execute(
            envelope(
                "repeat-remove",
                Command::RemoveRepeatedProperty {
                    entity: EntityId::Block {
                        page_id: page(),
                        id: block,
                    },
                    key: key("custom.labels"),
                    value: PropertyValue::String("one".into()),
                },
            ),
            "t9",
        )
        .unwrap();
        let snapshot = core.snapshot().unwrap();
        let entries = &snapshot.pages[0].blocks[0].properties;
        assert!(
            entries
                .iter()
                .any(|entry| entry.key.as_str() == "custom.number")
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry.key.as_str() == "task.status"
                    && entry.value == PropertyValue::String("doing".into()))
        );
        assert_eq!(
            snapshot.pages[0].blocks[0].tags,
            [TagId::new("project").unwrap()]
        );
        assert!(entries.iter().any(|entry| {
            entry.key.as_str() == "custom.number" && entry.value == PropertyValue::Number(1.25)
        }));
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.key.as_str() == "custom.labels")
                .map(|entry| &entry.value)
                .collect::<Vec<_>>(),
            vec![&PropertyValue::String("two".into())]
        );
    }

    #[test]
    fn model_journal_ensure_is_deterministic_and_commands_are_idempotent() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let command = envelope(
            "journal",
            Command::EnsureJournal {
                date: LocalDate::new("2026-08-03").unwrap(),
            },
        );
        let first = core.execute(command.clone(), "t1").unwrap();
        let duplicate = core.execute(command, "t2").unwrap();
        assert_eq!(
            first.result.created_page,
            Some(PageId::journal(
                &graph(),
                &LocalDate::new("2026-08-03").unwrap()
            ))
        );
        assert!(duplicate.duplicate);
        assert!(duplicate.update.is_empty());
    }

    #[test]
    fn page_local_outlines_isolate_root_indices() {
        let first_page = page();
        let second_page = PageId::new("second").unwrap();

        let mut insert_core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut insert_core, "insert-page-1", &first_page);
        ensure_regular_page(&mut insert_core, "insert-page-2", &second_page);
        insert_root(&mut insert_core, "second-1", &second_page, 0, "second 1");
        insert_root(&mut insert_core, "first-1", &first_page, 0, "first 1");
        insert_root(&mut insert_core, "first-2", &first_page, 1, "first 2");
        insert_root(&mut insert_core, "second-2", &second_page, 1, "second 2");

        let snapshot = insert_core.snapshot().unwrap();
        let second = snapshot
            .pages
            .iter()
            .find(|candidate| candidate.id == second_page)
            .unwrap();
        assert_eq!(
            second
                .blocks
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["second 1", "second 2"]
        );

        let mut move_core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut move_core, "move-page-1", &first_page);
        ensure_regular_page(&mut move_core, "move-page-2", &second_page);
        let moving = insert_root(&mut move_core, "move-second-1", &second_page, 0, "second 1");
        insert_root(&mut move_core, "move-second-2", &second_page, 1, "second 2");
        insert_root(&mut move_core, "move-first-1", &first_page, 0, "first 1");
        insert_root(&mut move_core, "move-first-2", &first_page, 1, "first 2");
        move_core
            .execute(
                envelope(
                    "move-second-1-after-second-2",
                    Command::MoveBlock {
                        block_id: moving,
                        page_id: second_page.clone(),
                        parent: None,
                        index: 1,
                    },
                ),
                "t3",
            )
            .unwrap();

        let snapshot = move_core.snapshot().unwrap();
        let second = snapshot
            .pages
            .iter()
            .find(|candidate| candidate.id == second_page)
            .unwrap();
        assert_eq!(
            second
                .blocks
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["second 2", "second 1"]
        );
    }

    #[test]
    fn summary_omits_blocks_and_page_reads_are_owner_scoped() {
        let first_page = page();
        let second_page = PageId::new("second").unwrap();
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page-1", &first_page);
        ensure_regular_page(&mut core, "page-2", &second_page);
        let first_block = insert_root(&mut core, "block-1", &first_page, 0, "first");
        insert_root(&mut core, "block-2", &second_page, 0, "second");

        let summary = core.summary().unwrap();
        assert_eq!(summary.pages.len(), 2);
        let first = core.page_snapshot(&first_page).unwrap();
        assert_eq!(first.blocks.len(), 1);
        assert_eq!(first.blocks[0].markdown, "first");

        let error = core
            .execute(
                envelope(
                    "wrong-owner",
                    Command::EditMarkdown {
                        page_id: second_page,
                        block_id: first_block,
                        markdown: "not allowed".into(),
                    },
                ),
                "t3",
            )
            .unwrap_err();
        assert!(matches!(error, CoreError::BlockNotFound(_)));
    }

    #[test]
    fn page_roots_and_blocks_share_node_shape_and_tags_are_first_class() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "child");
        let tag = TagId::new("project").unwrap();
        core.execute(
            envelope(
                "tag",
                Command::EnsureTag {
                    tag_id: tag.clone(),
                    name: "Project".into(),
                },
            ),
            "t2",
        )
        .unwrap();
        for (command_id, entity) in [
            ("tag-page", EntityId::Page { id: page() }),
            (
                "tag-block",
                EntityId::Block {
                    page_id: page(),
                    id: block.clone(),
                },
            ),
        ] {
            core.execute(
                envelope(
                    command_id,
                    Command::AddTag {
                        entity,
                        tag_id: tag.clone(),
                    },
                ),
                "t3",
            )
            .unwrap();
        }

        let page_map = core.require_page(&page()).unwrap();
        assert!(page_map.get("properties").is_none());
        assert!(page_map.get("defaults").is_none());
        let root = core.page_root(&page()).unwrap();
        for field in ["content", "properties", "tag_refs"] {
            assert!(root.get(field).is_some(), "page root lacks {field}");
        }
        let outline = core.page_outline(&page()).unwrap();
        let block_meta = outline.get_meta(tree_id(&block).unwrap()).unwrap();
        for field in ["content", "properties", "tag_refs"] {
            assert!(block_meta.get(field).is_some(), "block lacks {field}");
        }
        assert!(block_meta.get("markdown").is_none());
        assert!(core.doc.get_map("tags").get(tag.as_str()).is_some());

        let snapshot = core.snapshot().unwrap();
        assert_eq!(snapshot.tags[0].id, tag);
        assert_eq!(snapshot.pages[0].tags.len(), 1);
        assert_eq!(snapshot.pages[0].blocks[0].tags.len(), 1);
        assert!(snapshot.pages[0].blocks[0].properties.iter().any(|entry| {
            entry.key.as_str() == "system.updated-at"
                && entry.value == PropertyValue::String("t3".into())
        }));
        assert!(
            snapshot.pages[0].blocks[0]
                .properties
                .iter()
                .all(|entry| entry.key.as_str() != "tag")
        );

        core.execute(
            envelope(
                "edit-timestamp",
                Command::EditMarkdown {
                    page_id: page(),
                    block_id: block,
                    markdown: "updated child".into(),
                },
            ),
            "t4",
        )
        .unwrap();
        let snapshot = core.snapshot().unwrap();
        for properties in [
            &snapshot.pages[0].properties,
            &snapshot.pages[0].blocks[0].properties,
        ] {
            assert!(properties.iter().any(|entry| {
                entry.key.as_str() == "system.updated-at"
                    && entry.value == PropertyValue::String("t4".into())
            }));
        }
    }

    #[test]
    fn model_local_undo_does_not_remove_imported_remote_change() {
        let mut left = GraphCore::new(graph(), 1, "t0").unwrap();
        left.execute(
            envelope(
                "p",
                Command::EnsurePage {
                    page_id: page(),
                    title: "Home".into(),
                },
            ),
            "t1",
        )
        .unwrap();
        let base = left.export_snapshot().unwrap();
        let mut right = GraphCore::from_snapshot(graph(), 2, &base).unwrap();
        let remote_page = PageId::new("remote").unwrap();
        let remote = right
            .execute(
                envelope(
                    "remote",
                    Command::EnsurePage {
                        page_id: remote_page.clone(),
                        title: "Remote".into(),
                    },
                ),
                "t2",
            )
            .unwrap()
            .update;
        left.execute(
            envelope(
                "local",
                Command::RenamePage {
                    page_id: page(),
                    title: "Local".into(),
                },
            ),
            "t3",
        )
        .unwrap();
        left.import_remote(&remote).unwrap();
        left.execute(envelope("undo", Command::Undo), "t4").unwrap();
        let snapshot = left.snapshot().unwrap();
        assert!(snapshot.pages.iter().any(|item| item.id == remote_page));
        let home = snapshot
            .pages
            .iter()
            .find(|item| item.id == page())
            .unwrap();
        assert_eq!(home.title, "Home");
    }

    #[test]
    fn model_page_restore_and_invalid_projection_quarantine() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        core.execute(
            envelope(
                "page",
                Command::EnsurePage {
                    page_id: page(),
                    title: "Home".into(),
                },
            ),
            "t1",
        )
        .unwrap();
        core.execute(
            envelope("delete", Command::DeletePage { page_id: page() }),
            "t2",
        )
        .unwrap();
        assert!(core.snapshot().unwrap().pages.is_empty());
        core.execute(
            envelope("restore", Command::RestorePage { page_id: page() }),
            "t3",
        )
        .unwrap();
        let root = core
            .execute(
                envelope(
                    "root",
                    Command::InsertBlock {
                        page_id: page(),
                        parent: None,
                        index: 0,
                        markdown: String::new(),
                    },
                ),
                "t4",
            )
            .unwrap()
            .result
            .created_block
            .unwrap();
        let child = core
            .execute(
                envelope(
                    "child",
                    Command::InsertBlock {
                        page_id: page(),
                        parent: Some(root),
                        index: 0,
                        markdown: String::new(),
                    },
                ),
                "t5",
            )
            .unwrap()
            .result
            .created_block
            .unwrap();
        set_single(
            &core.block_bag(&page(), &child).unwrap(),
            &key("block.page"),
            &PropertyValue::Page(page()),
        )
        .unwrap();
        core.doc.commit();

        let snapshot = core.snapshot().unwrap();
        assert_eq!(snapshot.pages.len(), 1);
        assert!(
            snapshot.pages[0].blocks[0].children[0]
                .properties
                .iter()
                .all(|entry| entry.key.as_str() != "block.page")
        );
        assert_eq!(snapshot.quarantined.len(), 1);
    }
}
