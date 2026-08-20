use domain::{
    BlockId, BlockSnapshot, Cardinality, Command, CommandEnvelope, CommandResult, EntityId,
    GraphId, GraphSnapshot, GraphSummary, HistoryEffect, HistoryScope, PageId, PageSnapshot,
    PageSummary, PropertyBag, PropertyDocument, PropertyDocumentHeader, PropertyError,
    PropertyField, PropertyKey, PropertyOwner, PropertyTarget, PropertyType, PropertyValue,
    QUERY_DOCUMENT_SCHEMA, QUERY_DOCUMENT_VERSION, QUERY_LANGUAGE, QUERY_PROPERTY_KEY, QueryPlan,
    QueryView, QueryViewColumn, QueryViewId, QueryViewKind, QueryViewOptions, SplitPlacement,
    TagId, TagSnapshot, validate_property, validate_property_field, validate_property_shape,
    validate_property_target, validate_property_write,
};
use loro::{
    Container, ContainerID, ContainerTrait, ExportMode, Index, LoroDoc, LoroEncodeError, LoroError,
    LoroMap, LoroText, LoroTree, LoroValue, Subscription, TreeID, TreeParentId, UndoManager,
    ValueOrContainer, VersionVector, event::Diff,
};
use query::{IndexDelta, IndexUnit};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex},
};
use thiserror::Error;

pub const SCHEMA_VERSION: u32 = 1;

/// Encoded causal baseline for a replica that has no operations yet.
pub fn empty_version_vector() -> Vec<u8> {
    VersionVector::default().encode()
}
const IDEMPOTENCY_CAPACITY: usize = 1024;
const MAX_STRUCTURAL_TARGETS: usize = 10_000;

#[derive(Debug, Clone)]
struct OutlinePlan {
    roots: Vec<BlockId>,
}

#[derive(Debug, Clone)]
struct TagDetachPage {
    page_id: PageId,
    root: bool,
    blocks: Vec<BlockId>,
}

#[derive(Debug, Clone)]
struct TagDetachPlan {
    pages: Vec<TagDetachPage>,
}

#[derive(Debug, Clone)]
struct HistoryEntry {
    scope: HistoryScope,
    affected_pages: Vec<PageId>,
    undo_candidates: Vec<HistoryTarget>,
    redo_candidates: Vec<HistoryTarget>,
}

#[derive(Debug, Clone)]
enum HistoryTarget {
    Entity(EntityId),
    BlockPosition {
        page_id: PageId,
        parent: Option<BlockId>,
        index: usize,
    },
}

#[derive(Debug, Clone)]
struct HistoryPlan {
    entry: HistoryEntry,
    redo_created_block: bool,
    redo_created_page: bool,
}

#[derive(Debug, Clone, Copy)]
enum HistoryDirection {
    Undo,
    Redo,
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
    #[error("local history metadata is not aligned with the undo manager")]
    HistoryMetadataMismatch,
}

#[derive(Debug, Clone)]
pub struct CoreExecution {
    pub result: CommandResult,
    pub update: Vec<u8>,
    pub semantic: String,
    pub duplicate: bool,
    pub changes: GraphChangeSet,
}

/// Projection publication units affected by one local command or remote
/// import. An unclassifiable relevant diff requests a safe full rebuild.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GraphChangeSet {
    pub pages: BTreeSet<PageId>,
    pub tags: BTreeSet<TagId>,
    pub rebuild: bool,
}

#[derive(Debug, Clone)]
struct CapturedChange {
    target: ContainerID,
    path: Vec<(ContainerID, Index)>,
    map_keys: Vec<String>,
    unknown: bool,
}

struct ProjectionChangeTracker {
    captured: Arc<Mutex<Vec<CapturedChange>>>,
    subscription: Subscription,
}

pub struct GraphCore {
    graph_id: GraphId,
    doc: LoroDoc,
    undo: UndoManager,
    command_results: BTreeMap<String, CommandResult>,
    command_order: VecDeque<String>,
    undo_history: Vec<HistoryEntry>,
    redo_history: Vec<HistoryEntry>,
}

impl HistoryPlan {
    fn finish(mut self, result: &CommandResult, core: &GraphCore) -> HistoryEntry {
        if self.redo_created_block
            && let Some(block_id) = &result.created_block
            && let Some(page_id) = self.entry.affected_pages.first()
        {
            let target = core
                .outline_state(page_id)
                .ok()
                .and_then(|state| {
                    let parent = state.parents.get(block_id)?.clone();
                    let index = state
                        .children
                        .get(&parent)?
                        .iter()
                        .position(|item| item == block_id)?;
                    Some(HistoryTarget::BlockPosition {
                        page_id: page_id.clone(),
                        parent,
                        index,
                    })
                })
                .unwrap_or_else(|| {
                    HistoryTarget::Entity(EntityId::Block {
                        page_id: page_id.clone(),
                        id: block_id.clone(),
                    })
                });
            self.entry.redo_candidates.insert(0, target);
        }
        if self.redo_created_page
            && let Some(page_id) = &result.created_page
        {
            self.entry.redo_candidates.insert(
                0,
                HistoryTarget::Entity(EntityId::Page {
                    id: page_id.clone(),
                }),
            );
        }
        self.entry
    }
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

impl ProjectionChangeTracker {
    fn new(doc: &LoroDoc) -> Self {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let callback_captured = Arc::clone(&captured);
        let subscription = doc.subscribe_root(Arc::new(move |event| {
            let mut batch = callback_captured
                .lock()
                .expect("projection change tracker mutex poisoned");
            for change in event.events {
                let map_keys = match change.diff {
                    Diff::Map(delta) => delta.updated.keys().map(|key| key.to_string()).collect(),
                    _ => Vec::new(),
                };
                batch.push(CapturedChange {
                    target: change.target.clone(),
                    path: change.path.to_vec(),
                    map_keys,
                    unknown: change.is_unknown,
                });
            }
        }));
        Self {
            captured,
            subscription,
        }
    }

