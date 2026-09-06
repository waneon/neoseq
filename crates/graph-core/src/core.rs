mod outline;
mod transition;

use self::transition::{CreationSlot, NormalizedTransition};
use crate::{
    SemanticEvent,
    document::{
        GRAPH_SETTINGS_SCHEMA_VERSION, MAX_DEFAULT_QUERY_TITLE, MAX_ENTITY_NAME_BYTES,
        PAGE_REFERENCE_CHAR, PAGE_REFERENCE_MARK, PROPERTY_DOCUMENT_KEY, PROPERTY_SET_KEY,
        PROPERTY_SHAPE_KEY, PROPERTY_SINGLE_KEY, QUERY_PLAN_STATE_KEY, QUERY_PLAN_STATE_VERSION,
        StoredPlanState, StoredPropertyShape, decode_query_plan_state, validate_causal_document,
    },
};
use domain::{
    BlockContentUpdate, BlockId, BlockSnapshot, Cardinality, Command, CommandEnvelope, CommandId,
    CommandResult, ContentRangeChange, DefaultQueryId, DefaultQuerySnapshot, EntityId,
    GraphChanges, GraphConflict, GraphId, GraphSettings, GraphSnapshot, GraphSummary,
    HistoryEffect, HistoryScope, InlineContent, MAX_QUERY_SOURCE_BYTES, MAX_QUERY_VIEWS,
    OUTLINE_FRAGMENT_KIND, OUTLINE_FRAGMENT_VERSION, OutlineFragment, OutlineFragmentItem,
    OutlineFragmentPage, OutlineItem, OutlineOwner, OutlineSnapshot, PageDirectoryEntry, PageId,
    PageReferenceSpan, PageSnapshot, PageSummary, PropertyBag, PropertyCopyPolicy,
    PropertyDocument, PropertyDocumentHeader, PropertyError, PropertyField, PropertyKey,
    PropertyOwner, PropertyTarget, PropertyType, PropertyValue, QUERY_DOCUMENT_SCHEMA,
    QUERY_DOCUMENT_VERSION, QUERY_PROPERTY_KEY, QueryDefinition, QueryOwner, QueryPlan, QueryView,
    QueryViewColumn, QueryViewId, QueryViewKind, QueryViewOptions, TagId, TagSnapshot, TagSummary,
    TextTarget, property_copy_policy, validate_property, validate_property_field,
    validate_property_shape, validate_property_target, validate_property_write,
};
use loro::{
    Container, ContainerID, ContainerTrait, ExpandType, ExportMode, Index, LoroDoc,
    LoroEncodeError, LoroError, LoroMap, LoroText, LoroTree, LoroValue, StyleConfig,
    StyleConfigMap, Subscription, TextDelta, TreeID, TreeParentId, UndoManager, ValueOrContainer,
    VersionVector, event::Diff,
};
use query::{IndexChange, IndexDelta, IndexUnit, IndexUnitId, derive_plan_source};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex},
};
use thiserror::Error;

pub use domain::SCHEMA_VERSION;

const MAX_DEFAULT_QUERIES: usize = 8;
const MAX_BLOCK_TEXT_BYTES: usize = 1_048_576;
const MAX_OUTLINE_FRAGMENT_BYTES: usize = 4 * MAX_BLOCK_TEXT_BYTES;

/// Encoded causal baseline for a replica that has no operations yet.
pub fn empty_version_vector() -> Vec<u8> {
    VersionVector::default().encode()
}
const IDEMPOTENCY_CAPACITY: usize = 1024;
const MAX_STRUCTURAL_TARGETS: usize = 10_000;
const MAX_PROPERTY_CHANGES: usize = 64;
const MAX_BATCH_COMMANDS: usize = 64;

#[derive(Debug)]
enum PreparedCommandKind {
    Transition(Box<NormalizedTransition>),
    Batch { commands: Vec<Command> },
}

#[derive(Debug)]
struct PreparedBatch {
    affected_outlines: Vec<OutlineOwner>,
}

#[derive(Debug)]
struct PreparedCommand {
    kind: PreparedCommandKind,
    history: HistoryPlan,
}

impl PreparedCommand {
    fn semantic(&self) -> SemanticEvent {
        match &self.kind {
            PreparedCommandKind::Transition(transition) => transition.semantic(),
            PreparedCommandKind::Batch { .. } => SemanticEvent::CommandBatchApplied,
        }
    }
}

#[derive(Debug, Clone)]
struct HistoryEntry {
    scope: HistoryScope,
    affected_outlines: Vec<OutlineOwner>,
    undo_candidates: Vec<HistoryTarget>,
    redo_candidates: Vec<HistoryTarget>,
}

#[derive(Debug, Clone)]
enum HistoryTarget {
    Entity(EntityId),
    BlockPosition {
        owner: OutlineOwner,
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

#[derive(Debug)]
struct FragmentResolution {
    tags: BTreeMap<TagId, TagId>,
    pages: BTreeMap<PageId, PageId>,
    new_tags: Vec<(TagId, String)>,
    new_pages: Vec<(PageId, OutlineFragmentPage)>,
}

trait InsertableOutlineItem {
    fn depth(&self) -> usize;
    fn markdown(&self) -> &str;
}

impl InsertableOutlineItem for OutlineItem {
    fn depth(&self) -> usize {
        self.depth
    }

    fn markdown(&self) -> &str {
        &self.markdown
    }
}

impl InsertableOutlineItem for OutlineFragmentItem {
    fn depth(&self) -> usize {
        self.depth
    }

    fn markdown(&self) -> &str {
        &self.markdown
    }
}

struct OutlineInsertion<'a, T> {
    owner: &'a OutlineOwner,
    parent: Option<&'a BlockId>,
    index: usize,
    replace: Option<&'a BlockId>,
    items: &'a [T],
}

#[derive(Debug, Clone, Copy)]
enum HistoryDirection {
    Undo,
    Redo,
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
    #[error("invalid command batch: {0}")]
    InvalidBatch(String),
    #[error("page name already exists: {name} (page {existing})")]
    PageNameConflict { name: String, existing: PageId },
    #[error("tag name already exists: {name} (tag {existing})")]
    TagNameConflict { name: String, existing: TagId },
    #[error("{entity} name must not be empty")]
    EmptyName { entity: &'static str },
    #[error("block does not exist or is deleted: {0}")]
    BlockNotFound(BlockId),
    #[error("first sibling cannot be indented")]
    FirstSiblingIndent,
    #[error("root block cannot be outdented")]
    RootBlockOutdent,
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
    #[error("clone target graph id must differ from its source")]
    CloneTargetMatchesSource,
    #[error("unsupported schema version {0}")]
    UnsupportedSchema(i64),
    #[error("invalid schema metadata: {0}")]
    InvalidSchemaMetadata(&'static str),
    #[error("local history metadata is not aligned with the undo manager")]
    HistoryMetadataMismatch,
    #[error("Loro update is missing causal dependencies")]
    MissingDependencies,
}

#[derive(Debug, Clone)]
pub struct CoreExecution {
    pub result: CommandResult,
    pub update: Vec<u8>,
    pub semantic: SemanticEvent,
    pub changes: GraphChangeSet,
    content_only: bool,
    content_mappings: ContentMappings,
}

/// Mutation-local bookkeeping used while applying a prepared command.
///
/// `changed` controls internal follow-up work such as timestamps and batch
/// aggregation. It is deliberately not part of `CommandResult`: exported
/// update bytes are the sole authority at the core boundary.
#[derive(Debug, Default)]
struct MutationOutcome {
    created_page: Option<PageId>,
    created_block: Option<BlockId>,
    created_tag: Option<TagId>,
    changed: bool,
}

impl MutationOutcome {
    fn merge(&mut self, nested: Self) {
        self.created_page = self.created_page.take().or(nested.created_page);
        self.created_block = self.created_block.take().or(nested.created_block);
        self.created_tag = self.created_tag.take().or(nested.created_tag);
        self.changed |= nested.changed;
    }

    fn into_result(
        self,
        command_id: CommandId,
        history_effect: Option<HistoryEffect>,
    ) -> CommandResult {
        CommandResult {
            command_id,
            created_page: self.created_page,
            created_block: self.created_block,
            created_tag: self.created_tag,
            history_effect,
        }
    }
}

/// Projection publication units affected by one local command or remote
/// import. An unclassifiable relevant diff requests a safe full rebuild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphChangeSet {
    Incremental {
        pages: BTreeSet<PageId>,
        tags: BTreeSet<TagId>,
    },
    Rebuild,
}

impl Default for GraphChangeSet {
    fn default() -> Self {
        Self::Incremental {
            pages: BTreeSet::new(),
            tags: BTreeSet::new(),
        }
    }
}

impl GraphChangeSet {
    pub fn is_rebuild(&self) -> bool {
        matches!(self, Self::Rebuild)
    }

    pub fn pages(&self) -> Option<&BTreeSet<PageId>> {
        match self {
            Self::Incremental { pages, .. } => Some(pages),
            Self::Rebuild => None,
        }
    }

    pub fn tags(&self) -> Option<&BTreeSet<TagId>> {
        match self {
            Self::Incremental { tags, .. } => Some(tags),
            Self::Rebuild => None,
        }
    }

    fn require_rebuild(&mut self) {
        *self = Self::Rebuild;
    }

    fn include_page(&mut self, page: PageId) {
        if let Self::Incremental { pages, .. } = self {
            pages.insert(page);
        }
    }

