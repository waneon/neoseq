use domain::{
    BlockId, BlockSnapshot, Cardinality, Command, CommandEnvelope, CommandResult, EntityId,
    GraphId, GraphSnapshot, GraphSummary, PageId, PageSnapshot, PageSummary, PropertyBag,
    PropertyEntry, PropertyError, PropertyKey, PropertyTarget, PropertyValue, SplitPlacement,
    TagId, TagSnapshot, validate_default, validate_property, validate_property_target,
    validate_property_write,
};
use loro::{
    Container, ExportMode, LoroDoc, LoroEncodeError, LoroError, LoroMap, LoroText, LoroTree,
    LoroValue, TreeID, TreeParentId, UndoManager, ValueOrContainer,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use thiserror::Error;

pub const SCHEMA_VERSION: u32 = 1;
const IDEMPOTENCY_CAPACITY: usize = 1024;
const MAX_STRUCTURAL_TARGETS: usize = 10_000;

#[derive(Debug, Clone)]
struct OutlinePlan {
    roots: Vec<BlockId>,
}

#[derive(Debug, Clone)]
struct OutlineState {
    parents: BTreeMap<BlockId, Option<BlockId>>,
    children: BTreeMap<Option<BlockId>, Vec<BlockId>>,
    document_order: Vec<BlockId>,
}

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
    #[error("page name already exists: {name} (page {existing})")]
    PageNameConflict { name: String, existing: PageId },
    #[error("tag name already exists: {name} (tag {existing})")]
    TagNameConflict { name: String, existing: TagId },
    #[error("{entity} name must not be empty")]
    EmptyName { entity: &'static str },
    #[error("block does not exist or is deleted: {0}")]
    BlockNotFound(BlockId),
    #[error("invalid block hierarchy: {0}")]
    InvalidHierarchy(String),
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

impl OutlineState {
    fn from_page(page: &PageSnapshot) -> Self {
        let mut state = Self {
            parents: BTreeMap::new(),
            children: BTreeMap::new(),
            document_order: Vec::new(),
        };
        state.add_blocks(&page.blocks, None);
        state
    }

    fn add_blocks(&mut self, blocks: &[BlockSnapshot], parent: Option<BlockId>) {
        let ids = blocks
            .iter()
            .map(|block| block.id.clone())
            .collect::<Vec<_>>();
        self.children.insert(parent.clone(), ids);
        for block in blocks {
            self.parents.insert(block.id.clone(), parent.clone());
            self.document_order.push(block.id.clone());
            self.add_blocks(&block.children, Some(block.id.clone()));
        }
    }

    fn roots(&self, requested: &[BlockId]) -> Result<Vec<BlockId>, CoreError> {
        if requested.is_empty() {
            return Err(CoreError::InvalidHierarchy(
                "structural command requires at least one block".into(),
            ));
        }
        if requested.len() > MAX_STRUCTURAL_TARGETS {
            return Err(CoreError::InvalidHierarchy(
                "structural command exceeds the block target limit".into(),
            ));
        }
        let requested = requested.iter().cloned().collect::<BTreeSet<_>>();
        for block_id in &requested {
            if !self.parents.contains_key(block_id) {
                return Err(CoreError::BlockNotFound(block_id.clone()));
            }
        }

        Ok(self
            .document_order
            .iter()
            .filter(|block_id| {
                requested.contains(*block_id) && !self.has_requested_ancestor(block_id, &requested)
            })
            .cloned()
            .collect())
    }

    fn has_requested_ancestor(&self, block_id: &BlockId, requested: &BTreeSet<BlockId>) -> bool {
        let mut parent = self.parents.get(block_id).cloned().flatten();
        while let Some(current) = parent {
            if requested.contains(&current) {
                return true;
            }
            parent = self.parents.get(&current).cloned().flatten();
        }
        false
    }

    fn move_group(
        &mut self,
        roots: &[BlockId],
        parent: Option<BlockId>,
        index: usize,
    ) -> Result<(), CoreError> {
        if let Some(parent_id) = &parent
            && !self.parents.contains_key(parent_id)
        {
            return Err(CoreError::BlockNotFound(parent_id.clone()));
        }
        let root_set = roots.iter().cloned().collect::<BTreeSet<_>>();
        let stationary = self
            .children
            .get(&parent)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|id| !root_set.contains(id))
            .collect::<Vec<_>>();
        let mut anchor = index
            .min(stationary.len())
            .checked_sub(1)
            .map(|position| stationary[position].clone());

        for root in roots {
            let destination = match &anchor {
                Some(anchor_id) => self
                    .children
                    .get(&parent)
                    .and_then(|siblings| siblings.iter().position(|id| id == anchor_id))
                    .map(|position| position + 1)
                    .ok_or_else(|| {
                        CoreError::InvalidHierarchy("move anchor is not a target sibling".into())
                    })?,
                None => 0,
            };
            self.move_one(root, parent.clone(), destination)?;
            anchor = Some(root.clone());
        }
        Ok(())
    }

    fn indent(&mut self, block_id: &BlockId) -> Result<(), CoreError> {
        let parent = self
            .parents
            .get(block_id)
            .cloned()
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        let siblings = self.children.get(&parent).cloned().unwrap_or_default();
        let position = siblings
            .iter()
            .position(|id| id == block_id)
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        if position == 0 {
            return Err(CoreError::InvalidHierarchy(
                "first sibling cannot be indented".into(),
            ));
        }
        self.move_one(block_id, Some(siblings[position - 1].clone()), usize::MAX)
    }

    fn outdent(&mut self, block_id: &BlockId) -> Result<(), CoreError> {
        let parent = self
            .parents
            .get(block_id)
            .cloned()
            .flatten()
            .ok_or_else(|| CoreError::InvalidHierarchy("root block cannot be outdented".into()))?;
        let grandparent = self
            .parents
            .get(&parent)
            .cloned()
            .ok_or_else(|| CoreError::InvalidHierarchy("missing grandparent".into()))?;
        let position = self
            .children
            .get(&grandparent)
            .and_then(|siblings| siblings.iter().position(|id| id == &parent))
            .ok_or_else(|| CoreError::InvalidHierarchy("missing parent sibling".into()))?;
        self.move_one(block_id, grandparent, position + 1)
    }

    fn move_one(
        &mut self,
        block_id: &BlockId,
        parent: Option<BlockId>,
        index: usize,
    ) -> Result<(), CoreError> {
        if parent.as_ref() == Some(block_id)
            || parent
                .as_ref()
                .is_some_and(|candidate| self.is_descendant(candidate, block_id))
        {
            return Err(CoreError::InvalidHierarchy(
                "move would create a cycle".into(),
            ));
        }
        let old_parent = self
            .parents
            .get(block_id)
            .cloned()
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        let old_siblings = self
            .children
            .get_mut(&old_parent)
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        let old_position = old_siblings
            .iter()
            .position(|id| id == block_id)
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        old_siblings.remove(old_position);

        let destination = self.children.entry(parent.clone()).or_default();
        destination.insert(index.min(destination.len()), block_id.clone());
        self.parents.insert(block_id.clone(), parent);
        Ok(())
    }

    fn is_descendant(&self, candidate: &BlockId, ancestor: &BlockId) -> bool {
        let mut current = Some(candidate.clone());
        while let Some(block_id) = current {
            if &block_id == ancestor {
                return true;
            }
            current = self.parents.get(&block_id).cloned().flatten();
        }
        false
    }
}

impl GraphCore {
    pub fn new(graph_id: GraphId, peer_id: u64, now: &str) -> Result<Self, CoreError> {
        let doc = LoroDoc::new();
        doc.set_peer_id(peer_id)?;
        let meta = doc.get_map("meta");
        meta.insert("graph_id", graph_id.as_str())?;
        meta.insert("schema_version", i64::from(SCHEMA_VERSION))?;
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
        validate_unique_entity_names(&doc)?;
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
                if result.changed
                    && let Err(error) = validate_unique_entity_names(&self.doc)
                {
                    self.undo.redo()?;
                    self.doc.commit();
                    return Err(error);
                }
                self.doc.commit();
            }
            Command::Redo => {
                result.changed = self.undo.redo()?;
                if result.changed
                    && let Err(error) = validate_unique_entity_names(&self.doc)
                {
                    self.undo.undo()?;
                    self.doc.commit();
                    return Err(error);
                }
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
        // Validate on a deep fork first: a rejected remote update must not
        // partially enter the canonical document.
        let candidate = self.doc.fork();
        candidate.import(update)?;
        verify_schema(&candidate, &self.graph_id)?;
        validate_unique_entity_names(&candidate)?;

        self.doc.set_next_commit_origin("remote:import");
        self.doc.import(update)?;
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

    pub fn frontier(&self) -> String {
        let mut ids = self
            .doc
            .state_frontiers()
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>();
        ids.sort();
        ids.join(",")
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
            Command::EnsurePage { page_id, title } => {
                validate_text(title, 1024)?;
                validate_name(title, "page")?;
                if self.doc.get_map("pages").get(page_id.as_str()).is_none() {
                    ensure_page_name_available(&self.doc, page_id, title)?;
                }
            }
            Command::EnsureTag { tag_id, name } => {
                validate_text(name, 1024)?;
                validate_name(name, "tag")?;
                if self.doc.get_map("tags").get(tag_id.as_str()).is_none() {
                    ensure_tag_name_available(&self.doc, tag_id, name)?;
                }
            }
            Command::RenamePage { page_id, title } => {
                validate_text(title, 1024)?;
                validate_name(title, "page")?;
                self.require_page(page_id)?;
                ensure_page_name_available(&self.doc, page_id, title)?;
            }
            Command::RenameTag { tag_id, name } => {
                validate_text(name, 1024)?;
                validate_name(name, "tag")?;
                self.require_tag(tag_id)?;
                ensure_tag_name_available(&self.doc, tag_id, name)?;
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
            Command::SplitBlock {
                page_id,
                block_id,
                index,
                placement,
            } => {
                self.require_live_page(page_id)?;
                self.require_block(page_id, block_id)?;
                let length = self.block_text(page_id, block_id)?.len_unicode();
                if *index > length {
                    return Err(CoreError::InvalidHierarchy(
                        "block split is out of bounds".into(),
                    ));
                }
                if (*index == 0) != (*placement == SplitPlacement::Before) {
                    return Err(CoreError::InvalidHierarchy(
                        "a leading split must create a block before the target".into(),
                    ));
                }
            }
            Command::InsertOutline {
                page_id,
                parent,
                replace,
                items,
                ..
            } => {
                self.require_live_page(page_id)?;
                if replace.is_none()
                    && let Some(parent) = parent
                {
                    self.require_block(page_id, parent)?;
                }
                if items.is_empty() {
                    return Err(CoreError::InvalidHierarchy(
                        "outline insert requires at least one item".into(),
                    ));
                }
                if items.len() > MAX_STRUCTURAL_TARGETS {
                    return Err(CoreError::InvalidHierarchy(
                        "outline insert exceeds the block target limit".into(),
                    ));
                }
                if items[0].depth != 0 {
                    return Err(CoreError::InvalidHierarchy(
                        "outline insert must start at depth zero".into(),
                    ));
                }
                let mut previous_depth = 0;
                let mut total_text = 0usize;
                for item in items {
                    if item.depth > previous_depth + 1 {
                        return Err(CoreError::InvalidHierarchy(
                            "outline insert skips a depth".into(),
                        ));
                    }
                    validate_text(&item.markdown, 1_048_576)?;
                    total_text = total_text.saturating_add(item.markdown.len());
                    if total_text > 1_048_576 {
                        return Err(CoreError::InvalidHierarchy(
                            "outline insert exceeds the text limit".into(),
                        ));
                    }
                    previous_depth = item.depth;
                }
                if let Some(block_id) = replace {
                    self.require_block(page_id, block_id)?;
                    if !self.block_text(page_id, block_id)?.to_string().is_empty() {
                        return Err(CoreError::InvalidHierarchy(
                            "outline replacement block is not empty".into(),
                        ));
                    }
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
            Command::MoveBlocks {
                block_ids,
                page_id,
                parent,
                index,
            } => {
                self.plan_move_blocks(page_id, block_ids, parent.as_ref(), *index)?;
            }
            Command::IndentBlocks { page_id, block_ids } => {
                self.plan_indent_blocks(page_id, block_ids)?;
            }
            Command::OutdentBlocks { page_id, block_ids } => {
                self.plan_outdent_blocks(page_id, block_ids)?;
            }
            Command::DeleteBlocks { page_id, block_ids } => {
                self.plan_delete_blocks(page_id, block_ids)?;
            }
            Command::DeletePage { page_id } => {
                self.require_page(page_id)?;
            }
            Command::RestorePage { page_id } => {
                let root = self.page_root(page_id)?;
                let title = match root.get("content") {
                    Some(ValueOrContainer::Container(Container::Text(text))) => text.to_string(),
                    _ => {
                        return Err(CoreError::InvalidHierarchy(
                            "page root content is missing".to_owned(),
                        ));
                    }
                };
                validate_name(&title, "page")?;
                ensure_page_name_available(&self.doc, page_id, &title)?;
            }
            Command::DeleteTag { tag_id } | Command::RemoveTagDefault { tag_id, .. } => {
                self.require_tag(tag_id)?;
            }
            Command::RestoreTag { tag_id } => {
                let tag = self.require_tag(tag_id)?;
                let name = map_string(&tag, "name")
                    .ok_or_else(|| CoreError::TagNotFound(tag_id.clone()))?;
                validate_name(&name, "tag")?;
                ensure_tag_name_available(&self.doc, tag_id, &name)?;
            }
            Command::SetProperty { entity, key, value } => {
                self.validate_entity(entity)?;
                validate_property_write(key, property_target(entity))?;
                validate_property(key, value, Cardinality::Single)?;
            }
            Command::AddRepeatedProperty { entity, key, value }
            | Command::RemoveRepeatedProperty { entity, key, value } => {
                self.validate_entity(entity)?;
                validate_property_write(key, property_target(entity))?;
                validate_property(key, value, Cardinality::Set)?;
            }
            Command::RemoveProperty { entity, key } => {
                self.validate_entity(entity)?;
                validate_property_write(key, property_target(entity))?;
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
                initialize_created_node(&meta, markdown, now)?;
                result.created_block = Some(block_id(node));
            }
            Command::SplitBlock {
                page_id,
                block_id: target_id,
                index,
                placement,
            } => {
                let outline = self.page_outline(page_id)?;
                let target = require_block_in(&outline, target_id)?;
                let (parent, position) = match placement {
                    SplitPlacement::FirstChild => (Some(target), 0),
                    SplitPlacement::Before | SplitPlacement::After => {
                        let actual_parent = outline
                            .parent(target)
                            .ok_or_else(|| CoreError::BlockNotFound(target_id.clone()))?;
                        let siblings = outline.children(actual_parent).unwrap_or_default();
                        let target_position = siblings
                            .iter()
                            .position(|candidate| *candidate == target)
                            .ok_or_else(|| CoreError::BlockNotFound(target_id.clone()))?;
                        let parent = match actual_parent {
                            TreeParentId::Node(parent) => Some(parent),
                            TreeParentId::Root => None,
                            TreeParentId::Deleted | TreeParentId::Unexist => {
                                return Err(CoreError::BlockNotFound(target_id.clone()));
                            }
                        };
                        let offset = usize::from(*placement == SplitPlacement::After);
                        (parent, target_position + offset)
                    }
                };
                let text = self.block_text(page_id, target_id)?;
                let tail = if *index == 0 {
                    String::new()
                } else {
                    text.to_string().chars().skip(*index).collect()
                };
                let node = outline.create_at(parent, position)?;
                initialize_created_node(&outline.get_meta(node)?, &tail, now)?;
                if *index > 0 && *index < text.len_unicode() {
                    text.delete(*index, text.len_unicode() - *index)?;
                }
                result.created_block = Some(block_id(node));
            }
            Command::InsertOutline {
                page_id,
                parent,
                index,
                replace,
                items,
            } => {
                let outline = self.page_outline(page_id)?;
                let requested_parent = parent.as_ref().map(tree_id).transpose()?;
                let mut base_parent = requested_parent;
                let mut base_index = *index;
                let mut levels: Vec<TreeID> = Vec::new();
                let mut inserted_children: BTreeMap<TreeID, usize> = BTreeMap::new();
                let mut root_offset = 0;

                if let Some(replace_id) = replace {
                    let target = require_block_in(&outline, replace_id)?;
                    let actual_parent = outline
                        .parent(target)
                        .ok_or_else(|| CoreError::BlockNotFound(replace_id.clone()))?;
                    let siblings = outline.children(actual_parent).unwrap_or_default();
                    base_index = siblings
                        .iter()
                        .position(|candidate| *candidate == target)
                        .ok_or_else(|| CoreError::BlockNotFound(replace_id.clone()))?;
                    base_parent = match actual_parent {
                        TreeParentId::Node(parent) => Some(parent),
                        TreeParentId::Root => None,
                        TreeParentId::Deleted | TreeParentId::Unexist => {
                            return Err(CoreError::BlockNotFound(replace_id.clone()));
                        }
                    };
                    root_offset = 1;
                }

                for (position, item) in items.iter().enumerate() {
                    let node = if position == 0 {
                        if let Some(replace_id) = replace {
                            let target = require_block_in(&outline, replace_id)?;
                            replace_text(&self.block_text(page_id, replace_id)?, &item.markdown)?;
                            target
                        } else {
                            let available = base_parent.map_or_else(
                                || outline.roots().len(),
                                |parent| outline.children(parent).map_or(0, |rows| rows.len()),
                            );
                            let target =
                                outline.create_at(base_parent, base_index.min(available))?;
                            initialize_created_node(
                                &outline.get_meta(target)?,
                                &item.markdown,
                                now,
                            )?;
                            root_offset = 1;
                            target
                        }
                    } else if item.depth == 0 {
                        let available = base_parent.map_or_else(
                            || outline.roots().len(),
                            |parent| outline.children(parent).map_or(0, |rows| rows.len()),
                        );
                        let target = outline
                            .create_at(base_parent, (base_index + root_offset).min(available))?;
                        initialize_created_node(&outline.get_meta(target)?, &item.markdown, now)?;
                        root_offset += 1;
                        target
                    } else {
                        let parent_node = *levels.get(item.depth - 1).ok_or_else(|| {
                            CoreError::InvalidHierarchy("outline insert skips a depth".into())
                        })?;
                        let child_index = inserted_children.entry(parent_node).or_default();
                        let target = outline.create_at(Some(parent_node), *child_index)?;
                        *child_index += 1;
                        initialize_created_node(&outline.get_meta(target)?, &item.markdown, now)?;
                        target
                    };

                    if levels.len() <= item.depth {
                        levels.push(node);
                    } else {
                        levels[item.depth] = node;
                        levels.truncate(item.depth + 1);
                    }
                    let created_id = block_id(node);
                    self.touch_block(page_id, &created_id, now)?;
                    result.created_block = Some(created_id);
                }
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
            Command::MoveBlocks {
                block_ids,
                page_id,
                parent,
                index,
            } => {
                let plan = self.plan_move_blocks(page_id, block_ids, parent.as_ref(), *index)?;
                self.move_blocks(&plan.roots, page_id, parent.as_ref(), *index)?;
            }
            Command::IndentBlocks { page_id, block_ids } => {
                let plan = self.plan_indent_blocks(page_id, block_ids)?;
                for block_id in &plan.roots {
                    self.indent(page_id, block_id)?;
                }
            }
            Command::OutdentBlocks { page_id, block_ids } => {
                let plan = self.plan_outdent_blocks(page_id, block_ids)?;
                for block_id in &plan.roots {
                    self.outdent(page_id, block_id)?;
                }
            }
            Command::DeleteBlocks { page_id, block_ids } => {
                let plan = self.plan_delete_blocks(page_id, block_ids)?;
                let outline = self.page_outline(page_id)?;
                for block_id in &plan.roots {
                    self.touch_block(page_id, block_id, now)?;
                    outline.delete(tree_id(block_id)?)?;
                }
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
            Command::SplitBlock {
                page_id,
                block_id,
                index,
                ..
            } => {
                if *index > 0 {
                    self.touch_block(page_id, block_id, now)?;
                }
                if let Some(created) = &result.created_block {
                    self.touch_block(page_id, created, now)?;
                }
                self.touch_page(page_id, now)?;
            }
            Command::InsertOutline { page_id, .. } => self.touch_page(page_id, now)?,
            Command::EditMarkdown {
                page_id, block_id, ..
            }
            | Command::SpliceMarkdown {
                page_id, block_id, ..
            } => {
                self.touch_block(page_id, block_id, now)?;
                self.touch_page(page_id, now)?;
            }
            Command::MoveBlocks {
                page_id, block_ids, ..
            }
            | Command::IndentBlocks { page_id, block_ids }
            | Command::OutdentBlocks { page_id, block_ids } => {
                for block_id in block_ids {
                    self.touch_block(page_id, block_id, now)?;
                }
                self.touch_page(page_id, now)?;
            }
            Command::DeleteBlocks { page_id, .. } => self.touch_page(page_id, now)?,
            Command::SetProperty { entity, .. }
            | Command::RemoveProperty { entity, .. }
            | Command::AddRepeatedProperty { entity, .. }
            | Command::RemoveRepeatedProperty { entity, .. }
            | Command::AddTag { entity, .. }
            | Command::RemoveTag { entity, .. } => self.touch_entity(entity, now)?,
            Command::EnsureTag { .. } => {
                if let Some(tag_id) = &result.created_tag {
                    self.touch_tag(tag_id, now)?;
                }
            }
            Command::RenameTag { tag_id, .. }
            | Command::DeleteTag { tag_id }
            | Command::RestoreTag { tag_id }
            | Command::SetTagDefault { tag_id, .. }
            | Command::RemoveTagDefault { tag_id, .. } => self.touch_tag(tag_id, now)?,
            Command::Undo | Command::Redo => {}
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

    fn touch_tag(&self, tag_id: &TagId, now: &str) -> Result<(), CoreError> {
        set_single(
            &self.tag_bag(tag_id, "properties")?,
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
            initialize_lifecycle(&properties, now)?;
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
        initialize_lifecycle(&properties, now)?;
        Ok(Some(tag_id.clone()))
    }

    fn outline_state(&self, page_id: &PageId) -> Result<OutlineState, CoreError> {
        Ok(OutlineState::from_page(&self.page_snapshot(page_id)?))
    }

    fn plan_move_blocks(
        &self,
        page_id: &PageId,
        block_ids: &[BlockId],
        parent: Option<&BlockId>,
        index: usize,
    ) -> Result<OutlinePlan, CoreError> {
        let mut state = self.outline_state(page_id)?;
        let roots = state.roots(block_ids)?;
        state.move_group(&roots, parent.cloned(), index)?;
        Ok(OutlinePlan { roots })
    }

    fn plan_indent_blocks(
        &self,
        page_id: &PageId,
        block_ids: &[BlockId],
    ) -> Result<OutlinePlan, CoreError> {
        let mut state = self.outline_state(page_id)?;
        let roots = state.roots(block_ids)?;
        for block_id in &roots {
            state.indent(block_id)?;
        }
        Ok(OutlinePlan { roots })
    }

    fn plan_outdent_blocks(
        &self,
        page_id: &PageId,
        block_ids: &[BlockId],
    ) -> Result<OutlinePlan, CoreError> {
        let mut state = self.outline_state(page_id)?;
        let mut roots = state.roots(block_ids)?;
        roots.reverse();
        for block_id in &roots {
            state.outdent(block_id)?;
        }
        Ok(OutlinePlan { roots })
    }

    fn plan_delete_blocks(
        &self,
        page_id: &PageId,
        block_ids: &[BlockId],
    ) -> Result<OutlinePlan, CoreError> {
        let state = self.outline_state(page_id)?;
        Ok(OutlinePlan {
            roots: state.roots(block_ids)?,
        })
    }

    fn move_blocks(
        &self,
        block_ids: &[BlockId],
        page_id: &PageId,
        parent: Option<&BlockId>,
        index: usize,
    ) -> Result<(), CoreError> {
        let outline = self.page_outline(page_id)?;
        let root_ids = block_ids.iter().cloned().collect::<BTreeSet<_>>();
        let parent_tree = parent.map(tree_id).transpose()?;
        let stationary = parent_tree.map_or_else(
            || outline.roots(),
            |parent| outline.children(parent).unwrap_or_default(),
        );
        let stationary = stationary
            .into_iter()
            .map(block_id)
            .filter(|id| !root_ids.contains(id))
            .collect::<Vec<_>>();
        let mut anchor = index
            .min(stationary.len())
            .checked_sub(1)
            .map(|position| stationary[position].clone());

        for block_id in block_ids {
            let siblings = parent_tree.map_or_else(
                || outline.roots(),
                |parent| outline.children(parent).unwrap_or_default(),
            );
            let destination = match &anchor {
                Some(anchor_id) => {
                    let anchor_tree = tree_id(anchor_id)?;
                    siblings
                        .iter()
                        .position(|id| *id == anchor_tree)
                        .map(|position| position + 1)
                        .ok_or_else(|| {
                            CoreError::InvalidHierarchy(
                                "move anchor is not a target sibling".into(),
                            )
                        })?
                }
                None => 0,
            };
            self.move_block(block_id, page_id, parent, destination)?;
            anchor = Some(block_id.clone());
        }
        Ok(())
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

fn canonical_entity_name(value: &str) -> String {
    value
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

fn validate_name(value: &str, entity: &'static str) -> Result<(), CoreError> {
    if canonical_entity_name(value).is_empty() {
        Err(CoreError::EmptyName { entity })
    } else {
        Ok(())
    }
}

fn live_page_names(doc: &LoroDoc) -> Vec<(PageId, String)> {
    let mut names = Vec::new();
    doc.get_map("pages").for_each(|raw_id, value| {
        let Ok(page_id) = PageId::new(raw_id) else {
            return;
        };
        let Some(page) = value_into_map(value) else {
            return;
        };
        let mut quarantined = Vec::new();
        let Some(snapshot) = page_metadata(&page_id, &page, &mut quarantined) else {
            return;
        };
        let is_journal = snapshot.properties.iter().any(|entry| {
            entry.key.as_str() == "page.kind"
                && entry.value == PropertyValue::String("journal".to_owned())
        });
        if !is_journal {
            names.push((page_id, snapshot.title));
        }
    });
    names.sort_by(|left, right| left.0.cmp(&right.0));
    names
}

fn live_tag_names(doc: &LoroDoc) -> Vec<(TagId, String)> {
    let mut quarantined = Vec::new();
    tag_snapshots(doc, &mut quarantined)
        .into_iter()
        .map(|tag| (tag.id, tag.name))
        .collect()
}

fn ensure_page_name_available(
    doc: &LoroDoc,
    page_id: &PageId,
    name: &str,
) -> Result<(), CoreError> {
    let canonical = canonical_entity_name(name);
    if let Some((existing, _)) = live_page_names(doc)
        .into_iter()
        .find(|(id, title)| id != page_id && canonical_entity_name(title) == canonical)
    {
        return Err(CoreError::PageNameConflict {
            name: name.to_owned(),
            existing,
        });
    }
    Ok(())
}

fn ensure_tag_name_available(doc: &LoroDoc, tag_id: &TagId, name: &str) -> Result<(), CoreError> {
    let canonical = canonical_entity_name(name);
    if let Some((existing, _)) = live_tag_names(doc)
        .into_iter()
        .find(|(id, current)| id != tag_id && canonical_entity_name(current) == canonical)
    {
        return Err(CoreError::TagNameConflict {
            name: name.to_owned(),
            existing,
        });
    }
    Ok(())
}

fn validate_unique_entity_names(doc: &LoroDoc) -> Result<(), CoreError> {
    let mut pages = BTreeMap::<String, (PageId, String)>::new();
    for (page_id, name) in live_page_names(doc) {
        validate_name(&name, "page")?;
        let canonical = canonical_entity_name(&name);
        if let Some((existing, _)) = pages.get(&canonical) {
            return Err(CoreError::PageNameConflict {
                name,
                existing: existing.clone(),
            });
        }
        pages.insert(canonical, (page_id, name));
    }

    let mut tags = BTreeMap::<String, (TagId, String)>::new();
    for (tag_id, name) in live_tag_names(doc) {
        validate_name(&name, "tag")?;
        let canonical = canonical_entity_name(&name);
        if let Some((existing, _)) = tags.get(&canonical) {
            return Err(CoreError::TagNameConflict {
                name,
                existing: existing.clone(),
            });
        }
        tags.insert(canonical, (tag_id, name));
    }
    Ok(())
}

fn property_target(entity: &EntityId) -> PropertyTarget {
    match entity {
        EntityId::Page { .. } => PropertyTarget::Page,
        EntityId::Block { .. } => PropertyTarget::Block,
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
        Command::InsertBlock { .. } | Command::InsertOutline { .. } => "BlockInserted",
        Command::SplitBlock { .. } => "BlockSplit",
        Command::EditMarkdown { .. } | Command::SpliceMarkdown { .. } => "BlockTextChanged",
        Command::MoveBlocks { .. }
        | Command::IndentBlocks { .. }
        | Command::OutdentBlocks { .. } => "SubtreeMoved",
        Command::DeleteBlocks { .. } => "SubtreesDeleted",
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

fn initialize_created_node(node: &LoroMap, content: &str, now: &str) -> Result<(), CoreError> {
    initialize_node(node, content)?;
    initialize_lifecycle(&node.ensure_mergeable_map("properties")?, now)
}

fn initialize_lifecycle(properties: &LoroMap, now: &str) -> Result<(), CoreError> {
    let value = PropertyValue::String(now.to_owned());
    set_single(properties, &key("system.created-at"), &value)?;
    set_single(properties, &key("system.updated-at"), &value)
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
            Cardinality::Set
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
        if validate_property_target(&entry.key, PropertyTarget::Page).is_ok() {
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
        properties.retain(|entry| {
            validate_property_target(&entry.key, PropertyTarget::TagMetadata).is_ok()
        });
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
        let valid = validate_property_target(&entry.key, PropertyTarget::Block).is_ok();
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

    fn property_string<'a>(bag: &'a [PropertyEntry], raw_key: &str) -> Option<&'a str> {
        bag.iter().find_map(|entry| {
            if entry.key.as_str() != raw_key {
                return None;
            }
            match &entry.value {
                PropertyValue::String(value) => Some(value.as_str()),
                _ => None,
            }
        })
    }

    #[test]
    fn model_rejects_generic_writes_to_core_managed_properties() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let before = core.snapshot().unwrap();

        for (index, raw_key) in ["page.kind", "journal.date", "system.deleted-at"]
            .into_iter()
            .enumerate()
        {
            let value = if raw_key == "journal.date" {
                PropertyValue::Date(LocalDate::new("2026-08-08").unwrap())
            } else {
                PropertyValue::String("user-value".into())
            };
            let error = core
                .execute(
                    envelope(
                        &format!("forbidden-{index}"),
                        Command::SetProperty {
                            entity: EntityId::Page { id: page() },
                            key: key(raw_key),
                            value,
                        },
                    ),
                    "t2",
                )
                .unwrap_err();
            assert!(matches!(
                error,
                CoreError::Property(PropertyError::CoreManaged(_))
            ));
        }

        assert_eq!(core.snapshot().unwrap(), before);
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
                    Command::MoveBlocks {
                        block_ids: vec![moving],
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
    fn leading_split_preserves_block_identity_metadata_and_subtree_in_one_undo() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let target = insert_root(&mut core, "target", &page(), 0, "asdf");
        core.execute(
            envelope(
                "property",
                Command::SetProperty {
                    entity: EntityId::Block {
                        page_id: page(),
                        id: target.clone(),
                    },
                    key: key("task.status"),
                    value: PropertyValue::String("doing".into()),
                },
            ),
            "t3",
        )
        .unwrap();
        let project = TagId::new("project").unwrap();
        core.execute(
            envelope(
                "ensure-tag",
                Command::EnsureTag {
                    tag_id: project.clone(),
                    name: "Project".into(),
                },
            ),
            "t4",
        )
        .unwrap();
        core.execute(
            envelope(
                "add-tag",
                Command::AddTag {
                    entity: EntityId::Block {
                        page_id: page(),
                        id: target.clone(),
                    },
                    tag_id: project.clone(),
                },
            ),
            "t5",
        )
        .unwrap();
        core.execute(
            envelope(
                "child",
                Command::InsertBlock {
                    page_id: page(),
                    parent: Some(target.clone()),
                    index: 0,
                    markdown: "child".into(),
                },
            ),
            "t6",
        )
        .unwrap();

        core.execute(
            envelope(
                "split-leading",
                Command::SplitBlock {
                    page_id: page(),
                    block_id: target.clone(),
                    index: 0,
                    placement: SplitPlacement::Before,
                },
            ),
            "t7",
        )
        .unwrap();
        let split = core.page_snapshot(&page()).unwrap();
        assert_eq!(split.blocks.len(), 2);
        assert_eq!(split.blocks[0].markdown, "");
        assert_eq!(split.blocks[1].id, target);
        assert_eq!(split.blocks[1].markdown, "asdf");
        assert_eq!(split.blocks[1].children[0].markdown, "child");
        assert_eq!(split.blocks[1].tags, [project]);
        assert!(split.blocks[1].properties.iter().any(|entry| {
            entry.key.as_str() == "task.status"
                && entry.value == PropertyValue::String("doing".into())
        }));

        core.execute(envelope("undo-split", Command::Undo), "t8")
            .unwrap();
        let restored = core.page_snapshot(&page()).unwrap();
        assert_eq!(restored.blocks.len(), 1);
        assert_eq!(restored.blocks[0].id, target);
        assert_eq!(restored.blocks[0].markdown, "asdf");
        assert_eq!(restored.blocks[0].children[0].markdown, "child");

        core.execute(envelope("redo-split", Command::Redo), "t9")
            .unwrap();
        let redone = core.page_snapshot(&page()).unwrap();
        assert_eq!(redone.blocks.len(), 2);
        assert_eq!(redone.blocks[1].id, target);
    }

    #[test]
    fn middle_split_uses_unicode_points_and_undoes_as_one_command() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let target = insert_root(&mut core, "target", &page(), 0, "한글tail");

        core.execute(
            envelope(
                "split-middle",
                Command::SplitBlock {
                    page_id: page(),
                    block_id: target.clone(),
                    index: 2,
                    placement: SplitPlacement::After,
                },
            ),
            "t3",
        )
        .unwrap();
        let split = core.page_snapshot(&page()).unwrap();
        assert_eq!(
            split
                .blocks
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["한글", "tail"]
        );

        core.execute(envelope("undo-split", Command::Undo), "t4")
            .unwrap();
        let restored = core.page_snapshot(&page()).unwrap();
        assert_eq!(restored.blocks.len(), 1);
        assert_eq!(restored.blocks[0].id, target);
        assert_eq!(restored.blocks[0].markdown, "한글tail");
    }

    #[test]
    fn plural_delete_is_one_undo_group_and_normalizes_descendants() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let subtree = insert_root(&mut core, "subtree", &page(), 0, "subtree");
        let child = core
            .execute(
                envelope(
                    "child",
                    Command::InsertBlock {
                        page_id: page(),
                        parent: Some(subtree.clone()),
                        index: 0,
                        markdown: "child".into(),
                    },
                ),
                "t3",
            )
            .unwrap()
            .result
            .created_block
            .unwrap();
        let sibling = insert_root(&mut core, "sibling", &page(), 1, "sibling");

        core.execute(
            envelope(
                "delete-many",
                Command::DeleteBlocks {
                    page_id: page(),
                    block_ids: vec![child, sibling, subtree],
                },
            ),
            "t4",
        )
        .unwrap();
        assert!(core.page_snapshot(&page()).unwrap().blocks.is_empty());

        core.execute(envelope("undo-many", Command::Undo), "t5")
            .unwrap();
        let restored = core.page_snapshot(&page()).unwrap();
        assert_eq!(
            restored
                .blocks
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["subtree", "sibling"]
        );
        assert_eq!(restored.blocks[0].children[0].markdown, "child");

        core.execute(envelope("redo-many", Command::Redo), "t6")
            .unwrap();
        assert!(core.page_snapshot(&page()).unwrap().blocks.is_empty());
    }

    #[test]
    fn outline_insert_preserves_depth_replaces_an_empty_target_and_undoes_once() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let empty = insert_root(&mut core, "empty", &page(), 0, "");

        core.execute(
            envelope(
                "paste-outline",
                Command::InsertOutline {
                    page_id: page(),
                    parent: None,
                    index: 0,
                    replace: Some(empty),
                    items: vec![
                        domain::OutlineItem {
                            depth: 0,
                            markdown: "one".into(),
                        },
                        domain::OutlineItem {
                            depth: 1,
                            markdown: "two".into(),
                        },
                        domain::OutlineItem {
                            depth: 1,
                            markdown: "three".into(),
                        },
                        domain::OutlineItem {
                            depth: 0,
                            markdown: "four".into(),
                        },
                    ],
                },
            ),
            "t3",
        )
        .unwrap();

        let pasted = core.page_snapshot(&page()).unwrap();
        assert_eq!(
            pasted
                .blocks
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "four"]
        );
        assert_eq!(
            pasted.blocks[0]
                .children
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["two", "three"]
        );

        core.execute(envelope("undo-paste", Command::Undo), "t4")
            .unwrap();
        let restored = core.page_snapshot(&page()).unwrap();
        assert_eq!(restored.blocks.len(), 1);
        assert_eq!(restored.blocks[0].markdown, "");
        assert!(restored.blocks[0].children.is_empty());
    }

    #[test]
    fn plural_move_preserves_document_order_and_undoes_once() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let first = insert_root(&mut core, "first", &page(), 0, "first");
        let second = insert_root(&mut core, "second", &page(), 1, "second");
        insert_root(&mut core, "third", &page(), 2, "third");

        core.execute(
            envelope(
                "move-many",
                Command::MoveBlocks {
                    page_id: page(),
                    block_ids: vec![first, second],
                    parent: None,
                    index: 1,
                },
            ),
            "t3",
        )
        .unwrap();
        assert_eq!(
            core.page_snapshot(&page())
                .unwrap()
                .blocks
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["third", "first", "second"]
        );

        core.execute(envelope("undo-move-many", Command::Undo), "t4")
            .unwrap();
        assert_eq!(
            core.page_snapshot(&page())
                .unwrap()
                .blocks
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second", "third"]
        );
    }

    #[test]
    fn plural_indent_and_outdent_are_preflighted_undo_groups() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let parent = insert_root(&mut core, "parent", &page(), 0, "parent");
        let first = insert_root(&mut core, "first", &page(), 1, "first");
        let second = insert_root(&mut core, "second", &page(), 2, "second");

        let before_rejection = core.page_snapshot(&page()).unwrap();
        let rejected = core.execute(
            envelope(
                "invalid-indent-many",
                Command::IndentBlocks {
                    page_id: page(),
                    block_ids: vec![parent.clone(), first.clone()],
                },
            ),
            "t3",
        );
        assert!(matches!(rejected, Err(CoreError::InvalidHierarchy(_))));
        assert_eq!(core.page_snapshot(&page()).unwrap(), before_rejection);

        core.execute(
            envelope(
                "indent-many",
                Command::IndentBlocks {
                    page_id: page(),
                    block_ids: vec![first.clone(), second.clone()],
                },
            ),
            "t3",
        )
        .unwrap();
        let nested = core.page_snapshot(&page()).unwrap();
        assert_eq!(nested.blocks.len(), 1);
        assert_eq!(nested.blocks[0].id, parent);
        assert_eq!(
            nested.blocks[0]
                .children
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );

        core.execute(envelope("undo-indent-many", Command::Undo), "t4")
            .unwrap();
        assert_eq!(core.page_snapshot(&page()).unwrap().blocks.len(), 3);
        core.execute(envelope("redo-indent-many", Command::Redo), "t5")
            .unwrap();

        core.execute(
            envelope(
                "outdent-many",
                Command::OutdentBlocks {
                    page_id: page(),
                    block_ids: vec![first, second],
                },
            ),
            "t6",
        )
        .unwrap();
        assert_eq!(
            core.page_snapshot(&page())
                .unwrap()
                .blocks
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["parent", "first", "second"]
        );
        core.execute(envelope("undo-outdent-many", Command::Undo), "t7")
            .unwrap();
        assert_eq!(
            core.page_snapshot(&page()).unwrap().blocks[0]
                .children
                .len(),
            2
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
    fn lifecycle_metadata_is_uniform_for_persisted_entities() {
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
            "t3",
        )
        .unwrap();

        let snapshot = core.snapshot().unwrap();
        assert_eq!(
            property_string(&snapshot.pages[0].properties, "system.created-at"),
            Some("t1")
        );
        assert_eq!(
            property_string(&snapshot.pages[0].properties, "system.updated-at"),
            Some("t2")
        );
        assert_eq!(
            property_string(&snapshot.pages[0].blocks[0].properties, "system.created-at"),
            Some("t2")
        );
        assert_eq!(
            property_string(&snapshot.pages[0].blocks[0].properties, "system.updated-at"),
            Some("t2")
        );
        assert_eq!(snapshot.pages[0].blocks[0].id, block);
        assert_eq!(
            property_string(&snapshot.tags[0].properties, "system.created-at"),
            Some("t3")
        );
        assert_eq!(
            property_string(&snapshot.tags[0].properties, "system.updated-at"),
            Some("t3")
        );

        core.execute(
            envelope(
                "rename-tag",
                Command::RenameTag {
                    tag_id: tag.clone(),
                    name: "Work".into(),
                },
            ),
            "t4",
        )
        .unwrap();
        let snapshot = core.snapshot().unwrap();
        assert_eq!(
            property_string(&snapshot.tags[0].properties, "system.created-at"),
            Some("t3")
        );
        assert_eq!(
            property_string(&snapshot.tags[0].properties, "system.updated-at"),
            Some("t4")
        );

        core.execute(
            envelope(
                "delete-tag",
                Command::DeleteTag {
                    tag_id: tag.clone(),
                },
            ),
            "t5",
        )
        .unwrap();
        let deleted_tag = decode_bag(&core.tag_bag(&tag, "properties").unwrap()).0;
        assert_eq!(
            property_string(&deleted_tag, "system.created-at"),
            Some("t3")
        );
        assert_eq!(
            property_string(&deleted_tag, "system.updated-at"),
            Some("t5")
        );
        assert_eq!(
            property_string(&deleted_tag, "system.deleted-at"),
            Some("t5")
        );

        core.execute(
            envelope(
                "restore-tag",
                Command::RestoreTag {
                    tag_id: tag.clone(),
                },
            ),
            "t6",
        )
        .unwrap();
        let snapshot = core.snapshot().unwrap();
        let restored_tag = &snapshot.tags[0].properties;
        assert_eq!(
            property_string(restored_tag, "system.created-at"),
            Some("t3")
        );
        assert_eq!(
            property_string(restored_tag, "system.updated-at"),
            Some("t6")
        );
        assert_eq!(property_string(restored_tag, "system.deleted-at"), None);

        core.execute(
            envelope("delete-page", Command::DeletePage { page_id: page() }),
            "t7",
        )
        .unwrap();
        let deleted_page = decode_bag(&core.page_properties(&page()).unwrap()).0;
        assert_eq!(
            property_string(&deleted_page, "system.created-at"),
            Some("t1")
        );
        assert_eq!(
            property_string(&deleted_page, "system.updated-at"),
            Some("t7")
        );
        assert_eq!(
            property_string(&deleted_page, "system.deleted-at"),
            Some("t7")
        );

        core.execute(
            envelope("restore-page", Command::RestorePage { page_id: page() }),
            "t8",
        )
        .unwrap();
        let snapshot = core.page_snapshot(&page()).unwrap();
        let restored_page = &snapshot.properties;
        assert_eq!(
            property_string(restored_page, "system.created-at"),
            Some("t1")
        );
        assert_eq!(
            property_string(restored_page, "system.updated-at"),
            Some("t8")
        );
        assert_eq!(property_string(restored_page, "system.deleted-at"), None);
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