    fn finish(self, doc: &LoroDoc) -> GraphChangeSet {
        drop(self.subscription);
        let captured = self
            .captured
            .lock()
            .expect("projection change tracker mutex poisoned")
            .clone();
        let pages = doc.get_map("pages");
        let tags = doc.get_map("tags");
        let pages_id = pages.id();
        let tags_id = tags.id();
        let mut result = GraphChangeSet::default();

        for change in captured {
            let page_scope =
                change.target == pages_id || path_is_below_root(&change.path, &pages_id, "pages");
            let tag_scope =
                change.target == tags_id || path_is_below_root(&change.path, &tags_id, "tags");
            if !page_scope && !tag_scope {
                continue;
            }
            if change.unknown {
                result.rebuild = true;
                continue;
            }

            let mut resolved = false;
            if change.target == pages_id {
                resolved = true;
                for key in &change.map_keys {
                    if let Ok(page_id) = PageId::new(key) {
                        result.pages.insert(page_id);
                    }
                }
            }
            if change.target == tags_id {
                resolved = true;
                for key in &change.map_keys {
                    if let Ok(tag_id) = TagId::new(key) {
                        result.tags.insert(tag_id);
                    }
                }
            }

            for (container_id, index) in &change.path {
                let Index::Key(key) = index else {
                    continue;
                };
                let key = key.to_string();
                if page_scope
                    && pages
                        .get(&key)
                        .and_then(value_into_map)
                        .is_some_and(|page| page.id() == *container_id)
                {
                    if let Ok(page_id) = PageId::new(&key) {
                        result.pages.insert(page_id);
                    }
                    resolved = true;
                }
                if tag_scope
                    && tags
                        .get(&key)
                        .and_then(value_into_map)
                        .is_some_and(|tag| tag.id() == *container_id)
                {
                    if let Ok(tag_id) = TagId::new(&key) {
                        result.tags.insert(tag_id);
                    }
                    resolved = true;
                }
            }

            if !resolved {
                result.rebuild = true;
            }
        }
        result
    }
}

fn path_is_below_root(
    path: &[(ContainerID, Index)],
    root_id: &ContainerID,
    root_name: &str,
) -> bool {
    path.iter().any(|(container_id, index)| {
        container_id == root_id && matches!(index, Index::Key(key) if key.to_string() == root_name)
    })
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
            undo_history: Vec::new(),
            redo_history: Vec::new(),
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
            undo_history: Vec::new(),
            redo_history: Vec::new(),
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
                changes: GraphChangeSet::default(),
            });
        }

        let before = self.doc.oplog_vv();
        let semantic = semantic_name(&envelope.command).to_owned();
        let mut history_plan = None;
        let mut result = CommandResult {
            command_id: envelope.command_id.clone(),
            created_page: None,
            created_block: None,
            created_tag: None,
            changed: true,
            history_effect: None,
        };
        let change_tracker = ProjectionChangeTracker::new(&self.doc);

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
                if result.changed {
                    let Some(entry) = self.undo_history.pop() else {
                        self.undo.redo()?;
                        self.doc.commit();
                        return Err(CoreError::HistoryMetadataMismatch);
                    };
                    result.history_effect =
                        Some(self.history_effect(&entry, HistoryDirection::Undo));
                    self.redo_history.push(entry);
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
                if result.changed {
                    let Some(entry) = self.redo_history.pop() else {
                        self.undo.undo()?;
                        self.doc.commit();
                        return Err(CoreError::HistoryMetadataMismatch);
                    };
                    result.history_effect =
                        Some(self.history_effect(&entry, HistoryDirection::Redo));
                    self.undo_history.push(entry);
                }
                self.doc.commit();
            }
            command => {
                self.validate(command)?;
                history_plan = self.plan_history(command)?;
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

        let changes = change_tracker.finish(&self.doc);
        let update = self.doc.export(ExportMode::updates(&before))?;
        if !update.is_empty()
            && let Some(plan) = history_plan
        {
            let entry = plan.finish(&result, self);
            self.undo_history.push(entry);
            self.redo_history.clear();
        }
        self.remember(envelope.command_id.as_str(), result.clone());
        Ok(CoreExecution {
            result,
            update,
            semantic,
            duplicate: false,
            changes,
        })
    }

    pub fn import_remote(&mut self, update: &[u8]) -> Result<(), CoreError> {
        self.import_remote_with_changes(update).map(|_| ())
    }

    pub fn import_remote_with_changes(
        &mut self,
        update: &[u8],
    ) -> Result<GraphChangeSet, CoreError> {
        self.validate_remote(update)?;

        let change_tracker = ProjectionChangeTracker::new(&self.doc);
        self.doc.set_next_commit_origin("remote:import");
        self.doc.import(update)?;
        Ok(change_tracker.finish(&self.doc))
    }

    /// Validates a remote update without mutating canonical state. Persistence
    /// adapters use this before durably appending the bytes, then call
    /// `import_remote` after the append commits.
    pub fn validate_remote(&self, update: &[u8]) -> Result<(), CoreError> {
        // Validate on a deep fork first: a rejected remote update must not
        // partially enter the canonical document.
        let candidate = self.doc.fork();
        candidate.import(update)?;
        verify_schema(&candidate, &self.graph_id)?;
        validate_unique_entity_names(&candidate)?;
        Ok(())
    }

    pub fn export_snapshot(&self) -> Result<Vec<u8>, CoreError> {
        Ok(self.doc.export(ExportMode::Snapshot)?)
    }

    /// Exports the current state as a garbage-collected persistence baseline.
    ///
    /// Unlike `export_snapshot`, this intentionally drops operation history
    /// before the current frontier. It is suitable for a local recovery
    /// checkpoint only when the caller owns the history-retention decision.
    /// Synced replicas must use a server-approved history frontier instead of
    /// compacting independently.
    pub fn export_gc_checkpoint(&self) -> Result<Vec<u8>, CoreError> {
        let frontiers = self.doc.oplog_frontiers();
        Ok(self.doc.export(ExportMode::shallow_snapshot(&frontiers))?)
    }

    pub fn export_all(&self) -> Result<Vec<u8>, CoreError> {
        Ok(self.doc.export(ExportMode::all_updates())?)
    }

    /// Encodes the Loro version vector used as the CRDT synchronization truth.
    /// Durable transport cursors deliberately do not participate in this value.
    pub fn version_vector(&self) -> Vec<u8> {
        self.doc.oplog_vv().encode()
    }

    /// Exports operations absent from an encoded remote Loro version vector.
    pub fn export_updates_since(&self, encoded: &[u8]) -> Result<Vec<u8>, CoreError> {
        let version = VersionVector::decode(encoded)?;
        Ok(self.doc.export(ExportMode::updates(&version))?)
    }

    pub fn snapshot(&self) -> Result<GraphSnapshot, CoreError> {
        let mut quarantined = Vec::new();
        let tags = tag_snapshots(&self.doc, &mut quarantined);
        let live_tags = tags
            .iter()
            .map(|tag| tag.id.clone())
            .collect::<BTreeSet<_>>();
        let pages = self.doc.get_map("pages");
        let mut snapshots = BTreeMap::<PageId, PageSnapshot>::new();

        pages.for_each(|raw_id, value| {
            let Ok(page_id) = PageId::new(raw_id) else {
                quarantined.push(format!("page:{raw_id}:invalid-id"));
                return;
            };
            let Some(page) = value_into_map(value) else {
                quarantined.push(format!("page:{raw_id}:not-map"));
                return;
            };
            if let Some(snapshot) = page_metadata(&page_id, &page, &live_tags, &mut quarantined) {
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
                snapshot.blocks.push(block_snapshot(
                    &outline,
                    root,
                    &live_tags,
                    &mut quarantined,
                )?);
            }
        }

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
        let live_tags = live_tag_ids(&self.doc);
        let mut snapshot = page_metadata(page_id, &page, &live_tags, &mut quarantined)
            .ok_or_else(|| CoreError::PageDeleted(page_id.clone()))?;
        let outline = page
            .get("outline")
            .and_then(value_into_tree)
            .ok_or_else(|| CoreError::InvalidHierarchy("page outline is missing".to_owned()))?;
        for root in outline.roots() {
            snapshot.blocks.push(block_snapshot(
                &outline,
                root,
                &live_tags,
                &mut quarantined,
            )?);
        }
        Ok(snapshot)
    }

    /// Materializes only the projection units named by a change set. `None`
    /// means the Loro diff could not be classified safely and the caller must
    /// rebuild from a complete snapshot.
    pub fn index_delta(&self, changes: &GraphChangeSet) -> Result<Option<IndexDelta>, CoreError> {
        if changes.rebuild {
            return Ok(None);
        }
        let mut pages = Vec::with_capacity(changes.pages.len());
        let mut removed_pages = Vec::new();
        for page_id in &changes.pages {
            match self.page_snapshot(page_id) {
                Ok(page) => pages.push(page),
                Err(CoreError::PageNotFound(_)) | Err(CoreError::PageDeleted(_)) => {
                    removed_pages.push(page_id.clone());
                }
                Err(error) => return Err(error),
            }
        }

        let mut tags = Vec::with_capacity(changes.tags.len());
        let mut removed_tags = Vec::new();
        for tag_id in &changes.tags {
            let mut quarantined = Vec::new();
            if let Some(tag) = tag_snapshot_by_id(&self.doc, tag_id, &mut quarantined) {
                tags.push(tag);
            } else {
                removed_tags.push(tag_id.clone());
            }
        }
        Ok(Some(IndexDelta {
            pages,
            removed_pages,
            tags,
            removed_tags,
            frontier: self.frontier(),
        }))
    }

    /// Streams the validated projection units without materializing a complete
    /// `GraphSnapshot`. Tags are emitted first, followed by live pages in ID
    /// order; each page owns its complete visible block tree.
    pub fn index_units(
        &self,
    ) -> Result<impl Iterator<Item = Result<IndexUnit, CoreError>> + '_, CoreError> {
        let mut quarantined = Vec::new();
        let tags = tag_snapshots(&self.doc, &mut quarantined);
        let live_tags = tags
            .iter()
            .map(|tag| tag.id.clone())
            .collect::<BTreeSet<_>>();
        let pages = self.doc.get_map("pages");
        let mut page_ids = BTreeSet::new();
        pages.for_each(|raw_id, value| {
            if value_into_map(value).is_some()
                && let Ok(page_id) = PageId::new(raw_id)
            {
                page_ids.insert(page_id);
            }
        });

        let tag_units = tags.into_iter().map(|tag| Ok(IndexUnit::Tag(tag)));
        let page_units = page_ids.into_iter().filter_map(move |page_id| {
            match self.projection_page_snapshot(&page_id, &live_tags) {
                Ok(Some(page)) => Some(Ok(IndexUnit::Page(page))),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            }
        });
        Ok(tag_units.chain(page_units))
    }

    fn projection_page_snapshot(
        &self,
        page_id: &PageId,
        live_tags: &BTreeSet<TagId>,
    ) -> Result<Option<PageSnapshot>, CoreError> {
        let page = self.require_page(page_id)?;
        let mut quarantined = Vec::new();
        let Some(mut snapshot) = page_metadata(page_id, &page, live_tags, &mut quarantined) else {
            return Ok(None);
        };
        let Some(outline) = page.get("outline").and_then(value_into_tree) else {
            return Ok(Some(snapshot));
        };
        for root in outline.roots() {
            snapshot
                .blocks
                .push(block_snapshot(&outline, root, live_tags, &mut quarantined)?);
        }
        Ok(Some(snapshot))
    }

    fn snapshot_metadata(&self) -> Result<GraphSnapshot, CoreError> {
        let mut quarantined = Vec::new();
        let tags = tag_snapshots(&self.doc, &mut quarantined);
        let live_tags = tags
            .iter()
            .map(|tag| tag.id.clone())
            .collect::<BTreeSet<_>>();
        let pages = self.doc.get_map("pages");
        let mut snapshots = BTreeMap::<PageId, PageSnapshot>::new();
        pages.for_each(|raw_id, value| {
            let Ok(page_id) = PageId::new(raw_id) else {
                quarantined.push(format!("page:{raw_id}:invalid-id"));
                return;
            };
            let Some(page) = value_into_map(value) else {
                quarantined.push(format!("page:{raw_id}:not-map"));
                return;
            };
            if let Some(snapshot) = page_metadata(&page_id, &page, &live_tags, &mut quarantined) {
                snapshots.insert(page_id, snapshot);
            }
        });
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
            Command::DeleteTag { tag_id } => {
                self.require_live_tag(tag_id)?;
            }
            Command::RestoreTag { tag_id } => {
                let tag = self.require_tag(tag_id)?;
                let name = map_string(&tag, "name")
                    .ok_or_else(|| CoreError::TagNotFound(tag_id.clone()))?;
                validate_name(&name, "tag")?;
                ensure_tag_name_available(&self.doc, tag_id, &name)?;
            }
            Command::EnsureProperty {
                owner,
                key,
                value_type,
                cardinality,
            } => {
                self.validate_property_owner(owner)?;
                validate_property_write(key, property_owner_target(owner))?;
                validate_property_shape(key, *value_type, *cardinality)?;
                if *value_type == PropertyType::Document {
                    return Err(PropertyError::DocumentCommandRequired(key.to_string()).into());
                }
            }
            Command::SetProperty { owner, key, value } => {
                self.validate_property_owner(owner)?;
                validate_property_write(key, property_owner_target(owner))?;
                validate_property(key, value, Cardinality::Single)?;
                if value.property_type() == PropertyType::Document {
                    return Err(PropertyError::DocumentCommandRequired(key.to_string()).into());
                }
            }
            Command::AddRepeatedProperty { owner, key, value }
            | Command::RemoveRepeatedProperty { owner, key, value } => {
                self.validate_property_owner(owner)?;
                validate_property_write(key, property_owner_target(owner))?;
                validate_property(key, value, Cardinality::Set)?;
            }
            Command::ClearPropertyValues { owner, key }
            | Command::RemoveProperty { owner, key } => {
                self.validate_property_owner(owner)?;
                validate_property_write(key, property_owner_target(owner))?;
                if matches!(command, Command::ClearPropertyValues { .. })
                    && key.as_str() == QUERY_PROPERTY_KEY
                {
                    return Err(PropertyError::DocumentCommandRequired(key.to_string()).into());
                }
            }
            Command::SetQuerySource { owner, source } => {
                self.validate_query_owner(owner)?;
                if source.len() > 65_536 {
                    return Err(CoreError::TextTooLong);
                }
            }
            Command::SpliceQuerySource {
                owner,
                index,
                delete,
                insert,
            } => {
                self.validate_query_owner(owner)?;
                let document = self.query_document(owner)?;
                let points = document.source.chars().count();
                if index.saturating_add(*delete) > points {
                    return Err(CoreError::InvalidHierarchy(
                        "query source splice is out of bounds".to_owned(),
                    ));
                }
                let start_byte = document
                    .source
                    .char_indices()
                    .nth(*index)
                    .map_or(document.source.len(), |(offset, _)| offset);
                let end_byte = document
                    .source
                    .char_indices()
                    .nth(index.saturating_add(*delete))
                    .map_or(document.source.len(), |(offset, _)| offset);
                let next_len = document.source.len() - (end_byte - start_byte) + insert.len();
                if next_len > 65_536 {
                    return Err(CoreError::TextTooLong);
                }
            }
            Command::SetQueryPlan {
                owner,
                plan,
                source,
            } => {
                self.validate_query_owner(owner)?;
                plan.validate()?;
                if source.len() > 65_536 {
                    return Err(CoreError::TextTooLong);
                }
            }
            Command::ClearQueryPlan { owner } => {
                self.validate_query_owner(owner)?;
                self.query_document(owner)?;
            }
            Command::PutQueryView { owner, view } => {
                self.validate_query_owner(owner)?;
                let mut document = self.query_document(owner)?;
                if let Some(existing) = document.views.iter_mut().find(|item| item.id == view.id) {
                    *existing = view.clone();
                } else {
                    document.views.push(view.clone());
                }
                document.validate()?;
            }
            Command::RemoveQueryView { owner, view_id } => {
                self.validate_query_owner(owner)?;
                let mut document = self.query_document(owner)?;
                document.views.retain(|view| &view.id != view_id);
                if document.views.is_empty() {
                    return Err(PropertyError::InvalidDocument(
                        "the last query view cannot be removed".to_owned(),
                    )
                    .into());
                }
            }
            Command::SetQueryDefaultView { owner, view_id } => {
                self.validate_query_owner(owner)?;
                let document = self.query_document(owner)?;
                if !document.views.iter().any(|view| &view.id == view_id) {
                    return Err(PropertyError::InvalidDocument(
                        "default query view does not exist".to_owned(),
                    )
                    .into());
                }
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
                    &key("builtin.deleted-at"),
                    &PropertyValue::String(now.to_owned()),
                )?;
            }
            Command::RestorePage { page_id } => {
                remove_property_field(&self.page_properties(page_id)?, &key("builtin.deleted-at"))?;
            }
            Command::EnsureTag { tag_id, name } => {
                result.created_tag = self.ensure_tag(tag_id, name, now)?;
                result.changed = result.created_tag.is_some();
            }
            Command::RenameTag { tag_id, name } => {
                self.require_tag(tag_id)?.insert("name", name.as_str())?;
            }
            Command::DeleteTag { tag_id } => {
                let plan = self.plan_delete_tag(tag_id)?;
                self.apply_delete_tag(tag_id, &plan, now)?;
            }
            Command::RestoreTag { tag_id } => {
                remove_property_field(
                    &self.tag_bag(tag_id, "properties")?,
                    &key("builtin.deleted-at"),
                )?;
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
            Command::EnsureProperty {
                owner,
                key,
                value_type,
                cardinality,
            } => {
                ensure_property_field(
                    &self.property_owner_bag(owner)?,
                    key,
                    *value_type,
                    *cardinality,
                )?;
            }
            Command::SetProperty { owner, key, value } => {
                set_single(&self.property_owner_bag(owner)?, key, value)?;
            }
            Command::ClearPropertyValues { owner, key } => {
                clear_property_values(&self.property_owner_bag(owner)?, key)?;
            }
            Command::RemoveProperty { owner, key } => {
                remove_property_field(&self.property_owner_bag(owner)?, key)?;
            }
            Command::AddRepeatedProperty { owner, key, value } => {
                set_repeated(&self.property_owner_bag(owner)?, key, value)?;
            }
            Command::RemoveRepeatedProperty { owner, key, value } => {
                self.property_owner_bag(owner)?
                    .delete(&repeated_slot(key, value)?)?;
            }
            // Writing SPARQL by hand detaches the builder: the plan no longer
            // describes what runs, so it stops claiming to.
            Command::SetQuerySource { owner, source } => {
                let document = ensure_query_document(&self.property_owner_bag(owner)?)?;
                replace_text(&document.ensure_mergeable_text("source")?, source)?;
                clear_query_plan(&document)?;
            }
            Command::SpliceQuerySource {
                owner,
                index,
                delete,
                insert,
            } => {
                let document = require_query_document(&self.property_owner_bag(owner)?)?;
                document
                    .ensure_mergeable_text("source")?
                    .delete(*index, *delete)?;
                if !insert.is_empty() {
                    document
                        .ensure_mergeable_text("source")?
                        .insert(*index, insert)?;
                }
                clear_query_plan(&document)?;
            }
            Command::SetQueryPlan {
                owner,
                plan,
                source,
            } => {
                let document = ensure_query_document(&self.property_owner_bag(owner)?)?;
                // The plan and the source it compiled to land in one
                // transaction, so no revision ever runs a source the stored
                // plan did not produce.
                replace_text(&document.ensure_mergeable_text("source")?, source)?;
                document.insert("plan_version", i64::from(plan.version))?;
                document.insert("plan", plan.payload.as_str())?;
            }
            Command::ClearQueryPlan { owner } => {
                clear_query_plan(&require_query_document(&self.property_owner_bag(owner)?)?)?;
            }
            Command::PutQueryView { owner, view } => {
                put_query_view(
                    &require_query_document(&self.property_owner_bag(owner)?)?,
                    view,
                )?;
            }
            Command::RemoveQueryView { owner, view_id } => {
                remove_query_view(
                    &require_query_document(&self.property_owner_bag(owner)?)?,
                    view_id,
                )?;
            }
            Command::SetQueryDefaultView { owner, view_id } => {
                require_query_document(&self.property_owner_bag(owner)?)?
                    .insert("default_view_id", view_id.as_str())?;
            }
            Command::AddTag { entity, tag_id } => {
                self.entity_tags(entity)?.insert(tag_id.as_str(), true)?;
                let entity_bag = self.entity_bag(entity)?;
                for field in decode_bag(&self.tag_bag(tag_id, "defaults")?).0 {
                    if !bag_contains_key(&entity_bag, &field.key) {
                        ensure_property_field(
                            &entity_bag,
                            &field.key,
                            field.value_type,
                            field.cardinality,
                        )?;
                        for value in &field.values {
                            match field.cardinality {
                                Cardinality::Single => set_single(&entity_bag, &field.key, value)?,
                                Cardinality::Set => set_repeated(&entity_bag, &field.key, value)?,
                            }
                        }
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
            Command::EnsureProperty { owner, .. }
            | Command::SetProperty { owner, .. }
            | Command::ClearPropertyValues { owner, .. }
            | Command::RemoveProperty { owner, .. }
            | Command::AddRepeatedProperty { owner, .. }
            | Command::RemoveRepeatedProperty { owner, .. } => {
                self.touch_property_owner(owner, now)?
            }
            Command::SetQuerySource { owner, .. }
            | Command::SpliceQuerySource { owner, .. }
            | Command::SetQueryPlan { owner, .. }
            | Command::ClearQueryPlan { owner }
            | Command::PutQueryView { owner, .. }
            | Command::RemoveQueryView { owner, .. }
            | Command::SetQueryDefaultView { owner, .. } => {
                self.touch_property_owner(owner, now)?
            }
            Command::AddTag { entity, .. } | Command::RemoveTag { entity, .. } => {
                self.touch_entity(entity, now)?
            }
            Command::EnsureTag { .. } => {
                if let Some(tag_id) = &result.created_tag {
                    self.touch_tag(tag_id, now)?;
                }
            }
            Command::RenameTag { tag_id, .. }
            | Command::DeleteTag { tag_id }
            | Command::RestoreTag { tag_id } => self.touch_tag(tag_id, now)?,
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

    fn touch_property_owner(&self, owner: &PropertyOwner, now: &str) -> Result<(), CoreError> {
        match owner {
            PropertyOwner::Page { id } => self.touch_page(id, now),
            PropertyOwner::Block { page_id, id } => {
                self.touch_block(page_id, id, now)?;
                self.touch_page(page_id, now)
            }
            PropertyOwner::TagDefault { tag_id } => self.touch_tag(tag_id, now),
        }
    }

    fn touch_page(&self, page_id: &PageId, now: &str) -> Result<(), CoreError> {
        set_single(
            &self.page_properties(page_id)?,
            &key("builtin.updated-at"),
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
            &key("builtin.updated-at"),
            &PropertyValue::String(now.to_owned()),
        )
    }

    fn touch_tag(&self, tag_id: &TagId, now: &str) -> Result<(), CoreError> {
        set_single(
            &self.tag_bag(tag_id, "properties")?,
            &key("builtin.updated-at"),
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
                &key("builtin.page-kind"),
                &PropertyValue::String(kind.to_owned()),
            )?;
            if let Some(date) = date {
                set_single(
                    &properties,
                    &key("builtin.journal-date"),
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

    fn plan_history(&self, command: &Command) -> Result<Option<HistoryPlan>, CoreError> {
        let plan = |scope,
                    mut affected_pages: Vec<PageId>,
                    undo_candidates,
                    redo_candidates,
                    redo_created_block,
                    redo_created_page| {
            affected_pages.sort();
            affected_pages.dedup();
            Some(HistoryPlan {
                entry: HistoryEntry {
                    scope,
                    affected_pages,
                    undo_candidates,
                    redo_candidates,
                },
                redo_created_block,
                redo_created_page,
            })
        };
        let page = |page_id: &PageId| {
            HistoryTarget::Entity(EntityId::Page {
                id: page_id.clone(),
            })
        };
        let block = |page_id: &PageId, block_id: &BlockId| {
            HistoryTarget::Entity(EntityId::Block {
                page_id: page_id.clone(),
                id: block_id.clone(),
            })
        };
        let entity_plan = |entity: &EntityId| {
            let (scope, page_id) = match entity {
                EntityId::Page { id } => (HistoryScope::Page, id.clone()),
                EntityId::Block { page_id, .. } => (HistoryScope::Entity, page_id.clone()),
            };
            plan(
                scope,
                vec![page_id],
                vec![HistoryTarget::Entity(entity.clone())],
                vec![HistoryTarget::Entity(entity.clone())],
                false,
                false,
            )
        };
        let owner_plan = |owner: &PropertyOwner| match owner {
            PropertyOwner::Page { id } => entity_plan(&EntityId::Page { id: id.clone() }),
            PropertyOwner::Block { page_id, id } => entity_plan(&EntityId::Block {
                page_id: page_id.clone(),
                id: id.clone(),
            }),
            PropertyOwner::TagDefault { .. } => plan(
                HistoryScope::Graph,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                false,
                false,
            ),
        };

        Ok(match command {
            Command::EnsurePage { page_id, .. } => plan(
                HistoryScope::Page,
                vec![page_id.clone()],
                Vec::new(),
                Vec::new(),
                false,
                true,
            ),
            Command::EnsureJournal { date } => {
                let page_id = PageId::journal(&self.graph_id, date);
                plan(
                    HistoryScope::Page,
                    vec![page_id.clone()],
                    Vec::new(),
                    vec![page(&page_id)],
                    false,
                    false,
                )
            }
            Command::RenamePage { page_id, .. } => plan(
                HistoryScope::Page,
                vec![page_id.clone()],
                vec![page(page_id)],
                vec![page(page_id)],
                false,
                false,
            ),
            Command::DeletePage { page_id } => plan(
                HistoryScope::Page,
                vec![page_id.clone()],
                vec![page(page_id)],
                Vec::new(),
                false,
                false,
            ),
            Command::RestorePage { page_id } => plan(
                HistoryScope::Page,
                vec![page_id.clone()],
                Vec::new(),
                vec![page(page_id)],
                false,
                false,
            ),
            Command::EnsureTag { .. } | Command::RenameTag { .. } | Command::RestoreTag { .. } => {
                plan(
                    HistoryScope::Graph,
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    false,
                    false,
                )
            }
            Command::DeleteTag { tag_id } => plan(
                HistoryScope::Graph,
                self.plan_delete_tag(tag_id)?
                    .pages
                    .into_iter()
                    .map(|entry| entry.page_id)
                    .collect(),
                Vec::new(),
                Vec::new(),
                false,
                false,
            ),
            Command::InsertBlock {
                page_id, parent, ..
            } => plan(
                HistoryScope::Entity,
                vec![page_id.clone()],
                parent
                    .as_ref()
                    .map(|id| block(page_id, id))
                    .into_iter()
                    .chain([page(page_id)])
                    .collect(),
                Vec::new(),
                true,
                false,
            ),
            Command::SplitBlock {
                page_id, block_id, ..
            } => plan(
                HistoryScope::Entity,
                vec![page_id.clone()],
                vec![block(page_id, block_id), page(page_id)],
                vec![block(page_id, block_id)],
                true,
                false,
            ),
            Command::InsertOutline {
                page_id, parent, ..
            } => plan(
                HistoryScope::Entity,
                vec![page_id.clone()],
                parent
                    .as_ref()
                    .map(|id| block(page_id, id))
                    .into_iter()
                    .chain([page(page_id)])
                    .collect(),
                Vec::new(),
                true,
                false,
            ),
            Command::EditMarkdown {
                page_id, block_id, ..
            }
            | Command::SpliceMarkdown {
                page_id, block_id, ..
            } => plan(
                HistoryScope::Entity,
                vec![page_id.clone()],
                vec![block(page_id, block_id)],
                vec![block(page_id, block_id)],
                false,
                false,
            ),
            Command::MoveBlocks {
                page_id,
                block_ids,
                parent,
                index,
            } => {
                let roots = self
                    .plan_move_blocks(page_id, block_ids, parent.as_ref(), *index)?
                    .roots;
                let candidates = roots
                    .iter()
                    .map(|id| block(page_id, id))
                    .chain([page(page_id)])
                    .collect::<Vec<_>>();
                plan(
                    HistoryScope::Entity,
                    vec![page_id.clone()],
                    candidates.clone(),
                    candidates,
                    false,
                    false,
                )
            }
            Command::IndentBlocks { page_id, block_ids } => {
                let roots = self.plan_indent_blocks(page_id, block_ids)?.roots;
                let candidates = roots
                    .iter()
                    .map(|id| block(page_id, id))
                    .chain([page(page_id)])
                    .collect::<Vec<_>>();
                plan(
                    HistoryScope::Entity,
                    vec![page_id.clone()],
                    candidates.clone(),
                    candidates,
                    false,
                    false,
                )
            }
            Command::OutdentBlocks { page_id, block_ids } => {
                let roots = self.plan_outdent_blocks(page_id, block_ids)?.roots;
                let candidates = roots
                    .iter()
                    .map(|id| block(page_id, id))
                    .chain([page(page_id)])
                    .collect::<Vec<_>>();
                plan(
                    HistoryScope::Entity,
                    vec![page_id.clone()],
                    candidates.clone(),
                    candidates,
                    false,
                    false,
                )
            }
            Command::DeleteBlocks { page_id, block_ids } => {
                let state = self.outline_state(page_id)?;
                let roots = state.roots(block_ids)?;
                let undo_candidates = roots
                    .iter()
                    .filter_map(|id| {
                        let parent = state.parents.get(id)?.clone();
                        let index = state
                            .children
                            .get(&parent)?
                            .iter()
                            .position(|item| item == id)?;
                        Some(HistoryTarget::BlockPosition {
                            page_id: page_id.clone(),
                            parent,
                            index,
                        })
                    })
                    .chain([page(page_id)])
                    .collect::<Vec<_>>();
                let mut redo_candidates = Vec::new();
                if let Some(first) = roots.first()
                    && let Some(parent) = state.parents.get(first).cloned()
                {
                    if let Some(previous) = state.children.get(&parent).and_then(|siblings| {
                        siblings
                            .iter()
                            .position(|id| id == first)
                            .and_then(|position| position.checked_sub(1))
                            .map(|position| siblings[position].clone())
                    }) {
                        redo_candidates.push(block(page_id, &previous));
                    }
                    if let Some(parent) = parent {
                        redo_candidates.push(block(page_id, &parent));
                    }
                }
                redo_candidates.push(page(page_id));
                plan(
                    HistoryScope::Entity,
                    vec![page_id.clone()],
                    undo_candidates,
                    redo_candidates,
                    false,
                    false,
                )
            }
            Command::EnsureProperty { owner, .. }
            | Command::SetProperty { owner, .. }
            | Command::ClearPropertyValues { owner, .. }
            | Command::RemoveProperty { owner, .. }
            | Command::AddRepeatedProperty { owner, .. }
            | Command::RemoveRepeatedProperty { owner, .. }
            | Command::SetQuerySource { owner, .. }
            | Command::SpliceQuerySource { owner, .. }
            | Command::SetQueryPlan { owner, .. }
            | Command::ClearQueryPlan { owner }
            | Command::PutQueryView { owner, .. }
            | Command::RemoveQueryView { owner, .. }
            | Command::SetQueryDefaultView { owner, .. } => owner_plan(owner),
            Command::AddTag { entity, .. } | Command::RemoveTag { entity, .. } => {
                entity_plan(entity)
            }
            Command::Undo | Command::Redo => None,
        })
    }

    fn history_effect(&self, entry: &HistoryEntry, direction: HistoryDirection) -> HistoryEffect {
        let candidates = match direction {
            HistoryDirection::Undo => &entry.undo_candidates,
            HistoryDirection::Redo => &entry.redo_candidates,
        };
        HistoryEffect {
            scope: entry.scope,
            affected_pages: entry.affected_pages.clone(),
            reveal: candidates
                .iter()
                .find_map(|target| self.resolve_history_target(target)),
        }
    }

    fn resolve_history_target(&self, target: &HistoryTarget) -> Option<EntityId> {
        match target {
            HistoryTarget::Entity(entity) => self.entity_is_live(entity).then(|| entity.clone()),
            HistoryTarget::BlockPosition {
                page_id,
                parent,
                index,
            } => {
                let state = self.outline_state(page_id).ok()?;
                let id = state.children.get(parent)?.get(*index)?.clone();
                Some(EntityId::Block {
                    page_id: page_id.clone(),
                    id,
                })
            }
        }
    }

    fn entity_is_live(&self, entity: &EntityId) -> bool {
        match entity {
            EntityId::Page { id } => self.require_live_page(id).is_ok(),
            EntityId::Block { page_id, id } => {
                self.require_live_page(page_id).is_ok() && self.require_block(page_id, id).is_ok()
            }
        }
    }

    fn plan_delete_tag(&self, tag_id: &TagId) -> Result<TagDetachPlan, CoreError> {
        let mut page_maps = Vec::new();
        self.doc.get_map("pages").for_each(|raw_id, value| {
            if let (Ok(page_id), Some(page)) = (PageId::new(raw_id), value_into_map(value)) {
                page_maps.push((page_id, page));
            }
        });
        page_maps.sort_by(|left, right| left.0.cmp(&right.0));

        let mut pages = Vec::new();
        for (page_id, page) in page_maps {
            let root = page
                .get("root")
                .and_then(value_into_map)
                .ok_or_else(|| CoreError::InvalidHierarchy("page root node is missing".into()))?;
            let root_tagged = node_has_tag(&root, tag_id);
            let outline = page
                .get("outline")
                .and_then(value_into_tree)
                .ok_or_else(|| CoreError::InvalidHierarchy("page outline is missing".into()))?;
            let mut blocks = Vec::new();
            for node in outline.roots() {
                collect_tagged_blocks(&outline, node, tag_id, &mut blocks)?;
            }
            if root_tagged || !blocks.is_empty() {
                pages.push(TagDetachPage {
                    page_id,
                    root: root_tagged,
                    blocks,
                });
            }
        }
        Ok(TagDetachPlan { pages })
    }

    fn apply_delete_tag(
        &self,
        tag_id: &TagId,
        plan: &TagDetachPlan,
        now: &str,
    ) -> Result<(), CoreError> {
        set_single(
            &self.tag_bag(tag_id, "properties")?,
            &key("builtin.deleted-at"),
            &PropertyValue::String(now.to_owned()),
        )?;
        for page in &plan.pages {
            if page.root {
                self.page_root(&page.page_id)?
                    .ensure_mergeable_map("tag_refs")?
                    .delete(tag_id.as_str())?;
            }
            let outline = self.page_outline(&page.page_id)?;
            for block_id in &page.blocks {
                outline
                    .get_meta(require_block_in(&outline, block_id)?)?
                    .ensure_mergeable_map("tag_refs")?
                    .delete(tag_id.as_str())?;
                self.touch_block(&page.page_id, block_id, now)?;
            }
            self.touch_page(&page.page_id, now)?;
        }
        Ok(())
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
            &key("builtin.deleted-at"),
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
            &key("builtin.deleted-at"),
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

    fn property_owner_bag(&self, owner: &PropertyOwner) -> Result<LoroMap, CoreError> {
        match owner {
            PropertyOwner::Page { id } => self.page_properties(id),
            PropertyOwner::Block { page_id, id } => self.block_bag(page_id, id),
            PropertyOwner::TagDefault { tag_id } => self.tag_bag(tag_id, "defaults"),
        }
    }

    fn validate_query_owner(&self, owner: &PropertyOwner) -> Result<(), CoreError> {
        self.validate_property_owner(owner)?;
        let query_key = key(QUERY_PROPERTY_KEY);
        validate_property_write(&query_key, property_owner_target(owner))?;
        Ok(())
    }

    fn query_document(&self, owner: &PropertyOwner) -> Result<PropertyDocument, CoreError> {
        let bag = self.property_owner_bag(owner)?;
        let document = require_query_document(&bag)?;
        decode_query_document(&document).map_err(CoreError::InvalidHierarchy)
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

    fn validate_property_owner(&self, owner: &PropertyOwner) -> Result<(), CoreError> {
        match owner {
            PropertyOwner::Page { id } => {
                self.require_page(id)?;
            }
            PropertyOwner::Block { page_id, id } => {
                self.require_block(page_id, id)?;
            }
            PropertyOwner::TagDefault { tag_id } => {
                self.require_tag(tag_id)?;
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
    let live_tags = live_tag_ids(doc);
    doc.get_map("pages").for_each(|raw_id, value| {
        let Ok(page_id) = PageId::new(raw_id) else {
            return;
        };
        let Some(page) = value_into_map(value) else {
            return;
        };
        let mut quarantined = Vec::new();
        let Some(snapshot) = page_metadata(&page_id, &page, &live_tags, &mut quarantined) else {
            return;
        };
        let is_journal = snapshot.properties.iter().any(|entry| {
            entry.key.as_str() == "builtin.page-kind"
                && entry.values == [PropertyValue::String("journal".to_owned())]
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

fn live_tag_ids(doc: &LoroDoc) -> BTreeSet<TagId> {
    let mut quarantined = Vec::new();
    tag_snapshots(doc, &mut quarantined)
        .into_iter()
        .map(|tag| tag.id)
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

fn property_owner_target(owner: &PropertyOwner) -> PropertyTarget {
    match owner {
        PropertyOwner::Page { .. } => PropertyTarget::Page,
        PropertyOwner::Block { .. } => PropertyTarget::Block,
        PropertyOwner::TagDefault { .. } => PropertyTarget::TagDefault,
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
        Command::AddTag { .. } => "TagAddedAndDefaultsMaterialized",
        Command::RemoveTag { .. } => "TagRemoved",
        Command::EnsureProperty { owner, .. }
        | Command::SetProperty { owner, .. }
        | Command::ClearPropertyValues { owner, .. }
        | Command::RemoveProperty { owner, .. }
        | Command::AddRepeatedProperty { owner, .. }
        | Command::RemoveRepeatedProperty { owner, .. }
        | Command::SetQuerySource { owner, .. }
        | Command::SpliceQuerySource { owner, .. }
        | Command::SetQueryPlan { owner, .. }
        | Command::ClearQueryPlan { owner }
        | Command::PutQueryView { owner, .. }
        | Command::RemoveQueryView { owner, .. }
        | Command::SetQueryDefaultView { owner, .. } => match owner {
            PropertyOwner::TagDefault { .. } => "TagDefaultsChanged",
            PropertyOwner::Page { .. } | PropertyOwner::Block { .. } => "PropertiesChanged",
        },
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

fn field_slot(key: &PropertyKey) -> String {
    format!("f:{}", key.as_str())
}

fn repeated_slot(key: &PropertyKey, value: &PropertyValue) -> Result<String, CoreError> {
    let encoded = serde_json::to_vec(value)?;
    Ok(format!(
        "r:{}:{}",
        key.as_str(),
        hex::encode(Sha256::digest(encoded))
    ))
}

fn document_slot(key: &PropertyKey) -> String {
    format!("d:{}", key.as_str())
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
    set_single(properties, &key("builtin.created-at"), &value)?;
    set_single(properties, &key("builtin.updated-at"), &value)
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

fn encode_value(value: &PropertyValue) -> Result<String, CoreError> {
    Ok(serde_json::to_string(value)?)
}

fn ensure_property_field(
    map: &LoroMap,
    key: &PropertyKey,
    value_type: PropertyType,
    cardinality: Cardinality,
) -> Result<(), CoreError> {
    validate_property_shape(key, value_type, cardinality)?;
    if let Some(encoded) = map.get(&field_slot(key)).and_then(value_into_string) {
        let existing: PropertyField = serde_json::from_str(&encoded)?;
        if !existing.values.is_empty() {
            return Err(CoreError::InvalidHierarchy(format!(
                "property field marker {} contains inline values",
                key
            )));
        }
        validate_property_field(&existing)?;
        if existing.key != *key || existing.value_type != value_type {
            return Err(CoreError::Property(PropertyError::WrongType {
                key: key.to_string(),
                expected: existing.value_type,
                actual: value_type,
            }));
        }
        if existing.cardinality != cardinality {
            return Err(CoreError::Property(PropertyError::WrongCardinality {
                key: key.to_string(),
                expected: existing.cardinality,
                actual: cardinality,
            }));
        }
        return Ok(());
    }
    // A field recreated after removal starts empty even if a malformed or
    // concurrently orphaned value slot survived without its marker.
    clear_property_values(map, key)?;
    let marker = PropertyField {
        key: key.clone(),
        value_type,
        cardinality,
        values: Vec::new(),
    };
    map.insert(&field_slot(key), serde_json::to_string(&marker)?)?;
    Ok(())
}

fn set_single(map: &LoroMap, key: &PropertyKey, value: &PropertyValue) -> Result<(), CoreError> {
    ensure_property_field(map, key, value.property_type(), Cardinality::Single)?;
    map.insert(&single_slot(key), encode_value(value)?)?;
    Ok(())
}

fn set_repeated(map: &LoroMap, key: &PropertyKey, value: &PropertyValue) -> Result<(), CoreError> {
    ensure_property_field(map, key, value.property_type(), Cardinality::Set)?;
    map.insert(&repeated_slot(key, value)?, encode_value(value)?)?;
    Ok(())
}

fn ensure_query_document(map: &LoroMap) -> Result<LoroMap, CoreError> {
    let query_key = key(QUERY_PROPERTY_KEY);
    ensure_property_field(map, &query_key, PropertyType::Document, Cardinality::Single)?;
    let created = map.get(&document_slot(&query_key)).is_none();
    let document = map.ensure_mergeable_map(&document_slot(&query_key))?;
    if created {
        document.insert("schema", QUERY_DOCUMENT_SCHEMA)?;
        document.insert("version", i64::from(QUERY_DOCUMENT_VERSION))?;
        document.insert("language", QUERY_LANGUAGE)?;
        document.insert("default_view_id", "table")?;
        let _ = document.ensure_mergeable_text("source")?;
        let defaults = PropertyDocument::default_query(String::new());
        for view in &defaults.views {
            put_query_view(&document, view)?;
        }
    } else {
        let decoded = decode_query_document(&document).map_err(CoreError::InvalidHierarchy)?;
        decoded.validate()?;
    }
    Ok(document)
}

fn clear_query_plan(document: &LoroMap) -> Result<(), CoreError> {
    if document.get("plan").is_some() {
        document.delete("plan")?;
    }
    if document.get("plan_version").is_some() {
        document.delete("plan_version")?;
    }
    Ok(())
}

fn require_query_document(map: &LoroMap) -> Result<LoroMap, CoreError> {
    let query_key = key(QUERY_PROPERTY_KEY);
    let Some(document) = map.get(&document_slot(&query_key)).and_then(value_into_map) else {
        return Err(PropertyError::InvalidDocument("query document is missing".to_owned()).into());
    };
    Ok(document)
}

fn put_query_view(document: &LoroMap, view: &QueryView) -> Result<(), CoreError> {
    let views = document.ensure_mergeable_map("views")?;
    let created = views.get(view.id.as_str()).is_none();
    let stored = views.ensure_mergeable_map(view.id.as_str())?;
    stored.insert("name", view.name.as_str())?;
    stored.insert(
        "kind",
        match view.kind {
            QueryViewKind::Table => "table",
            QueryViewKind::List => "list",
        },
    )?;
    stored.insert("position", i64::from(view.position))?;
    stored.insert("columns", serde_json::to_string(&view.columns)?)?;
    stored.insert("options", serde_json::to_string(&view.options)?)?;
    // Editing an existing view never clears its tombstone. A concurrent remove
    // therefore wins over writes to the view's other fields; recreating a view
    // uses a new stable ID.
    if created {
        stored.insert("deleted", false)?;
    }
    Ok(())
}

fn remove_query_view(document: &LoroMap, view_id: &QueryViewId) -> Result<(), CoreError> {
    let current = decode_query_document(document).map_err(CoreError::InvalidHierarchy)?;
    let next_default = if current.default_view_id == *view_id {
        Some(
            current
                .views
                .iter()
                .find(|view| &view.id != view_id)
                .ok_or_else(|| {
                    PropertyError::InvalidDocument(
                        "the last query view cannot be removed".to_owned(),
                    )
                })?
                .id
                .clone(),
        )
    } else {
        None
    };
    let views = document.ensure_mergeable_map("views")?;
    let stored = views
        .get(view_id.as_str())
        .and_then(value_into_map)
        .ok_or_else(|| PropertyError::InvalidDocument("query view does not exist".to_owned()))?;
    stored.insert("deleted", true)?;
    if let Some(next) = next_default {
        document.insert("default_view_id", next.as_str())?;
    }
    Ok(())
}

fn decode_query_document(document: &LoroMap) -> Result<PropertyDocument, String> {
    let schema = map_string(document, "schema")
        .ok_or_else(|| "query document schema is missing".to_owned())?;
    let version = map_i64(document, "version")
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "query document version is invalid".to_owned())?;
    let language = map_string(document, "language")
        .ok_or_else(|| "query document language is missing".to_owned())?;
    let source = match document.get("source") {
        Some(ValueOrContainer::Container(Container::Text(text))) => text.to_string(),
        _ => return Err("query document source is missing".to_owned()),
    };
    let requested_default_view_id = QueryViewId::new(
        map_string(document, "default_view_id")
            .ok_or_else(|| "query document default view is missing".to_owned())?,
    )
    .map_err(|error| error.to_string())?;
    let views = document
        .get("views")
        .and_then(value_into_map)
        .ok_or_else(|| "query document views are missing".to_owned())?;
    let mut decoded = Vec::new();
    let mut issues = Vec::new();
    views.for_each(|raw_id, value| {
        let Some(view) = value_into_map(value) else {
            issues.push(format!("query view {raw_id} is not a map"));
            return;
        };
        if map_bool(&view, "deleted") == Some(true) {
            return;
        }
        let parsed = (|| {
            let id = QueryViewId::new(raw_id).map_err(|error| error.to_string())?;
            let name = map_string(&view, "name")
                .ok_or_else(|| format!("query view {raw_id} name is missing"))?;
            let kind = match map_string(&view, "kind").as_deref() {
                Some("table") => QueryViewKind::Table,
                Some("list") => QueryViewKind::List,
                _ => return Err(format!("query view {raw_id} kind is invalid")),
            };
            let position = map_i64(&view, "position")
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| format!("query view {raw_id} position is invalid"))?;
            let columns = map_string(&view, "columns")
                .and_then(|value| serde_json::from_str::<Vec<QueryViewColumn>>(&value).ok())
                .ok_or_else(|| format!("query view {raw_id} columns are invalid"))?;
            // Presentation switches decode leniently: a view written by a peer
            // that predates them, or by one that added a switch this build does
            // not know, still opens on this build's defaults.
            let options = map_string(&view, "options")
                .and_then(|value| serde_json::from_str::<QueryViewOptions>(&value).ok())
                .unwrap_or_default();
            Ok(QueryView {
                id,
                name,
                kind,
                position,
                columns,
                options,
            })
        })();
        match parsed {
            Ok(view) => decoded.push(view),
            Err(issue) => issues.push(issue),
        }
    });
    if let Some(issue) = issues.into_iter().next() {
        return Err(issue);
    }
    decoded.sort_by(|left, right| {
        left.position
            .cmp(&right.position)
            .then_with(|| left.id.cmp(&right.id))
    });
    if decoded.is_empty() {
        decoded.push(
            PropertyDocument::default_query(String::new())
                .views
                .remove(0),
        );
    }
    let default_view_id = if decoded
        .iter()
        .any(|view| view.id == requested_default_view_id)
    {
        requested_default_view_id
    } else {
        decoded[0].id.clone()
    };
    // A plan this build cannot read is not a broken document: the source is
    // still the executable query, so the plan is simply absent and the block
    // opens on its SPARQL instead of the builder.
    let plan = match (
        map_i64(document, "plan_version"),
        map_string(document, "plan"),
    ) {
        (Some(version), Some(payload)) => u32::try_from(version)
            .ok()
            .map(|version| QueryPlan { version, payload })
            .filter(|plan| plan.validate().is_ok()),
        _ => None,
    };
    let snapshot = PropertyDocument {
        schema,
        version,
        source,
        language,
        views: decoded,
        default_view_id,
        plan,
    };
    snapshot.validate().map_err(|error| error.to_string())?;
    Ok(snapshot)
}

fn bag_contains_key(map: &LoroMap, key: &PropertyKey) -> bool {
    map.get(&field_slot(key)).is_some()
}

fn property_value_slots(map: &LoroMap, key: &PropertyKey) -> Vec<String> {
    let single = single_slot(key);
    let document = document_slot(key);
    let repeated = format!("r:{}:", key.as_str());
    let mut slots = Vec::new();
    map.for_each(|slot, _| {
        if slot == single || slot == document || slot.starts_with(&repeated) {
            slots.push(slot.to_owned());
        }
    });
    slots
}

fn clear_property_values(map: &LoroMap, key: &PropertyKey) -> Result<(), CoreError> {
    for slot in property_value_slots(map, key) {
        map.delete(&slot)?;
    }
    Ok(())
}

fn remove_property_field(map: &LoroMap, key: &PropertyKey) -> Result<(), CoreError> {
    clear_property_values(map, key)?;
    map.delete(&field_slot(key))?;
    Ok(())
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
    let mut fields = BTreeMap::<PropertyKey, PropertyField>::new();
    let mut issues = Vec::new();
    map.for_each(|slot, value| {
        let Some(raw_key) = slot.strip_prefix("f:") else {
            return;
        };
        let Some(encoded) = value_into_string(value) else {
            issues.push(format!("property-slot:{slot}:not-atomic-string"));
            return;
        };
        let Ok(field) = serde_json::from_str::<PropertyField>(&encoded) else {
            issues.push(format!("property-slot:{slot}:invalid-field"));
            return;
        };
        if field.key.as_str() != raw_key || !field.values.is_empty() {
            issues.push(format!("property-slot:{slot}:invalid-marker"));
            return;
        }
        if validate_property_field(&field).is_err() {
            issues.push(format!("property-slot:{slot}:contract-violation"));
            return;
        }
        fields.insert(field.key.clone(), field);
    });
    map.for_each(|slot, value| {
        if slot.starts_with("f:") {
            return;
        }
        if let Some(raw_key) = slot.strip_prefix("d:") {
            let Ok(key) = PropertyKey::new(raw_key) else {
                issues.push(format!("property-slot:{slot}:invalid-key"));
                return;
            };
            let Some(field) = fields.get_mut(&key) else {
                issues.push(format!("property-slot:{slot}:missing-field"));
                return;
            };
            if field.value_type != PropertyType::Document
                || field.cardinality != Cardinality::Single
            {
                issues.push(format!("property-slot:{slot}:contract-violation"));
                return;
            }
            let Some(document) = value_into_map(value) else {
                issues.push(format!("property-slot:{slot}:not-document-map"));
                return;
            };
            let schema = map_string(&document, "schema");
            let version = map_i64(&document, "version").and_then(|value| u32::try_from(value).ok());
            match (schema, version) {
                (Some(schema), Some(version))
                    if schema != QUERY_DOCUMENT_SCHEMA || version != QUERY_DOCUMENT_VERSION =>
                {
                    field.values =
                        vec![PropertyValue::UnsupportedDocument(PropertyDocumentHeader {
                            schema,
                            version,
                        })];
                }
                (Some(_), Some(_)) => {
                    let Ok(document) = decode_query_document(&document) else {
                        issues.push(format!("property-slot:{slot}:invalid-document"));
                        return;
                    };
                    field.values = vec![PropertyValue::Document(document)];
                }
                _ => issues.push(format!("property-slot:{slot}:invalid-document-header")),
            }
            return;
        }
        let (raw_key, cardinality) = if let Some(raw_key) = slot.strip_prefix("s:") {
            (raw_key, Cardinality::Single)
        } else if let Some(rest) = slot.strip_prefix("r:") {
            let Some((raw_key, _hash)) = rest.split_once(':') else {
                issues.push(format!("property-slot:{slot}:invalid-slot"));
                return;
            };
            (raw_key, Cardinality::Set)
        } else {
            issues.push(format!("property-slot:{slot}:invalid-slot"));
            return;
        };
        let Ok(key) = PropertyKey::new(raw_key) else {
            issues.push(format!("property-slot:{slot}:invalid-key"));
            return;
        };
        let Some(field) = fields.get_mut(&key) else {
            issues.push(format!("property-slot:{slot}:missing-field"));
            return;
        };
        if field.cardinality != cardinality {
            issues.push(format!("property-slot:{slot}:cardinality-mismatch"));
            return;
        }
        let Some(encoded) = value_into_string(value) else {
            issues.push(format!("property-slot:{slot}:not-atomic-string"));
            return;
        };
        let Ok(property_value) = serde_json::from_str::<PropertyValue>(&encoded) else {
            issues.push(format!("property-slot:{slot}:invalid-value"));
            return;
        };
        if property_value.property_type() != field.value_type
            || validate_property(&key, &property_value, cardinality).is_err()
        {
            issues.push(format!("property-slot:{slot}:contract-violation"));
            return;
        }
        if cardinality == Cardinality::Single {
            field.values.clear();
        }
        field.values.push(property_value);
    });
    for field in fields.values_mut() {
        field
            .values
            .sort_by_key(|value| serde_json::to_string(value).unwrap_or_default());
    }
    issues.sort();
    (fields.into_values().collect(), issues)
}

fn page_metadata(
    page_id: &PageId,
    page: &LoroMap,
    live_tags: &BTreeSet<TagId>,
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
    if bag_has_key(&properties, "builtin.deleted-at") {
        return None;
    }
    let tags = decode_tag_refs(&root, &format!("page:{page_id}"), live_tags, quarantined);
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
        if let Some(snapshot) = tag_snapshot(&tag_id, &tag, quarantined) {
            snapshots.insert(tag_id, snapshot);
        }
    });
    snapshots.into_values().collect()
}

fn tag_snapshot_by_id(
    doc: &LoroDoc,
    tag_id: &TagId,
    quarantined: &mut Vec<String>,
) -> Option<TagSnapshot> {
    let tag = doc
        .get_map("tags")
        .get(tag_id.as_str())
        .and_then(value_into_map)?;
    tag_snapshot(tag_id, &tag, quarantined)
}

fn tag_snapshot(
    tag_id: &TagId,
    tag: &LoroMap,
    quarantined: &mut Vec<String>,
) -> Option<TagSnapshot> {
    let Some(name) = map_string(tag, "name") else {
        quarantined.push(format!("tag:{tag_id}:missing-name"));
        return None;
    };
    let (mut properties, mut issues) = decode_bag_child(tag, "properties");
    quarantined.append(&mut issues);
    if bag_has_key(&properties, "builtin.deleted-at") {
        return None;
    }
    properties
        .retain(|entry| validate_property_target(&entry.key, PropertyTarget::TagMetadata).is_ok());
    let (mut defaults, mut issues) = decode_bag_child(tag, "defaults");
    quarantined.append(&mut issues);
    defaults.retain(|field| {
        validate_property_write(&field.key, PropertyTarget::TagDefault).is_ok()
            && validate_property_field(field).is_ok()
    });
    Some(TagSnapshot {
        id: tag_id.clone(),
        name,
        properties,
        defaults,
    })
}

fn decode_tag_refs(
    node: &LoroMap,
    owner: &str,
    live_tags: &BTreeSet<TagId>,
    quarantined: &mut Vec<String>,
) -> Vec<TagId> {
    let Some(refs) = node.get("tag_refs").and_then(value_into_map) else {
        quarantined.push(format!("{owner}:tag-refs:missing-or-invalid"));
        return Vec::new();
    };
    let mut tags = Vec::new();
    refs.for_each(|raw_id, value| {
        let valid = matches!(value, ValueOrContainer::Value(LoroValue::Bool(true)));
        match (TagId::new(raw_id), valid) {
            (Ok(tag_id), true) if live_tags.contains(&tag_id) => tags.push(tag_id),
            (Ok(_), true) => quarantined.push(format!("{owner}:tag-ref:{raw_id}:dangling")),
            _ => quarantined.push(format!("{owner}:tag-ref:{raw_id}:invalid")),
        }
    });
    tags.sort();
    tags
}

fn block_snapshot(
    outline: &LoroTree,
    node: TreeID,
    live_tags: &BTreeSet<TagId>,
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
    let tags = decode_tag_refs(&meta, &format!("block:{node}"), live_tags, quarantined);
    let mut children = Vec::new();
    for child in outline.children(node).unwrap_or_default() {
        children.push(block_snapshot(outline, child, live_tags, quarantined)?);
    }
    Ok(BlockSnapshot {
        id: block_id(node),
        markdown,
        properties,
        tags,
        children,
    })
}

fn node_has_tag(node: &LoroMap, tag_id: &TagId) -> bool {
    node.get("tag_refs")
        .and_then(value_into_map)
        .and_then(|refs| refs.get(tag_id.as_str()))
        .is_some_and(|value| matches!(value, ValueOrContainer::Value(LoroValue::Bool(true))))
}

fn collect_tagged_blocks(
    outline: &LoroTree,
    node: TreeID,
    tag_id: &TagId,
    blocks: &mut Vec<BlockId>,
) -> Result<(), CoreError> {
    if node_has_tag(&outline.get_meta(node)?, tag_id) {
        blocks.push(block_id(node));
    }
    for child in outline.children(node).unwrap_or_default() {
        collect_tagged_blocks(outline, child, tag_id, blocks)?;
    }
    Ok(())
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

fn map_bool(map: &LoroMap, key: &str) -> Option<bool> {
    match map.get(key) {
        Some(ValueOrContainer::Value(LoroValue::Bool(value))) => Some(value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{CommandId, LocalDate, QueryViewSort};

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

    fn property_string<'a>(bag: &'a [PropertyField], raw_key: &str) -> Option<&'a str> {
        bag.iter().find_map(|field| {
            if field.key.as_str() != raw_key {
                return None;
            }
            match field.values.first()? {
                PropertyValue::String(value) => Some(value.as_str()),
                _ => None,
            }
        })
    }

    #[test]
    fn projection_changes_track_local_and_remote_page_edits() {
        let mut left = GraphCore::new(graph(), 1, "t0").unwrap();
        let created = left
            .execute(
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
        assert_eq!(created.changes.pages, BTreeSet::from([page()]));
        assert!(!created.changes.rebuild);

        let block = insert_root(&mut left, "block", &page(), 0, "before");
        let baseline = left.export_snapshot().unwrap();
        let mut right = GraphCore::from_snapshot(graph(), 2, &baseline).unwrap();
        let edited = left
            .execute(
                envelope(
                    "edit",
                    Command::EditMarkdown {
                        page_id: page(),
                        block_id: block,
                        markdown: "after".into(),
                    },
                ),
                "t2",
            )
            .unwrap();
        assert_eq!(edited.changes.pages, BTreeSet::from([page()]));
        assert!(edited.changes.tags.is_empty());
        assert!(!edited.changes.rebuild);

        let remote = right.import_remote_with_changes(&edited.update).unwrap();
        assert_eq!(remote, edited.changes);
        let delta = right.index_delta(&remote).unwrap().unwrap();
        assert_eq!(delta.pages.len(), 1);
        assert_eq!(delta.pages[0].blocks[0].markdown, "after");
    }

    #[test]
    fn streaming_index_units_match_a_complete_snapshot_build() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        insert_root(&mut core, "block", &page(), 0, "streamed");
        let frontier = core.frontier();
        let streamed = query::GraphIndex::from_units(
            core.graph_id().clone(),
            frontier.clone(),
            core.index_units().unwrap(),
        )
        .unwrap();
        let rebuilt = query::GraphIndex::new_at(&core.snapshot().unwrap(), frontier).unwrap();
        assert_eq!(streamed.semantic_triples(), rebuilt.semantic_triples());
        assert_eq!(streamed.triple_count(), rebuilt.triple_count());
    }

    #[test]
    fn projection_changes_track_tags_separately() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let tag_id = TagId::new("project").unwrap();
        let created = core
            .execute(
                envelope(
                    "tag",
                    Command::EnsureTag {
                        tag_id: tag_id.clone(),
                        name: "Project".into(),
                    },
                ),
                "t1",
            )
            .unwrap();
        assert_eq!(created.changes.tags, BTreeSet::from([tag_id.clone()]));
        assert!(created.changes.pages.is_empty());
        let delta = core.index_delta(&created.changes).unwrap().unwrap();
        assert_eq!(delta.tags[0].id, tag_id);

        ensure_regular_page(&mut core, "page", &page());
        let block_id = insert_root(&mut core, "block", &page(), 0, "tagged");
        let tagged = core
            .execute(
                envelope(
                    "add-tag",
                    Command::AddTag {
                        entity: EntityId::Block {
                            page_id: page(),
                            id: block_id,
                        },
                        tag_id: tag_id.clone(),
                    },
                ),
                "t2",
            )
            .unwrap();
        assert_eq!(tagged.changes.pages, BTreeSet::from([page()]));
        assert!(tagged.changes.tags.is_empty());

        let deleted = core
            .execute(
                envelope(
                    "delete-tag",
                    Command::DeleteTag {
                        tag_id: tag_id.clone(),
                    },
                ),
                "t3",
            )
            .unwrap();
        assert_eq!(deleted.changes.pages, BTreeSet::from([page()]));
        assert_eq!(deleted.changes.tags, BTreeSet::from([tag_id.clone()]));
        let delta = core.index_delta(&deleted.changes).unwrap().unwrap();
        assert_eq!(delta.pages.len(), 1);
        assert_eq!(delta.removed_tags, [tag_id]);
    }

    #[test]
    fn model_rejects_generic_writes_to_core_managed_properties() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let before = core.snapshot().unwrap();

        for (index, raw_key) in [
            "builtin.page-kind",
            "builtin.journal-date",
            "builtin.deleted-at",
        ]
        .into_iter()
        .enumerate()
        {
            let value = if raw_key == "builtin.journal-date" {
                PropertyValue::Date(LocalDate::new("2026-08-08").unwrap())
            } else {
                PropertyValue::String("user-value".into())
            };
            let error = core
                .execute(
                    envelope(
                        &format!("forbidden-{index}"),
                        Command::SetProperty {
                            owner: PropertyOwner::Page { id: page() },
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
    fn query_documents_use_semantic_commands_and_round_trip_structured_views() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "query");
        let source = "SELECT ?item WHERE {}";
        let owner = PropertyOwner::Block {
            page_id: page(),
            id: block.clone(),
        };

        core.execute(
            envelope(
                "query",
                Command::SetQuerySource {
                    owner: owner.clone(),
                    source: source.into(),
                },
            ),
            "t3",
        )
        .unwrap();
        core.execute(
            envelope(
                "query-splice",
                Command::SpliceQuerySource {
                    owner: owner.clone(),
                    index: source.chars().count(),
                    delete: 0,
                    insert: " LIMIT 10".into(),
                },
            ),
            "t4",
        )
        .unwrap();
        core.execute(
            envelope(
                "query-view",
                Command::SetQueryDefaultView {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("list").unwrap(),
                },
            ),
            "t5",
        )
        .unwrap();

        let snapshot = core.page_snapshot(&page()).unwrap();
        let field = snapshot.blocks[0]
            .properties
            .iter()
            .find(|field| field.key.as_str() == QUERY_PROPERTY_KEY)
            .unwrap();
        let PropertyValue::Document(document) = &field.values[0] else {
            panic!("query property did not decode as a document")
        };
        assert_eq!(document.source, "SELECT ?item WHERE {} LIMIT 10");
        assert_eq!(document.default_view_id.as_str(), "list");
        assert_eq!(document.views.len(), 2);

        let error = core
            .execute(
                envelope(
                    "oversized-query-splice",
                    Command::SpliceQuerySource {
                        owner: owner.clone(),
                        index: document.source.chars().count(),
                        delete: 0,
                        insert: "😀".repeat(20_000),
                    },
                ),
                "t6",
            )
            .unwrap_err();
        assert!(matches!(error, CoreError::TextTooLong));

        let error = core
            .execute(
                envelope(
                    "generic-query-write",
                    Command::SetProperty {
                        owner,
                        key: key(QUERY_PROPERTY_KEY),
                        value: PropertyValue::Document(document.clone()),
                    },
                ),
                "t7",
            )
            .unwrap_err();
        assert!(matches!(
            error,
            CoreError::Property(PropertyError::DocumentCommandRequired(_))
        ));
    }

    #[test]
    fn query_plan_travels_with_its_compiled_source_and_detaches_on_a_hand_edit() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "query");
        let owner = PropertyOwner::Block {
            page_id: page(),
            id: block.clone(),
        };
        let read = |core: &GraphCore| {
            let snapshot = core.page_snapshot(&page()).unwrap();
            let field = snapshot.blocks[0]
                .properties
                .iter()
                .find(|field| field.key.as_str() == QUERY_PROPERTY_KEY)
                .cloned()
                .unwrap();
            let PropertyValue::Document(document) = field.values[0].clone() else {
                panic!("query property did not decode as a document")
            };
            document
        };

        core.execute(
            envelope(
                "plan",
                Command::SetQueryPlan {
                    owner: owner.clone(),
                    plan: QueryPlan {
                        version: 1,
                        payload: "{\"subject\":\"block\"}".into(),
                    },
                    source: "SELECT ?item WHERE {}".into(),
                },
            ),
            "t3",
        )
        .unwrap();
        let document = read(&core);
        assert_eq!(document.source, "SELECT ?item WHERE {}");
        assert_eq!(document.plan.as_ref().map(|plan| plan.version), Some(1));

        // Editing the SPARQL by hand makes the source authoritative again.
        core.execute(
            envelope(
                "hand-edit",
                Command::SpliceQuerySource {
                    owner: owner.clone(),
                    index: 0,
                    delete: 0,
                    insert: "# note\n".into(),
                },
            ),
            "t4",
        )
        .unwrap();
        assert!(read(&core).plan.is_none());

        core.execute(
            envelope(
                "replan",
                Command::SetQueryPlan {
                    owner: owner.clone(),
                    plan: QueryPlan {
                        version: 1,
                        payload: "{\"subject\":\"page\"}".into(),
                    },
                    source: "SELECT ?page WHERE {}".into(),
                },
            ),
            "t5",
        )
        .unwrap();
        assert!(read(&core).plan.is_some());
        core.execute(
            envelope(
                "clear-plan",
                Command::ClearQueryPlan {
                    owner: owner.clone(),
                },
            ),
            "t6",
        )
        .unwrap();
        let detached = read(&core);
        assert!(detached.plan.is_none());
        assert_eq!(detached.source, "SELECT ?page WHERE {}");

        let error = core
            .execute(
                envelope(
                    "invalid-plan",
                    Command::SetQueryPlan {
                        owner,
                        plan: QueryPlan {
                            version: 1,
                            payload: "not json".into(),
                        },
                        source: String::new(),
                    },
                ),
                "t7",
            )
            .unwrap_err();
        assert!(matches!(
            error,
            CoreError::Property(PropertyError::InvalidDocument(_))
        ));
    }

    #[test]
    fn query_view_columns_round_trip_through_loro() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "query");
        let owner = PropertyOwner::Block {
            page_id: page(),
            id: block,
        };
        core.execute(
            envelope(
                "source",
                Command::SetQuerySource {
                    owner: owner.clone(),
                    source: "SELECT ?item WHERE {}".into(),
                },
            ),
            "t1",
        )
        .unwrap();
        core.execute(
            envelope(
                "view",
                Command::PutQueryView {
                    owner: owner.clone(),
                    view: QueryView {
                        id: QueryViewId::new("table").unwrap(),
                        name: "Table".into(),
                        kind: QueryViewKind::Table,
                        position: 0,
                        columns: vec![
                            QueryViewColumn {
                                variable: "item".into(),
                                hidden: false,
                                width: Some(240),
                            },
                            QueryViewColumn {
                                variable: "status".into(),
                                hidden: true,
                                width: None,
                            },
                        ],
                        options: QueryViewOptions {
                            compact: true,
                            wrap: false,
                            sort: vec![
                                QueryViewSort {
                                    variable: "status".into(),
                                    descending: true,
                                },
                                QueryViewSort {
                                    variable: "item".into(),
                                    descending: false,
                                },
                            ],
                        },
                    },
                },
            ),
            "t2",
        )
        .unwrap();

        let snapshot = core.page_snapshot(&page()).unwrap();
        let PropertyValue::Document(document) = snapshot.blocks[0]
            .properties
            .iter()
            .find(|field| field.key.as_str() == QUERY_PROPERTY_KEY)
            .map(|field| field.values[0].clone())
            .unwrap()
        else {
            panic!("query property did not decode as a document")
        };
        let table = document
            .views
            .iter()
            .find(|view| view.id.as_str() == "table")
            .unwrap();
        assert_eq!(table.columns.len(), 2);
        assert_eq!(table.columns[0].width, Some(240));
        assert!(table.columns[1].hidden);
        assert!(table.options.compact);
        // Every term survives, in order: the precedence is the list's own.
        assert_eq!(table.options.sort.len(), 2);
        assert_eq!(table.options.sort[0].variable, "status");
        assert!(table.options.sort[0].descending);
        assert_eq!(table.options.sort[1].variable, "item");
        assert!(!table.options.sort[1].descending);
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
            ("builtin.task-status", PropertyValue::String("todo".into())),
            ("user.number", PropertyValue::Number(1.25)),
            ("user.text", PropertyValue::String("value".into())),
            ("user.flag", PropertyValue::Checkbox(true)),
            (
                "user.date",
                PropertyValue::Date(LocalDate::new("2026-08-03").unwrap()),
            ),
            ("user.page", PropertyValue::Page(page())),
        ];
        for (index, (raw_key, value)) in defaults.into_iter().enumerate() {
            core.execute(
                envelope(
                    &format!("d{index}"),
                    Command::SetProperty {
                        owner: PropertyOwner::TagDefault {
                            tag_id: tag.clone(),
                        },
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
                    owner: PropertyOwner::Block {
                        page_id: page(),
                        id: block.clone(),
                    },
                    key: key("builtin.task-status"),
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
                Command::SetProperty {
                    owner: PropertyOwner::TagDefault { tag_id: tag },
                    key: key("user.number"),
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
                        owner: PropertyOwner::Block {
                            page_id: page(),
                            id: block.clone(),
                        },
                        key: key("user.labels"),
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
                    owner: PropertyOwner::Block {
                        page_id: page(),
                        id: block,
                    },
                    key: key("user.labels"),
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
                .any(|entry| entry.key.as_str() == "user.number")
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry.key.as_str() == "builtin.task-status"
                    && entry.values == [PropertyValue::String("doing".into())])
        );
        assert_eq!(
            snapshot.pages[0].blocks[0].tags,
            [TagId::new("project").unwrap()]
        );
        assert!(entries.iter().any(|entry| {
            entry.key.as_str() == "user.number" && entry.values == [PropertyValue::Number(1.25)]
        }));
        let labels = entries
            .iter()
            .find(|entry| entry.key.as_str() == "user.labels")
            .unwrap();
        assert_eq!(labels.values, vec![PropertyValue::String("two".into())]);
    }

    #[test]
    fn empty_tag_defaults_materialize_as_empty_fields() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "work");
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
        core.execute(
            envelope(
                "empty-default",
                Command::EnsureProperty {
                    owner: PropertyOwner::TagDefault {
                        tag_id: tag.clone(),
                    },
                    key: key("builtin.task-priority"),
                    value_type: PropertyType::String,
                    cardinality: Cardinality::Single,
                },
            ),
            "t3",
        )
        .unwrap();
        core.execute(
            envelope(
                "apply-tag",
                Command::AddTag {
                    entity: EntityId::Block {
                        page_id: page(),
                        id: block.clone(),
                    },
                    tag_id: tag,
                },
            ),
            "t4",
        )
        .unwrap();

        let snapshot = core.snapshot().unwrap();
        let default = snapshot.tags[0]
            .defaults
            .iter()
            .find(|field| field.key.as_str() == "builtin.task-priority")
            .unwrap();
        assert!(default.values.is_empty());
        let inherited = snapshot.pages[0].blocks[0]
            .properties
            .iter()
            .find(|field| field.key.as_str() == "builtin.task-priority")
            .unwrap();
        assert!(inherited.values.is_empty());

        core.execute(envelope("undo-tag", Command::Undo), "t5")
            .unwrap();
        let snapshot = core.snapshot().unwrap();
        assert!(
            snapshot.pages[0].blocks[0]
                .properties
                .iter()
                .all(|field| field.key.as_str() != "builtin.task-priority")
        );
    }

    #[test]
    fn clearing_values_preserves_a_field_while_removing_drops_it() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "work");
        let owner = PropertyOwner::Block {
            page_id: page(),
            id: block,
        };
        let key = key("builtin.task-status");
        core.execute(
            envelope(
                "set",
                Command::SetProperty {
                    owner: owner.clone(),
                    key: key.clone(),
                    value: PropertyValue::String("todo".into()),
                },
            ),
            "t2",
        )
        .unwrap();
        core.execute(
            envelope(
                "clear",
                Command::ClearPropertyValues {
                    owner: owner.clone(),
                    key: key.clone(),
                },
            ),
            "t3",
        )
        .unwrap();
        let snapshot = core.snapshot().unwrap();
        let field = snapshot.pages[0].blocks[0]
            .properties
            .iter()
            .find(|field| field.key == key)
            .unwrap();
        assert!(field.values.is_empty());

        core.execute(
            envelope(
                "remove",
                Command::RemoveProperty {
                    owner,
                    key: key.clone(),
                },
            ),
            "t4",
        )
        .unwrap();
        let snapshot = core.snapshot().unwrap();
        assert!(
            snapshot.pages[0].blocks[0]
                .properties
                .iter()
                .all(|field| field.key != key)
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
                    owner: PropertyOwner::Block {
                        page_id: page(),
                        id: target.clone(),
                    },
                    key: key("builtin.task-status"),
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
            entry.key.as_str() == "builtin.task-status"
                && entry.values == [PropertyValue::String("doing".into())]
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
            entry.key.as_str() == "builtin.updated-at"
                && entry.values == [PropertyValue::String("t3".into())]
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
                entry.key.as_str() == "builtin.updated-at"
                    && entry.values == [PropertyValue::String("t4".into())]
            }));
        }
    }

    #[test]
    fn model_delete_tag_detaches_every_node_and_undo_restores_membership() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let live_page = page();
        let deleted_page = PageId::new("deleted-page").unwrap();
        ensure_regular_page(&mut core, "live-page", &live_page);
        ensure_regular_page(&mut core, "deleted-page", &deleted_page);
        let live_block = insert_root(&mut core, "live-block", &live_page, 0, "live");
        let nested_block = core
            .execute(
                envelope(
                    "nested-block",
                    Command::InsertBlock {
                        page_id: live_page.clone(),
                        parent: Some(live_block.clone()),
                        index: 0,
                        markdown: "nested".into(),
                    },
                ),
                "t2",
            )
            .unwrap()
            .result
            .created_block
            .unwrap();
        let deleted_block = insert_root(&mut core, "deleted-block", &deleted_page, 0, "hidden");
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
        core.execute(
            envelope(
                "default",
                Command::SetProperty {
                    owner: PropertyOwner::TagDefault {
                        tag_id: tag.clone(),
                    },
                    key: key("builtin.task-status"),
                    value: PropertyValue::String("todo".into()),
                },
            ),
            "t4",
        )
        .unwrap();
        for (command_id, entity) in [
            (
                "tag-page",
                EntityId::Page {
                    id: live_page.clone(),
                },
            ),
            (
                "tag-live-block",
                EntityId::Block {
                    page_id: live_page.clone(),
                    id: live_block.clone(),
                },
            ),
            (
                "tag-deleted-block",
                EntityId::Block {
                    page_id: deleted_page.clone(),
                    id: deleted_block.clone(),
                },
            ),
            (
                "tag-nested-block",
                EntityId::Block {
                    page_id: live_page.clone(),
                    id: nested_block.clone(),
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
                "t5",
            )
            .unwrap();
        }
        core.execute(
            envelope(
                "hide-page",
                Command::DeletePage {
                    page_id: deleted_page.clone(),
                },
            ),
            "t6",
        )
        .unwrap();

        core.execute(
            envelope(
                "delete-tag",
                Command::DeleteTag {
                    tag_id: tag.clone(),
                },
            ),
            "t7",
        )
        .unwrap();

        let snapshot = core.snapshot().unwrap();
        assert!(snapshot.tags.is_empty());
        assert!(snapshot.pages[0].tags.is_empty());
        assert!(snapshot.pages[0].blocks[0].tags.is_empty());
        assert!(snapshot.pages[0].blocks[0].children[0].tags.is_empty());
        assert!(snapshot.pages[0].blocks[0].properties.iter().any(|entry| {
            entry.key.as_str() == "builtin.task-status"
                && entry.values == [PropertyValue::String("todo".into())]
        }));
        assert!(!node_has_tag(&core.page_root(&live_page).unwrap(), &tag));
        assert!(!node_has_tag(
            &core
                .page_outline(&deleted_page)
                .unwrap()
                .get_meta(tree_id(&deleted_block).unwrap())
                .unwrap(),
            &tag,
        ));

        let undo = core
            .execute(envelope("undo-delete-tag", Command::Undo), "t8")
            .unwrap();
        let effect = undo.result.history_effect.unwrap();
        assert_eq!(effect.scope, HistoryScope::Graph);
        assert_eq!(
            effect.affected_pages,
            [deleted_page.clone(), live_page.clone()]
        );
        assert_eq!(effect.reveal, None);
        let snapshot = core.snapshot().unwrap();
        assert_eq!(snapshot.tags[0].id, tag);
        assert_eq!(
            snapshot.pages[0].tags.as_slice(),
            std::slice::from_ref(&tag)
        );
        assert_eq!(
            snapshot.pages[0].blocks[0].tags.as_slice(),
            std::slice::from_ref(&tag)
        );
        assert_eq!(
            snapshot.pages[0].blocks[0].children[0].tags.as_slice(),
            std::slice::from_ref(&tag)
        );
        assert!(node_has_tag(
            &core
                .page_outline(&deleted_page)
                .unwrap()
                .get_meta(tree_id(&deleted_block).unwrap())
                .unwrap(),
            &tag,
        ));

        core.execute(envelope("redo-delete-tag", Command::Redo), "t9")
            .unwrap();
        core.execute(
            envelope(
                "restore-tag",
                Command::RestoreTag {
                    tag_id: tag.clone(),
                },
            ),
            "t10",
        )
        .unwrap();
        let snapshot = core.snapshot().unwrap();
        assert_eq!(snapshot.tags[0].id, tag);
        assert!(snapshot.pages[0].tags.is_empty());
        assert!(snapshot.pages[0].blocks[0].tags.is_empty());
        assert!(snapshot.pages[0].blocks[0].children[0].tags.is_empty());
        assert!(!node_has_tag(
            &core
                .page_outline(&deleted_page)
                .unwrap()
                .get_meta(tree_id(&deleted_block).unwrap())
                .unwrap(),
            &tag,
        ));
    }

    #[test]
    fn model_history_effect_tracks_cross_page_targets_and_delete_fallbacks() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let first_page = PageId::new("first").unwrap();
        let second_page = PageId::new("second").unwrap();
        ensure_regular_page(&mut core, "first-page", &first_page);
        ensure_regular_page(&mut core, "second-page", &second_page);
        let previous = insert_root(&mut core, "previous", &first_page, 0, "previous");
        let deleted = insert_root(&mut core, "deleted", &first_page, 1, "deleted");
        let second = insert_root(&mut core, "second-block", &second_page, 0, "second");

        core.execute(
            envelope(
                "edit-second",
                Command::EditMarkdown {
                    page_id: second_page.clone(),
                    block_id: second.clone(),
                    markdown: "changed".into(),
                },
            ),
            "t3",
        )
        .unwrap();
        let undo = core
            .execute(envelope("undo-edit", Command::Undo), "t4")
            .unwrap();
        assert_eq!(
            undo.result.history_effect.unwrap().reveal,
            Some(EntityId::Block {
                page_id: second_page.clone(),
                id: second,
            })
        );

        core.execute(
            envelope(
                "delete-block",
                Command::DeleteBlocks {
                    page_id: first_page.clone(),
                    block_ids: vec![deleted.clone()],
                },
            ),
            "t5",
        )
        .unwrap();
        let undo = core
            .execute(envelope("undo-delete", Command::Undo), "t6")
            .unwrap();
        let restored = core.page_snapshot(&first_page).unwrap().blocks[1].clone();
        assert_eq!(restored.markdown, "deleted");
        assert_eq!(
            undo.result.history_effect.unwrap().reveal,
            Some(EntityId::Block {
                page_id: first_page.clone(),
                id: restored.id,
            })
        );
        let redo = core
            .execute(envelope("redo-delete", Command::Redo), "t7")
            .unwrap();
        assert_eq!(
            redo.result.history_effect.unwrap().reveal,
            Some(EntityId::Block {
                page_id: first_page.clone(),
                id: previous,
            })
        );

        insert_root(&mut core, "insert-for-redo", &first_page, 1, "created");
        core.execute(envelope("undo-insert", Command::Undo), "t8")
            .unwrap();
        let redo = core
            .execute(envelope("redo-insert", Command::Redo), "t9")
            .unwrap();
        let recreated = core.page_snapshot(&first_page).unwrap().blocks[1].clone();
        assert_eq!(recreated.markdown, "created");
        assert_eq!(
            redo.result.history_effect.unwrap().reveal,
            Some(EntityId::Block {
                page_id: first_page,
                id: recreated.id,
            })
        );
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
            property_string(&snapshot.pages[0].properties, "builtin.created-at"),
            Some("t1")
        );
        assert_eq!(
            property_string(&snapshot.pages[0].properties, "builtin.updated-at"),
            Some("t2")
        );
        assert_eq!(
            property_string(
                &snapshot.pages[0].blocks[0].properties,
                "builtin.created-at"
            ),
            Some("t2")
        );
        assert_eq!(
            property_string(
                &snapshot.pages[0].blocks[0].properties,
                "builtin.updated-at"
            ),
            Some("t2")
        );
        assert_eq!(snapshot.pages[0].blocks[0].id, block);
        assert_eq!(
            property_string(&snapshot.tags[0].properties, "builtin.created-at"),
            Some("t3")
        );
        assert_eq!(
            property_string(&snapshot.tags[0].properties, "builtin.updated-at"),
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
            property_string(&snapshot.tags[0].properties, "builtin.created-at"),
            Some("t3")
        );
        assert_eq!(
            property_string(&snapshot.tags[0].properties, "builtin.updated-at"),
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
            property_string(&deleted_tag, "builtin.created-at"),
            Some("t3")
        );
        assert_eq!(
            property_string(&deleted_tag, "builtin.updated-at"),
            Some("t5")
        );
        assert_eq!(
            property_string(&deleted_tag, "builtin.deleted-at"),
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
            property_string(restored_tag, "builtin.created-at"),
            Some("t3")
        );
        assert_eq!(
            property_string(restored_tag, "builtin.updated-at"),
            Some("t6")
        );
        assert_eq!(property_string(restored_tag, "builtin.deleted-at"), None);

        core.execute(
            envelope("delete-page", Command::DeletePage { page_id: page() }),
            "t7",
        )
        .unwrap();
        let deleted_page = decode_bag(&core.page_properties(&page()).unwrap()).0;
        assert_eq!(
            property_string(&deleted_page, "builtin.created-at"),
            Some("t1")
        );
        assert_eq!(
            property_string(&deleted_page, "builtin.updated-at"),
            Some("t7")
        );
        assert_eq!(
            property_string(&deleted_page, "builtin.deleted-at"),
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
            property_string(restored_page, "builtin.created-at"),
            Some("t1")
        );
        assert_eq!(
            property_string(restored_page, "builtin.updated-at"),
            Some("t8")
        );
        assert_eq!(property_string(restored_page, "builtin.deleted-at"), None);
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
        let corrupt_bag = core.block_bag(&page(), &child).unwrap();
        ensure_property_field(
            &corrupt_bag,
            &key("builtin.page-kind"),
            PropertyType::String,
            Cardinality::Single,
        )
        .unwrap();
        corrupt_bag
            .insert(
                &single_slot(&key("builtin.page-kind")),
                encode_value(&PropertyValue::Page(page())).unwrap(),
            )
            .unwrap();
        core.doc.commit();

        let snapshot = core.snapshot().unwrap();
        assert_eq!(snapshot.pages.len(), 1);
        assert!(
            snapshot.pages[0].blocks[0].children[0]
                .properties
                .iter()
                .all(|entry| entry.key.as_str() != "builtin.page-kind")
        );
        assert!(!snapshot.quarantined.is_empty());
    }
}