    fn include_tag(&mut self, tag: TagId) {
        if let Self::Incremental { tags, .. } = self {
            tags.insert(tag);
        }
    }
}

type ContentMappings = BTreeMap<(OutlineOwner, BlockId), Vec<ContentRangeChange>>;

#[derive(Debug, Clone)]
struct CapturedChange {
    target: ContainerID,
    path: Vec<(ContainerID, Index)>,
    map_keys: Vec<String>,
    text: Option<Vec<TextDelta>>,
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
    fn finish(mut self, outcome: &MutationOutcome, core: &GraphCore) -> HistoryEntry {
        if self.redo_created_block
            && let Some(block_id) = &outcome.created_block
            && let Some(owner) = self.entry.affected_outlines.first()
        {
            let target = core
                .outline_state(owner)
                .ok()
                .and_then(|state| {
                    let parent = state.parents.get(block_id)?.clone();
                    let index = state
                        .children
                        .get(&parent)?
                        .iter()
                        .position(|item| item == block_id)?;
                    Some(HistoryTarget::BlockPosition {
                        owner: owner.clone(),
                        parent,
                        index,
                    })
                })
                .unwrap_or_else(|| {
                    HistoryTarget::Entity(EntityId::Block {
                        owner: owner.clone(),
                        id: block_id.clone(),
                    })
                });
            self.entry.redo_candidates.insert(0, target);
        }
        if self.redo_created_page
            && let Some(page_id) = &outcome.created_page
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

impl ProjectionChangeTracker {
    fn new(doc: &LoroDoc) -> Self {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let callback_captured = Arc::clone(&captured);
        let subscription = doc.subscribe_root(Arc::new(move |event| {
            let mut batch = callback_captured
                .lock()
                .expect("projection change tracker mutex poisoned");
            for change in event.events {
                let map_keys = match &change.diff {
                    Diff::Map(delta) => delta.updated.keys().map(|key| key.to_string()).collect(),
                    _ => Vec::new(),
                };
                batch.push(CapturedChange {
                    target: change.target.clone(),
                    path: change.path.to_vec(),
                    map_keys,
                    text: match change.diff {
                        Diff::Text(delta) => Some(delta.clone()),
                        _ => None,
                    },
                    unknown: change.is_unknown,
                });
            }
        }));
        Self {
            captured,
            subscription,
        }
    }

    fn content_mappings(&self, doc: &LoroDoc) -> ContentMappings {
        let captured = self
            .captured
            .lock()
            .expect("projection change tracker mutex poisoned");
        let pages = doc.get_map("pages");
        let tags = doc.get_map("tags");
        let mut mappings = ContentMappings::new();
        for change in captured.iter() {
            let Some(delta) = &change.text else { continue };
            if change.unknown
                || !matches!(change.path.last(), Some((_, Index::Key(key))) if key.as_ref() == "content")
            {
                continue;
            }
            let Some(block_id) = change.path.iter().find_map(|(_, index)| match index {
                Index::Node(id) => BlockId::new(id.to_string()).ok(),
                _ => None,
            }) else {
                continue;
            };
            let owner = change.path.iter().find_map(|(container, index)| {
                let Index::Key(key) = index else { return None };
                if pages
                    .get(key)
                    .and_then(value_into_map)
                    .is_some_and(|page| page.id() == *container)
                {
                    PageId::new(key.as_ref())
                        .ok()
                        .map(|id| OutlineOwner::Page { id })
                } else if tags
                    .get(key)
                    .and_then(value_into_map)
                    .is_some_and(|tag| tag.id() == *container)
                {
                    TagId::new(key.as_ref())
                        .ok()
                        .map(|id| OutlineOwner::Tag { id })
                } else {
                    None
                }
            });
            let Some(owner) = owner else { continue };
            let mapping = mappings.entry((owner, block_id)).or_default();
            // The Rust `loro` dependency does not enable loro-internal's `wasm`
            // feature: event positions are Unicode scalars on both platforms.
            let mut index = 0;
            for part in delta {
                match part {
                    TextDelta::Retain { retain, .. } => index += retain,
                    TextDelta::Insert { insert, .. } => {
                        let length = insert.chars().count();
                        mapping.push(ContentRangeChange {
                            index,
                            delete: 0,
                            insert: length,
                        });
                        index += length;
                    }
                    TextDelta::Delete { delete } => mapping.push(ContentRangeChange {
                        index,
                        delete: *delete,
                        insert: 0,
                    }),
                }
            }
        }
        mappings
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
        let created_pages = captured
            .iter()
            .filter(|change| change.target == pages_id)
            .flat_map(|change| &change.map_keys)
            .filter_map(|key| PageId::new(key).ok())
            .collect::<BTreeSet<_>>();

        for change in captured {
            let page_scope =
                change.target == pages_id || path_is_below_root(&change.path, &pages_id, "pages");
            let tag_scope =
                change.target == tags_id || path_is_below_root(&change.path, &tags_id, "tags");
            if !page_scope && !tag_scope {
                continue;
            }
            if change.unknown {
                result.require_rebuild();
                continue;
            }
            if page_scope
                && page_for_title_target(&pages, &change.target)
                    .is_some_and(|page_id| !created_pages.contains(&page_id))
            {
                // Every referring block materializes this title. The canonical
                // references do not change, but the disposable RDF/text index
                // must refresh those derived strings as one coherent view.
                result.require_rebuild();
            }

            let mut resolved = false;
            if change.target == pages_id {
                resolved = true;
                for key in &change.map_keys {
                    if let Ok(page_id) = PageId::new(key) {
                        result.include_page(page_id);
                    }
                }
            }
            if change.target == tags_id {
                resolved = true;
                for key in &change.map_keys {
                    if let Ok(tag_id) = TagId::new(key) {
                        result.include_tag(tag_id);
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
                        result.include_page(page_id);
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
                        result.include_tag(tag_id);
                    }
                    resolved = true;
                }
            }

            if !resolved {
                result.require_rebuild();
            }
        }
        result
    }
}

fn page_for_title_target(pages: &LoroMap, target: &ContainerID) -> Option<PageId> {
    let mut found = None;
    pages.for_each(|raw_id, value| {
        if found.is_some() {
            return;
        }
        let Some(page) = value_into_map(value) else {
            return;
        };
        let Some(root) = page.get("root").and_then(value_into_map) else {
            return;
        };
        if root
            .get("content")
            .and_then(|value| match value {
                ValueOrContainer::Container(Container::Text(text)) => Some(text.id() == *target),
                _ => None,
            })
            .unwrap_or(false)
        {
            found = PageId::new(raw_id).ok();
        }
    });
    found
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

pub(crate) fn configure_inline_content(doc: &LoroDoc) {
    let mut styles = StyleConfigMap::default_rich_text_config();
    styles.insert(
        PAGE_REFERENCE_MARK.into(),
        StyleConfig::new().expand(ExpandType::None),
    );
    doc.config_text_style(styles);
}

pub(crate) fn new_document(
    graph_id: &GraphId,
    peer_id: u64,
    now: &str,
) -> Result<LoroDoc, CoreError> {
    let doc = LoroDoc::new();
    configure_inline_content(&doc);
    doc.set_peer_id(peer_id)?;
    let meta = doc.get_map("meta");
    meta.insert("graph_id", graph_id.as_str())?;
    meta.insert("schema_version", i64::from(SCHEMA_VERSION))?;
    let settings = doc.get_map("graph_settings");
    settings.insert("schema_version", i64::from(GRAPH_SETTINGS_SCHEMA_VERSION))?;
    let _ = settings.ensure_mergeable_map("default_queries")?;
    let _ = doc.get_map("pages");
    let _ = doc.get_map("tags");
    doc.set_next_commit_origin("system:init");
    doc.set_next_commit_message(&format!("initialize graph at {now}"));
    doc.commit();
    Ok(doc)
}

impl GraphCore {
    pub fn new(graph_id: GraphId, peer_id: u64, now: &str) -> Result<Self, CoreError> {
        let doc = new_document(&graph_id, peer_id, now)?;
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
        let mut core = Self::from_recovery_snapshot(graph_id, peer_id, snapshot)?;
        core.finish_recovery()?;
        Ok(core)
    }

    /// Loads a persistence Base. Recovery adapters must
    /// replay the complete durable Tail with `import_recovery_update`, then
    /// call `finish_recovery` before exposing the graph to normal reads or
    /// writes.
    pub fn from_recovery_snapshot(
        graph_id: GraphId,
        peer_id: u64,
        snapshot: &[u8],
    ) -> Result<Self, CoreError> {
        let doc = LoroDoc::from_snapshot(snapshot)?;
        configure_inline_content(&doc);
        doc.set_peer_id(peer_id)?;
        verify_schema(&doc, &graph_id)?;
        validate_entity_names(&doc)?;
        enable_outlines(&doc)?;
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

    /// Replays a durable Tail while preserving current-schema invariants.
    pub fn import_recovery_update(&mut self, update: &[u8]) -> Result<(), CoreError> {
        let candidate = self.doc.fork();
        let status = candidate.import(update)?;
        if status.pending.is_some() {
            return Err(CoreError::MissingDependencies);
        }
        verify_schema(&candidate, &self.graph_id)?;
        validate_entity_names(&candidate)?;

        let status = self.doc.import(update)?;
        if status.pending.is_some() {
            return Err(CoreError::MissingDependencies);
        }
        Ok(())
    }

    /// Stages one checksummed Tail update for the recovery fast path.
    ///
    /// The persistence adapter owns the surrounding transaction: it builds a
    /// disposable core from the selected Base, stages the complete Tail, then
    /// calls `finish_recovery` once. If either import or final validation fails,
    /// the adapter discards this core and replays through
    /// `import_recovery_update` to identify the first invalid record.
    pub fn stage_recovery_update(&mut self, update: &[u8]) -> Result<(), CoreError> {
        let status = self.doc.import(update)?;
        if status.pending.is_some() {
            return Err(CoreError::MissingDependencies);
        }
        Ok(())
    }

    /// Validates Base+Tail and starts a fresh undo epoch.
    pub fn finish_recovery(&mut self) -> Result<(), CoreError> {
        let peer_id = self.doc.peer_id();
        let staged = self.doc.fork();
        configure_inline_content(&staged);
        staged.set_peer_id(peer_id)?;
        verify_schema(&staged, &self.graph_id)?;
        validate_entity_names(&staged)?;
        enable_outlines(&staged)?;
        self.doc = staged;
        self.reset_local_history();
        Ok(())
    }

    pub fn graph_id(&self) -> &GraphId {
        &self.graph_id
    }

    /// Starts a new session-local undo boundary at the document's current
    /// frontier. Persistence recovery must call this only after the complete
    /// Base+Tail has been replayed: imported operations from this replica are
    /// durable graph state, not commands from the newly opened session.
    pub fn reset_local_history(&mut self) {
        self.undo = UndoManager::new(&self.doc);
        self.undo_history.clear();
        self.redo_history.clear();
    }

    /// Restores the exact pre-command document after a history operation was
    /// rejected. Loro has no transactional undo preview; replacing the fork
    /// prevents compensating undo/redo operations from leaking into the local
    /// causal frontier. The rare rejection deliberately starts a fresh history
    /// boundary because Loro's old stacks are bound to the discarded document.
    fn restore_history_backup(&mut self, backup: LoroDoc) -> Result<(), CoreError> {
        let peer_id = self.doc.peer_id();
        self.doc = backup;
        configure_inline_content(&self.doc);
        self.doc.set_peer_id(peer_id)?;
        enable_outlines(&self.doc)?;
        self.reset_local_history();
        Ok(())
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
                semantic: SemanticEvent::CommandDeduplicated,
                changes: GraphChangeSet::default(),
                content_only: false,
                content_mappings: ContentMappings::new(),
            });
        }

        let before = self.doc.oplog_vv();
        let semantic;
        let mut history_plan = None;
        let mut outcome = MutationOutcome::default();
        let mut history_effect = None;
        let mut content_only = false;
        let change_tracker = ProjectionChangeTracker::new(&self.doc);

        match &envelope.command {
            Command::Undo => {
                semantic = SemanticEvent::LocalUndo;
                if self.undo_history.is_empty() {
                    if self.undo.can_undo() {
                        self.reset_local_history();
                        return Err(CoreError::HistoryMetadataMismatch);
                    }
                    self.doc.commit();
                    let changes = change_tracker.finish(&self.doc);
                    let result = outcome.into_result(envelope.command_id.clone(), None);
                    self.remember(envelope.command_id.as_str(), result.clone());
                    return Ok(CoreExecution {
                        result,
                        update: Vec::new(),
                        semantic,
                        changes,
                        content_only: false,
                        content_mappings: ContentMappings::new(),
                    });
                }
                if !self.undo.can_undo() {
                    self.reset_local_history();
                    return Err(CoreError::HistoryMetadataMismatch);
                }
                let backup = self.doc.fork();
                let changed = match self.undo.undo() {
                    Ok(changed) => changed,
                    Err(error) => {
                        self.restore_history_backup(backup)?;
                        return Err(error.into());
                    }
                };
                if !changed {
                    self.restore_history_backup(backup)?;
                    return Err(CoreError::HistoryMetadataMismatch);
                }
                if let Err(error) = validate_entity_names(&self.doc) {
                    self.restore_history_backup(backup)?;
                    return Err(error);
                }
                let entry = self
                    .undo_history
                    .pop()
                    .expect("history metadata was checked before undo");
                history_effect = Some(self.history_effect(&entry, HistoryDirection::Undo));
                self.redo_history.push(entry);
                self.doc.commit();
            }
            Command::Redo => {
                semantic = SemanticEvent::LocalRedo;
                if self.redo_history.is_empty() {
                    if self.undo.can_redo() {
                        self.reset_local_history();
                        return Err(CoreError::HistoryMetadataMismatch);
                    }
                    self.doc.commit();
                    let changes = change_tracker.finish(&self.doc);
                    let result = outcome.into_result(envelope.command_id.clone(), None);
                    self.remember(envelope.command_id.as_str(), result.clone());
                    return Ok(CoreExecution {
                        result,
                        update: Vec::new(),
                        semantic,
                        changes,
                        content_only: false,
                        content_mappings: ContentMappings::new(),
                    });
                }
                if !self.undo.can_redo() {
                    self.reset_local_history();
                    return Err(CoreError::HistoryMetadataMismatch);
                }
                let backup = self.doc.fork();
                let changed = match self.undo.redo() {
                    Ok(changed) => changed,
                    Err(error) => {
                        self.restore_history_backup(backup)?;
                        return Err(error.into());
                    }
                };
                if !changed {
                    self.restore_history_backup(backup)?;
                    return Err(CoreError::HistoryMetadataMismatch);
                }
                if let Err(error) = validate_entity_names(&self.doc) {
                    self.restore_history_backup(backup)?;
                    return Err(error);
                }
                let entry = self
                    .redo_history
                    .pop()
                    .expect("history metadata was checked before redo");
                history_effect = Some(self.history_effect(&entry, HistoryDirection::Redo));
                self.undo_history.push(entry);
                self.doc.commit();
            }
            command => {
                let prepared = self.prepare(command)?;
                if let PreparedCommandKind::Transition(transition) = &prepared.kind {
                    content_only = transition.is_content_only();
                }
                semantic = prepared.semantic();
                history_plan = Some(prepared.history.clone());
                self.undo.group_start()?;
                self.doc.set_next_commit_origin("local:command");
                self.doc
                    .set_next_commit_message(envelope.command_id.as_str());
                let apply_result = self.apply(&prepared, now, &mut outcome);
                if apply_result.is_ok() {
                    self.doc.commit();
                }
                self.undo.group_end();
                apply_result?;
            }
        }

        let content_mappings = change_tracker.content_mappings(&self.doc);
        let changes = change_tracker.finish(&self.doc);
        let update = if self.doc.oplog_vv() == before {
            Vec::new()
        } else {
            self.doc.export(ExportMode::updates(&before))?
        };
        if !update.is_empty()
            && let Some(plan) = history_plan
        {
            let entry = plan.finish(&outcome, self);
            self.undo_history.push(entry);
            self.redo_history.clear();
        }
        let result = outcome.into_result(envelope.command_id.clone(), history_effect);
        self.remember(envelope.command_id.as_str(), result.clone());
        Ok(CoreExecution {
            result,
            update,
            semantic,
            changes,
            content_only,
            content_mappings,
        })
    }

    pub fn publication(&self, execution: &CoreExecution) -> GraphChanges {
        let blocks = self.content_publication(&execution.content_mappings);
        if execution.content_only && !blocks.is_empty() {
            return GraphChanges::Content { blocks };
        }
        self.refresh_publication(&execution.changes, blocks)
    }

    fn refresh_publication(
        &self,
        changes: &GraphChangeSet,
        blocks: Vec<BlockContentUpdate>,
    ) -> GraphChanges {
        let outlines = match changes {
            GraphChangeSet::Rebuild => None,
            GraphChangeSet::Incremental { pages, tags } => Some(
                pages
                    .iter()
                    .cloned()
                    .map(|id| OutlineOwner::Page { id })
                    .chain(tags.iter().cloned().map(|id| OutlineOwner::Tag { id }))
                    .collect(),
            ),
        };
        GraphChanges::Refresh { outlines, blocks }
    }

    fn content_publication(&self, mappings: &ContentMappings) -> Vec<BlockContentUpdate> {
        let mut diagnostics = ProjectionDiagnostics::default();
        let directory = page_directory(&self.doc, &mut diagnostics.quarantined)
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect();
        mappings
            .iter()
            .filter_map(|((owner, block_id), mapping)| {
                // A structural transaction may remove a text target after editing it.
                let text = self.block_text(owner, block_id).ok()?;
                let (markdown, page_references, content) = materialize_block_content(
                    &text,
                    &directory,
                    block_id.as_str(),
                    &mut diagnostics.quarantined,
                );
                let meta = self
                    .outline(owner)
                    .ok()?
                    .get_meta(tree_id(block_id).ok()?)
                    .ok()?;
                let property_owner = PropertyOwner::Block {
                    owner: owner.clone(),
                    id: block_id.clone(),
                };
                let (properties, _) =
                    project_bag_child(&meta, "properties", Some(&property_owner), &mut diagnostics);
                Some(BlockContentUpdate {
                    owner: owner.clone(),
                    block_id: block_id.clone(),
                    content,
                    markdown,
                    page_references,
                    properties,
                    mapping: mapping.clone(),
                })
            })
            .collect()
    }

    pub fn import_remote(&mut self, update: &[u8]) -> Result<(), CoreError> {
        self.import_remote_with_changes(update).map(|_| ())
    }

    pub fn import_remote_with_changes(
        &mut self,
        update: &[u8],
    ) -> Result<GraphChangeSet, CoreError> {
        self.import_remote_with_publication(update)
            .map(|(changes, _)| changes)
    }

    pub fn import_remote_with_publication(
        &mut self,
        update: &[u8],
    ) -> Result<(GraphChangeSet, GraphChanges), CoreError> {
        self.validate_remote(update)?;

        let change_tracker = ProjectionChangeTracker::new(&self.doc);
        self.doc.set_next_commit_origin("remote:import");
        let status = self.doc.import(update)?;
        if status.pending.is_some() {
            return Err(CoreError::MissingDependencies);
        }
        let mappings = change_tracker.content_mappings(&self.doc);
        let changes = change_tracker.finish(&self.doc);
        let publication = self.refresh_publication(&changes, self.content_publication(&mappings));
        Ok((changes, publication))
    }

    /// Validates a remote update without mutating canonical state.
    pub fn validate_remote(&self, update: &[u8]) -> Result<(), CoreError> {
        self.validated_remote_candidate_doc(update).map(|_| ())
    }

    fn validated_remote_candidate_doc(&self, update: &[u8]) -> Result<LoroDoc, CoreError> {
        // Validate on a deep fork first: a rejected remote update must not
        // partially enter the canonical document. A fork receives a new random
        // peer, so restore the live server/client peer before it can be adopted.
        let candidate = self.doc.fork();
        configure_inline_content(&candidate);
        candidate.set_peer_id(self.doc.peer_id())?;
        let status = candidate.import(update)?;
        if status.pending.is_some() {
            return Err(CoreError::MissingDependencies);
        }
        verify_schema(&candidate, &self.graph_id)?;
        validate_entity_names(&candidate)?;
        enable_outlines(&candidate)?;
        Ok(candidate)
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

    /// Creates an independent graph baseline with a new graph and replica
    /// identity while retaining every current CRDT container, including soft
    /// deleted entities and forward-compatible property data.
    ///
    /// Stable entity IDs remain stable across a copy. The new graph ID keeps
    /// the replica outside the source graph's sync unit, and the shallow export
    /// intentionally starts the copy at a fresh history-retention boundary.
    pub fn export_clone_snapshot(
        &self,
        target_graph_id: GraphId,
        target_peer_id: u64,
    ) -> Result<Vec<u8>, CoreError> {
        let source_graph_id = self.graph_id.clone();
        if target_graph_id == source_graph_id {
            return Err(CoreError::CloneTargetMatchesSource);
        }
        let baseline = self.export_gc_checkpoint()?;
        let doc = LoroDoc::from_snapshot(&baseline)?;
        configure_inline_content(&doc);
        doc.set_peer_id(target_peer_id)?;
        rewrite_graph_scoped_query_iris(&doc, &source_graph_id, &target_graph_id)?;
        doc.get_map("meta")
            .insert("graph_id", target_graph_id.as_str())?;
        doc.set_next_commit_origin("system:clone");
        doc.set_next_commit_message("clone graph into a new identity");
        doc.commit();
        verify_schema(&doc, &target_graph_id)?;
        validate_entity_names(&doc)?;
        let frontiers = doc.oplog_frontiers();
        Ok(doc.export(ExportMode::shallow_snapshot(&frontiers))?)
    }

    pub fn export_all(&self) -> Result<Vec<u8>, CoreError> {
        Ok(self.doc.export(ExportMode::all_updates())?)
    }

    /// Encodes the Loro version vector used as the CRDT synchronization truth.
    /// Durable transport cursors deliberately do not participate in this value.
    pub fn version_vector(&self) -> Vec<u8> {
        self.doc.oplog_vv().encode()
    }

    /// Validates only the binary encoding of a Loro version vector without
    /// exporting or allocating a missing-update payload.
    pub fn validate_version_vector(&self, encoded: &[u8]) -> Result<(), CoreError> {
        VersionVector::decode(encoded)?;
        Ok(())
    }

    /// Exports operations absent from an encoded remote Loro version vector.
    pub fn export_updates_since(&self, encoded: &[u8]) -> Result<Vec<u8>, CoreError> {
        let version = VersionVector::decode(encoded)?;
        Ok(self.doc.export(ExportMode::updates(&version))?)
    }

    /// Projects the complete public graph and its diagnostics in one walk per
    /// canonical entity. Snapshot and summary are views of this same result;
    /// neither performs a second interpretation of CRDT state.
    fn project_graph(&self) -> Result<ProjectedGraph, CoreError> {
        let mut diagnostics = ProjectionDiagnostics::default();
        let mut tag_headers = BTreeMap::<TagId, (TagSummary, LoroMap)>::new();
        self.doc.get_map("tags").for_each(|raw_id, value| {
            let Ok(tag_id) = TagId::new(raw_id) else {
                diagnostics
                    .quarantined
                    .push(format!("tag:{raw_id}:invalid-id"));
                return;
            };
            let Some(tag) = value_into_map(value) else {
                diagnostics
                    .quarantined
                    .push(format!("tag:{raw_id}:not-map"));
                return;
            };
            if let Some(summary) = project_tag_summary(&tag_id, &tag, &mut diagnostics) {
                tag_headers.insert(tag_id, (summary, tag));
            }
        });
        let live_tags = tag_headers.keys().cloned().collect::<BTreeSet<_>>();

        let mut page_directory = BTreeMap::<PageId, PageDirectoryEntry>::new();
        let mut page_headers = BTreeMap::<PageId, (PageSnapshot, LoroMap)>::new();
        self.doc.get_map("pages").for_each(|raw_id, value| {
            let Ok(page_id) = PageId::new(raw_id) else {
                diagnostics
                    .quarantined
                    .push(format!("page:{raw_id}:invalid-id"));
                return;
            };
            let Some(page) = value_into_map(value) else {
                diagnostics
                    .quarantined
                    .push(format!("page:{raw_id}:not-map"));
                return;
            };
            let Some(header) = project_page_header(&page_id, &page, &live_tags, &mut diagnostics)
            else {
                return;
            };
            page_directory.insert(page_id.clone(), header.directory);
            if let Some(snapshot) = header.snapshot {
                page_headers.insert(page_id, (snapshot, page));
            }
        });
        let directory = page_directory.clone();

        let mut tags = Vec::with_capacity(tag_headers.len());
        for (tag_id, (summary, tag)) in tag_headers {
            let owner = OutlineOwner::Tag { id: tag_id };
            let outline = tag_outline(&tag)?;
            let mut blocks = Vec::new();
            for root in outline.roots() {
                blocks.push(project_block_snapshot(
                    &outline,
                    root,
                    &owner,
                    &live_tags,
                    &directory,
                    &mut diagnostics,
                )?);
            }
            tags.push(TagSnapshot {
                id: summary.id,
                name: summary.name,
                properties: summary.properties,
                defaults: summary.defaults,
                blocks,
            });
        }

        let mut pages = BTreeMap::new();
        for (page_id, (mut snapshot, page)) in page_headers {
            let owner = OutlineOwner::Page {
                id: page_id.clone(),
            };
            let Some(outline) = page.get("outline").and_then(value_into_tree) else {
                diagnostics
                    .quarantined
                    .push(format!("page:{page_id}:outline:missing-or-invalid"));
                pages.insert(page_id, snapshot);
                continue;
            };
            for root in outline.roots() {
                snapshot.blocks.push(project_block_snapshot(
                    &outline,
                    root,
                    &owner,
                    &live_tags,
                    &directory,
                    &mut diagnostics,
                )?);
            }
            pages.insert(page_id, snapshot);
        }

        let ProjectedGraphSettings {
            settings,
            overflow_ids,
            query_conflicts,
        } = project_graph_settings(&self.doc)?;
        diagnostics.query_conflicts.extend(query_conflicts);
        diagnostics.sort();

        let mut text_conflicts =
            page_title_limit_conflicts(pages.values().map(|page| (&page.id, page.title.as_str())));
        text_conflicts.extend(diagnostics.text_conflicts);
        let conflicts = projection_conflicts(
            pages
                .values()
                .filter(|page| !is_journal_page(&page.properties))
                .map(|page| (&page.id, page.title.as_str())),
            tags.iter().map(|tag| (&tag.id, tag.name.as_str())),
            overflow_ids,
            text_conflicts,
            diagnostics.query_conflicts,
        );

        Ok(ProjectedGraph {
            pages,
            page_directory: page_directory.into_values().collect(),
            tags,
            settings,
            conflicts,
            quarantined: diagnostics.quarantined,
        })
    }

    pub fn snapshot(&self) -> Result<GraphSnapshot, CoreError> {
        let projection = self.project_graph()?;
        Ok(GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            graph_id: self.graph_id.clone(),
            pages: projection.pages.into_values().collect(),
            page_directory: projection.page_directory,
            tags: projection.tags,
            settings: projection.settings,
            conflicts: projection.conflicts,
            quarantined: projection.quarantined,
        })
    }

    pub fn summary(&self) -> Result<GraphSummary, CoreError> {
        let projection = self.project_graph()?;
        Ok(GraphSummary {
            schema_version: SCHEMA_VERSION,
            graph_id: self.graph_id.clone(),
            pages: projection
                .pages
                .into_values()
                .map(|page| PageSummary {
                    id: page.id,
                    title: page.title,
                    properties: page.properties,
                    tags: page.tags,
                })
                .collect(),
            page_directory: projection.page_directory,
            tags: projection
                .tags
                .into_iter()
                .map(|tag| TagSummary {
                    id: tag.id,
                    name: tag.name,
                    properties: tag.properties,
                    defaults: tag.defaults,
                })
                .collect(),
            settings: projection.settings,
            conflicts: projection.conflicts,
            quarantined: projection.quarantined,
        })
    }

    pub fn page_snapshot(&self, page_id: &PageId) -> Result<PageSnapshot, CoreError> {
        let page = self.require_live_page(page_id)?;
        let mut quarantined = Vec::new();
        let live_tags = live_tag_ids(&self.doc);
        let mut snapshot = page_metadata(page_id, &page, &live_tags, &mut quarantined)
            .ok_or_else(|| CoreError::PageDeleted(page_id.clone()))?;
        snapshot.blocks = self
            .outline_snapshot(&OutlineOwner::Page {
                id: page_id.clone(),
            })?
            .blocks;
        Ok(snapshot)
    }

    pub fn outline_snapshot(&self, owner: &OutlineOwner) -> Result<OutlineSnapshot, CoreError> {
        self.require_live_outline_owner(owner)?;
        let outline = self.outline(owner)?;
        let live_tags = live_tag_ids(&self.doc);
        let mut quarantined = Vec::new();
        let directory = page_directory(&self.doc, &mut quarantined)
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect::<BTreeMap<_, _>>();
        let mut blocks = Vec::new();
        for root in outline.roots() {
            blocks.push(block_snapshot(
                &outline,
                root,
                owner,
                &live_tags,
                &directory,
                &mut quarantined,
            )?);
        }
        Ok(OutlineSnapshot {
            owner: owner.clone(),
            blocks,
        })
    }

    /// Materializes only the projection units named by a change set. `None`
    /// means the Loro diff could not be classified safely and the caller must
    /// rebuild from a complete snapshot.
    pub fn index_delta(&self, changes: &GraphChangeSet) -> Result<Option<IndexDelta>, CoreError> {
        let GraphChangeSet::Incremental {
            pages: affected_pages,
            tags: affected_tags,
        } = changes
        else {
            return Ok(None);
        };
        let mut index_changes = Vec::with_capacity(affected_pages.len() + affected_tags.len());
        for page_id in affected_pages {
            match self.page_snapshot(page_id) {
                Ok(page) => index_changes.push(IndexChange::Upsert(IndexUnit::Page(page))),
                Err(CoreError::PageNotFound(_)) | Err(CoreError::PageDeleted(_)) => {
                    index_changes.push(IndexChange::Remove(IndexUnitId::Page(page_id.clone())));
                }
                Err(error) => return Err(error),
            }
        }

        let mut directory_issues = Vec::new();
        let directory = page_directory(&self.doc, &mut directory_issues)
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect::<BTreeMap<_, _>>();
        for tag_id in affected_tags {
            let mut quarantined = Vec::new();
            if let Some(tag) = tag_snapshot_by_id(
                &self.doc,
                tag_id,
                &live_tag_ids(&self.doc),
                &directory,
                &mut quarantined,
            )? {
                index_changes.push(IndexChange::Upsert(IndexUnit::Tag(tag)));
            } else {
                index_changes.push(IndexChange::Remove(IndexUnitId::Tag(tag_id.clone())));
            }
        }
        Ok(Some(IndexDelta::new(self.frontier(), index_changes)))
    }

    /// Streams the validated projection units without materializing a complete
    /// `GraphSnapshot`. Tags are emitted first, followed by live pages in ID
    /// order; each page owns its complete visible block tree.
    pub fn index_units(
        &self,
    ) -> Result<impl Iterator<Item = Result<IndexUnit, CoreError>> + '_, CoreError> {
        let mut quarantined = Vec::new();
        let live_tags = live_tag_ids(&self.doc);
        let directory = page_directory(&self.doc, &mut quarantined)
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect::<BTreeMap<_, _>>();
        let tags = tag_snapshots(&self.doc, &live_tags, &directory, &mut quarantined)?;
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
        let directory = page_directory(&self.doc, &mut quarantined)
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect::<BTreeMap<_, _>>();
        for root in outline.roots() {
            snapshot.blocks.push(block_snapshot(
                &outline,
                root,
                &OutlineOwner::Page {
                    id: page_id.clone(),
                },
                live_tags,
                &directory,
                &mut quarantined,
            )?);
        }
        Ok(Some(snapshot))
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

    /// Turns one user intent into the complete, immutable work description the
    /// transaction will consume. User-rejectable checks and structural reads
    /// happen here exactly once; history and mutation never re-plan against a
    /// subtly different view of the document.
    fn prepare(&self, command: &Command) -> Result<PreparedCommand, CoreError> {
        match command {
            Command::Batch { commands } => {
                if commands.is_empty() || commands.len() > MAX_BATCH_COMMANDS {
                    return Err(CoreError::InvalidBatch(format!(
                        "expected between 1 and {MAX_BATCH_COMMANDS} commands"
                    )));
                }
                let plan = self.prepare_batch(commands)?;
                let mut affected_outlines = plan.affected_outlines.clone();
                affected_outlines.sort();
                affected_outlines.dedup();
                Ok(PreparedCommand {
                    kind: PreparedCommandKind::Batch {
                        commands: commands.to_vec(),
                    },
                    history: HistoryPlan {
                        entry: HistoryEntry {
                            scope: HistoryScope::Graph,
                            affected_outlines,
                            undo_candidates: Vec::new(),
                            redo_candidates: Vec::new(),
                        },
                        redo_created_block: false,
                        redo_created_page: false,
                    },
                })
            }
            Command::Undo | Command::Redo => {
                unreachable!("history commands are handled before preparation")
            }
            _ => {
                let transition = self.prepare_transition(command)?;
                let history = transition.history().clone();
                Ok(PreparedCommand {
                    kind: PreparedCommandKind::Transition(Box::new(transition)),
                    history,
                })
            }
        }
    }

    fn prepare_batch(&self, commands: &[Command]) -> Result<PreparedBatch, CoreError> {
        // Later steps may intentionally target an entity created by an earlier
        // one. Prepare and apply them against a disposable fork in order. Plans
        // may contain fork-local generated TreeIDs, so only portable history
        // scope leaves this validation boundary.
        let mut staged = self.validation_fork();
        let mut affected_outlines = Vec::new();
        let mut created_pages = 0;
        let mut created_tags = 0;
        let mut created_blocks = 0;
        for command in commands {
            if matches!(
                command,
                Command::Batch { .. } | Command::Undo | Command::Redo
            ) {
                return Err(CoreError::InvalidBatch(
                    "nested batches and history commands are not allowed".into(),
                ));
            }
            let prepared = staged.prepare(command)?;
            if let PreparedCommandKind::Transition(transition) = &prepared.kind {
                match transition.creation_slot() {
                    Some(CreationSlot::Page) => created_pages += 1,
                    Some(CreationSlot::Block) => created_blocks += 1,
                    Some(CreationSlot::Tag) => created_tags += 1,
                    None => {}
                }
            }
            if created_pages > 1 || created_tags > 1 || created_blocks > 1 {
                return Err(CoreError::InvalidBatch(
                    "at most one page, block, and tag creation may report a result".into(),
                ));
            }
            let mut outcome = MutationOutcome::default();
            affected_outlines.extend(prepared.history.entry.affected_outlines.iter().cloned());
            staged.apply(&prepared, "1970-01-01T00:00:00Z", &mut outcome)?;
            staged.doc.commit();
        }
        Ok(PreparedBatch { affected_outlines })
    }

    fn validation_fork(&self) -> Self {
        let doc = self.doc.fork();
        let undo = UndoManager::new(&doc);
        Self {
            graph_id: self.graph_id.clone(),
            doc,
            undo,
            command_results: BTreeMap::new(),
            command_order: VecDeque::new(),
            undo_history: Vec::new(),
            redo_history: Vec::new(),
        }
    }

    fn apply(
        &mut self,
        prepared: &PreparedCommand,
        now: &str,
        outcome: &mut MutationOutcome,
    ) -> Result<(), CoreError> {
        match &prepared.kind {
            PreparedCommandKind::Transition(transition) => {
                self.apply_transition(transition, now, outcome)
            }
            PreparedCommandKind::Batch { commands, .. } => {
                outcome.changed = false;
                for command in commands {
                    // Preflight proved the complete sequence valid, but opaque
                    // TreeIDs created on its fork cannot safely cross into the
                    // live document. Resolve each live plan against the state
                    // produced by the preceding live step.
                    let prepared = self.prepare(command)?;
                    let mut nested = MutationOutcome::default();
                    self.apply(&prepared, now, &mut nested)?;
                    outcome.merge(nested);
                }
                Ok(())
            }
        }
    }
    fn insert_outline_items<T>(
        &self,
        insertion: OutlineInsertion<'_, T>,
        now: &str,
        mut decorate: impl FnMut(&LoroMap, &T) -> Result<(), CoreError>,
    ) -> Result<Option<BlockId>, CoreError>
    where
        T: InsertableOutlineItem,
    {
        let OutlineInsertion {
            owner,
            parent,
            index,
            replace,
            items,
        } = insertion;
        let outline = self.outline(owner)?;
        let mut base_parent = parent.map(tree_id).transpose()?;
        let mut base_index = index;
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

        let mut levels = Vec::<TreeID>::new();
        let mut inserted_children = BTreeMap::<TreeID, usize>::new();
        let mut last_created = None;

        for (position, item) in items.iter().enumerate() {
            let node = if position == 0
                && let Some(replace_id) = replace
            {
                let target = require_block_in(&outline, replace_id)?;
                replace_text(&self.block_text(owner, replace_id)?, item.markdown())?;
                target
            } else if item.depth() == 0 {
                let available = base_parent.map_or_else(
                    || outline.roots().len(),
                    |parent| outline.children(parent).map_or(0, |rows| rows.len()),
                );
                let target =
                    outline.create_at(base_parent, (base_index + root_offset).min(available))?;
                initialize_created_node(&outline.get_meta(target)?, item.markdown(), now)?;
                root_offset += 1;
                target
            } else {
                let parent_node = *levels.get(item.depth() - 1).ok_or_else(|| {
                    CoreError::InvalidHierarchy("outline insert skips a depth".into())
                })?;
                let child_index = inserted_children.entry(parent_node).or_default();
                let target = outline.create_at(Some(parent_node), *child_index)?;
                *child_index += 1;
                initialize_created_node(&outline.get_meta(target)?, item.markdown(), now)?;
                target
            };

            let meta = outline.get_meta(node)?;
            decorate(&meta, item)?;
            if levels.len() <= item.depth() {
                levels.push(node);
            } else {
                levels[item.depth()] = node;
                levels.truncate(item.depth() + 1);
            }
            let created_id = block_id(node);
            self.touch_block(owner, &created_id, now)?;
            last_created = Some(created_id);
        }

        Ok(last_created)
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
        owner: &OutlineOwner,
        block_id: &BlockId,
        now: &str,
    ) -> Result<(), CoreError> {
        set_single(
            &self.block_bag(owner, block_id)?,
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

    fn touch_outline_owner(&self, owner: &OutlineOwner, now: &str) -> Result<(), CoreError> {
        match owner {
            OutlineOwner::Page { id } => self.touch_page(id, now),
            OutlineOwner::Tag { id } => self.touch_tag(id, now),
        }
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
        if pages.get(page_id.as_str()).is_some() {
            return Ok(None);
        }
        let page = pages.ensure_mergeable_map(page_id.as_str())?;
        let root = page.ensure_mergeable_map("root")?;
        initialize_node(&root, "")?;
        let properties = root.ensure_mergeable_map("properties")?;
        let outline = page.ensure_mergeable_tree("outline")?;
        outline.enable_fractional_index(0);
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
    }

    /// Normal graph creation uses the deterministic graph/date ID. A portable
    /// copy keeps stable entity IDs, so it may contain a journal created under
    /// the source graph ID. Resolve the semantic journal date first to avoid
    /// creating a duplicate day after import.
    fn journal_page_id(&self, date: &domain::LocalDate) -> PageId {
        let pages = self.doc.get_map("pages");
        let mut matches = Vec::new();
        pages.for_each(|raw_id, value| {
            let Ok(page_id) = PageId::new(raw_id) else {
                return;
            };
            let Some(page) = value_into_map(value) else {
                return;
            };
            let Some(root) = page.get("root").and_then(value_into_map) else {
                return;
            };
            let Some(properties) = root.get("properties").and_then(value_into_map) else {
                return;
            };
            let (fields, _) = decode_bag(&properties);
            let is_journal = fields
                .get("builtin.page-kind")
                .is_some_and(|field| field.values == [PropertyValue::String("journal".to_owned())]);
            let is_date = fields
                .get("builtin.journal-date")
                .is_some_and(|field| field.values == [PropertyValue::Date(date.clone())]);
            if is_journal && is_date {
                matches.push(page_id);
            }
        });
        matches.sort();
        matches
            .into_iter()
            .next()
            .unwrap_or_else(|| PageId::journal(&self.graph_id, date))
    }

    fn ensure_tag(
        &self,
        tag_id: &TagId,
        name: &str,
        now: &str,
    ) -> Result<Option<TagId>, CoreError> {
        let tags = self.doc.get_map("tags");
        if tags.get(tag_id.as_str()).is_some() {
            return Ok(None);
        }
        let tag = tags.ensure_mergeable_map(tag_id.as_str())?;
        let properties = tag.ensure_mergeable_map("properties")?;
        let _ = tag.ensure_mergeable_map("defaults")?;
        let outline = tag.ensure_mergeable_tree("outline")?;
        outline.enable_fractional_index(0);
        tag.insert("name", name)?;
        initialize_lifecycle(&properties, now)?;
        Ok(Some(tag_id.clone()))
    }

    fn validate_outline_fragment(&self, fragment: &OutlineFragment) -> Result<(), CoreError> {
        if fragment.kind != OUTLINE_FRAGMENT_KIND || fragment.version != OUTLINE_FRAGMENT_VERSION {
            return Err(CoreError::InvalidHierarchy(
                "unsupported outline fragment".to_owned(),
            ));
        }
        validate_outline_items(&fragment.items, "paste")?;
        if fragment.tags.len() > MAX_STRUCTURAL_TARGETS
            || fragment.pages.len() > MAX_STRUCTURAL_TARGETS
        {
            return Err(CoreError::InvalidHierarchy(
                "outline paste exceeds the reference limit".to_owned(),
            ));
        }
        if serde_json::to_vec(fragment)?.len() > MAX_OUTLINE_FRAGMENT_BYTES {
            return Err(CoreError::InvalidHierarchy(
                "outline fragment exceeds the payload limit".to_owned(),
            ));
        }

        let mut tag_ids = BTreeSet::new();
        for tag in &fragment.tags {
            if !tag_ids.insert(tag.id.clone()) {
                return Err(CoreError::InvalidHierarchy(
                    "outline fragment contains a duplicate tag reference".to_owned(),
                ));
            }
            validate_text(&tag.name, MAX_ENTITY_NAME_BYTES)?;
            validate_name(&tag.name, "tag")?;
        }
        let mut page_ids = BTreeSet::new();
        for page in &fragment.pages {
            if !page_ids.insert(page.id.clone()) {
                return Err(CoreError::InvalidHierarchy(
                    "outline fragment contains a duplicate page reference".to_owned(),
                ));
            }
            if page.journal_date.is_none() {
                validate_text(&page.title, MAX_ENTITY_NAME_BYTES)?;
                validate_name(&page.title, "page")?;
            }
        }

        let same_graph = fragment.source_graph_id == self.graph_id;
        let mut total_fields = 0usize;
        let mut referenced_tags = BTreeSet::new();
        let mut referenced_pages = BTreeSet::new();
        for item in &fragment.items {
            validate_fragment_page_references(item)?;
            for reference in &item.page_references {
                if !page_ids.contains(&reference.page_id) {
                    return Err(CoreError::InvalidHierarchy(format!(
                        "outline fragment page reference is missing: {}",
                        reference.page_id
                    )));
                }
                referenced_pages.insert(reference.page_id.clone());
            }
            total_fields = total_fields.saturating_add(item.properties.len());
            if total_fields > MAX_STRUCTURAL_TARGETS {
                return Err(CoreError::InvalidHierarchy(
                    "outline paste exceeds the property limit".to_owned(),
                ));
            }
            let mut property_keys = BTreeSet::new();
            for field in &item.properties {
                if !property_keys.insert(&field.key) {
                    return Err(CoreError::InvalidHierarchy(format!(
                        "outline fragment contains a duplicate property: {}",
                        field.key
                    )));
                }
                if property_copy_policy(&field.key) != PropertyCopyPolicy::Portable {
                    return Err(CoreError::InvalidHierarchy(format!(
                        "property is not portable: {}",
                        field.key
                    )));
                }
                validate_property_write(&field.key, PropertyTarget::Block)?;
                validate_property_field(field)?;
                if field.value_type == PropertyType::Document
                    && (field.key.as_str() != QUERY_PROPERTY_KEY
                        || field.cardinality != Cardinality::Single
                        || !matches!(field.values.as_slice(), [PropertyValue::Document(_)]))
                {
                    return Err(CoreError::InvalidHierarchy(
                        "outline fragment contains an unsupported document property".to_owned(),
                    ));
                }
                for value in &field.values {
                    if let PropertyValue::Page(page_id) = value {
                        referenced_pages.insert(page_id.clone());
                        let resolves_directly =
                            same_graph && self.require_live_page(page_id).is_ok();
                        if !resolves_directly && !page_ids.contains(page_id) {
                            return Err(CoreError::InvalidHierarchy(format!(
                                "outline fragment page reference is missing: {page_id}"
                            )));
                        }
                    }
                }
            }
            let mut item_tags = BTreeSet::new();
            for tag_id in &item.tags {
                if !item_tags.insert(tag_id) || !tag_ids.contains(tag_id) {
                    return Err(CoreError::InvalidHierarchy(format!(
                        "outline fragment tag reference is missing or duplicated: {tag_id}"
                    )));
                }
                referenced_tags.insert(tag_id.clone());
            }
        }
        if tag_ids.iter().any(|id| !referenced_tags.contains(id))
            || page_ids.iter().any(|id| !referenced_pages.contains(id))
        {
            return Err(CoreError::InvalidHierarchy(
                "outline fragment contains an unused reference descriptor".to_owned(),
            ));
        }
        Ok(())
    }

    fn resolve_outline_fragment(
        &self,
        fragment: &OutlineFragment,
    ) -> Result<FragmentResolution, CoreError> {
        let same_graph = fragment.source_graph_id == self.graph_id;
        let mut tags = BTreeMap::new();
        let mut new_tags = Vec::new();
        let mut tag_names = live_tag_names(&self.doc)
            .into_iter()
            .map(|(id, name)| (canonical_entity_name(&name), id))
            .collect::<BTreeMap<_, _>>();
        let mut reserved_tag_ids = self
            .doc
            .get_map("tags")
            .keys()
            .filter_map(|id| TagId::new(id.to_string()).ok())
            .collect::<BTreeSet<_>>();
        for reference in &fragment.tags {
            let target = if same_graph && self.require_live_tag(&reference.id).is_ok() {
                reference.id.clone()
            } else if let Some(existing) = tag_names.get(&canonical_entity_name(&reference.name)) {
                existing.clone()
            } else {
                let id = fresh_fragment_tag_id(
                    &self.graph_id,
                    &fragment.source_graph_id,
                    &reference.id,
                    &reserved_tag_ids,
                )?;
                reserved_tag_ids.insert(id.clone());
                tag_names.insert(canonical_entity_name(&reference.name), id.clone());
                new_tags.push((id.clone(), reference.name.clone()));
                id
            };
            tags.insert(reference.id.clone(), target);
        }

        let mut pages = BTreeMap::new();
        let mut new_pages = Vec::new();
        let mut page_names = live_page_names(&self.doc)
            .into_iter()
            .map(|(id, name)| (canonical_entity_name(&name), id))
            .collect::<BTreeMap<_, _>>();
        let mut reserved_page_ids = self
            .doc
            .get_map("pages")
            .keys()
            .filter_map(|id| PageId::new(id.to_string()).ok())
            .collect::<BTreeSet<_>>();
        for reference in &fragment.pages {
            let target = if same_graph && self.require_live_page(&reference.id).is_ok() {
                reference.id.clone()
            } else if let Some(date) = &reference.journal_date {
                let id = self.journal_page_id(date);
                if self.require_page(&id).is_err() {
                    new_pages.push((id.clone(), reference.clone()));
                    reserved_page_ids.insert(id.clone());
                }
                id
            } else if let Some(existing) = page_names.get(&canonical_entity_name(&reference.title))
            {
                existing.clone()
            } else {
                let id = fresh_fragment_page_id(
                    &self.graph_id,
                    &fragment.source_graph_id,
                    &reference.id,
                    &reserved_page_ids,
                )?;
                reserved_page_ids.insert(id.clone());
                page_names.insert(canonical_entity_name(&reference.title), id.clone());
                new_pages.push((id.clone(), reference.clone()));
                id
            };
            pages.insert(reference.id.clone(), target);
        }

        Ok(FragmentResolution {
            tags,
            pages,
            new_tags,
            new_pages,
        })
    }

    fn block_is_plain_empty(
        &self,
        owner: &OutlineOwner,
        block_id: &BlockId,
    ) -> Result<bool, CoreError> {
        let outline = self.outline_snapshot(owner)?;
        let block = find_snapshot_block(&outline.blocks, block_id)
            .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
        Ok(block.markdown.is_empty()
            && block.tags.is_empty()
            && block.children.is_empty()
            && block
                .properties
                .iter()
                .all(|field| property_copy_policy(&field.key) != PropertyCopyPolicy::Portable))
    }

    fn history_effect(&self, entry: &HistoryEntry, direction: HistoryDirection) -> HistoryEffect {
        let candidates = match direction {
            HistoryDirection::Undo => &entry.undo_candidates,
            HistoryDirection::Redo => &entry.redo_candidates,
        };
        HistoryEffect {
            scope: entry.scope,
            affected_outlines: entry.affected_outlines.clone(),
            reveal: candidates
                .iter()
                .find_map(|target| self.resolve_history_target(target)),
        }
    }

    fn resolve_history_target(&self, target: &HistoryTarget) -> Option<EntityId> {
        match target {
            HistoryTarget::Entity(entity) => self.entity_is_live(entity).then(|| entity.clone()),
            HistoryTarget::BlockPosition {
                owner,
                parent,
                index,
            } => {
                let state = self.outline_state(owner).ok()?;
                let id = state.children.get(parent)?.get(*index)?.clone();
                Some(EntityId::Block {
                    owner: owner.clone(),
                    id,
                })
            }
        }
    }

    fn entity_is_live(&self, entity: &EntityId) -> bool {
        match entity {
            EntityId::Page { id } => self.require_live_page(id).is_ok(),
            EntityId::Block { owner, id } => {
                self.require_live_outline_owner(owner).is_ok()
                    && self.require_block(owner, id).is_ok()
            }
        }
    }

    fn move_blocks(
        &self,
        block_ids: &[BlockId],
        owner: &OutlineOwner,
        parent: Option<&BlockId>,
        after: Option<&BlockId>,
    ) -> Result<(), CoreError> {
        let outline = self.outline(owner)?;
        let parent_tree = parent.map(tree_id).transpose()?;
        let mut anchor = after.map(tree_id).transpose()?;

        for block_id in block_ids {
            let block = tree_id(block_id)?;
            if let Some(previous) = anchor {
                outline.mov_after(block, previous)?;
            } else {
                outline.mov_to(block, parent_tree, 0)?;
            }
            anchor = Some(block);
        }
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

    fn outline(&self, owner: &OutlineOwner) -> Result<LoroTree, CoreError> {
        let value = self
            .require_outline_owner(owner)?
            .get("outline")
            .ok_or_else(|| CoreError::InvalidHierarchy("owner outline is missing".to_owned()))?;
        let outline = value_into_tree(value)
            .ok_or_else(|| CoreError::InvalidHierarchy("owner outline is invalid".to_owned()))?;
        outline.enable_fractional_index(0);
        Ok(outline)
    }

    fn require_outline_owner(&self, owner: &OutlineOwner) -> Result<LoroMap, CoreError> {
        match owner {
            OutlineOwner::Page { id } => self.require_page(id),
            OutlineOwner::Tag { id } => self.require_tag(id),
        }
    }

    fn require_live_outline_owner(&self, owner: &OutlineOwner) -> Result<LoroMap, CoreError> {
        match owner {
            OutlineOwner::Page { id } => self.require_live_page(id),
            OutlineOwner::Tag { id } => self.require_live_tag(id),
        }
    }

    fn require_block(&self, owner: &OutlineOwner, block_id: &BlockId) -> Result<TreeID, CoreError> {
        let outline = self.outline(owner)?;
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

    fn block_bag(&self, owner: &OutlineOwner, block_id: &BlockId) -> Result<LoroMap, CoreError> {
        let outline = self.outline(owner)?;
        Ok(outline
            .get_meta(require_block_in(&outline, block_id)?)?
            .ensure_mergeable_map("properties")?)
    }

    fn block_text(&self, owner: &OutlineOwner, block_id: &BlockId) -> Result<LoroText, CoreError> {
        let outline = self.outline(owner)?;
        Ok(outline
            .get_meta(require_block_in(&outline, block_id)?)?
            .ensure_mergeable_text("content")?)
    }

    fn entity_bag(&self, entity: &EntityId) -> Result<LoroMap, CoreError> {
        match entity {
            EntityId::Page { id } => self.page_properties(id),
            EntityId::Block { owner, id } => self.block_bag(owner, id),
        }
    }

    fn property_owner_bag(&self, owner: &PropertyOwner) -> Result<LoroMap, CoreError> {
        match owner {
            PropertyOwner::Page { id } => self.page_properties(id),
            PropertyOwner::Block { owner, id } => self.block_bag(owner, id),
            PropertyOwner::Tag { tag_id } => self.tag_bag(tag_id, "properties"),
            PropertyOwner::TagDefault { tag_id } => self.tag_bag(tag_id, "defaults"),
        }
    }

    fn require_default_query(&self, id: &DefaultQueryId) -> Result<LoroMap, CoreError> {
        let entry = default_queries_map(&self.doc)?
            .get(id.as_str())
            .and_then(value_into_map)
            .ok_or_else(|| {
                CoreError::InvalidHierarchy(format!("default query does not exist: {id}"))
            })?;
        if map_bool(&entry, "deleted") != Some(false) {
            return Err(CoreError::InvalidHierarchy(format!(
                "default query does not exist: {id}"
            )));
        }
        Ok(entry)
    }

    fn validate_query_owner(&self, owner: &QueryOwner) -> Result<(), CoreError> {
        if let QueryOwner::GraphDefault { default_query_id } = owner {
            self.require_default_query(default_query_id)?;
            return Ok(());
        }
        let owner = property_owner_from_query_owner(owner)
            .expect("non-graph query owner has a property owner");
        self.validate_property_owner(&owner)?;
        let query_key = key(QUERY_PROPERTY_KEY);
        validate_property_write(&query_key, property_owner_target(&owner))?;
        Ok(())
    }

    fn require_query_document_for_owner(&self, owner: &QueryOwner) -> Result<LoroMap, CoreError> {
        match owner {
            QueryOwner::GraphDefault { default_query_id } => self
                .require_default_query(default_query_id)?
                .get("document")
                .and_then(value_into_map)
                .ok_or_else(|| {
                    CoreError::InvalidHierarchy("default query document is missing".to_owned())
                }),
            _ => {
                let property = property_owner_from_query_owner(owner)
                    .expect("non-graph query owner has a property owner");
                require_query_document(&self.property_owner_bag(&property)?)
            }
        }
    }

    fn ensure_query_document_for_owner(&self, owner: &QueryOwner) -> Result<LoroMap, CoreError> {
        match owner {
            QueryOwner::GraphDefault { .. } => self.require_query_document_for_owner(owner),
            _ => {
                let property = property_owner_from_query_owner(owner)
                    .expect("non-graph query owner has a property owner");
                ensure_query_document(&self.property_owner_bag(&property)?)
            }
        }
    }

    fn query_document(&self, owner: &QueryOwner) -> Result<PropertyDocument, CoreError> {
        let document = self.require_query_document_for_owner(owner)?;
        decode_query_document(&document).map_err(CoreError::InvalidHierarchy)
    }

    fn query_document_if_present(
        &self,
        owner: &QueryOwner,
    ) -> Result<Option<PropertyDocument>, CoreError> {
        if matches!(owner, QueryOwner::GraphDefault { .. }) {
            return self.query_document(owner).map(Some);
        }
        let property = property_owner_from_query_owner(owner)
            .expect("non-graph query owner has a property owner");
        let bag = self.property_owner_bag(&property)?;
        if !bag_contains_key(&bag, &key(QUERY_PROPERTY_KEY)) {
            return Ok(None);
        }
        let document = require_query_document(&bag)?;
        decode_query_document(&document)
            .map(Some)
            .map_err(CoreError::InvalidHierarchy)
    }

    fn entity_tags(&self, entity: &EntityId) -> Result<LoroMap, CoreError> {
        match entity {
            EntityId::Page { id } => Ok(self.page_root(id)?.ensure_mergeable_map("tag_refs")?),
            EntityId::Block { owner, id } => {
                let outline = self.outline(owner)?;
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
            EntityId::Block { owner, id } => {
                self.require_block(owner, id)?;
            }
        }
        Ok(())
    }

    fn validate_property_owner(&self, owner: &PropertyOwner) -> Result<(), CoreError> {
        match owner {
            PropertyOwner::Page { id } => {
                self.require_page(id)?;
            }
            PropertyOwner::Block { owner, id } => {
                self.require_block(owner, id)?;
            }
            PropertyOwner::Tag { tag_id } | PropertyOwner::TagDefault { tag_id } => {
                self.require_tag(tag_id)?;
            }
        }
        Ok(())
    }
}

fn rewrite_graph_scoped_query_iris(
    doc: &LoroDoc,
    source_graph_id: &GraphId,
    target_graph_id: &GraphId,
) -> Result<(), CoreError> {
    let mut property_bags = Vec::new();
    doc.get_map("pages").for_each(|_, value| {
        let Some(page) = value_into_map(value) else {
            return;
        };
        if let Some(root) = page.get("root").and_then(value_into_map)
            && let Some(properties) = root.get("properties").and_then(value_into_map)
        {
            property_bags.push(properties);
        }
        if let Some(outline) = page.get("outline").and_then(value_into_tree) {
            for node in outline.nodes() {
                if let Ok(meta) = outline.get_meta(node)
                    && let Some(properties) = meta.get("properties").and_then(value_into_map)
                {
                    property_bags.push(properties);
                }
            }
        }
    });
    doc.get_map("tags").for_each(|_, value| {
        let Some(tag) = value_into_map(value) else {
            return;
        };
        for name in ["properties", "defaults"] {
            if let Some(properties) = tag.get(name).and_then(value_into_map) {
                property_bags.push(properties);
            }
        }
        if let Some(outline) = tag.get("outline").and_then(value_into_tree) {
            for node in outline.nodes() {
                if let Ok(meta) = outline.get_meta(node)
                    && let Some(properties) = meta.get("properties").and_then(value_into_map)
                {
                    property_bags.push(properties);
                }
            }
        }
    });

    let replacements = ["page", "block", "tag"]
        .into_iter()
        .map(|kind| {
            let source = query::entity_iri(source_graph_id, kind, "")
                .map_err(|error| CoreError::InvalidHierarchy(error.to_string()))?;
            let target = query::entity_iri(target_graph_id, kind, "")
                .map_err(|error| CoreError::InvalidHierarchy(error.to_string()))?;
            Ok((source.as_str().to_owned(), target.as_str().to_owned()))
        })
        .collect::<Result<Vec<_>, CoreError>>()?;

    for bag in property_bags {
        let Some(document) = query_document_from_bag(&bag) else {
            continue;
        };
        rewrite_query_document_iris(&document, &replacements)?;
    }
    for query in graph_settings_snapshot(doc)?.default_queries {
        let queries = default_queries_map(doc)?;
        let entry = queries
            .get(query.id.as_str())
            .and_then(value_into_map)
            .ok_or_else(|| CoreError::InvalidHierarchy("default query is missing".to_owned()))?;
        let document = entry
            .get("document")
            .and_then(value_into_map)
            .ok_or_else(|| {
                CoreError::InvalidHierarchy("default query document is missing".to_owned())
            })?;
        rewrite_query_document_iris(&document, &replacements)?;
    }
    Ok(())
}

fn rewrite_query_document_iris(
    document: &LoroMap,
    replacements: &[(String, String)],
) -> Result<(), CoreError> {
    if map_string(document, "schema").as_deref() != Some(QUERY_DOCUMENT_SCHEMA)
        || map_i64(document, "version") != Some(i64::from(QUERY_DOCUMENT_VERSION))
    {
        return Ok(());
    }
    let Some(views) = document.get("views").and_then(value_into_map) else {
        return Ok(());
    };
    let mut sources = Vec::new();
    views.for_each(|_, value| {
        let Some(view) = value_into_map(value) else {
            return;
        };
        let Some(definition) = view.get("definition").and_then(value_into_map) else {
            return;
        };
        let Some(source) = definition.get("source").and_then(value_into_text) else {
            return;
        };
        sources.push(source);
    });
    for source in sources {
        let current = source.to_string();
        let rewritten = replacements
            .iter()
            .fold(current.clone(), |value, (from, to)| value.replace(from, to));
        if rewritten != current {
            replace_text(&source, &rewritten)?;
        }
    }
    Ok(())
}

struct StoredQueryDocument {
    owner: Option<QueryOwner>,
    document: LoroMap,
}

fn query_document_from_bag(bag: &LoroMap) -> Option<LoroMap> {
    let query_key = key(QUERY_PROPERTY_KEY);
    bag.get(query_key.as_str())
        .and_then(value_into_map)
        .filter(|field| {
            stored_property_shape(field, &query_key).is_ok_and(|shape| {
                shape.value_type == PropertyType::Document
                    && shape.cardinality == Cardinality::Single
            })
        })
        .and_then(|field| field.get(PROPERTY_DOCUMENT_KEY))
        .and_then(value_into_map)
}

fn push_query_document(
    documents: &mut Vec<StoredQueryDocument>,
    bag: &LoroMap,
    owner: Option<QueryOwner>,
) {
    if let Some(document) = query_document_from_bag(bag) {
        documents.push(StoredQueryDocument { owner, document });
    }
}

/// Enumerates non-settings query documents with their stable semantic owner.
/// Graph-default documents are projected once by `project_graph_settings`.
fn stored_query_documents(doc: &LoroDoc) -> Vec<StoredQueryDocument> {
    let mut documents = Vec::new();
    doc.get_map("pages").for_each(|raw_id, value| {
        let Some(page) = value_into_map(value) else {
            return;
        };
        let page_id = PageId::new(raw_id).ok();
        let outline_owner = page_id
            .as_ref()
            .map(|id| OutlineOwner::Page { id: id.clone() });
        if let Some(root) = page.get("root").and_then(value_into_map)
            && let Some(properties) = root.get("properties").and_then(value_into_map)
        {
            push_query_document(
                &mut documents,
                &properties,
                page_id.clone().map(|id| QueryOwner::Page { id }),
            );
        }
        if let Some(outline) = page.get("outline").and_then(value_into_tree) {
            for node in outline.nodes() {
                if let Ok(meta) = outline.get_meta(node)
                    && let Some(properties) = meta.get("properties").and_then(value_into_map)
                {
                    push_query_document(
                        &mut documents,
                        &properties,
                        outline_owner.clone().map(|owner| QueryOwner::Block {
                            owner,
                            id: block_id(node),
                        }),
                    );
                }
            }
        }
    });
    doc.get_map("tags").for_each(|raw_id, value| {
        let Some(tag) = value_into_map(value) else {
            return;
        };
        let tag_id = TagId::new(raw_id).ok();
        let outline_owner = tag_id
            .as_ref()
            .map(|id| OutlineOwner::Tag { id: id.clone() });
        if let Some(properties) = tag.get("properties").and_then(value_into_map) {
            push_query_document(
                &mut documents,
                &properties,
                tag_id.clone().map(|tag_id| QueryOwner::Tag { tag_id }),
            );
        }
        if let Some(defaults) = tag.get("defaults").and_then(value_into_map) {
            // Query documents are not valid tag defaults, but an unowned entry
            // is still decoded so malformed remote state cannot hide here.
            push_query_document(&mut documents, &defaults, None);
        }
        if let Some(outline) = tag.get("outline").and_then(value_into_tree) {
            for node in outline.nodes() {
                if let Ok(meta) = outline.get_meta(node)
                    && let Some(properties) = meta.get("properties").and_then(value_into_map)
                {
                    push_query_document(
                        &mut documents,
                        &properties,
                        outline_owner.clone().map(|owner| QueryOwner::Block {
                            owner,
                            id: block_id(node),
                        }),
                    );
                }
            }
        }
    });
    documents.sort_by(|left, right| left.owner.cmp(&right.owner));
    documents
}

fn validate_current_query_documents(doc: &LoroDoc) -> Result<(), CoreError> {
    for stored in stored_query_documents(doc) {
        project_query_document(&stored.document).map_err(CoreError::InvalidHierarchy)?;
    }
    Ok(())
}

pub(crate) fn verify_schema(doc: &LoroDoc, graph_id: &GraphId) -> Result<(), CoreError> {
    validate_causal_document(doc, graph_id)?;
    validate_current_graph_settings(doc)?;
    validate_current_query_documents(doc)
}

fn validate_outline_items<T: InsertableOutlineItem>(
    items: &[T],
    operation: &str,
) -> Result<(), CoreError> {
    if items.is_empty() {
        return Err(CoreError::InvalidHierarchy(format!(
            "outline {operation} requires at least one item"
        )));
    }
    if items.len() > MAX_STRUCTURAL_TARGETS {
        return Err(CoreError::InvalidHierarchy(format!(
            "outline {operation} exceeds the block target limit"
        )));
    }
    if items[0].depth() != 0 {
        return Err(CoreError::InvalidHierarchy(format!(
            "outline {operation} must start at depth zero"
        )));
    }

    let mut previous_depth = 0usize;
    let mut total_text = 0usize;
    for item in items {
        if item.depth() > previous_depth.saturating_add(1) {
            return Err(CoreError::InvalidHierarchy(format!(
                "outline {operation} skips a depth"
            )));
        }
        validate_text(item.markdown(), MAX_BLOCK_TEXT_BYTES)?;
        total_text = total_text.saturating_add(item.markdown().len());
        if total_text > MAX_BLOCK_TEXT_BYTES {
            return Err(CoreError::InvalidHierarchy(format!(
                "outline {operation} exceeds the text limit"
            )));
        }
        previous_depth = item.depth();
    }
    Ok(())
}

fn validate_text(value: &str, max: usize) -> Result<(), CoreError> {
    if value.len() > max {
        Err(CoreError::TextTooLong)
    } else if value.contains(PAGE_REFERENCE_CHAR) {
        Err(CoreError::InvalidHierarchy(
            "text contains the reserved page-reference atom".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn validate_default_query_title(value: &str) -> Result<(), CoreError> {
    if value.chars().count() > MAX_DEFAULT_QUERY_TITLE {
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
        if !is_journal_page(&snapshot.properties) {
            names.push((page_id, snapshot.title));
        }
    });
    names.sort_by(|left, right| left.0.cmp(&right.0));
    names
}

fn live_tag_names(doc: &LoroDoc) -> Vec<(TagId, String)> {
    let mut quarantined = Vec::new();
    tag_summaries(doc, &mut quarantined)
        .into_iter()
        .map(|tag| (tag.id, tag.name))
        .collect()
}

fn live_tag_ids(doc: &LoroDoc) -> BTreeSet<TagId> {
    let mut quarantined = Vec::new();
    tag_summaries(doc, &mut quarantined)
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

pub(crate) fn validate_entity_names(doc: &LoroDoc) -> Result<(), CoreError> {
    for (_, name) in live_page_names(doc) {
        validate_name(&name, "page")?;
    }
    for (_, name) in live_tag_names(doc) {
        validate_name(&name, "tag")?;
    }
    Ok(())
}

fn is_journal_page(properties: &PropertyBag) -> bool {
    properties
        .get("builtin.page-kind")
        .is_some_and(|entry| entry.values == [PropertyValue::String("journal".to_owned())])
}

fn page_title_limit_conflicts<'a>(
    pages: impl IntoIterator<Item = (&'a PageId, &'a str)>,
) -> Vec<GraphConflict> {
    pages
        .into_iter()
        .filter(|(_, title)| title.len() > MAX_ENTITY_NAME_BYTES)
        .map(|(page_id, title)| GraphConflict::TextLimitExceeded {
            target: TextTarget::PageTitle {
                page_id: page_id.clone(),
            },
            actual_bytes: title.len(),
            limit: MAX_ENTITY_NAME_BYTES,
        })
        .collect()
}

/// Combines conflicts after entity-name projection. Each input is already in
/// canonical order, so the public conflict order is independent of map
/// iteration order.
fn projection_conflicts<'page, 'tag>(
    pages: impl IntoIterator<Item = (&'page PageId, &'page str)>,
    tags: impl IntoIterator<Item = (&'tag TagId, &'tag str)>,
    overflow_ids: Vec<DefaultQueryId>,
    text_conflicts: Vec<GraphConflict>,
    query_conflicts: Vec<GraphConflict>,
) -> Vec<GraphConflict> {
    let mut page_names = BTreeMap::<String, Vec<PageId>>::new();
    for (page_id, name) in pages {
        page_names
            .entry(canonical_entity_name(name))
            .or_default()
            .push(page_id.clone());
    }

    let mut tag_names = BTreeMap::<String, Vec<TagId>>::new();
    for (tag_id, name) in tags {
        tag_names
            .entry(canonical_entity_name(name))
            .or_default()
            .push(tag_id.clone());
    }

    let mut conflicts = page_names
        .into_iter()
        .filter_map(|(canonical_name, mut page_ids)| {
            if page_ids.len() < 2 {
                return None;
            }
            page_ids.sort();
            Some(GraphConflict::DuplicatePageName {
                canonical_name,
                page_ids,
            })
        })
        .collect::<Vec<_>>();
    conflicts.extend(
        tag_names
            .into_iter()
            .filter_map(|(canonical_name, mut tag_ids)| {
                if tag_ids.len() < 2 {
                    return None;
                }
                tag_ids.sort();
                Some(GraphConflict::DuplicateTagName {
                    canonical_name,
                    tag_ids,
                })
            }),
    );
    if !overflow_ids.is_empty() {
        conflicts.push(GraphConflict::DefaultQueryOverflow { overflow_ids });
    }
    conflicts.extend(text_conflicts);
    conflicts.extend(query_conflicts);
    conflicts
}

fn property_owner_target(owner: &PropertyOwner) -> PropertyTarget {
    match owner {
        PropertyOwner::Page { .. } => PropertyTarget::Page,
        PropertyOwner::Block { .. } => PropertyTarget::Block,
        PropertyOwner::Tag { .. } => PropertyTarget::TagMetadata,
        PropertyOwner::TagDefault { .. } => PropertyTarget::TagDefault,
    }
}

fn property_owner_from_query_owner(owner: &QueryOwner) -> Option<PropertyOwner> {
    match owner {
        QueryOwner::Page { id } => Some(PropertyOwner::Page { id: id.clone() }),
        QueryOwner::Block { owner, id } => Some(PropertyOwner::Block {
            owner: owner.clone(),
            id: id.clone(),
        }),
        QueryOwner::Tag { tag_id } => Some(PropertyOwner::Tag {
            tag_id: tag_id.clone(),
        }),
        QueryOwner::GraphDefault { .. } => None,
    }
}

fn query_owner_from_property_owner(owner: &PropertyOwner) -> Option<QueryOwner> {
    match owner {
        PropertyOwner::Page { id } => Some(QueryOwner::Page { id: id.clone() }),
        PropertyOwner::Block { owner, id } => Some(QueryOwner::Block {
            owner: owner.clone(),
            id: id.clone(),
        }),
        PropertyOwner::Tag { tag_id } => Some(QueryOwner::Tag {
            tag_id: tag_id.clone(),
        }),
        PropertyOwner::TagDefault { .. } => None,
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

fn property_member_slot(value: &PropertyValue) -> Result<String, CoreError> {
    let encoded = serde_json::to_vec(value)?;
    Ok(hex::encode(Sha256::digest(encoded)))
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

fn find_snapshot_block<'a>(
    blocks: &'a [BlockSnapshot],
    block_id: &BlockId,
) -> Option<&'a BlockSnapshot> {
    for block in blocks {
        if &block.id == block_id {
            return Some(block);
        }
        if let Some(found) = find_snapshot_block(&block.children, block_id) {
            return Some(found);
        }
    }
    None
}

fn fresh_fragment_tag_id(
    target_graph: &GraphId,
    source_graph: &GraphId,
    source_id: &TagId,
    occupied: &BTreeSet<TagId>,
) -> Result<TagId, CoreError> {
    let base = fragment_entity_id("t-copy", target_graph, source_graph, source_id.as_str());
    for suffix in 0..=MAX_STRUCTURAL_TARGETS {
        let value = if suffix == 0 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };
        let id =
            TagId::new(value).map_err(|error| CoreError::InvalidHierarchy(error.to_string()))?;
        if !occupied.contains(&id) {
            return Ok(id);
        }
    }
    Err(CoreError::InvalidHierarchy(
        "cannot allocate a copied tag id".to_owned(),
    ))
}

fn fresh_fragment_page_id(
    target_graph: &GraphId,
    source_graph: &GraphId,
    source_id: &PageId,
    occupied: &BTreeSet<PageId>,
) -> Result<PageId, CoreError> {
    let base = fragment_entity_id("p-copy", target_graph, source_graph, source_id.as_str());
    for suffix in 0..=MAX_STRUCTURAL_TARGETS {
        let value = if suffix == 0 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };
        let id =
            PageId::new(value).map_err(|error| CoreError::InvalidHierarchy(error.to_string()))?;
        if !occupied.contains(&id) {
            return Ok(id);
        }
    }
    Err(CoreError::InvalidHierarchy(
        "cannot allocate a copied page id".to_owned(),
    ))
}

fn fragment_entity_id(
    prefix: &str,
    target_graph: &GraphId,
    source_graph: &GraphId,
    source_id: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"neoseq-outline-fragment-v1\0");
    digest.update(target_graph.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(source_graph.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(source_id.as_bytes());
    format!("{prefix}-{}", hex::encode(&digest.finalize()[..12]))
}

fn validate_fragment_page_references(item: &OutlineFragmentItem) -> Result<(), CoreError> {
    let length = item.markdown.chars().count();
    let mut previous_end = 0usize;
    let mut collapsed = 0usize;
    for reference in &item.page_references {
        if reference.start < previous_end
            || reference.start >= reference.end
            || reference.end > length
            || reference.index != reference.start.saturating_sub(collapsed)
        {
            return Err(CoreError::InvalidHierarchy(
                "outline fragment contains an invalid inline page reference".to_owned(),
            ));
        }
        collapsed += reference.end - reference.start - 1;
        previous_end = reference.end;
    }
    Ok(())
}

fn write_query_document_snapshot(
    bag: &LoroMap,
    snapshot: &PropertyDocument,
) -> Result<(), CoreError> {
    let query_key = key(QUERY_PROPERTY_KEY);
    let field =
        ensure_property_field(bag, &query_key, PropertyType::Document, Cardinality::Single)?;
    let document = required_property_payload_map(&field, PROPERTY_DOCUMENT_KEY, &query_key)?;
    write_query_document_map(&document, snapshot)
}

fn write_query_document_map(
    document: &LoroMap,
    snapshot: &PropertyDocument,
) -> Result<(), CoreError> {
    snapshot.validate()?;
    document.insert("schema", snapshot.schema.as_str())?;
    document.insert("version", i64::from(snapshot.version))?;
    document.insert("default_view_id", snapshot.default_view_id.as_str())?;
    let views = document.ensure_mergeable_map("views")?;
    for view_id in views.keys() {
        views.delete(&view_id)?;
    }
    for view in &snapshot.views {
        put_query_view(document, view)?;
    }
    Ok(())
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
) -> Result<LoroMap, CoreError> {
    validate_property_shape(key, value_type, cardinality)?;
    if value_type == PropertyType::Document && cardinality == Cardinality::Set {
        return Err(CoreError::Property(PropertyError::WrongCardinality {
            key: key.to_string(),
            expected: Cardinality::Single,
            actual: Cardinality::Set,
        }));
    }
    if let Some(value) = map.get(key.as_str()) {
        let field = value_into_map(value).ok_or_else(|| {
            CoreError::InvalidHierarchy(format!("property field {key} is not a map"))
        })?;
        let existing = stored_property_shape(&field, key)?;
        validate_property_shape(key, existing.value_type, existing.cardinality)?;
        if existing.value_type != value_type {
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
        validate_property_payload_shape(&field, key, existing)?;
        return Ok(field);
    }

    // A regular child has a fresh op-derived identity. Removing the outer map
    // reference therefore makes every edit inside the old generation inert,
    // while recreating cannot surface its preserved payload.
    let field = map.insert_container(key.as_str(), LoroMap::new())?;
    let shape = StoredPropertyShape {
        value_type,
        cardinality,
    };
    field.insert(PROPERTY_SHAPE_KEY, serde_json::to_string(&shape)?)?;
    match (value_type, cardinality) {
        (PropertyType::Document, Cardinality::Single) => {
            let _ = field.ensure_mergeable_map(PROPERTY_DOCUMENT_KEY)?;
        }
        (PropertyType::Document, Cardinality::Set) => unreachable!(),
        (_, Cardinality::Set) => {
            let _ = field.ensure_mergeable_map(PROPERTY_SET_KEY)?;
        }
        (_, Cardinality::Single) => {}
    }
    Ok(field)
}

fn set_single(map: &LoroMap, key: &PropertyKey, value: &PropertyValue) -> Result<(), CoreError> {
    let field = ensure_property_field(map, key, value.property_type(), Cardinality::Single)?;
    field.insert(PROPERTY_SINGLE_KEY, encode_value(value)?)?;
    Ok(())
}

fn set_repeated(map: &LoroMap, key: &PropertyKey, value: &PropertyValue) -> Result<(), CoreError> {
    let field = ensure_property_field(map, key, value.property_type(), Cardinality::Set)?;
    required_property_payload_map(&field, PROPERTY_SET_KEY, key)?
        .insert(&property_member_slot(value)?, encode_value(value)?)?;
    Ok(())
}

fn ensure_query_document(map: &LoroMap) -> Result<LoroMap, CoreError> {
    let query_key = key(QUERY_PROPERTY_KEY);
    let created = !bag_contains_key(map, &query_key);
    let field =
        ensure_property_field(map, &query_key, PropertyType::Document, Cardinality::Single)?;
    let document = required_property_payload_map(&field, PROPERTY_DOCUMENT_KEY, &query_key)?;
    if created {
        document.insert("schema", QUERY_DOCUMENT_SCHEMA)?;
        document.insert("version", i64::from(QUERY_DOCUMENT_VERSION))?;
        let defaults = PropertyDocument::default_query(String::new());
        document.insert("default_view_id", defaults.default_view_id.as_str())?;
        for view in &defaults.views {
            put_query_view(&document, view)?;
        }
    } else {
        let decoded = decode_query_document(&document).map_err(CoreError::InvalidHierarchy)?;
        decoded.validate()?;
    }
    Ok(document)
}

/// Writes the complete query authority with one LWW map operation.
fn write_query_plan_state(definition: &LoroMap, plan: Option<&QueryPlan>) -> Result<(), CoreError> {
    let state = plan.map_or(StoredPlanState::Raw, |plan| StoredPlanState::Built {
        version: QUERY_PLAN_STATE_VERSION,
        plan: plan.clone(),
    });
    definition.insert(QUERY_PLAN_STATE_KEY, serde_json::to_string(&state)?)?;
    Ok(())
}

fn require_query_document(map: &LoroMap) -> Result<LoroMap, CoreError> {
    let query_key = key(QUERY_PROPERTY_KEY);
    let Some(field) = map.get(query_key.as_str()).and_then(value_into_map) else {
        return Err(PropertyError::InvalidDocument("query document is missing".to_owned()).into());
    };
    let shape = stored_property_shape(&field, &query_key)?;
    if shape.value_type != PropertyType::Document || shape.cardinality != Cardinality::Single {
        return Err(
            PropertyError::InvalidDocument("query property shape is invalid".to_owned()).into(),
        );
    }
    required_property_payload_map(&field, PROPERTY_DOCUMENT_KEY, &query_key)
}

fn stored_property_shape(
    field: &LoroMap,
    key: &PropertyKey,
) -> Result<StoredPropertyShape, CoreError> {
    let encoded = field
        .get(PROPERTY_SHAPE_KEY)
        .and_then(value_into_string)
        .ok_or_else(|| {
            CoreError::InvalidHierarchy(format!("property field {key} has no valid shape"))
        })?;
    Ok(serde_json::from_str(&encoded)?)
}

fn required_property_payload_map(
    field: &LoroMap,
    slot: &str,
    key: &PropertyKey,
) -> Result<LoroMap, CoreError> {
    field.get(slot).and_then(value_into_map).ok_or_else(|| {
        CoreError::InvalidHierarchy(format!("property field {key} has no valid {slot} payload"))
    })
}

fn validate_property_payload_shape(
    field: &LoroMap,
    key: &PropertyKey,
    shape: StoredPropertyShape,
) -> Result<(), CoreError> {
    match (shape.value_type, shape.cardinality) {
        (PropertyType::Document, Cardinality::Single) => {
            required_property_payload_map(field, PROPERTY_DOCUMENT_KEY, key)?;
        }
        (PropertyType::Document, Cardinality::Set) => {
            return Err(CoreError::InvalidHierarchy(format!(
                "property field {key} has invalid document cardinality"
            )));
        }
        (_, Cardinality::Set) => {
            required_property_payload_map(field, PROPERTY_SET_KEY, key)?;
        }
        (_, Cardinality::Single) => {}
    }
    Ok(())
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
        write_query_definition(
            &stored.ensure_mergeable_map("definition")?,
            &view.definition,
        )?;
    }
    Ok(())
}

fn write_query_definition(
    definition: &LoroMap,
    snapshot: &QueryDefinition,
) -> Result<(), CoreError> {
    let snapshot = normalized_query_definition(snapshot)?;
    definition.insert("language", snapshot.language.as_str())?;
    replace_text(
        &definition.ensure_mergeable_text("source")?,
        &snapshot.source,
    )?;
    write_query_plan_state(definition, snapshot.plan.as_ref())
}

fn derived_query_source(plan: &QueryPlan) -> Result<String, CoreError> {
    let source = derive_plan_source(plan)
        .map_err(|error| CoreError::Property(PropertyError::InvalidDocument(error.to_string())))?;
    if source.len() > MAX_QUERY_SOURCE_BYTES {
        return Err(CoreError::TextTooLong);
    }
    Ok(source)
}

fn normalized_query_definition(snapshot: &QueryDefinition) -> Result<QueryDefinition, CoreError> {
    if let Some(plan) = &snapshot.plan {
        let _ = derived_query_source(plan)?;
    }
    Ok(snapshot.clone())
}

fn normalized_query_view(view: &QueryView) -> Result<QueryView, CoreError> {
    let mut normalized = view.clone();
    normalized.definition = normalized_query_definition(&view.definition)?;
    normalized.validate()?;
    Ok(normalized)
}

fn normalized_query_document(document: &PropertyDocument) -> Result<PropertyDocument, CoreError> {
    let mut normalized = document.clone();
    normalized.views = document
        .views
        .iter()
        .map(normalized_query_view)
        .collect::<Result<_, _>>()?;
    normalized.validate()?;
    Ok(normalized)
}

fn require_query_view(document: &LoroMap, view_id: &QueryViewId) -> Result<LoroMap, CoreError> {
    let view = document
        .get("views")
        .and_then(value_into_map)
        .and_then(|views| views.get(view_id.as_str()))
        .and_then(value_into_map)
        .ok_or_else(|| PropertyError::InvalidDocument("query view does not exist".to_owned()))?;
    if map_bool(&view, "deleted") == Some(true) {
        return Err(PropertyError::InvalidDocument("query view does not exist".to_owned()).into());
    }
    Ok(view)
}

fn require_query_definition(
    document: &LoroMap,
    view_id: &QueryViewId,
) -> Result<LoroMap, CoreError> {
    require_query_view(document, view_id)?
        .get("definition")
        .and_then(value_into_map)
        .ok_or_else(|| {
            PropertyError::InvalidDocument("query view definition is missing".to_owned()).into()
        })
}

struct ProjectedQueryDocument {
    document: PropertyDocument,
    overflow_ids: Vec<QueryViewId>,
    unavailable_default: Option<(QueryViewId, QueryViewId)>,
    source_overflows: Vec<(QueryViewId, usize)>,
}

fn append_query_projection_conflicts(
    conflicts: &mut Vec<GraphConflict>,
    owner: QueryOwner,
    projection: &ProjectedQueryDocument,
) {
    if !projection.overflow_ids.is_empty() {
        conflicts.push(GraphConflict::QueryViewOverflow {
            owner: owner.clone(),
            overflow_ids: projection.overflow_ids.clone(),
        });
    }
    if let Some((requested_view_id, fallback_view_id)) = &projection.unavailable_default {
        conflicts.push(GraphConflict::QueryDefaultViewUnavailable {
            owner: owner.clone(),
            requested_view_id: requested_view_id.clone(),
            fallback_view_id: fallback_view_id.clone(),
        });
    }
    for (view_id, actual_bytes) in &projection.source_overflows {
        conflicts.push(GraphConflict::TextLimitExceeded {
            target: TextTarget::QuerySource {
                owner: owner.clone(),
                view_id: view_id.clone(),
            },
            actual_bytes: *actual_bytes,
            limit: MAX_QUERY_SOURCE_BYTES,
        });
    }
}

fn decode_query_document(document: &LoroMap) -> Result<PropertyDocument, String> {
    Ok(project_query_document(document)?.document)
}

fn project_query_document(document: &LoroMap) -> Result<ProjectedQueryDocument, String> {
    let schema = map_string(document, "schema")
        .ok_or_else(|| "query document schema is missing".to_owned())?;
    let version = map_i64(document, "version")
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "query document version is invalid".to_owned())?;
    project_query_document_with(document, schema, version, |view, raw_id| {
        read_query_definition(
            &view
                .get("definition")
                .and_then(value_into_map)
                .ok_or_else(|| format!("query view {raw_id} definition is missing"))?,
            &format!("query view {raw_id}"),
        )
    })
}

fn project_query_document_with(
    document: &LoroMap,
    schema: String,
    version: u32,
    mut decode_definition: impl FnMut(&LoroMap, &str) -> Result<QueryDefinition, String>,
) -> Result<ProjectedQueryDocument, String> {
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
            let definition = decode_definition(&view, raw_id)?;
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
                definition,
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
        // Distinct locally valid removals can jointly delete every view. Keep
        // reads total with an ephemeral, deterministic fallback; the raw
        // tombstones and unavailable canonical selection stay untouched.
        decoded.push(
            PropertyDocument::default_query(String::new())
                .views
                .remove(0),
        );
    }
    // Shape corruption is never mergeable. Source length is different: each
    // branch can stay within budget while LoroText retains both insertions, so
    // it belongs to the conflict projection rather than import validation.
    for view in &decoded {
        view.validate_structure()
            .map_err(|error| error.to_string())?;
    }
    let source_overflows = decoded
        .iter()
        .filter(|view| view.definition.source.len() > MAX_QUERY_SOURCE_BYTES)
        .map(|view| (view.id.clone(), view.definition.source.len()))
        .collect();
    let overflow = if decoded.len() > MAX_QUERY_VIEWS {
        decoded.split_off(MAX_QUERY_VIEWS)
    } else {
        Vec::new()
    };
    let overflow_ids = overflow.into_iter().map(|view| view.id).collect();
    let default_view_id = if decoded
        .iter()
        .any(|view| view.id == requested_default_view_id)
    {
        requested_default_view_id.clone()
    } else {
        decoded[0].id.clone()
    };
    let unavailable_default = (default_view_id != requested_default_view_id)
        .then(|| (requested_default_view_id, default_view_id.clone()));
    let snapshot = PropertyDocument {
        schema,
        version,
        views: decoded,
        default_view_id,
    };
    snapshot
        .validate_structure()
        .map_err(|error| error.to_string())?;
    Ok(ProjectedQueryDocument {
        document: snapshot,
        overflow_ids,
        unavailable_default,
        source_overflows,
    })
}

fn read_query_definition(map: &LoroMap, label: &str) -> Result<QueryDefinition, String> {
    let language =
        map_string(map, "language").ok_or_else(|| format!("{label} language is missing"))?;
    let raw_source = map
        .get("source")
        .and_then(value_into_text)
        .map(|text| text.to_string())
        .ok_or_else(|| format!("{label} source is missing"))?;
    let candidate = decode_query_plan_state(map, label).map_err(|error| error.to_string())?;
    let (source, plan) = match candidate {
        Some(plan) => (
            derived_query_source(&plan).unwrap_or(raw_source),
            Some(plan),
        ),
        None => (raw_source, None),
    };
    Ok(QueryDefinition {
        source,
        language,
        plan,
    })
}

fn default_queries_map(doc: &LoroDoc) -> Result<LoroMap, CoreError> {
    let settings = doc.get_map("graph_settings");
    if map_i64(&settings, "schema_version") != Some(i64::from(GRAPH_SETTINGS_SCHEMA_VERSION)) {
        return Err(CoreError::InvalidHierarchy(
            "graph settings schema is missing or unsupported".to_owned(),
        ));
    }
    settings
        .get("default_queries")
        .and_then(value_into_map)
        .ok_or_else(|| {
            CoreError::InvalidHierarchy("graph default queries map is missing".to_owned())
        })
}

struct StoredDefaultQuery {
    id: DefaultQueryId,
    title: String,
    position: u32,
    document: LoroMap,
}

fn stored_default_queries(doc: &LoroDoc) -> Result<Vec<StoredDefaultQuery>, CoreError> {
    let queries = default_queries_map(doc)?;
    let mut stored = Vec::new();
    let mut issue = None;
    queries.for_each(|raw_id, value| {
        if issue.is_some() {
            return;
        }
        let parsed = (|| {
            let id = DefaultQueryId::new(raw_id).map_err(|error| error.to_string())?;
            let entry = value_into_map(value)
                .ok_or_else(|| format!("default query {raw_id} is not a map"))?;
            let deleted = map_bool(&entry, "deleted")
                .ok_or_else(|| format!("default query {raw_id} tombstone is missing"))?;
            if deleted {
                return Ok(None);
            }
            let title = map_string(&entry, "title")
                .ok_or_else(|| format!("default query {raw_id} title is missing"))?;
            if title.chars().count() > MAX_DEFAULT_QUERY_TITLE {
                return Err(format!("default query {raw_id} title is too long"));
            }
            let position = map_i64(&entry, "position")
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| format!("default query {raw_id} position is invalid"))?;
            let document = entry
                .get("document")
                .and_then(value_into_map)
                .ok_or_else(|| format!("default query {raw_id} document is missing"))?;
            Ok(Some(StoredDefaultQuery {
                id,
                title,
                position,
                document,
            }))
        })();
        match parsed {
            Ok(Some(query)) => stored.push(query),
            Ok(None) => {}
            Err(error) => issue = Some(error),
        }
    });
    if let Some(issue) = issue {
        return Err(CoreError::InvalidHierarchy(issue));
    }
    stored.sort_by(|left, right| {
        left.position
            .cmp(&right.position)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(stored)
}

struct ProjectedGraphSettings {
    settings: GraphSettings,
    overflow_ids: Vec<DefaultQueryId>,
    query_conflicts: Vec<GraphConflict>,
}

struct ProjectedGraph {
    pages: BTreeMap<PageId, PageSnapshot>,
    page_directory: Vec<PageDirectoryEntry>,
    tags: Vec<TagSnapshot>,
    settings: GraphSettings,
    conflicts: Vec<GraphConflict>,
    quarantined: Vec<String>,
}

#[derive(Default)]
struct ProjectionDiagnostics {
    quarantined: Vec<String>,
    text_conflicts: Vec<GraphConflict>,
    query_conflicts: Vec<GraphConflict>,
}

impl ProjectionDiagnostics {
    fn sort(&mut self) {
        self.quarantined.sort();
        self.text_conflicts.sort_by_cached_key(conflict_sort_key);
        self.query_conflicts.sort_by_cached_key(conflict_sort_key);
    }
}

fn conflict_sort_key(conflict: &GraphConflict) -> String {
    serde_json::to_string(conflict).expect("graph conflicts are always JSON-serializable")
}

/// Decodes every canonical entry, then bounds only the published projection.
/// A merge may exceed the local creation limit; dropping those entries would
/// lose valid CRDT operations, while rejecting them would break merge closure.
fn project_graph_settings(doc: &LoroDoc) -> Result<ProjectedGraphSettings, CoreError> {
    let mut visible = Vec::new();
    let mut overflow_ids = Vec::new();
    let mut query_conflicts = Vec::new();
    for (index, stored) in stored_default_queries(doc)?.into_iter().enumerate() {
        let query_projection =
            project_query_document(&stored.document).map_err(CoreError::InvalidHierarchy)?;
        append_query_projection_conflicts(
            &mut query_conflicts,
            QueryOwner::GraphDefault {
                default_query_id: stored.id.clone(),
            },
            &query_projection,
        );
        if index < MAX_DEFAULT_QUERIES {
            visible.push(DefaultQuerySnapshot {
                id: stored.id,
                title: stored.title,
                position: stored.position,
                document: query_projection.document,
            });
        } else {
            overflow_ids.push(stored.id);
        }
    }
    Ok(ProjectedGraphSettings {
        settings: GraphSettings {
            default_queries: visible,
        },
        overflow_ids,
        query_conflicts,
    })
}

fn graph_settings_snapshot(doc: &LoroDoc) -> Result<GraphSettings, CoreError> {
    Ok(project_graph_settings(doc)?.settings)
}

fn validate_current_graph_settings(doc: &LoroDoc) -> Result<(), CoreError> {
    project_graph_settings(doc).map(|_| ())
}

fn bag_contains_key(map: &LoroMap, key: &PropertyKey) -> bool {
    map.get(key.as_str()).is_some()
}

fn clear_property_values(map: &LoroMap, key: &PropertyKey) -> Result<(), CoreError> {
    let Some(field) = map.get(key.as_str()).and_then(value_into_map) else {
        return Ok(());
    };
    let shape = stored_property_shape(&field, key)?;
    match (shape.value_type, shape.cardinality) {
        (PropertyType::Document, _) => {
            return Err(PropertyError::DocumentCommandRequired(key.to_string()).into());
        }
        (_, Cardinality::Single) => {
            field.delete(PROPERTY_SINGLE_KEY)?;
        }
        (_, Cardinality::Set) => {
            let values = required_property_payload_map(&field, PROPERTY_SET_KEY, key)?;
            for member in values.keys() {
                values.delete(&member)?;
            }
        }
    }
    Ok(())
}

fn remove_property_field(map: &LoroMap, key: &PropertyKey) -> Result<(), CoreError> {
    // Deleting only the selected generation is the remove-wins boundary. Any
    // concurrent operation against that generation remains causally valid but
    // unreachable; a later declaration inserts a fresh regular child.
    map.delete(key.as_str())?;
    Ok(())
}

fn remove_repeated_value(
    map: &LoroMap,
    key: &PropertyKey,
    value: &PropertyValue,
) -> Result<(), CoreError> {
    let Some(field) = map.get(key.as_str()).and_then(value_into_map) else {
        return Ok(());
    };
    let shape = stored_property_shape(&field, key)?;
    if shape.value_type != value.property_type() || shape.cardinality != Cardinality::Set {
        return Ok(());
    }
    required_property_payload_map(&field, PROPERTY_SET_KEY, key)?
        .delete(&property_member_slot(value)?)?;
    Ok(())
}

fn decode_bag(map: &LoroMap) -> (PropertyBag, Vec<String>) {
    let mut ignored_query_conflicts = Vec::new();
    decode_bag_with_owner(map, None, &mut ignored_query_conflicts)
}

fn project_bag_child(
    parent: &LoroMap,
    name: &str,
    owner: Option<&PropertyOwner>,
    diagnostics: &mut ProjectionDiagnostics,
) -> (PropertyBag, Vec<String>) {
    match parent.get(name).and_then(value_into_map) {
        Some(map) => decode_bag_with_owner(&map, owner, &mut diagnostics.query_conflicts),
        None => (
            PropertyBag::new(),
            vec![format!("property-bag:{name}:missing-or-invalid")],
        ),
    }
}

fn decode_bag_with_owner(
    map: &LoroMap,
    owner: Option<&PropertyOwner>,
    query_conflicts: &mut Vec<GraphConflict>,
) -> (PropertyBag, Vec<String>) {
    let mut fields = BTreeMap::<PropertyKey, PropertyField>::new();
    let mut issues = Vec::new();
    map.for_each(|slot, value| {
        let Ok(key) = PropertyKey::new(slot) else {
            issues.push(format!("property-slot:{slot}:invalid-key"));
            return;
        };
        let Some(stored) = value_into_map(value) else {
            issues.push(format!("property-slot:{slot}:not-field-map"));
            return;
        };
        let Ok(shape) = stored_property_shape(&stored, &key) else {
            issues.push(format!("property-slot:{slot}:invalid-shape"));
            return;
        };
        if validate_property_shape(&key, shape.value_type, shape.cardinality).is_err() {
            issues.push(format!("property-slot:{slot}:contract-violation"));
            return;
        }
        let payload_key = match (shape.value_type, shape.cardinality) {
            (PropertyType::Document, Cardinality::Single) => PROPERTY_DOCUMENT_KEY,
            (PropertyType::Document, Cardinality::Set) => {
                issues.push(format!("property-slot:{slot}:invalid-document-cardinality"));
                return;
            }
            (_, Cardinality::Single) => PROPERTY_SINGLE_KEY,
            (_, Cardinality::Set) => PROPERTY_SET_KEY,
        };
        if stored
            .keys()
            .any(|name| name.as_ref() != PROPERTY_SHAPE_KEY && name.as_ref() != payload_key)
        {
            issues.push(format!("property-slot:{slot}:invalid-payload-slot"));
            return;
        }
        let mut field = PropertyField {
            key: key.clone(),
            value_type: shape.value_type,
            cardinality: shape.cardinality,
            values: Vec::new(),
        };
        match (shape.value_type, shape.cardinality) {
            (PropertyType::Document, Cardinality::Single) => {
                let Some(document) = stored.get(PROPERTY_DOCUMENT_KEY).and_then(value_into_map)
                else {
                    issues.push(format!("property-slot:{slot}:not-document-map"));
                    return;
                };
                let schema = map_string(&document, "schema");
                let version =
                    map_i64(&document, "version").and_then(|value| u32::try_from(value).ok());
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
                        let Ok(projection) = project_query_document(&document) else {
                            issues.push(format!("property-slot:{slot}:invalid-document"));
                            fields.insert(key, field);
                            return;
                        };
                        if let Some(owner) = owner.and_then(query_owner_from_property_owner) {
                            append_query_projection_conflicts(query_conflicts, owner, &projection);
                        }
                        field.values = vec![PropertyValue::Document(projection.document)];
                    }
                    _ => {
                        issues.push(format!("property-slot:{slot}:invalid-document-header"));
                        fields.insert(key, field);
                        return;
                    }
                }
            }
            (PropertyType::Document, Cardinality::Set) => unreachable!(),
            (_, Cardinality::Single) => {
                let Some(value) = stored.get(PROPERTY_SINGLE_KEY) else {
                    fields.insert(key, field);
                    return;
                };
                let Some(encoded) = value_into_string(value) else {
                    issues.push(format!("property-slot:{slot}:not-atomic-string"));
                    return;
                };
                let Ok(value) = serde_json::from_str::<PropertyValue>(&encoded) else {
                    issues.push(format!("property-slot:{slot}:invalid-value"));
                    return;
                };
                if value.property_type() != shape.value_type
                    || validate_property(&key, &value, Cardinality::Single).is_err()
                {
                    issues.push(format!("property-slot:{slot}:contract-violation"));
                    return;
                }
                field.values.push(value);
            }
            (_, Cardinality::Set) => {
                let Some(values) = stored.get(PROPERTY_SET_KEY).and_then(value_into_map) else {
                    issues.push(format!("property-slot:{slot}:not-set-map"));
                    return;
                };
                let mut valid = true;
                values.for_each(|member, value| {
                    let Some(encoded) = value_into_string(value) else {
                        issues.push(format!(
                            "property-slot:{slot}:member:{member}:not-atomic-string"
                        ));
                        valid = false;
                        return;
                    };
                    let Ok(value) = serde_json::from_str::<PropertyValue>(&encoded) else {
                        issues.push(format!(
                            "property-slot:{slot}:member:{member}:invalid-value"
                        ));
                        valid = false;
                        return;
                    };
                    let member_matches =
                        property_member_slot(&value).is_ok_and(|expected| expected == member);
                    if value.property_type() != shape.value_type
                        || validate_property(&key, &value, Cardinality::Set).is_err()
                        || !member_matches
                    {
                        issues.push(format!(
                            "property-slot:{slot}:member:{member}:contract-violation"
                        ));
                        valid = false;
                        return;
                    }
                    field.values.push(value);
                });
                if !valid {
                    return;
                }
            }
        }
        if validate_property_field(&field).is_err() {
            issues.push(format!("property-slot:{slot}:contract-violation"));
            return;
        }
        field
            .values
            .sort_by_key(|value| serde_json::to_string(value).unwrap_or_default());
        fields.insert(key, field);
    });
    issues.sort();
    let fields = PropertyBag::try_from_fields(fields.into_values())
        .expect("property fields decoded from distinct Loro map slots are valid and unique");
    (fields, issues)
}

struct ProjectedPageHeader {
    directory: PageDirectoryEntry,
    snapshot: Option<PageSnapshot>,
}

fn project_page_header(
    page_id: &PageId,
    page: &LoroMap,
    live_tags: &BTreeSet<TagId>,
    diagnostics: &mut ProjectionDiagnostics,
) -> Option<ProjectedPageHeader> {
    let Some(root) = page.get("root").and_then(value_into_map) else {
        diagnostics
            .quarantined
            .push(format!("page:{page_id}:root:missing-or-invalid"));
        return None;
    };
    let title = match root.get("content") {
        Some(ValueOrContainer::Container(Container::Text(text))) => text.to_string(),
        _ => {
            diagnostics
                .quarantined
                .push(format!("page:{page_id}:root:missing-content"));
            String::new()
        }
    };
    let property_owner = PropertyOwner::Page {
        id: page_id.clone(),
    };
    let (mut properties, mut issues) =
        project_bag_child(&root, "properties", Some(&property_owner), diagnostics);
    diagnostics.quarantined.append(&mut issues);
    properties.retain(|entry| {
        if validate_property_target(&entry.key, PropertyTarget::Page).is_ok() {
            true
        } else {
            diagnostics.quarantined.push(format!(
                "page:{page_id}:property:{}:invalid-target",
                entry.key
            ));
            false
        }
    });
    let deleted = properties.contains_key("builtin.deleted-at");
    let journal_date = properties
        .get("builtin.journal-date")
        .and_then(|field| field.values.first())
        .and_then(|value| match value {
            PropertyValue::Date(date) => Some(date.clone()),
            _ => None,
        });
    let directory = PageDirectoryEntry {
        id: page_id.clone(),
        title: journal_date
            .as_ref()
            .map_or_else(|| title.clone(), ToString::to_string),
        journal_date,
        deleted,
    };
    let snapshot = if deleted {
        None
    } else {
        Some(PageSnapshot {
            id: page_id.clone(),
            title,
            properties,
            tags: decode_tag_refs(
                &root,
                &format!("page:{page_id}"),
                live_tags,
                &mut diagnostics.quarantined,
            ),
            blocks: Vec::new(),
        })
    };
    Some(ProjectedPageHeader {
        directory,
        snapshot,
    })
}

fn page_metadata(
    page_id: &PageId,
    page: &LoroMap,
    live_tags: &BTreeSet<TagId>,
    quarantined: &mut Vec<String>,
) -> Option<PageSnapshot> {
    let mut diagnostics = ProjectionDiagnostics::default();
    let snapshot = project_page_header(page_id, page, live_tags, &mut diagnostics)
        .and_then(|header| header.snapshot);
    quarantined.append(&mut diagnostics.quarantined);
    snapshot
}

fn page_directory(doc: &LoroDoc, quarantined: &mut Vec<String>) -> Vec<PageDirectoryEntry> {
    let live_tags = live_tag_ids(doc);
    let mut diagnostics = ProjectionDiagnostics::default();
    let mut entries = BTreeMap::new();
    doc.get_map("pages").for_each(|raw_id, value| {
        let Ok(page_id) = PageId::new(raw_id) else {
            diagnostics
                .quarantined
                .push(format!("page:{raw_id}:invalid-id"));
            return;
        };
        let Some(page) = value_into_map(value) else {
            diagnostics
                .quarantined
                .push(format!("page:{raw_id}:not-map"));
            return;
        };
        let Some(header) = project_page_header(&page_id, &page, &live_tags, &mut diagnostics)
        else {
            return;
        };
        entries.insert(page_id, header.directory);
    });
    quarantined.append(&mut diagnostics.quarantined);
    entries.into_values().collect()
}

fn materialize_block_content(
    text: &LoroText,
    directory: &BTreeMap<PageId, PageDirectoryEntry>,
    owner: &str,
    quarantined: &mut Vec<String>,
) -> (String, Vec<PageReferenceSpan>, Vec<InlineContent>) {
    let mut markdown = String::new();
    let mut references = Vec::new();
    let mut content = Vec::new();
    let mut plain = String::new();
    let mut display_index = 0;
    let mut logical_index = 0;

    for segment in text.to_delta() {
        let TextDelta::Insert { insert, attributes } = segment else {
            quarantined.push(format!("{owner}:page-reference:invalid-delta"));
            continue;
        };
        let marked_page = attributes
            .as_ref()
            .and_then(|attributes| attributes.get(PAGE_REFERENCE_MARK))
            .and_then(|value| match value {
                LoroValue::String(value) => PageId::new(value.as_ref()).ok(),
                _ => None,
            });
        if marked_page.is_some() && !insert.contains(PAGE_REFERENCE_CHAR) {
            quarantined.push(format!("{owner}:page-reference:mark-without-atom"));
        }

        for character in insert.chars() {
            if character == PAGE_REFERENCE_CHAR {
                if let Some(page_id) = &marked_page {
                    if !plain.is_empty() {
                        content.push(InlineContent::Markdown {
                            value: std::mem::take(&mut plain),
                        });
                    }
                    content.push(InlineContent::PageReference {
                        page_id: page_id.clone(),
                    });
                    let title = directory
                        .get(page_id)
                        .map(|entry| entry.title.as_str())
                        .unwrap_or_else(|| page_id.as_str());
                    let source = format!("[[{title}]]");
                    let length = source.chars().count();
                    markdown.push_str(&source);
                    references.push(PageReferenceSpan {
                        start: display_index,
                        end: display_index + length,
                        index: logical_index,
                        page_id: page_id.clone(),
                    });
                    display_index += length;
                } else {
                    markdown.push('\u{fffd}');
                    plain.push('\u{fffd}');
                    display_index += 1;
                    quarantined.push(format!("{owner}:page-reference:invalid-atom"));
                }
            } else {
                markdown.push(character);
                plain.push(character);
                display_index += 1;
            }
            logical_index += 1;
        }
    }

    if !plain.is_empty() {
        content.push(InlineContent::Markdown { value: plain });
    }
    (markdown, references, content)
}

fn tag_summaries(doc: &LoroDoc, quarantined: &mut Vec<String>) -> Vec<TagSummary> {
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
        if let Some(snapshot) = tag_summary(&tag_id, &tag, quarantined) {
            snapshots.insert(tag_id, snapshot);
        }
    });
    snapshots.into_values().collect()
}

fn tag_outline(tag: &LoroMap) -> Result<LoroTree, CoreError> {
    let value = tag
        .get("outline")
        .ok_or_else(|| CoreError::InvalidHierarchy("tag outline is missing".to_owned()))?;
    let outline = value_into_tree(value)
        .ok_or_else(|| CoreError::InvalidHierarchy("tag outline is invalid".to_owned()))?;
    outline.enable_fractional_index(0);
    Ok(outline)
}

fn tag_snapshots(
    doc: &LoroDoc,
    live_tags: &BTreeSet<TagId>,
    directory: &BTreeMap<PageId, PageDirectoryEntry>,
    quarantined: &mut Vec<String>,
) -> Result<Vec<TagSnapshot>, CoreError> {
    let mut snapshots = Vec::new();
    for summary in tag_summaries(doc, quarantined) {
        let tag = doc
            .get_map("tags")
            .get(summary.id.as_str())
            .and_then(value_into_map)
            .ok_or_else(|| CoreError::TagNotFound(summary.id.clone()))?;
        let mut blocks = Vec::new();
        let outline = tag_outline(&tag)?;
        let owner = OutlineOwner::Tag {
            id: summary.id.clone(),
        };
        for root in outline.roots() {
            blocks.push(block_snapshot(
                &outline,
                root,
                &owner,
                live_tags,
                directory,
                quarantined,
            )?);
        }
        snapshots.push(TagSnapshot {
            id: summary.id,
            name: summary.name,
            properties: summary.properties,
            defaults: summary.defaults,
            blocks,
        });
    }
    Ok(snapshots)
}

fn tag_snapshot_by_id(
    doc: &LoroDoc,
    tag_id: &TagId,
    live_tags: &BTreeSet<TagId>,
    directory: &BTreeMap<PageId, PageDirectoryEntry>,
    quarantined: &mut Vec<String>,
) -> Result<Option<TagSnapshot>, CoreError> {
    let tag = doc
        .get_map("tags")
        .get(tag_id.as_str())
        .and_then(value_into_map);
    let Some(tag) = tag else {
        return Ok(None);
    };
    let Some(summary) = tag_summary(tag_id, &tag, quarantined) else {
        return Ok(None);
    };
    let mut blocks = Vec::new();
    let outline = tag_outline(&tag)?;
    let owner = OutlineOwner::Tag { id: tag_id.clone() };
    for root in outline.roots() {
        blocks.push(block_snapshot(
            &outline,
            root,
            &owner,
            live_tags,
            directory,
            quarantined,
        )?);
    }
    Ok(Some(TagSnapshot {
        id: summary.id,
        name: summary.name,
        properties: summary.properties,
        defaults: summary.defaults,
        blocks,
    }))
}

fn project_tag_summary(
    tag_id: &TagId,
    tag: &LoroMap,
    diagnostics: &mut ProjectionDiagnostics,
) -> Option<TagSummary> {
    let Some(name) = map_string(tag, "name") else {
        diagnostics
            .quarantined
            .push(format!("tag:{tag_id}:missing-name"));
        return None;
    };
    let property_owner = PropertyOwner::Tag {
        tag_id: tag_id.clone(),
    };
    let (mut properties, mut issues) =
        project_bag_child(tag, "properties", Some(&property_owner), diagnostics);
    diagnostics.quarantined.append(&mut issues);
    if properties.contains_key("builtin.deleted-at") {
        return None;
    }
    properties
        .retain(|entry| validate_property_target(&entry.key, PropertyTarget::TagMetadata).is_ok());
    let default_owner = PropertyOwner::TagDefault {
        tag_id: tag_id.clone(),
    };
    let (mut defaults, mut issues) =
        project_bag_child(tag, "defaults", Some(&default_owner), diagnostics);
    diagnostics.quarantined.append(&mut issues);
    defaults.retain(|field| {
        validate_property_write(&field.key, PropertyTarget::TagDefault).is_ok()
            && validate_property_field(field).is_ok()
    });
    Some(TagSummary {
        id: tag_id.clone(),
        name,
        properties,
        defaults,
    })
}

fn tag_summary(tag_id: &TagId, tag: &LoroMap, quarantined: &mut Vec<String>) -> Option<TagSummary> {
    let mut diagnostics = ProjectionDiagnostics::default();
    let summary = project_tag_summary(tag_id, tag, &mut diagnostics);
    quarantined.append(&mut diagnostics.quarantined);
    summary
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
    owner: &OutlineOwner,
    live_tags: &BTreeSet<TagId>,
    directory: &BTreeMap<PageId, PageDirectoryEntry>,
    quarantined: &mut Vec<String>,
) -> Result<BlockSnapshot, CoreError> {
    let mut diagnostics = ProjectionDiagnostics::default();
    let snapshot =
        project_block_snapshot(outline, node, owner, live_tags, directory, &mut diagnostics)?;
    quarantined.append(&mut diagnostics.quarantined);
    Ok(snapshot)
}

fn project_block_snapshot(
    outline: &LoroTree,
    node: TreeID,
    owner: &OutlineOwner,
    live_tags: &BTreeSet<TagId>,
    directory: &BTreeMap<PageId, PageDirectoryEntry>,
    diagnostics: &mut ProjectionDiagnostics,
) -> Result<BlockSnapshot, CoreError> {
    let meta = outline.get_meta(node)?;
    let id = block_id(node);
    let (markdown, page_references, content) = match meta.get("content") {
        Some(ValueOrContainer::Container(Container::Text(text))) => {
            let actual_bytes = text.to_string().len();
            if actual_bytes > MAX_BLOCK_TEXT_BYTES {
                diagnostics
                    .text_conflicts
                    .push(GraphConflict::TextLimitExceeded {
                        target: TextTarget::BlockContent {
                            owner: owner.clone(),
                            block_id: id.clone(),
                        },
                        actual_bytes,
                        limit: MAX_BLOCK_TEXT_BYTES,
                    });
            }
            materialize_block_content(
                &text,
                directory,
                &format!("block:{node}"),
                &mut diagnostics.quarantined,
            )
        }
        _ => {
            diagnostics
                .quarantined
                .push(format!("block:{node}:missing-content"));
            (String::new(), Vec::new(), Vec::new())
        }
    };
    let property_owner = PropertyOwner::Block {
        owner: owner.clone(),
        id: id.clone(),
    };
    let (mut properties, mut issues) =
        project_bag_child(&meta, "properties", Some(&property_owner), diagnostics);
    diagnostics.quarantined.append(&mut issues);
    properties.retain(|entry| {
        let valid = validate_property_target(&entry.key, PropertyTarget::Block).is_ok();
        if !valid {
            diagnostics.quarantined.push(format!(
                "block:{node}:property:{}:invalid-target",
                entry.key
            ));
        }
        valid
    });
    let tags = decode_tag_refs(
        &meta,
        &format!("block:{node}"),
        live_tags,
        &mut diagnostics.quarantined,
    );
    let mut children = Vec::new();
    for child in outline.children(node).unwrap_or_default() {
        children.push(project_block_snapshot(
            outline,
            child,
            owner,
            live_tags,
            directory,
            diagnostics,
        )?);
    }
    Ok(BlockSnapshot {
        id,
        content,
        markdown,
        page_references,
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

fn value_into_text(value: ValueOrContainer) -> Option<LoroText> {
    match value {
        ValueOrContainer::Container(Container::Text(text)) => Some(text),
        _ => None,
    }
}

pub(crate) fn enable_outlines(doc: &LoroDoc) -> Result<(), CoreError> {
    let mut outlines = Vec::new();
    for root in [doc.get_map("pages"), doc.get_map("tags")] {
        root.for_each(|_, value| {
            if let Some(owner) = value_into_map(value)
                && let Some(outline) = owner.get("outline").and_then(value_into_tree)
            {
                outlines.push(outline);
            }
        });
    }
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
    use domain::{
        BlockContentSplice, CommandId, InlineContent, LocalDate, MarkdownSplice, PropertyChange,
        QueryViewFieldSort, QueryViewSort, SplitPlacement,
    };

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
    fn query_definition(source: &str) -> QueryDefinition {
        QueryDefinition {
            source: source.to_owned(),
            language: domain::QUERY_LANGUAGE.to_owned(),
            plan: None,
        }
    }
    fn query_plan(subject: &str) -> QueryPlan {
        QueryPlan {
            version: domain::QUERY_PLAN_VERSION,
            payload: serde_json::json!({
                "version": domain::QUERY_PLAN_VERSION,
                "grain": "entity",
                "subject": subject,
                "where": {
                    "kind": "group",
                    "id": "root",
                    "match": "all",
                    "children": [],
                },
                "columns": [{
                    "id": "subject",
                    "source": { "kind": "subject" },
                }],
                "limit": 100,
            })
            .to_string(),
        }
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
                    owner: OutlineOwner::Page {
                        id: page_id.clone(),
                    },
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

    fn property_bag(fields: Vec<PropertyField>) -> PropertyBag {
        PropertyBag::try_from(fields).unwrap()
    }

    fn property_string<'a>(bag: &'a PropertyBag, raw_key: &str) -> Option<&'a str> {
        match bag.get(raw_key)?.values.first()? {
            PropertyValue::String(value) => Some(value.as_str()),
            _ => None,
        }
    }

    fn property_date<'a>(bag: &'a PropertyBag, raw_key: &str) -> Option<&'a str> {
        match bag.get(raw_key)?.values.first()? {
            PropertyValue::Date(value) => Some(value.as_str()),
            _ => None,
        }
    }

    #[test]
    fn batch_preflights_cross_owner_intent_and_undoes_it_once() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block_id = insert_root(&mut core, "block", &page(), 0, "tag me");
        let tag_id = TagId::new("project").unwrap();
        let owner = OutlineOwner::Page { id: page() };

        core.execute(
            envelope(
                "create-and-attach",
                Command::Batch {
                    commands: vec![
                        Command::EnsureTag {
                            tag_id: tag_id.clone(),
                            name: "Project".into(),
                        },
                        Command::SetProperty {
                            owner: PropertyOwner::Tag {
                                tag_id: tag_id.clone(),
                            },
                            key: key("builtin.tag-order"),
                            value: PropertyValue::Number(7.0),
                        },
                        Command::AddTag {
                            entity: EntityId::Block {
                                owner: owner.clone(),
                                id: block_id.clone(),
                            },
                            tag_id: tag_id.clone(),
                        },
                    ],
                },
            ),
            "t3",
        )
        .unwrap();

        let snapshot = core.snapshot().unwrap();
        assert_eq!(snapshot.tags.len(), 1);
        assert_eq!(snapshot.pages[0].blocks[0].tags, vec![tag_id.clone()]);

        core.execute(envelope("undo-batch", Command::Undo), "t4")
            .unwrap();
        let snapshot = core.snapshot().unwrap();
        assert!(snapshot.tags.is_empty());
        assert!(snapshot.pages[0].blocks[0].tags.is_empty());
    }

    #[test]
    fn batch_resolves_generated_tree_ids_on_the_live_document() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let source = insert_root(&mut core, "source", &page(), 0, "source");
        let owner = OutlineOwner::Page { id: page() };

        let execution = core
            .execute(
                envelope(
                    "insert-and-merge",
                    Command::Batch {
                        commands: vec![
                            Command::InsertBlock {
                                owner: owner.clone(),
                                parent: None,
                                index: 0,
                                markdown: "target".into(),
                            },
                            Command::MergeBlockBackward {
                                owner,
                                block_id: source.clone(),
                            },
                        ],
                    },
                ),
                "t3",
            )
            .unwrap();

        let created = execution.result.created_block.unwrap();
        let outline = core.page_snapshot(&page()).unwrap();
        assert_eq!(outline.blocks.len(), 1);
        assert_eq!(outline.blocks[0].id, created);
        assert_eq!(outline.blocks[0].markdown, "targetsource");

        core.execute(envelope("undo-batch", Command::Undo), "t4")
            .unwrap();
        let outline = core.page_snapshot(&page()).unwrap();
        assert_eq!(outline.blocks.len(), 1);
        assert_eq!(outline.blocks[0].markdown, "source");
    }

    #[test]
    fn rejected_batch_leaves_no_partial_entity() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let tag_id = TagId::new("project").unwrap();
        let before = core.frontier();

        let error = core
            .execute(
                envelope(
                    "invalid-batch",
                    Command::Batch {
                        commands: vec![
                            Command::EnsureTag {
                                tag_id: tag_id.clone(),
                                name: "Project".into(),
                            },
                            Command::SetProperty {
                                owner: PropertyOwner::Tag { tag_id },
                                key: key("builtin.created-at"),
                                value: PropertyValue::String("forged".into()),
                            },
                        ],
                    },
                ),
                "t1",
            )
            .unwrap_err();

        assert!(matches!(error, CoreError::Property(_)));
        assert_eq!(core.frontier(), before);
        assert!(core.snapshot().unwrap().tags.is_empty());
    }

    #[test]
    fn model_tag_owns_an_editable_outline() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let tag = TagId::new("project").unwrap();
        core.execute(
            envelope(
                "tag",
                Command::EnsureTag {
                    tag_id: tag.clone(),
                    name: "Project".into(),
                },
            ),
            "t1",
        )
        .unwrap();

        let created = core
            .execute(
                envelope(
                    "block",
                    Command::InsertBlock {
                        owner: OutlineOwner::Tag { id: tag.clone() },
                        parent: None,
                        index: 0,
                        markdown: "Tag notes".into(),
                    },
                ),
                "t2",
            )
            .unwrap();
        let block = created.result.created_block.unwrap();

        core.execute(
            envelope(
                "edit",
                Command::EditMarkdown {
                    owner: OutlineOwner::Tag { id: tag.clone() },
                    block_id: block,
                    markdown: "Edited tag notes".into(),
                },
            ),
            "t3",
        )
        .unwrap();

        let undo = core.execute(envelope("undo", Command::Undo), "t4").unwrap();
        assert_eq!(
            undo.result.history_effect.unwrap().affected_outlines,
            [OutlineOwner::Tag { id: tag.clone() }]
        );
        assert_eq!(
            core.snapshot().unwrap().tags[0].blocks[0].markdown,
            "Tag notes"
        );
        core.execute(envelope("redo", Command::Redo), "t5").unwrap();

        let snapshot = core.snapshot().unwrap();
        assert_eq!(snapshot.tags[0].blocks[0].markdown, "Edited tag notes");
        assert!(snapshot.pages.is_empty());
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
        assert_eq!(created.changes.pages(), Some(&BTreeSet::from([page()])));
        assert!(!created.changes.is_rebuild());

        let block = insert_root(&mut left, "block", &page(), 0, "before");
        let baseline = left.export_snapshot().unwrap();
        let mut right = GraphCore::from_snapshot(graph(), 2, &baseline).unwrap();
        let edited = left
            .execute(
                envelope(
                    "edit",
                    Command::EditMarkdown {
                        owner: OutlineOwner::Page { id: page() },
                        block_id: block,
                        markdown: "after".into(),
                    },
                ),
                "t2",
            )
            .unwrap();
        assert_eq!(edited.changes.pages(), Some(&BTreeSet::from([page()])));
        assert!(edited.changes.tags().is_some_and(BTreeSet::is_empty));
        assert!(!edited.changes.is_rebuild());

        let remote = right.import_remote_with_changes(&edited.update).unwrap();
        assert_eq!(remote, edited.changes);
        let delta = right.index_delta(&remote).unwrap().unwrap();
        assert_eq!(delta.changes().count(), 1);
        assert!(matches!(
            delta.changes().next(),
            Some(IndexChange::Upsert(IndexUnit::Page(page)))
                if page.blocks[0].markdown == "after"
        ));
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
        assert_eq!(
            created.changes.tags(),
            Some(&BTreeSet::from([tag_id.clone()]))
        );
        assert!(created.changes.pages().is_some_and(BTreeSet::is_empty));
        let delta = core.index_delta(&created.changes).unwrap().unwrap();
        assert_eq!(delta.changes().count(), 1);
        assert!(matches!(
            delta.changes().next(),
            Some(IndexChange::Upsert(IndexUnit::Tag(tag))) if tag.id == tag_id
        ));

        ensure_regular_page(&mut core, "page", &page());
        let block_id = insert_root(&mut core, "block", &page(), 0, "tagged");
        let tagged = core
            .execute(
                envelope(
                    "add-tag",
                    Command::AddTag {
                        entity: EntityId::Block {
                            owner: OutlineOwner::Page { id: page() },
                            id: block_id,
                        },
                        tag_id: tag_id.clone(),
                    },
                ),
                "t2",
            )
            .unwrap();
        assert_eq!(tagged.changes.pages(), Some(&BTreeSet::from([page()])));
        assert!(tagged.changes.tags().is_some_and(BTreeSet::is_empty));

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
        assert_eq!(deleted.changes.pages(), Some(&BTreeSet::from([page()])));
        assert_eq!(
            deleted.changes.tags(),
            Some(&BTreeSet::from([tag_id.clone()]))
        );
        let delta = core.index_delta(&deleted.changes).unwrap().unwrap();
        let page_id = page();
        assert_eq!(delta.changes().count(), 2);
        assert!(delta.changes().any(|change| matches!(
            change,
            IndexChange::Upsert(IndexUnit::Page(page)) if page.id == page_id
        )));
        assert!(delta.changes().any(|change| {
            matches!(change, IndexChange::Remove(IndexUnitId::Tag(id)) if id == &tag_id)
        }));
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
    fn property_patch_is_one_atomic_undo_boundary() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let owner = PropertyOwner::Page { id: page() };

        core.execute(
            envelope(
                "moment",
                Command::SetProperties {
                    owner,
                    changes: vec![
                        PropertyChange {
                            key: key("builtin.task-scheduled"),
                            value: Some(PropertyValue::Date(LocalDate::new("2026-08-25").unwrap())),
                        },
                        PropertyChange {
                            key: key("builtin.task-scheduled-time"),
                            value: Some(PropertyValue::String("21:30".into())),
                        },
                    ],
                },
            ),
            "t2",
        )
        .unwrap();

        let written = core.page_snapshot(&page()).unwrap();
        assert_eq!(
            property_date(&written.properties, "builtin.task-scheduled"),
            Some("2026-08-25")
        );
        assert_eq!(
            property_string(&written.properties, "builtin.task-scheduled-time"),
            Some("21:30")
        );

        core.execute(envelope("undo-moment", Command::Undo), "t3")
            .unwrap();
        let undone = core.page_snapshot(&page()).unwrap();
        assert_eq!(
            property_date(&undone.properties, "builtin.task-scheduled"),
            None
        );
        assert_eq!(
            property_string(&undone.properties, "builtin.task-scheduled-time"),
            None
        );
    }

    #[test]
    fn property_patch_validates_every_change_before_mutating() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());

        let rejected = core.execute(
            envelope(
                "invalid-moment",
                Command::SetProperties {
                    owner: PropertyOwner::Page { id: page() },
                    changes: vec![
                        PropertyChange {
                            key: key("builtin.task-scheduled"),
                            value: Some(PropertyValue::Date(LocalDate::new("2026-08-25").unwrap())),
                        },
                        PropertyChange {
                            key: key("builtin.task-scheduled-time"),
                            value: Some(PropertyValue::Date(LocalDate::new("2026-08-25").unwrap())),
                        },
                    ],
                },
            ),
            "t2",
        );
        assert!(matches!(
            rejected,
            Err(CoreError::Property(PropertyError::WrongType { .. }))
        ));

        let snapshot = core.page_snapshot(&page()).unwrap();
        assert_eq!(
            property_date(&snapshot.properties, "builtin.task-scheduled"),
            None
        );
        assert_eq!(
            property_string(&snapshot.properties, "builtin.task-scheduled-time"),
            None
        );
    }

    #[test]
    fn graph_default_queries_are_ordered_query_documents() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let first = DefaultQueryId::new("dq-first").unwrap();
        let second = DefaultQueryId::new("dq-second").unwrap();
        for (command_id, id, title) in [
            ("first", first.clone(), "First"),
            ("second", second.clone(), "Second"),
        ] {
            core.execute(
                envelope(
                    command_id,
                    Command::CreateDefaultQuery {
                        default_query_id: id,
                        title: title.into(),
                        document: PropertyDocument::default_query("SELECT ?item WHERE {}".into()),
                    },
                ),
                "t1",
            )
            .unwrap();
        }
        core.execute(
            envelope(
                "edit",
                Command::SetQuerySource {
                    owner: QueryOwner::GraphDefault {
                        default_query_id: first.clone(),
                    },
                    view_id: QueryViewId::new("all").unwrap(),
                    source: "SELECT ?block WHERE {}".into(),
                },
            ),
            "t2",
        )
        .unwrap();
        core.execute(
            envelope(
                "move",
                Command::MoveDefaultQuery {
                    default_query_id: second.clone(),
                    index: 0,
                },
            ),
            "t3",
        )
        .unwrap();

        let settings = core.summary().unwrap().settings;
        assert_eq!(
            settings
                .default_queries
                .iter()
                .map(|query| query.id.clone())
                .collect::<Vec<_>>(),
            vec![second, first.clone()]
        );
        assert_eq!(
            settings.default_queries[1].document.views[0]
                .definition
                .source,
            "SELECT ?block WHERE {}"
        );

        core.execute(
            envelope(
                "delete",
                Command::DeleteDefaultQuery {
                    default_query_id: first,
                },
            ),
            "t4",
        )
        .unwrap();
        assert_eq!(core.summary().unwrap().settings.default_queries.len(), 1);

        core.execute(envelope("undo-delete", Command::Undo), "t5")
            .unwrap();
        assert_eq!(core.summary().unwrap().settings.default_queries.len(), 2);
    }

    #[test]
    fn a_tag_owns_a_query_document_with_views_of_its_own() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let tag = TagId::new("t-project").unwrap();
        core.execute(
            envelope(
                "tag",
                Command::EnsureTag {
                    tag_id: tag.clone(),
                    name: "Project".into(),
                },
            ),
            "t1",
        )
        .unwrap();
        let owner = QueryOwner::Tag {
            tag_id: tag.clone(),
        };
        core.execute(
            envelope(
                "plan",
                Command::SetQueryPlan {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("all").unwrap(),
                    plan: query_plan("block"),
                },
            ),
            "t2",
        )
        .unwrap();
        core.execute(
            envelope(
                "view",
                Command::PutQueryView {
                    owner: owner.clone(),
                    view: QueryView {
                        id: QueryViewId::new("v-open").unwrap(),
                        name: "Open".into(),
                        definition: query_definition("SELECT ?item WHERE {}"),
                        kind: QueryViewKind::List,
                        position: 2,
                        columns: Vec::new(),
                        options: QueryViewOptions::default(),
                    },
                },
            ),
            "t3",
        )
        .unwrap();
        core.execute(
            envelope(
                "default-view",
                Command::SetQueryDefaultView {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("v-open").unwrap(),
                },
            ),
            "t4",
        )
        .unwrap();

        let snapshot = core.snapshot().unwrap();
        let record = snapshot.tags.iter().find(|item| item.id == tag).unwrap();
        let field = record
            .properties
            .iter()
            .find(|field| field.key.as_str() == QUERY_PROPERTY_KEY)
            .unwrap();
        let PropertyValue::Document(document) = &field.values[0] else {
            panic!("a tag's query did not decode as a document")
        };
        assert!(
            document.views[0]
                .definition
                .source
                .starts_with(query::DERIVED_SOURCE_PROVENANCE)
        );
        assert_eq!(document.default_view_id.as_str(), "v-open");
        assert_eq!(document.views.len(), 2);
        // A tag's query lives in its metadata, never in the defaults it copies.
        assert!(
            record
                .defaults
                .iter()
                .all(|field| field.key.as_str() != QUERY_PROPERTY_KEY)
        );
    }

    #[test]
    fn query_documents_use_semantic_commands_and_round_trip_structured_views() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "query");
        let source = "SELECT ?item WHERE {}";
        let owner = QueryOwner::Block {
            owner: OutlineOwner::Page { id: page() },
            id: block.clone(),
        };

        core.execute(
            envelope(
                "query",
                Command::SetQuerySource {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("all").unwrap(),
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
                    view_id: QueryViewId::new("all").unwrap(),
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
                "query-add-view",
                Command::PutQueryView {
                    owner: owner.clone(),
                    view: QueryView {
                        id: QueryViewId::new("v-list").unwrap(),
                        name: "As a list".into(),
                        definition: query_definition(source),
                        kind: QueryViewKind::List,
                        position: 1,
                        columns: Vec::new(),
                        options: QueryViewOptions::default(),
                    },
                },
            ),
            "t5",
        )
        .unwrap();
        core.execute(
            envelope(
                "query-view",
                Command::SetQueryDefaultView {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("v-list").unwrap(),
                },
            ),
            "t6",
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
        assert_eq!(
            document.views[0].definition.source,
            "SELECT ?item WHERE {} LIMIT 10"
        );
        assert_eq!(document.default_view_id.as_str(), "v-list");
        assert_eq!(document.views.len(), 2);

        let error = core
            .execute(
                envelope(
                    "oversized-query-splice",
                    Command::SpliceQuerySource {
                        owner: owner.clone(),
                        view_id: QueryViewId::new("all").unwrap(),
                        index: document.views[0].definition.source.chars().count(),
                        delete: 0,
                        insert: "😀".repeat(20_000),
                    },
                ),
                "t7",
            )
            .unwrap_err();
        assert!(matches!(error, CoreError::TextTooLong));

        let error = core
            .execute(
                envelope(
                    "generic-query-write",
                    Command::SetProperty {
                        owner: PropertyOwner::Block {
                            owner: OutlineOwner::Page { id: page() },
                            id: block,
                        },
                        key: key(QUERY_PROPERTY_KEY),
                        value: PropertyValue::Document(document.clone()),
                    },
                ),
                "t8",
            )
            .unwrap_err();
        assert!(matches!(
            error,
            CoreError::Property(PropertyError::DocumentCommandRequired(_))
        ));
    }

    #[test]
    fn query_plan_derives_its_source_in_core_and_detaches_on_a_hand_edit() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "query");
        let owner = QueryOwner::Block {
            owner: OutlineOwner::Page { id: page() },
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
                    view_id: QueryViewId::new("all").unwrap(),
                    plan: query_plan("block"),
                },
            ),
            "t3",
        )
        .unwrap();
        let document = read(&core);
        assert!(
            document.views[0]
                .definition
                .source
                .starts_with(query::DERIVED_SOURCE_PROVENANCE)
        );
        assert_eq!(
            document.views[0]
                .definition
                .plan
                .as_ref()
                .map(|plan| plan.version),
            Some(domain::QUERY_PLAN_VERSION)
        );

        let stored_document = core.require_query_document_for_owner(&owner).unwrap();
        let stored_definition =
            require_query_definition(&stored_document, &QueryViewId::new("all").unwrap()).unwrap();
        assert!(stored_definition.get(QUERY_PLAN_STATE_KEY).is_some());
        assert!(stored_definition.get("plan_version").is_none());
        assert!(stored_definition.get("plan").is_none());
        assert_eq!(
            stored_definition
                .get("source")
                .and_then(value_into_text)
                .unwrap()
                .to_string(),
            ""
        );

        // A text splice is not an implicit Built -> Raw transition because the
        // projected explanation is not authoritative source text.
        let splice_error = core
            .execute(
                envelope(
                    "splice-built",
                    Command::SpliceQuerySource {
                        owner: owner.clone(),
                        view_id: QueryViewId::new("all").unwrap(),
                        index: 0,
                        delete: 0,
                        insert: "# edit".into(),
                    },
                ),
                "t3-splice",
            )
            .unwrap_err();
        assert!(matches!(
            splice_error,
            CoreError::Property(PropertyError::InvalidDocument(_))
        ));
        assert!(read(&core).views[0].definition.plan.is_some());

        // Replacing the SPARQL explicitly makes the raw source authoritative.
        core.execute(
            envelope(
                "hand-edit",
                Command::SetQuerySource {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("all").unwrap(),
                    source: "# note\nSELECT ?item WHERE {}".into(),
                },
            ),
            "t4",
        )
        .unwrap();
        assert!(read(&core).views[0].definition.plan.is_none());
        let stored_document = core.require_query_document_for_owner(&owner).unwrap();
        let stored_definition =
            require_query_definition(&stored_document, &QueryViewId::new("all").unwrap()).unwrap();
        assert!(
            decode_query_plan_state(&stored_definition, "query definition")
                .unwrap()
                .is_none()
        );

        core.execute(
            envelope(
                "replan",
                Command::SetQueryPlan {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("all").unwrap(),
                    plan: query_plan("page"),
                },
            ),
            "t5",
        )
        .unwrap();
        assert!(read(&core).views[0].definition.plan.is_some());
        core.execute(
            envelope(
                "eject-plan",
                Command::SetQuerySource {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("all").unwrap(),
                    source: "SELECT ?item WHERE {}".into(),
                },
            ),
            "t6",
        )
        .unwrap();
        let detached = read(&core);
        assert!(detached.views[0].definition.plan.is_none());
        assert_eq!(detached.views[0].definition.source, "SELECT ?item WHERE {}");

        let error = core
            .execute(
                envelope(
                    "invalid-plan",
                    Command::SetQueryPlan {
                        owner,
                        view_id: QueryViewId::new("all").unwrap(),
                        plan: QueryPlan {
                            version: domain::QUERY_PLAN_VERSION,
                            payload: "not json".into(),
                        },
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
    fn plan_bearing_document_commands_ignore_caller_supplied_source() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let default_query_id = DefaultQueryId::new("dq-authority").unwrap();
        let mut document = PropertyDocument::default_query("caller supplied".into());
        document.views[0].definition.plan = Some(query_plan("block"));

        core.execute(
            envelope(
                "create",
                Command::CreateDefaultQuery {
                    default_query_id: default_query_id.clone(),
                    title: "Authority".into(),
                    document,
                },
            ),
            "t1",
        )
        .unwrap();

        let created = &core.summary().unwrap().settings.default_queries[0]
            .document
            .views[0];
        assert_ne!(created.definition.source, "caller supplied");
        assert!(
            created
                .definition
                .source
                .starts_with(query::DERIVED_SOURCE_PROVENANCE)
        );

        core.execute(
            envelope(
                "put",
                Command::PutQueryView {
                    owner: QueryOwner::GraphDefault { default_query_id },
                    view: QueryView {
                        id: QueryViewId::new("page-view").unwrap(),
                        name: "Pages".into(),
                        definition: QueryDefinition {
                            source: "another caller source".into(),
                            language: domain::QUERY_LANGUAGE.into(),
                            plan: Some(query_plan("page")),
                        },
                        kind: QueryViewKind::Table,
                        position: 1,
                        columns: Vec::new(),
                        options: QueryViewOptions::default(),
                    },
                },
            ),
            "t2",
        )
        .unwrap();

        let settings = core.summary().unwrap().settings;
        let added = &settings.default_queries[0].document.views[1];
        assert_ne!(added.definition.source, "another caller source");
        assert!(
            added
                .definition
                .source
                .starts_with(query::DERIVED_SOURCE_PROVENANCE)
        );
        assert!(added.definition.plan.is_some());
    }

    #[test]
    fn projection_preserves_unknown_plans_and_quarantines_corrupt_envelopes() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "query");
        let owner = QueryOwner::Block {
            owner: OutlineOwner::Page { id: page() },
            id: block,
        };
        core.execute(
            envelope(
                "source",
                Command::SetQuerySource {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("all").unwrap(),
                    source: "SELECT * WHERE {}".into(),
                },
            ),
            "t3",
        )
        .unwrap();

        // Simulate a document authored by a newer peer. Projection must retain
        // the plan's presence so an older client cannot execute its explanation
        // artifact as if it were hand-authored raw SPARQL.
        let document = core.require_query_document_for_owner(&owner).unwrap();
        let definition =
            require_query_definition(&document, &QueryViewId::new("all").unwrap()).unwrap();
        // Remove the canonical register to exercise the v2 two-key read adapter.
        definition.delete(QUERY_PLAN_STATE_KEY).unwrap();
        definition
            .insert("plan_version", i64::from(domain::QUERY_PLAN_VERSION + 1))
            .unwrap();
        definition
            .insert(
                "plan",
                serde_json::json!({"version": domain::QUERY_PLAN_VERSION + 1, "future": true})
                    .to_string(),
            )
            .unwrap();

        let snapshot = core.page_snapshot(&page()).unwrap();
        let field = snapshot.blocks[0]
            .properties
            .iter()
            .find(|field| field.key.as_str() == QUERY_PROPERTY_KEY)
            .unwrap();
        let PropertyValue::Document(projected) = &field.values[0] else {
            panic!("query property did not decode as a document")
        };
        assert_eq!(
            projected.views[0]
                .definition
                .plan
                .as_ref()
                .map(|plan| plan.version),
            Some(domain::QUERY_PLAN_VERSION + 1)
        );
        assert_eq!(projected.views[0].definition.source, "SELECT * WHERE {}");

        definition.insert("plan", "not json").unwrap();
        let snapshot = core.page_snapshot(&page()).unwrap();
        let field = snapshot.blocks[0]
            .properties
            .iter()
            .find(|field| field.key.as_str() == QUERY_PROPERTY_KEY)
            .unwrap();
        assert!(field.values.is_empty());
    }

    #[test]
    fn unsupported_query_plans_recover_without_reinterpreting_their_source() {
        for version in [1, domain::QUERY_PLAN_VERSION + 1] {
            let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
            ensure_regular_page(&mut core, "page", &page());
            let block = insert_root(&mut core, "block", &page(), 0, "query");
            let owner = QueryOwner::Block {
                owner: OutlineOwner::Page { id: page() },
                id: block,
            };
            let source = "# explanation retained verbatim\nSELECT ?old WHERE {}";
            core.execute(
                envelope(
                    "source",
                    Command::SetQuerySource {
                        owner: owner.clone(),
                        view_id: QueryViewId::new("all").unwrap(),
                        source: source.into(),
                    },
                ),
                "t3",
            )
            .unwrap();
            let document = core.require_query_document_for_owner(&owner).unwrap();
            let definition =
                require_query_definition(&document, &QueryViewId::new("all").unwrap()).unwrap();
            let plan = QueryPlan {
                version,
                payload: serde_json::json!({"version": version, "opaque": true}).to_string(),
            };
            write_query_plan_state(&definition, Some(&plan)).unwrap();
            core.doc.commit();
            let recovered =
                GraphCore::from_snapshot(graph(), 2, &core.export_snapshot().unwrap()).unwrap();
            let document = recovered.query_document(&owner).unwrap();
            assert_eq!(document.views[0].definition.plan.as_ref(), Some(&plan));
            assert_eq!(document.views[0].definition.source, source);
            assert!(query::derive_plan_source(&plan).is_err());
            assert!(recovered.snapshot().unwrap().quarantined.is_empty());
        }
    }

    #[test]
    fn authored_column_identity_does_not_expand_the_compiler_source() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "query");
        let owner = QueryOwner::Block {
            owner: OutlineOwner::Page { id: page() },
            id: block,
        };
        let mut payload: serde_json::Value =
            serde_json::from_str(&query_plan("block").payload).unwrap();
        payload["columns"][0]["id"] = serde_json::Value::String("x".repeat(20_000));
        payload["columns"][0]["source"] =
            serde_json::json!({"kind": "property", "key": "builtin.task-scheduled"});
        let plan = QueryPlan {
            version: domain::QUERY_PLAN_VERSION,
            payload: payload.to_string(),
        };
        assert!(plan.payload.len() <= domain::QUERY_PLAN_LIMIT);
        core.execute(
            envelope(
                "opaque-column-id",
                Command::SetQueryPlan {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("all").unwrap(),
                    plan: plan.clone(),
                },
            ),
            "t3",
        )
        .unwrap();
        let document = core.query_document(&owner).unwrap();
        assert_eq!(document.views[0].definition.plan.as_ref(), Some(&plan));
        assert!(document.views[0].definition.source.len() < 1_000);
    }

    #[test]
    fn query_conditions_disclosure_survives_reload_and_concurrent_plan_edits() {
        let mut base = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut base, "page", &page());
        let block = insert_root(&mut base, "block", &page(), 0, "query");
        let default_query_id = DefaultQueryId::new("default-query").unwrap();
        base.execute(
            envelope(
                "default-query",
                Command::CreateDefaultQuery {
                    default_query_id: default_query_id.clone(),
                    title: "Default query".into(),
                    document: PropertyDocument::default_query(String::new()),
                },
            ),
            "t1",
        )
        .unwrap();
        let owners = [
            QueryOwner::Block {
                owner: OutlineOwner::Page { id: page() },
                id: block,
            },
            QueryOwner::GraphDefault { default_query_id },
        ];
        let view_id = QueryViewId::new("all").unwrap();
        let initial_plan = query_plan("block");
        for (index, owner) in owners.iter().enumerate() {
            base.execute(
                envelope(
                    &format!("plan-{index}"),
                    Command::SetQueryPlan {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        plan: initial_plan.clone(),
                    },
                ),
                "t2",
            )
            .unwrap();
        }

        let baseline = base.export_snapshot().unwrap();
        for owner in owners {
            let mut left = GraphCore::from_snapshot(graph(), 2, &baseline).unwrap();
            let mut right = GraphCore::from_snapshot(graph(), 3, &baseline).unwrap();
            let mut view = right.query_document(&owner).unwrap().views.remove(0);
            assert_eq!(view.options.conditions_open, None);

            // Even an empty condition group can be closed explicitly, and
            // changing disclosure must leave the query definition untouched.
            for open in [false, true] {
                view.options.conditions_open = Some(open);
                right
                    .execute(
                        envelope(
                            &format!("conditions-{open}"),
                            Command::PutQueryView {
                                owner: owner.clone(),
                                view: view.clone(),
                            },
                        ),
                        "t3",
                    )
                    .unwrap();
                right = GraphCore::from_snapshot(graph(), 3, &right.export_snapshot().unwrap())
                    .unwrap();
                let restored = right.query_document(&owner).unwrap().views.remove(0);
                assert_eq!(restored.options.conditions_open, Some(open));
                assert_eq!(restored.definition.plan, Some(initial_plan.clone()));
            }

            let edited_plan = query_plan("page");
            left.execute(
                envelope(
                    "edit-plan",
                    Command::SetQueryPlan {
                        owner: owner.clone(),
                        view_id: view_id.clone(),
                        plan: edited_plan.clone(),
                    },
                ),
                "t4",
            )
            .unwrap();
            let left_update = left.export_all().unwrap();
            let right_update = right.export_all().unwrap();
            left.import_remote(&right_update).unwrap();
            right.import_remote(&left_update).unwrap();
            for core in [&left, &right] {
                let restored =
                    GraphCore::from_snapshot(graph(), 4, &core.export_snapshot().unwrap()).unwrap();
                let view = restored.query_document(&owner).unwrap().views.remove(0);
                assert_eq!(view.options.conditions_open, Some(true));
                assert_eq!(view.definition.plan, Some(edited_plan.clone()));
                assert!(restored.snapshot().unwrap().quarantined.is_empty());
            }
            assert_eq!(left.fingerprint().unwrap(), right.fingerprint().unwrap());
        }
    }

    #[test]
    fn query_view_columns_round_trip_through_loro() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "query");
        let owner = QueryOwner::Block {
            owner: OutlineOwner::Page { id: page() },
            id: block,
        };
        core.execute(
            envelope(
                "source",
                Command::SetQuerySource {
                    owner: owner.clone(),
                    view_id: QueryViewId::new("all").unwrap(),
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
                        definition: query_definition("SELECT ?item WHERE {}"),
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
                            conditions_open: None,
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
                            list_sort: vec![QueryViewFieldSort {
                                field: "property:builtin.task-priority".into(),
                                descending: false,
                            }],
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
        assert_eq!(table.options.list_sort.len(), 1);
        assert_eq!(
            table.options.list_sort[0].field,
            "property:builtin.task-priority"
        );
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
                        owner: OutlineOwner::Page { id: page() },
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
                        owner: OutlineOwner::Page { id: page() },
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
                        owner: OutlineOwner::Page { id: page() },
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
                        owner: OutlineOwner::Page { id: page() },
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
                            owner: OutlineOwner::Page { id: page() },
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
                        owner: OutlineOwner::Page { id: page() },
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
                        owner: OutlineOwner::Page { id: page() },
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
            owner: OutlineOwner::Page { id: page() },
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
        assert_eq!(duplicate.semantic, SemanticEvent::CommandDeduplicated);
        assert_eq!(duplicate.result, first.result);
        assert!(duplicate.update.is_empty());
    }

    #[test]
    fn entity_name_conflicts_are_typed_command_rejections() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let page_error = core.execute(
            envelope(
                "conflicting-page",
                Command::EnsurePage {
                    page_id: PageId::new("other-page").unwrap(),
                    title: " HOME ".into(),
                },
            ),
            "t2",
        );
        assert!(matches!(
            page_error,
            Err(CoreError::PageNameConflict { existing, .. }) if existing == page()
        ));

        let existing_tag = TagId::new("tag").unwrap();
        core.execute(
            envelope(
                "tag",
                Command::EnsureTag {
                    tag_id: existing_tag.clone(),
                    name: "Project".into(),
                },
            ),
            "t3",
        )
        .unwrap();
        let tag_error = core.execute(
            envelope(
                "conflicting-tag",
                Command::EnsureTag {
                    tag_id: TagId::new("other-tag").unwrap(),
                    name: " project ".into(),
                },
            ),
            "t4",
        );
        assert!(matches!(
            tag_error,
            Err(CoreError::TagNameConflict { existing, .. }) if existing == existing_tag
        ));
    }

    #[test]
    fn existing_ensure_commands_are_true_crdt_noops() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        let tag_id = TagId::new("project").unwrap();
        let date = LocalDate::new("2026-08-03").unwrap();
        core.execute(
            envelope(
                "create-page",
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
                "create-tag",
                Command::EnsureTag {
                    tag_id: tag_id.clone(),
                    name: "Project".into(),
                },
            ),
            "t1",
        )
        .unwrap();
        core.execute(
            envelope(
                "create-journal",
                Command::EnsureJournal { date: date.clone() },
            ),
            "t1",
        )
        .unwrap();
        let baseline = core.version_vector();

        for command in [
            envelope(
                "ensure-page-again",
                Command::EnsurePage {
                    page_id: page(),
                    title: "Home".into(),
                },
            ),
            envelope(
                "ensure-tag-again",
                Command::EnsureTag {
                    tag_id,
                    name: "Project".into(),
                },
            ),
            envelope("ensure-journal-again", Command::EnsureJournal { date }),
        ] {
            let execution = core.execute(command, "t2").unwrap();
            assert_ne!(execution.semantic, SemanticEvent::CommandDeduplicated);
            assert!(
                execution.update.is_empty(),
                "{} emitted {} update bytes",
                execution.semantic,
                execution.update.len()
            );
            assert_eq!(execution.changes, GraphChangeSet::default());
            assert_eq!(core.version_vector(), baseline);
        }
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
        let second = insert_root(&mut move_core, "move-second-2", &second_page, 1, "second 2");
        insert_root(&mut move_core, "move-first-1", &first_page, 0, "first 1");
        insert_root(&mut move_core, "move-first-2", &first_page, 1, "first 2");
        move_core
            .execute(
                envelope(
                    "move-second-1-after-second-2",
                    Command::MoveBlocks {
                        block_ids: vec![moving],
                        owner: OutlineOwner::Page {
                            id: second_page.clone(),
                        },
                        parent: None,
                        after: Some(second),
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
                        owner: OutlineOwner::Page { id: page() },
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
                        owner: OutlineOwner::Page { id: page() },
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
                    owner: OutlineOwner::Page { id: page() },
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
                    owner: OutlineOwner::Page { id: page() },
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
                    owner: OutlineOwner::Page { id: page() },
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
    fn backward_merge_preserves_rich_text_moves_children_and_undoes_once() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "home", &page());
        let referenced_page = PageId::new("roadmap").unwrap();
        ensure_regular_page(&mut core, "roadmap", &referenced_page);
        let target = insert_root(&mut core, "target", &page(), 0, "head ");
        let source = insert_root(&mut core, "source", &page(), 1, "tail");
        core.execute(
            envelope(
                "reference",
                Command::SpliceBlockContent {
                    owner: OutlineOwner::Page { id: page() },
                    block_id: source.clone(),
                    index: 4,
                    delete: 0,
                    insert: vec![InlineContent::PageReference {
                        page_id: referenced_page.clone(),
                    }],
                },
            ),
            "t3",
        )
        .unwrap();
        core.execute(
            envelope(
                "target-child",
                Command::InsertBlock {
                    owner: OutlineOwner::Page { id: page() },
                    parent: Some(target.clone()),
                    index: 0,
                    markdown: "before".into(),
                },
            ),
            "t4",
        )
        .unwrap();
        core.execute(
            envelope(
                "source-child-one",
                Command::InsertBlock {
                    owner: OutlineOwner::Page { id: page() },
                    parent: Some(source.clone()),
                    index: 0,
                    markdown: "after one".into(),
                },
            ),
            "t5",
        )
        .unwrap();
        core.execute(
            envelope(
                "source-child-two",
                Command::InsertBlock {
                    owner: OutlineOwner::Page { id: page() },
                    parent: Some(source.clone()),
                    index: 1,
                    markdown: "after two".into(),
                },
            ),
            "t5",
        )
        .unwrap();

        core.execute(
            envelope(
                "merge",
                Command::MergeBlockBackward {
                    owner: OutlineOwner::Page { id: page() },
                    block_id: source.clone(),
                },
            ),
            "t6",
        )
        .unwrap();
        let merged = core.page_snapshot(&page()).unwrap();
        assert_eq!(merged.blocks.len(), 1);
        assert_eq!(merged.blocks[0].id, target);
        assert_eq!(merged.blocks[0].markdown, "head tail[[roadmap]]");
        assert_eq!(
            merged.blocks[0].page_references,
            [PageReferenceSpan {
                start: 9,
                end: 20,
                index: 9,
                page_id: referenced_page,
            }]
        );
        assert_eq!(
            merged.blocks[0]
                .children
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            ["before", "after one", "after two"]
        );

        core.execute(envelope("undo-merge", Command::Undo), "t7")
            .unwrap();
        let restored = core.page_snapshot(&page()).unwrap();
        assert_eq!(
            restored
                .blocks
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            ["head ", "tail[[roadmap]]"]
        );
        assert_eq!(restored.blocks[0].children[0].markdown, "before");
        assert_eq!(
            restored.blocks[1]
                .children
                .iter()
                .map(|block| block.markdown.as_str())
                .collect::<Vec<_>>(),
            ["after one", "after two"]
        );

        core.execute(envelope("redo-merge", Command::Redo), "t8")
            .unwrap();
        assert_eq!(core.page_snapshot(&page()).unwrap().blocks.len(), 1);
    }

    #[test]
    fn backward_merge_rejects_the_first_sibling() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let first = insert_root(&mut core, "first", &page(), 0, "first");

        let error = core
            .execute(
                envelope(
                    "merge-first",
                    Command::MergeBlockBackward {
                        owner: OutlineOwner::Page { id: page() },
                        block_id: first,
                    },
                ),
                "t3",
            )
            .unwrap_err();
        assert!(matches!(error, CoreError::InvalidHierarchy(_)));
        assert_eq!(core.page_snapshot(&page()).unwrap().blocks.len(), 1);
    }

    #[test]
    fn page_reference_identity_survives_rename_and_rich_text_split() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "home", &page());
        let target_page = PageId::new("roadmap").unwrap();
        ensure_regular_page(&mut core, "roadmap", &target_page);
        let block = insert_root(&mut core, "block", &page(), 0, "See ");

        core.execute(
            envelope(
                "reference",
                Command::SpliceBlockContent {
                    owner: OutlineOwner::Page { id: page() },
                    block_id: block.clone(),
                    index: 4,
                    delete: 0,
                    insert: vec![
                        InlineContent::PageReference {
                            page_id: target_page.clone(),
                        },
                        InlineContent::Markdown { value: "!".into() },
                    ],
                },
            ),
            "t3",
        )
        .unwrap();
        let referenced = core.page_snapshot(&page()).unwrap();
        assert_eq!(referenced.blocks[0].markdown, "See [[roadmap]]!");
        assert_eq!(
            referenced.blocks[0].page_references,
            [PageReferenceSpan {
                start: 4,
                end: 15,
                index: 4,
                page_id: target_page.clone(),
            }]
        );

        let renamed = core
            .execute(
                envelope(
                    "rename-target",
                    Command::RenamePage {
                        page_id: target_page.clone(),
                        title: "Plan".into(),
                    },
                ),
                "t4",
            )
            .unwrap();
        assert!(renamed.changes.is_rebuild());
        let projected = core.page_snapshot(&page()).unwrap();
        assert_eq!(projected.blocks[0].markdown, "See [[Plan]]!");
        assert_eq!(projected.blocks[0].page_references[0].page_id, target_page);
        assert_eq!(projected.blocks[0].page_references[0].end, 12);

        core.execute(
            envelope(
                "split-after-reference",
                Command::SplitBlock {
                    owner: OutlineOwner::Page { id: page() },
                    block_id: block.clone(),
                    index: 5,
                    placement: SplitPlacement::After,
                },
            ),
            "t5",
        )
        .unwrap();
        let split = core.page_snapshot(&page()).unwrap();
        assert_eq!(split.blocks[0].markdown, "See [[Plan]]");
        assert_eq!(split.blocks[0].page_references.len(), 1);
        assert_eq!(split.blocks[1].markdown, "!");
        assert!(split.blocks[1].page_references.is_empty());
    }

    #[test]
    fn journal_reference_uses_its_semantic_date_as_the_shared_title() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "home", &page());
        let journal = core
            .execute(
                envelope(
                    "journal",
                    Command::EnsureJournal {
                        date: LocalDate::new("2026-08-27").unwrap(),
                    },
                ),
                "t1",
            )
            .unwrap()
            .result
            .created_page
            .unwrap();
        let block = insert_root(&mut core, "block", &page(), 0, "On ");
        core.execute(
            envelope(
                "journal-reference",
                Command::SpliceBlockContent {
                    owner: OutlineOwner::Page { id: page() },
                    block_id: block,
                    index: 3,
                    delete: 0,
                    insert: vec![InlineContent::PageReference {
                        page_id: journal.clone(),
                    }],
                },
            ),
            "t2",
        )
        .unwrap();

        assert_eq!(
            core.page_snapshot(&page()).unwrap().blocks[0].markdown,
            "On [[2026-08-27]]"
        );
        let snapshot = core.snapshot().unwrap();
        assert_eq!(
            snapshot
                .page_directory
                .iter()
                .find(|entry| entry.id == journal)
                .unwrap()
                .title,
            "2026-08-27"
        );
    }

    #[test]
    fn page_creation_and_reference_insertion_share_one_batch_boundary() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "home", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "See ");
        let target = PageId::new("new-page").unwrap();

        core.execute(
            envelope(
                "create-and-reference",
                Command::Batch {
                    commands: vec![
                        Command::EnsurePage {
                            page_id: target.clone(),
                            title: "New page".into(),
                        },
                        Command::SpliceBlockContent {
                            owner: OutlineOwner::Page { id: page() },
                            block_id: block,
                            index: 4,
                            delete: 0,
                            insert: vec![InlineContent::PageReference {
                                page_id: target.clone(),
                            }],
                        },
                    ],
                },
            ),
            "t1",
        )
        .unwrap();

        let referenced = core.page_snapshot(&page()).unwrap();
        assert_eq!(referenced.blocks[0].markdown, "See [[New page]]");
        assert_eq!(referenced.blocks[0].page_references[0].page_id, target);
        core.execute(envelope("undo-batch", Command::Undo), "t2")
            .unwrap();
        assert!(matches!(
            core.page_snapshot(&PageId::new("new-page").unwrap()),
            Err(CoreError::PageNotFound(_))
        ));
        assert_eq!(
            core.page_snapshot(&page()).unwrap().blocks[0].markdown,
            "See "
        );
    }

    #[test]
    fn outline_fragment_v2_restores_semantic_page_reference_atoms() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "home", &page());
        let target = PageId::new("target").unwrap();
        ensure_regular_page(&mut core, "target", &target);
        core.execute(
            envelope(
                "paste-reference",
                Command::PasteOutline {
                    owner: OutlineOwner::Page { id: page() },
                    parent: None,
                    index: 0,
                    replace: None,
                    fragment: OutlineFragment {
                        kind: OUTLINE_FRAGMENT_KIND.into(),
                        version: OUTLINE_FRAGMENT_VERSION,
                        source_graph_id: graph(),
                        items: vec![OutlineFragmentItem {
                            depth: 0,
                            markdown: "See [[target]]".into(),
                            page_references: vec![PageReferenceSpan {
                                start: 4,
                                end: 14,
                                index: 4,
                                page_id: target.clone(),
                            }],
                            properties: PropertyBag::new(),
                            tags: Vec::new(),
                        }],
                        tags: Vec::new(),
                        pages: vec![OutlineFragmentPage {
                            id: target.clone(),
                            title: "target".into(),
                            journal_date: None,
                        }],
                    },
                },
            ),
            "t3",
        )
        .unwrap();

        let pasted = core.page_snapshot(&page()).unwrap();
        assert_eq!(pasted.blocks[0].markdown, "See [[target]]");
        assert_eq!(pasted.blocks[0].page_references[0].page_id, target);
    }

    #[test]
    fn same_block_splices_preserve_disjoint_scalar_mappings_locally_remotely_and_on_undo() {
        fn map_position(mut position: usize, changes: &[ContentRangeChange]) -> usize {
            for change in changes {
                if position > change.index + change.delete {
                    position = position + change.insert - change.delete;
                } else if position >= change.index {
                    position = change.index + change.insert;
                }
            }
            position
        }
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "🙂ab--CD");
        let baseline = core.page_snapshot(&page()).unwrap();
        let mut remote =
            GraphCore::from_snapshot(graph(), 2, &core.export_snapshot().unwrap()).unwrap();
        let execution = core
            .execute(
                envelope(
                    "two-splices",
                    Command::SpliceBlockContents {
                        owner: OutlineOwner::Page { id: page() },
                        splices: vec![
                            BlockContentSplice {
                                block_id: block.clone(),
                                index: 1,
                                delete: 2,
                                insert: vec![InlineContent::Markdown { value: "X".into() }],
                            },
                            BlockContentSplice {
                                block_id: block.clone(),
                                index: 4,
                                delete: 2,
                                insert: vec![InlineContent::Markdown {
                                    value: "YZ🙂".into(),
                                }],
                            },
                        ],
                    },
                ),
                "t3",
            )
            .unwrap();
        let GraphChanges::Content { blocks } = core.publication(&execution) else {
            panic!("content publication expected")
        };
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].block_id, block);
        assert_eq!(blocks[0].markdown, "🙂X--YZ🙂");
        assert_eq!(
            blocks[0].content,
            vec![InlineContent::Markdown {
                value: "🙂X--YZ🙂".into()
            }]
        );
        // The caret between the unchanged dashes must survive. A flattened
        // replacement of the surrounding text would instead move it to the end.
        assert_eq!(map_position(4, &blocks[0].mapping), 3);
        assert_eq!(map_position(7, &blocks[0].mapping), 7);
        let (_, remote_publication) = remote
            .import_remote_with_publication(&execution.update)
            .unwrap();
        let GraphChanges::Refresh {
            blocks: remote_blocks,
            ..
        } = remote_publication
        else {
            panic!("remote publication expected")
        };
        assert_eq!(remote_blocks.len(), 1);
        assert_eq!(remote_blocks[0].content, blocks[0].content);
        assert_eq!(map_position(4, &remote_blocks[0].mapping), 3);
        assert_eq!(
            remote.page_snapshot(&page()).unwrap(),
            core.page_snapshot(&page()).unwrap()
        );

        let undo = core
            .execute(envelope("undo-two-splices", Command::Undo), "t4")
            .unwrap();
        let GraphChanges::Refresh {
            blocks: undo_blocks,
            ..
        } = core.publication(&undo)
        else {
            panic!("undo publication expected")
        };
        assert_eq!(undo_blocks.len(), 1);
        assert_eq!(map_position(3, &undo_blocks[0].mapping), 4);
        assert_eq!(undo_blocks[0].markdown, "🙂ab--CD");
        assert_eq!(core.page_snapshot(&page()).unwrap(), baseline);
        let (_, remote_undo) = remote.import_remote_with_publication(&undo.update).unwrap();
        let GraphChanges::Refresh {
            blocks: undo_blocks,
            ..
        } = remote_undo
        else {
            panic!("remote undo publication expected")
        };
        assert_eq!(map_position(3, &undo_blocks[0].mapping), 4);
        assert_eq!(remote.page_snapshot(&page()).unwrap(), baseline);
    }

    #[test]
    fn invalid_later_same_block_splice_rejects_the_complete_transition() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let block = insert_root(&mut core, "block", &page(), 0, "abcdef");
        let baseline = core.page_snapshot(&page()).unwrap();
        let frontier = core.frontier();
        let rejected = core.execute(
            envelope(
                "invalid-later-splice",
                Command::SpliceBlockContents {
                    owner: OutlineOwner::Page { id: page() },
                    splices: vec![
                        BlockContentSplice {
                            block_id: block.clone(),
                            index: 0,
                            delete: 4,
                            insert: vec![InlineContent::Markdown { value: "X".into() }],
                        },
                        // This was a valid range in the original string, but not in
                        // the three-scalar content produced by the first splice.
                        BlockContentSplice {
                            block_id: block,
                            index: 4,
                            delete: 1,
                            insert: vec![InlineContent::Markdown { value: "!".into() }],
                        },
                    ],
                },
            ),
            "t3",
        );
        assert!(rejected.is_err());
        assert_eq!(core.frontier(), frontier);
        assert_eq!(core.page_snapshot(&page()).unwrap(), baseline);
    }

    #[test]
    fn plural_markdown_splice_preserves_blocks_and_undoes_once() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let first = insert_root(&mut core, "first", &page(), 0, "one tail");
        let second = insert_root(&mut core, "second", &page(), 1, "next words");

        core.execute(
            envelope(
                "splice-many",
                Command::SpliceMarkdowns {
                    owner: OutlineOwner::Page { id: page() },
                    splices: vec![
                        MarkdownSplice {
                            block_id: first.clone(),
                            index: 4,
                            delete: 4,
                            insert: String::new(),
                        },
                        MarkdownSplice {
                            block_id: second.clone(),
                            index: 0,
                            delete: 5,
                            insert: String::new(),
                        },
                    ],
                },
            ),
            "t3",
        )
        .unwrap();
        let changed = core.page_snapshot(&page()).unwrap();
        assert_eq!(changed.blocks.len(), 2);
        assert_eq!(changed.blocks[0].id, first);
        assert_eq!(changed.blocks[0].markdown, "one ");
        assert_eq!(changed.blocks[1].id, second);
        assert_eq!(changed.blocks[1].markdown, "words");

        core.execute(envelope("undo-splice-many", Command::Undo), "t4")
            .unwrap();
        let restored = core.page_snapshot(&page()).unwrap();
        assert_eq!(restored.blocks.len(), 2);
        assert_eq!(restored.blocks[0].markdown, "one tail");
        assert_eq!(restored.blocks[1].markdown, "next words");
    }

    #[test]
    fn plural_inline_splice_preserves_unicode_references_and_undoes_once() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "home", &page());
        let referenced_page = PageId::new("roadmap").unwrap();
        ensure_regular_page(&mut core, "roadmap", &referenced_page);
        let first = insert_root(&mut core, "first", &page(), 0, "한글 tail");
        let second = insert_root(&mut core, "second", &page(), 1, "next");

        core.execute(
            envelope(
                "splice-inline-many",
                Command::SpliceBlockContents {
                    owner: OutlineOwner::Page { id: page() },
                    splices: vec![
                        BlockContentSplice {
                            block_id: first.clone(),
                            index: 3,
                            delete: 4,
                            insert: vec![InlineContent::PageReference {
                                page_id: referenced_page.clone(),
                            }],
                        },
                        BlockContentSplice {
                            block_id: second.clone(),
                            index: 0,
                            delete: 4,
                            insert: vec![InlineContent::Markdown {
                                value: "done".into(),
                            }],
                        },
                    ],
                },
            ),
            "t3",
        )
        .unwrap();

        let changed = core.page_snapshot(&page()).unwrap();
        assert_eq!(changed.blocks[0].markdown, "한글 [[roadmap]]");
        assert_eq!(changed.blocks[0].page_references.len(), 1);
        assert_eq!(changed.blocks[0].page_references[0].index, 3);
        assert_eq!(
            changed.blocks[0].page_references[0].page_id,
            referenced_page
        );
        assert_eq!(changed.blocks[1].markdown, "done");

        core.execute(envelope("undo-inline-many", Command::Undo), "t4")
            .unwrap();
        let restored = core.page_snapshot(&page()).unwrap();
        assert_eq!(restored.blocks[0].id, first);
        assert_eq!(restored.blocks[0].markdown, "한글 tail");
        assert!(restored.blocks[0].page_references.is_empty());
        assert_eq!(restored.blocks[1].id, second);
        assert_eq!(restored.blocks[1].markdown, "next");
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
                        owner: OutlineOwner::Page { id: page() },
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
                    owner: OutlineOwner::Page { id: page() },
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
                    owner: OutlineOwner::Page { id: page() },
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
    fn outline_fragment_paste_preserves_properties_tags_and_empty_fields() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let empty = insert_root(&mut core, "empty", &page(), 0, "");
        let tag_id = TagId::new("project").unwrap();
        core.execute(
            envelope(
                "tag",
                Command::EnsureTag {
                    tag_id: tag_id.clone(),
                    name: "Project".into(),
                },
            ),
            "t2",
        )
        .unwrap();

        core.execute(
            envelope(
                "paste-rich-outline",
                Command::PasteOutline {
                    owner: OutlineOwner::Page { id: page() },
                    parent: None,
                    index: 0,
                    replace: Some(empty),
                    fragment: OutlineFragment {
                        kind: OUTLINE_FRAGMENT_KIND.into(),
                        version: OUTLINE_FRAGMENT_VERSION,
                        source_graph_id: graph(),
                        items: vec![domain::OutlineFragmentItem {
                            depth: 0,
                            markdown: "ship it".into(),
                            page_references: Vec::new(),
                            properties: property_bag(vec![
                                PropertyField {
                                    key: key("builtin.task-status"),
                                    value_type: PropertyType::String,
                                    cardinality: Cardinality::Single,
                                    values: vec![PropertyValue::String("doing".into())],
                                },
                                PropertyField {
                                    key: key("user.reviewers"),
                                    value_type: PropertyType::String,
                                    cardinality: Cardinality::Set,
                                    values: Vec::new(),
                                },
                                PropertyField {
                                    key: key(QUERY_PROPERTY_KEY),
                                    value_type: PropertyType::Document,
                                    cardinality: Cardinality::Single,
                                    values: vec![PropertyValue::Document(
                                        PropertyDocument::default_query(
                                            "SELECT ?item WHERE {}".into(),
                                        ),
                                    )],
                                },
                            ]),
                            tags: vec![tag_id.clone()],
                        }],
                        tags: vec![domain::OutlineFragmentTag {
                            id: tag_id.clone(),
                            name: "Project".into(),
                        }],
                        pages: Vec::new(),
                    },
                },
            ),
            "t3",
        )
        .unwrap();

        let pasted = core.page_snapshot(&page()).unwrap();
        assert_eq!(pasted.blocks[0].markdown, "ship it");
        assert_eq!(pasted.blocks[0].tags, [tag_id]);
        assert!(pasted.blocks[0].properties.iter().any(|field| {
            field.key.as_str() == "builtin.task-status"
                && field.values == [PropertyValue::String("doing".into())]
        }));
        assert!(
            pasted.blocks[0]
                .properties
                .iter()
                .any(|field| { field.key.as_str() == "user.reviewers" && field.values.is_empty() })
        );
        assert!(pasted.blocks[0].properties.iter().any(|field| {
            field.key.as_str() == QUERY_PROPERTY_KEY
                && matches!(
                    field.values.first(),
                    Some(PropertyValue::Document(document))
                        if document.views[0].definition.source == "SELECT ?item WHERE {}"
                )
        }));
        assert!(pasted.blocks[0].properties.iter().any(|field| {
            field.key.as_str() == "builtin.created-at"
                && field.values == [PropertyValue::String("t2".into())]
        }));
        assert!(pasted.blocks[0].properties.iter().any(|field| {
            field.key.as_str() == "builtin.updated-at"
                && field.values == [PropertyValue::String("t3".into())]
        }));
    }

    #[test]
    fn outline_fragment_rejects_non_query_documents_and_unused_descriptors() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());

        let unsupported_document = OutlineFragment {
            kind: OUTLINE_FRAGMENT_KIND.into(),
            version: OUTLINE_FRAGMENT_VERSION,
            source_graph_id: graph(),
            items: vec![domain::OutlineFragmentItem {
                depth: 0,
                markdown: "untrusted".into(),
                page_references: Vec::new(),
                properties: property_bag(vec![PropertyField {
                    key: key("user.embedded-document"),
                    value_type: PropertyType::Document,
                    cardinality: Cardinality::Single,
                    values: vec![PropertyValue::Document(PropertyDocument::default_query(
                        "SELECT * WHERE {}".into(),
                    ))],
                }]),
                tags: Vec::new(),
            }],
            tags: Vec::new(),
            pages: Vec::new(),
        };
        assert!(matches!(
            core.execute(
                envelope(
                    "reject-document",
                    Command::PasteOutline {
                        owner: OutlineOwner::Page { id: page() },
                        parent: None,
                        index: 0,
                        replace: None,
                        fragment: unsupported_document,
                    },
                ),
                "t2",
            ),
            Err(CoreError::InvalidHierarchy(_))
        ));

        let unused_descriptor = OutlineFragment {
            kind: OUTLINE_FRAGMENT_KIND.into(),
            version: OUTLINE_FRAGMENT_VERSION,
            source_graph_id: graph(),
            items: vec![domain::OutlineFragmentItem {
                depth: 0,
                markdown: "untrusted".into(),
                page_references: Vec::new(),
                properties: PropertyBag::new(),
                tags: Vec::new(),
            }],
            tags: vec![domain::OutlineFragmentTag {
                id: TagId::new("unused").unwrap(),
                name: "Unused".into(),
            }],
            pages: Vec::new(),
        };
        assert!(matches!(
            core.execute(
                envelope(
                    "reject-descriptor",
                    Command::PasteOutline {
                        owner: OutlineOwner::Page { id: page() },
                        parent: None,
                        index: 0,
                        replace: None,
                        fragment: unused_descriptor,
                    },
                ),
                "t3",
            ),
            Err(CoreError::InvalidHierarchy(_))
        ));
        assert!(core.page_snapshot(&page()).unwrap().blocks.is_empty());
    }

    #[test]
    fn cross_graph_fragment_resolves_references_and_undoes_atomically() {
        let target_graph = GraphId::new("target-graph").unwrap();
        let mut core = GraphCore::new(target_graph.clone(), 1, "t0").unwrap();
        let destination = PageId::new("destination").unwrap();
        core.execute(
            CommandEnvelope {
                graph_id: target_graph.clone(),
                command_id: CommandId::new("page").unwrap(),
                command: Command::EnsurePage {
                    page_id: destination.clone(),
                    title: "Destination".into(),
                },
            },
            "t1",
        )
        .unwrap();
        let empty = core
            .execute(
                CommandEnvelope {
                    graph_id: target_graph.clone(),
                    command_id: CommandId::new("empty").unwrap(),
                    command: Command::InsertBlock {
                        owner: OutlineOwner::Page {
                            id: destination.clone(),
                        },
                        parent: None,
                        index: 0,
                        markdown: String::new(),
                    },
                },
                "t2",
            )
            .unwrap()
            .result
            .created_block
            .unwrap();
        let source_page = PageId::new("source-reference").unwrap();
        let source_tag = TagId::new("source-tag").unwrap();

        core.execute(
            CommandEnvelope {
                graph_id: target_graph.clone(),
                command_id: CommandId::new("paste").unwrap(),
                command: Command::PasteOutline {
                    owner: OutlineOwner::Page {
                        id: destination.clone(),
                    },
                    parent: None,
                    index: 0,
                    replace: Some(empty),
                    fragment: OutlineFragment {
                        kind: OUTLINE_FRAGMENT_KIND.into(),
                        version: OUTLINE_FRAGMENT_VERSION,
                        source_graph_id: graph(),
                        items: vec![domain::OutlineFragmentItem {
                            depth: 0,
                            markdown: "portable".into(),
                            page_references: Vec::new(),
                            properties: property_bag(vec![PropertyField {
                                key: key("user.related"),
                                value_type: PropertyType::Page,
                                cardinality: Cardinality::Single,
                                values: vec![PropertyValue::Page(source_page.clone())],
                            }]),
                            tags: vec![source_tag.clone()],
                        }],
                        tags: vec![domain::OutlineFragmentTag {
                            id: source_tag,
                            name: "Project".into(),
                        }],
                        pages: vec![OutlineFragmentPage {
                            id: source_page,
                            title: "Referenced page".into(),
                            journal_date: None,
                        }],
                    },
                },
            },
            "t3",
        )
        .unwrap();

        let snapshot = core.snapshot().unwrap();
        let copied_tag = snapshot
            .tags
            .iter()
            .find(|tag| tag.name == "Project")
            .unwrap();
        let copied_page = snapshot
            .pages
            .iter()
            .find(|page| page.title == "Referenced page")
            .unwrap();
        let pasted = snapshot
            .pages
            .iter()
            .find(|page| page.id == destination)
            .unwrap();
        assert_eq!(pasted.blocks[0].tags, std::slice::from_ref(&copied_tag.id));
        assert!(pasted.blocks[0].properties.iter().any(|field| {
            field.key.as_str() == "user.related"
                && field.values == [PropertyValue::Page(copied_page.id.clone())]
        }));

        core.execute(
            CommandEnvelope {
                graph_id: target_graph,
                command_id: CommandId::new("undo").unwrap(),
                command: Command::Undo,
            },
            "t4",
        )
        .unwrap();
        let undone = core.snapshot().unwrap();
        assert!(undone.tags.is_empty());
        assert!(
            undone
                .pages
                .iter()
                .all(|page| page.title != "Referenced page")
        );
        let destination = undone
            .pages
            .iter()
            .find(|page| page.title == "Destination")
            .unwrap();
        assert_eq!(destination.blocks.len(), 1);
        assert_eq!(destination.blocks[0].markdown, "");
    }

    #[test]
    fn plural_move_keeps_middle_run_contiguous_and_undoes_once() {
        let mut core = GraphCore::new(graph(), 1, "t0").unwrap();
        ensure_regular_page(&mut core, "page", &page());
        let first = insert_root(&mut core, "first", &page(), 0, "first");
        let second = insert_root(&mut core, "second", &page(), 1, "second");
        let third = insert_root(&mut core, "third", &page(), 2, "third");
        insert_root(&mut core, "fourth", &page(), 3, "fourth");
        insert_root(&mut core, "fifth", &page(), 4, "fifth");
        let sixth = insert_root(&mut core, "sixth", &page(), 5, "sixth");
        insert_root(&mut core, "seventh", &page(), 6, "seventh");
        insert_root(&mut core, "eighth", &page(), 7, "eighth");
        insert_root(&mut core, "ninth", &page(), 8, "ninth");

        core.execute(
            envelope(
                "move-many",
                Command::MoveBlocks {
                    owner: OutlineOwner::Page { id: page() },
                    block_ids: vec![first, second, third],
                    parent: None,
                    after: Some(sixth),
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
            vec![
                "fourth", "fifth", "sixth", "first", "second", "third", "seventh", "eighth",
                "ninth"
            ]
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
            vec![
                "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
                "ninth"
            ]
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
                    owner: OutlineOwner::Page { id: page() },
                    block_ids: vec![parent.clone(), first.clone()],
                },
            ),
            "t3",
        );
        assert!(matches!(rejected, Err(CoreError::FirstSiblingIndent)));
        assert_eq!(core.page_snapshot(&page()).unwrap(), before_rejection);

        let rejected = core.execute(
            envelope(
                "invalid-outdent-root",
                Command::OutdentBlocks {
                    owner: OutlineOwner::Page { id: page() },
                    block_ids: vec![first.clone()],
                },
            ),
            "t3",
        );
        assert!(matches!(rejected, Err(CoreError::RootBlockOutdent)));
        assert_eq!(core.page_snapshot(&page()).unwrap(), before_rejection);

        core.execute(
            envelope(
                "indent-many",
                Command::IndentBlocks {
                    owner: OutlineOwner::Page { id: page() },
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
                    owner: OutlineOwner::Page { id: page() },
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
                        owner: OutlineOwner::Page { id: second_page },
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
                    owner: OutlineOwner::Page { id: page() },
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
        let outline = core.outline(&OutlineOwner::Page { id: page() }).unwrap();
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
                    owner: OutlineOwner::Page { id: page() },
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
                        owner: OutlineOwner::Page {
                            id: live_page.clone(),
                        },
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
                    owner: OutlineOwner::Page {
                        id: live_page.clone(),
                    },
                    id: live_block.clone(),
                },
            ),
            (
                "tag-deleted-block",
                EntityId::Block {
                    owner: OutlineOwner::Page {
                        id: deleted_page.clone(),
                    },
                    id: deleted_block.clone(),
                },
            ),
            (
                "tag-nested-block",
                EntityId::Block {
                    owner: OutlineOwner::Page {
                        id: live_page.clone(),
                    },
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
                .outline(&OutlineOwner::Page {
                    id: deleted_page.clone(),
                })
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
            effect.affected_outlines,
            [
                OutlineOwner::Page {
                    id: deleted_page.clone(),
                },
                OutlineOwner::Page {
                    id: live_page.clone(),
                },
            ]
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
                .outline(&OutlineOwner::Page {
                    id: deleted_page.clone(),
                })
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
                .outline(&OutlineOwner::Page {
                    id: deleted_page.clone(),
                })
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
                    owner: OutlineOwner::Page {
                        id: second_page.clone(),
                    },
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
                owner: OutlineOwner::Page {
                    id: second_page.clone()
                },
                id: second,
            })
        );

        core.execute(
            envelope(
                "delete-block",
                Command::DeleteBlocks {
                    owner: OutlineOwner::Page {
                        id: first_page.clone(),
                    },
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
                owner: OutlineOwner::Page {
                    id: first_page.clone()
                },
                id: restored.id,
            })
        );
        let redo = core
            .execute(envelope("redo-delete", Command::Redo), "t7")
            .unwrap();
        assert_eq!(
            redo.result.history_effect.unwrap().reveal,
            Some(EntityId::Block {
                owner: OutlineOwner::Page {
                    id: first_page.clone()
                },
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
                owner: OutlineOwner::Page { id: first_page },
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
    fn recovery_history_boundary_excludes_replayed_same_peer_tail() {
        let mut writer = GraphCore::new(graph(), 1, "t0").unwrap();
        let base = writer.export_gc_checkpoint().unwrap();
        let tail = writer
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
            .unwrap()
            .update;

        let mut recovered = GraphCore::from_snapshot(graph(), 1, &base).unwrap();
        recovered.import_remote(&tail).unwrap();
        recovered.reset_local_history();

        let old_session = recovered
            .execute(envelope("old-session-undo", Command::Undo), "t2")
            .unwrap();
        assert!(old_session.update.is_empty());
        assert_eq!(recovered.summary().unwrap().pages[0].title, "Home");

        recovered
            .execute(
                envelope(
                    "new-session-rename",
                    Command::RenamePage {
                        page_id: page(),
                        title: "Current".into(),
                    },
                ),
                "t3",
            )
            .unwrap();
        let current_session = recovered
            .execute(envelope("new-session-undo", Command::Undo), "t4")
            .unwrap();
        assert!(!current_session.update.is_empty());
        assert_eq!(recovered.summary().unwrap().pages[0].title, "Home");
    }

    #[test]
    fn history_metadata_mismatch_discards_unpaired_loro_history() {
        let mut recovered = GraphCore::new(graph(), 1, "t0").unwrap();
        recovered
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
        recovered.undo_history.clear();
        let frontier = recovered.doc.oplog_vv();
        assert!(matches!(
            recovered.execute(envelope("unpaired-undo", Command::Undo), "t2"),
            Err(CoreError::HistoryMetadataMismatch)
        ));
        assert_eq!(recovered.doc.oplog_vv(), frontier);

        recovered
            .execute(
                envelope(
                    "new-session-rename",
                    Command::RenamePage {
                        page_id: page(),
                        title: "Current".into(),
                    },
                ),
                "t3",
            )
            .unwrap();
        assert!(
            !recovered
                .execute(envelope("new-session-undo", Command::Undo), "t4")
                .unwrap()
                .update
                .is_empty()
        );
        let exhausted = recovered
            .execute(envelope("exhausted-undo", Command::Undo), "t5")
            .unwrap();
        assert!(exhausted.update.is_empty());
        assert_eq!(recovered.summary().unwrap().pages[0].title, "Home");
    }

    #[test]
    fn incomplete_remote_update_is_rejected_without_entering_pending_state() {
        let mut writer = GraphCore::new(graph(), 1, "t0").unwrap();
        let base = writer.export_snapshot().unwrap();
        let first = writer
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
            .unwrap()
            .update;
        let second = writer
            .execute(
                envelope(
                    "rename",
                    Command::RenamePage {
                        page_id: page(),
                        title: "Renamed".into(),
                    },
                ),
                "t2",
            )
            .unwrap()
            .update;

        let mut recipient = GraphCore::from_snapshot(graph(), 2, &base).unwrap();
        assert!(matches!(
            recipient.import_remote(&second),
            Err(CoreError::MissingDependencies)
        ));
        assert!(recipient.summary().unwrap().pages.is_empty());

        recipient.import_remote(&first).unwrap();
        recipient.import_remote(&second).unwrap();
        assert_eq!(recipient.summary().unwrap().pages[0].title, "Renamed");
    }

    #[test]
    fn history_operation_preserves_concurrent_name_conflicts_as_data() {
        let other_page = PageId::new("other").unwrap();
        let mut left = GraphCore::new(graph(), 1, "t0").unwrap();
        left.execute(
            envelope(
                "home",
                Command::EnsurePage {
                    page_id: page(),
                    title: "Alpha".into(),
                },
            ),
            "t1",
        )
        .unwrap();
        left.execute(
            envelope(
                "other",
                Command::EnsurePage {
                    page_id: other_page.clone(),
                    title: "Beta".into(),
                },
            ),
            "t2",
        )
        .unwrap();
        let base = left.export_snapshot().unwrap();
        let mut right = GraphCore::from_snapshot(graph(), 2, &base).unwrap();

        let local_rename = left
            .execute(
                envelope(
                    "local-rename",
                    Command::RenamePage {
                        page_id: page(),
                        title: "Gamma".into(),
                    },
                ),
                "t3",
            )
            .unwrap()
            .update;
        right.import_remote(&local_rename).unwrap();
        let remote_rename = right
            .execute(
                CommandEnvelope {
                    graph_id: graph(),
                    command_id: CommandId::new("remote-rename").unwrap(),
                    command: Command::RenamePage {
                        page_id: other_page,
                        title: "Alpha".into(),
                    },
                },
                "t4",
            )
            .unwrap()
            .update;
        left.import_remote(&remote_rename).unwrap();

        let undone = left
            .execute(envelope("conflicting-undo", Command::Undo), "t5")
            .unwrap();
        assert!(!undone.update.is_empty());
        let snapshot = left.summary().unwrap();
        assert_eq!(
            snapshot
                .pages
                .iter()
                .filter(|item| item.title == "Alpha")
                .count(),
            2
        );
        assert_eq!(
            snapshot.conflicts,
            vec![GraphConflict::DuplicatePageName {
                canonical_name: "alpha".into(),
                page_ids: vec![page(), PageId::new("other").unwrap()],
            }]
        );

        left.execute(envelope("resolve-conflict-redo", Command::Redo), "t6")
            .unwrap();
        let resolved = left.summary().unwrap();
        assert!(resolved.conflicts.is_empty());
        assert!(resolved.pages.iter().any(|item| item.title == "Gamma"));
    }

    #[test]
    fn clone_snapshot_gets_a_new_graph_identity_without_losing_graph_state() {
        let mut source = GraphCore::new(graph(), 1, "t0").unwrap();
        assert!(matches!(
            source.export_clone_snapshot(graph(), 99),
            Err(CoreError::CloneTargetMatchesSource)
        ));
        ensure_regular_page(&mut source, "page", &page());
        let block = insert_root(&mut source, "block", &page(), 0, "query");
        let old_iri = query::entity_iri(&graph(), "page", page().as_str())
            .unwrap()
            .as_str()
            .to_owned();
        source
            .execute(
                envelope(
                    "query",
                    Command::SetQuerySource {
                        owner: QueryOwner::Block {
                            owner: OutlineOwner::Page { id: page() },
                            id: block,
                        },
                        view_id: QueryViewId::new("all").unwrap(),
                        source: format!("SELECT ?page WHERE {{ BIND(<{old_iri}> AS ?page) }}"),
                    },
                ),
                "t1",
            )
            .unwrap();
        source
            .execute(
                envelope(
                    "default-query",
                    Command::CreateDefaultQuery {
                        default_query_id: DefaultQueryId::new("dq-copy").unwrap(),
                        title: "Copy me".into(),
                        document: PropertyDocument::default_query(format!(
                            "SELECT ?page WHERE {{ BIND(<{old_iri}> AS ?page) }}"
                        )),
                    },
                ),
                "t1",
            )
            .unwrap();
        let date = LocalDate::new("2026-08-21").unwrap();
        source
            .execute(
                envelope("journal", Command::EnsureJournal { date: date.clone() }),
                "t2",
            )
            .unwrap();
        let source_journal_id = PageId::journal(&graph(), &date);
        source
            .execute(
                envelope("delete", Command::DeletePage { page_id: page() }),
                "t3",
            )
            .unwrap();

        let target_id = GraphId::new("cloned-graph").unwrap();
        let bytes = source.export_clone_snapshot(target_id.clone(), 99).unwrap();
        let mut cloned = GraphCore::from_snapshot(target_id.clone(), 99, &bytes).unwrap();
        assert_eq!(cloned.graph_id(), &target_id);
        assert!(
            cloned.require_page(&page()).is_ok(),
            "soft-deleted page is retained"
        );
        assert!(cloned.require_page(&source_journal_id).is_ok());

        let result = cloned
            .execute(
                CommandEnvelope {
                    graph_id: target_id.clone(),
                    command_id: CommandId::new("same-journal").unwrap(),
                    command: Command::EnsureJournal { date },
                },
                "t4",
            )
            .unwrap();
        assert!(result.update.is_empty(), "the copied journal day is reused");

        let page_map = cloned.require_page(&page()).unwrap();
        let outline = page_map.get("outline").and_then(value_into_tree).unwrap();
        let copied_block = outline.nodes().into_iter().next().unwrap();
        let bag = outline
            .get_meta(copied_block)
            .unwrap()
            .get("properties")
            .and_then(value_into_map)
            .unwrap();
        let document = require_query_document(&bag).unwrap();
        let source = decode_query_document(&document).unwrap().views[0]
            .definition
            .source
            .clone();
        let new_iri = query::entity_iri(&target_id, "page", page().as_str())
            .unwrap()
            .as_str()
            .to_owned();
        assert!(source.contains(&new_iri));
        assert!(!source.contains(&old_iri));
        let default_source = &cloned.summary().unwrap().settings.default_queries[0]
            .document
            .views[0]
            .definition
            .source;
        assert!(default_source.contains(&new_iri));
        assert!(!default_source.contains(&old_iri));
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
                        owner: OutlineOwner::Page { id: page() },
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
                        owner: OutlineOwner::Page { id: page() },
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
        let corrupt_bag = core
            .block_bag(&OutlineOwner::Page { id: page() }, &child)
            .unwrap();
        let corrupt_field = ensure_property_field(
            &corrupt_bag,
            &key("builtin.page-kind"),
            PropertyType::String,
            Cardinality::Single,
        )
        .unwrap();
        corrupt_field
            .insert(
                PROPERTY_SINGLE_KEY,
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
