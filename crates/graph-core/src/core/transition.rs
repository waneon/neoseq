use super::outline::{MergePlan, MovePlan, OutlinePlan, ReparentDestination, ReparentPlan};
use super::{
    CoreError, FragmentResolution, GraphCore, HistoryEntry, HistoryPlan, HistoryTarget,
    InsertableOutlineItem, MAX_BLOCK_TEXT_BYTES, MAX_DEFAULT_QUERIES, MAX_ENTITY_NAME_BYTES,
    MAX_PROPERTY_CHANGES, MAX_QUERY_SOURCE_BYTES, MAX_STRUCTURAL_TARGETS, MutationOutcome,
    OutlineInsertion, PAGE_REFERENCE_CHAR, PAGE_REFERENCE_MARK, bag_contains_key, block_id,
    clear_property_values, collect_tagged_blocks, decode_bag, default_queries_map,
    ensure_page_name_available, ensure_property_field, ensure_tag_name_available,
    initialize_created_node, key, map_string, node_has_tag, normalized_query_document,
    normalized_query_view, property_owner_from_query_owner, property_owner_target,
    remove_property_field, remove_repeated_value, replace_text, require_block_in, set_repeated,
    set_single, tree_id, validate_default_query_title, validate_name, validate_text,
    value_into_map, value_into_tree, write_query_document_snapshot,
};
use crate::SemanticEvent;
use domain::{
    BlockId, Cardinality, Command, DefaultQueryId, EntityId, HistoryScope, InlineContent,
    LocalDate, OutlineFragment, OutlineFragmentItem, OutlineItem, OutlineOwner, PageId,
    PropertyChange, PropertyDocument, PropertyError, PropertyField, PropertyKey, PropertyOwner,
    PropertyType, PropertyValue, QUERY_PROPERTY_KEY, QueryDefinition, QueryOwner, QueryPlan,
    QueryView, QueryViewColumn, QueryViewId, QueryViewKind, QueryViewOptions, SplitPlacement,
    TagId, validate_property, validate_property_shape, validate_property_write,
};
use loro::{Container, LoroText, TextDelta, ValueOrContainer, cursor::PosType};
use std::collections::{BTreeMap, BTreeSet};

/// The first normalized command representation in the core.
///
/// A transition contains only typed storage-independent operations and the
/// metadata derived from them. Once an intent reaches this form, mutation,
/// timestamps, history, and semantic events no longer interpret `Command`.
#[derive(Debug)]
pub(super) struct NormalizedTransition {
    semantic: SemanticEvent,
    operations: Vec<PrimitiveOp>,
    footprint: TransitionFootprint,
    history: HistoryPlan,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum CreationSlot {
    Page,
    Block,
    Tag,
}

impl NormalizedTransition {
    pub(super) fn is_content_only(&self) -> bool {
        self.operations.iter().all(|operation| {
            matches!(
                operation,
                PrimitiveOp::SpliceText { .. } | PrimitiveOp::SpliceInline { .. }
            )
        })
    }

    fn new(semantic: SemanticEvent, operations: Vec<PrimitiveOp>, history: HistoryShape) -> Self {
        let footprint = TransitionFootprint::from_operations(&operations);
        let history = history.materialize(&footprint);
        Self {
            semantic,
            operations,
            footprint,
            history,
        }
    }

    fn properties(operations: Vec<PrimitiveOp>) -> Self {
        let footprint = TransitionFootprint::from_operations(&operations);
        debug_assert_eq!(footprint.property_owners.len(), 1);
        let semantic = property_semantic(
            footprint
                .property_owners
                .first()
                .expect("a property transition has one owner"),
        );
        let history = HistoryShape::Property.materialize(&footprint);
        Self {
            semantic,
            operations,
            footprint,
            history,
        }
    }

    fn content(operations: Vec<PrimitiveOp>) -> Self {
        debug_assert!(!operations.is_empty());
        Self::new(
            SemanticEvent::BlockTextChanged,
            operations,
            HistoryShape::Content,
        )
    }

    fn structural(operation: PrimitiveOp) -> Self {
        let footprint = TransitionFootprint::from_operations(std::slice::from_ref(&operation));
        let (semantic, history) = structural_metadata(&operation, &footprint);
        Self {
            semantic,
            operations: vec![operation],
            footprint,
            history,
        }
    }

    fn query(operations: Vec<PrimitiveOp>) -> Self {
        let footprint = TransitionFootprint::from_operations(&operations);
        debug_assert_eq!(footprint.query_owners.len(), 1);
        let semantic = query_semantic(
            footprint
                .query_owners
                .first()
                .expect("a query transition has one owner"),
        );
        let history = HistoryShape::Query.materialize(&footprint);
        Self {
            semantic,
            operations,
            footprint,
            history,
        }
    }

    fn graph_settings(operations: Vec<PrimitiveOp>) -> Self {
        debug_assert!(!operations.is_empty());
        Self::new(
            SemanticEvent::GraphSettingsChanged,
            operations,
            HistoryShape::Graph,
        )
    }

    fn ensure(seed: EntitySeed) -> Self {
        let (semantic, history) = match &seed {
            EntitySeed::RegularPage { page_id, .. } => (
                SemanticEvent::PageEnsured,
                HistoryShape::PageCreated(page_id.clone()),
            ),
            EntitySeed::JournalPage { page_id, .. } => (
                SemanticEvent::JournalEnsured,
                HistoryShape::PageCreated(page_id.clone()),
            ),
            EntitySeed::Tag { .. } => (SemanticEvent::TagEnsured, HistoryShape::Graph),
        };
        Self::new(semantic, vec![PrimitiveOp::EnsureEntity { seed }], history)
    }

    fn tag_membership(operations: Vec<PrimitiveOp>) -> Self {
        let present = operations
            .iter()
            .find_map(|operation| match operation {
                PrimitiveOp::SetTagMembership { present, .. } => Some(*present),
                _ => None,
            })
            .expect("a tag membership transition has a membership operation");
        let footprint = TransitionFootprint::from_operations(&operations);
        let semantic = if present {
            SemanticEvent::TagAddedAndDefaultsMaterialized
        } else {
            SemanticEvent::TagRemoved
        };
        let history = HistoryShape::Entity.materialize(&footprint);
        Self {
            semantic,
            operations,
            footprint,
            history,
        }
    }

    pub(super) fn semantic(&self) -> SemanticEvent {
        self.semantic
    }

    pub(super) fn history(&self) -> &HistoryPlan {
        &self.history
    }

    pub(super) fn creation_slot(&self) -> Option<CreationSlot> {
        self.operations
            .iter()
            .find_map(|operation| match operation {
                PrimitiveOp::EnsureEntity {
                    seed: EntitySeed::RegularPage { .. } | EntitySeed::JournalPage { .. },
                } => Some(CreationSlot::Page),
                PrimitiveOp::EnsureEntity {
                    seed: EntitySeed::Tag { .. },
                } => Some(CreationSlot::Tag),
                PrimitiveOp::InsertOutline { .. } | PrimitiveOp::SplitBlock { .. } => {
                    Some(CreationSlot::Block)
                }
                _ => None,
            })
    }
}

#[derive(Debug, Clone, PartialEq)]
enum LifecycleEntity {
    Page(PageId),
    Tag(TagId),
}

impl From<&LifecycleEntity> for TouchedEntity {
    fn from(entity: &LifecycleEntity) -> Self {
        match entity {
            LifecycleEntity::Page(page_id) => Self::Page(page_id.clone()),
            LifecycleEntity::Tag(tag_id) => Self::Tag(tag_id.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum TouchedEntity {
    Page(PageId),
    Block {
        owner: OutlineOwner,
        block_id: BlockId,
    },
    Tag(TagId),
}

impl TouchedEntity {
    fn from_entity(entity: &EntityId) -> Self {
        match entity {
            EntityId::Page { id } => Self::Page(id.clone()),
            EntityId::Block { owner, id } => Self::Block {
                owner: owner.clone(),
                block_id: id.clone(),
            },
        }
    }

    fn from_property_owner(owner: &PropertyOwner) -> Self {
        match owner {
            PropertyOwner::Page { id } => Self::Page(id.clone()),
            PropertyOwner::Block { owner, id } => Self::Block {
                owner: owner.clone(),
                block_id: id.clone(),
            },
            PropertyOwner::Tag { tag_id } | PropertyOwner::TagDefault { tag_id } => {
                Self::Tag(tag_id.clone())
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum EntitySeed {
    RegularPage { page_id: PageId, title: String },
    JournalPage { page_id: PageId, date: LocalDate },
    Tag { tag_id: TagId, name: String },
}

impl EntitySeed {
    fn target(&self) -> TouchedEntity {
        match self {
            Self::RegularPage { page_id, .. } | Self::JournalPage { page_id, .. } => {
                TouchedEntity::Page(page_id.clone())
            }
            Self::Tag { tag_id, .. } => TouchedEntity::Tag(tag_id.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum PrimitiveOp {
    EnsureEntity {
        seed: EntitySeed,
    },
    AssignName {
        target: LifecycleEntity,
        name: String,
    },
    AssignDeleted {
        target: LifecycleEntity,
        deleted: bool,
    },
    RemoveTagReference {
        target: TagReferenceTarget,
        tag_id: TagId,
    },
    SetTagMembership {
        entity: EntityId,
        tag_id: TagId,
        present: bool,
    },
    DeclareProperty {
        owner: PropertyOwner,
        key: PropertyKey,
        value_type: PropertyType,
        cardinality: Cardinality,
    },
    AssignProperty {
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
    AddPropertyValue {
        owner: PropertyOwner,
        key: PropertyKey,
        value: PropertyValue,
    },
    RemovePropertyValue {
        owner: PropertyOwner,
        key: PropertyKey,
        value: PropertyValue,
    },
    SpliceText {
        target: TextTarget,
        insert: String,
    },
    SpliceInline {
        target: TextTarget,
        insert: Vec<InlineAtom>,
    },
    InsertOutline {
        plan: Box<OutlineInsertPlan>,
    },
    SplitBlock {
        plan: Box<SplitPlan>,
    },
    MergeBlockBackward {
        owner: OutlineOwner,
        plan: Box<MergePlan>,
    },
    MoveBlocks {
        owner: OutlineOwner,
        requested: Vec<BlockId>,
        plan: Box<MovePlan>,
    },
    IndentBlocks {
        owner: OutlineOwner,
        plan: Box<ReparentPlan>,
    },
    OutdentBlocks {
        owner: OutlineOwner,
        plan: Box<ReparentPlan>,
    },
    DeleteBlocks {
        owner: OutlineOwner,
        plan: Box<OutlinePlan>,
    },
    InsertDefaultQuery {
        seed: Box<DefaultQuerySeed>,
    },
    AssignDefaultQueryTitle {
        default_query_id: DefaultQueryId,
        title: String,
    },
    AssignDefaultQueryPositions {
        positions: Vec<(DefaultQueryId, u32)>,
    },
    AssignDefaultQueryDeleted {
        default_query_id: DefaultQueryId,
        deleted: bool,
    },
    InitializeQueryDocument {
        owner: QueryOwner,
    },
    ReplaceQuerySource {
        target: QueryDefinitionTarget,
        source: String,
    },
    SpliceQuerySource {
        target: QuerySourceTarget,
        insert: String,
    },
    AssignQueryPlan {
        target: QueryDefinitionTarget,
        plan: Option<QueryPlan>,
    },
    PutQueryView {
        owner: QueryOwner,
        write: Box<QueryViewWrite>,
    },
    RemoveQueryView {
        owner: QueryOwner,
        view_id: QueryViewId,
        next_default: Option<QueryViewId>,
    },
    AssignQueryDefaultView {
        owner: QueryOwner,
        view_id: QueryViewId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TextTarget {
    owner: OutlineOwner,
    block_id: BlockId,
    index: usize,
    delete: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum InlineAtom {
    Text(String),
    PageReference(PageId),
}

#[derive(Debug, Clone, PartialEq)]
struct OutlineInsertPlan {
    owner: OutlineOwner,
    parent: Option<BlockId>,
    index: usize,
    replace: Option<BlockId>,
    items: Vec<PlannedOutlineItem>,
    dependencies: Vec<EntitySeed>,
}

#[derive(Debug, Clone, PartialEq)]
struct PlannedOutlineItem {
    depth: usize,
    content: PlannedBlockContent,
    properties: Vec<PropertyField>,
    tags: Vec<TagId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PlannedBlockContent {
    Markdown(String),
    Inline(Vec<InlineAtom>),
}

impl InsertableOutlineItem for PlannedOutlineItem {
    fn depth(&self) -> usize {
        self.depth
    }

    fn markdown(&self) -> &str {
        match &self.content {
            PlannedBlockContent::Markdown(markdown) => markdown,
            PlannedBlockContent::Inline(_) => "",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct SplitPlan {
    owner: OutlineOwner,
    target: BlockId,
    destination: BlockPosition,
    index: usize,
    truncate: usize,
    tail: Vec<TextDelta>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlockPosition {
    parent: Option<BlockId>,
    index: usize,
}

#[derive(Debug, Clone, PartialEq)]
struct DefaultQuerySeed {
    default_query_id: DefaultQueryId,
    title: String,
    document: PropertyDocument,
    position: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QueryDefinitionTarget {
    owner: QueryOwner,
    view_id: QueryViewId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QuerySourceTarget {
    definition: QueryDefinitionTarget,
    index: usize,
    delete: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QueryViewPresentation {
    id: QueryViewId,
    name: String,
    kind: QueryViewKind,
    position: u32,
    columns: Vec<QueryViewColumn>,
    options: QueryViewOptions,
}

impl From<&QueryView> for QueryViewPresentation {
    fn from(view: &QueryView) -> Self {
        Self {
            id: view.id.clone(),
            name: view.name.clone(),
            kind: view.kind,
            position: view.position,
            columns: view.columns.clone(),
            options: view.options.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QueryViewWrite {
    presentation: QueryViewPresentation,
    definition: Option<QueryDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum TagReferenceTarget {
    PageRoot(PageId),
    Block {
        owner: OutlineOwner,
        block_id: BlockId,
    },
}

#[derive(Debug, Default)]
struct TransitionFootprint {
    entities: BTreeSet<TouchedEntity>,
    blocks: Vec<(OutlineOwner, BlockId)>,
    outlines: BTreeSet<OutlineOwner>,
    property_owners: Vec<PropertyOwner>,
    query_owners: Vec<QueryOwner>,
}

impl TransitionFootprint {
    fn include_query_owner(&mut self, owner: &QueryOwner) {
        if !self.query_owners.contains(owner) {
            self.query_owners.push(owner.clone());
        }
        if let Some(property_owner) = property_owner_from_query_owner(owner) {
            self.entities
                .insert(TouchedEntity::from_property_owner(&property_owner));
        }
    }

    fn from_operations(operations: &[PrimitiveOp]) -> Self {
        let mut footprint = Self::default();
        let mut seen_blocks = BTreeSet::new();
        for operation in operations {
            match operation {
                PrimitiveOp::EnsureEntity { seed } => {
                    footprint.entities.insert(seed.target());
                }
                PrimitiveOp::AssignName { target, .. }
                | PrimitiveOp::AssignDeleted { target, .. } => {
                    footprint.entities.insert(target.into());
                }
                PrimitiveOp::RemoveTagReference { target, .. } => match target {
                    TagReferenceTarget::PageRoot(page_id) => {
                        footprint.outlines.insert(OutlineOwner::Page {
                            id: page_id.clone(),
                        });
                    }
                    TagReferenceTarget::Block { owner, block_id } => {
                        let block = (owner.clone(), block_id.clone());
                        if seen_blocks.insert(block.clone()) {
                            footprint.blocks.push(block);
                        }
                        footprint.outlines.insert(owner.clone());
                    }
                },
                PrimitiveOp::SetTagMembership { entity, .. } => {
                    footprint
                        .entities
                        .insert(TouchedEntity::from_entity(entity));
                }
                PrimitiveOp::DeclareProperty { owner, .. }
                | PrimitiveOp::AssignProperty { owner, .. }
                | PrimitiveOp::ClearPropertyValues { owner, .. }
                | PrimitiveOp::RemoveProperty { owner, .. }
                | PrimitiveOp::AddPropertyValue { owner, .. }
                | PrimitiveOp::RemovePropertyValue { owner, .. } => {
                    if !footprint.property_owners.contains(owner) {
                        footprint.property_owners.push(owner.clone());
                    }
                    footprint
                        .entities
                        .insert(TouchedEntity::from_property_owner(owner));
                }
                PrimitiveOp::SpliceText { target, .. }
                | PrimitiveOp::SpliceInline { target, .. } => {
                    let block = (target.owner.clone(), target.block_id.clone());
                    if seen_blocks.insert(block.clone()) {
                        footprint.blocks.push(block);
                    }
                    footprint.outlines.insert(target.owner.clone());
                }
                PrimitiveOp::InsertOutline { plan } => {
                    footprint.outlines.insert(plan.owner.clone());
                }
                PrimitiveOp::SplitBlock { plan } => {
                    if plan.index > 0 {
                        let block = (plan.owner.clone(), plan.target.clone());
                        if seen_blocks.insert(block.clone()) {
                            footprint.blocks.push(block);
                        }
                    }
                    footprint.outlines.insert(plan.owner.clone());
                }
                PrimitiveOp::MergeBlockBackward { owner, .. } => {
                    footprint.outlines.insert(owner.clone());
                }
                PrimitiveOp::MoveBlocks {
                    owner, requested, ..
                } => {
                    for block_id in requested {
                        let block = (owner.clone(), block_id.clone());
                        if seen_blocks.insert(block.clone()) {
                            footprint.blocks.push(block);
                        }
                    }
                    footprint.outlines.insert(owner.clone());
                }
                PrimitiveOp::IndentBlocks { owner, plan }
                | PrimitiveOp::OutdentBlocks { owner, plan } => {
                    for step in &plan.steps {
                        let block = (owner.clone(), step.block_id.clone());
                        if seen_blocks.insert(block.clone()) {
                            footprint.blocks.push(block);
                        }
                    }
                    footprint.outlines.insert(owner.clone());
                }
                PrimitiveOp::DeleteBlocks { owner, .. } => {
                    footprint.outlines.insert(owner.clone());
                }
                PrimitiveOp::InsertDefaultQuery { .. }
                | PrimitiveOp::AssignDefaultQueryTitle { .. }
                | PrimitiveOp::AssignDefaultQueryPositions { .. }
                | PrimitiveOp::AssignDefaultQueryDeleted { .. } => {}
                PrimitiveOp::InitializeQueryDocument { owner }
                | PrimitiveOp::PutQueryView { owner, .. }
                | PrimitiveOp::RemoveQueryView { owner, .. }
                | PrimitiveOp::AssignQueryDefaultView { owner, .. } => {
                    footprint.include_query_owner(owner);
                }
                PrimitiveOp::ReplaceQuerySource { target, .. }
                | PrimitiveOp::AssignQueryPlan { target, .. } => {
                    footprint.include_query_owner(&target.owner);
                }
                PrimitiveOp::SpliceQuerySource { target, .. } => {
                    footprint.include_query_owner(&target.definition.owner);
                }
            }
        }
        footprint
    }
}

#[derive(Debug)]
enum HistoryShape {
    PageCreated(PageId),
    PageChanged {
        page_id: PageId,
        reveal_on_undo: bool,
        reveal_on_redo: bool,
    },
    Graph,
    Property,
    Query,
    Entity,
    Content,
}

impl HistoryShape {
    fn materialize(self, footprint: &TransitionFootprint) -> HistoryPlan {
        let page_target = |page_id: &PageId| {
            HistoryTarget::Entity(EntityId::Page {
                id: page_id.clone(),
            })
        };
        match self {
            Self::PageCreated(page_id) => HistoryPlan {
                entry: HistoryEntry {
                    scope: HistoryScope::Outline,
                    affected_outlines: vec![OutlineOwner::Page { id: page_id }],
                    undo_candidates: Vec::new(),
                    redo_candidates: Vec::new(),
                },
                redo_created_block: false,
                redo_created_page: true,
            },
            Self::PageChanged {
                page_id,
                reveal_on_undo,
                reveal_on_redo,
            } => {
                let target = page_target(&page_id);
                HistoryPlan {
                    entry: HistoryEntry {
                        scope: HistoryScope::Outline,
                        affected_outlines: vec![OutlineOwner::Page { id: page_id }],
                        undo_candidates: reveal_on_undo
                            .then(|| target.clone())
                            .into_iter()
                            .collect(),
                        redo_candidates: reveal_on_redo.then_some(target).into_iter().collect(),
                    },
                    redo_created_block: false,
                    redo_created_page: false,
                }
            }
            Self::Graph => HistoryPlan {
                entry: HistoryEntry {
                    scope: HistoryScope::Graph,
                    affected_outlines: footprint.outlines.iter().cloned().collect(),
                    undo_candidates: Vec::new(),
                    redo_candidates: Vec::new(),
                },
                redo_created_block: false,
                redo_created_page: false,
            },
            Self::Property => {
                let owner = footprint
                    .property_owners
                    .first()
                    .expect("a property transition has one owner");
                entity_history(&TouchedEntity::from_property_owner(owner))
            }
            Self::Query => {
                let owner = footprint
                    .query_owners
                    .first()
                    .expect("a query transition has one owner");
                property_owner_from_query_owner(owner).map_or_else(
                    || HistoryShape::Graph.materialize(footprint),
                    |owner| entity_history(&TouchedEntity::from_property_owner(&owner)),
                )
            }
            Self::Entity => entity_history(
                footprint
                    .entities
                    .first()
                    .expect("an entity transition has one entity"),
            ),
            Self::Content => {
                let candidates = footprint
                    .blocks
                    .iter()
                    .map(|(owner, block_id)| {
                        HistoryTarget::Entity(EntityId::Block {
                            owner: owner.clone(),
                            id: block_id.clone(),
                        })
                    })
                    .collect::<Vec<_>>();
                HistoryPlan {
                    entry: HistoryEntry {
                        scope: HistoryScope::Entity,
                        affected_outlines: footprint.outlines.iter().cloned().collect(),
                        undo_candidates: candidates.clone(),
                        redo_candidates: candidates,
                    },
                    redo_created_block: false,
                    redo_created_page: false,
                }
            }
        }
    }
}

fn entity_history(target: &TouchedEntity) -> HistoryPlan {
    let (scope, affected_outlines, target) = match target {
        TouchedEntity::Page(page_id) => (
            HistoryScope::Outline,
            vec![OutlineOwner::Page {
                id: page_id.clone(),
            }],
            Some(EntityId::Page {
                id: page_id.clone(),
            }),
        ),
        TouchedEntity::Block { owner, block_id } => (
            HistoryScope::Entity,
            vec![owner.clone()],
            Some(EntityId::Block {
                owner: owner.clone(),
                id: block_id.clone(),
            }),
        ),
        TouchedEntity::Tag(_) => (HistoryScope::Graph, Vec::new(), None),
    };
    let candidates: Vec<_> = target.map(HistoryTarget::Entity).into_iter().collect();
    HistoryPlan {
        entry: HistoryEntry {
            scope,
            affected_outlines,
            undo_candidates: candidates.clone(),
            redo_candidates: candidates,
        },
        redo_created_block: false,
        redo_created_page: false,
    }
}

fn structural_metadata(
    operation: &PrimitiveOp,
    footprint: &TransitionFootprint,
) -> (SemanticEvent, HistoryPlan) {
    let block = |owner: &OutlineOwner, block_id: &BlockId| {
        HistoryTarget::Entity(EntityId::Block {
            owner: owner.clone(),
            id: block_id.clone(),
        })
    };
    let outline = |owner: &OutlineOwner| match owner {
        OutlineOwner::Page { id } => Some(HistoryTarget::Entity(EntityId::Page { id: id.clone() })),
        OutlineOwner::Tag { .. } => None,
    };
    let history = |undo_candidates, redo_candidates, redo_created_block| HistoryPlan {
        entry: HistoryEntry {
            scope: HistoryScope::Entity,
            affected_outlines: footprint.outlines.iter().cloned().collect(),
            undo_candidates,
            redo_candidates,
        },
        redo_created_block,
        redo_created_page: false,
    };
    let moved = |semantic, owner: &OutlineOwner, block_ids: Vec<&BlockId>| {
        let candidates = block_ids
            .into_iter()
            .map(|block_id| block(owner, block_id))
            .chain(outline(owner))
            .collect::<Vec<_>>();
        (semantic, history(candidates.clone(), candidates, false))
    };

    match operation {
        PrimitiveOp::InsertOutline { plan } => {
            let undo_candidates = plan
                .parent
                .as_ref()
                .map(|parent| block(&plan.owner, parent))
                .into_iter()
                .chain(outline(&plan.owner))
                .collect();
            (
                SemanticEvent::BlockInserted,
                history(undo_candidates, Vec::new(), true),
            )
        }
        PrimitiveOp::SplitBlock { plan } => {
            let target = block(&plan.owner, &plan.target);
            let undo_candidates = [target.clone()]
                .into_iter()
                .chain(outline(&plan.owner))
                .collect();
            (
                SemanticEvent::BlockSplit,
                history(undo_candidates, vec![target], true),
            )
        }
        PrimitiveOp::MergeBlockBackward { owner, plan } => {
            let parent = plan.before.parents.get(&plan.source).cloned().flatten();
            let index = plan
                .before
                .children
                .get(&parent)
                .and_then(|siblings| siblings.iter().position(|id| id == &plan.source))
                .expect("a prepared merge source has a stable sibling position");
            let target = block(owner, &plan.target);
            (
                SemanticEvent::BlockMergedBackward,
                history(
                    vec![
                        HistoryTarget::BlockPosition {
                            owner: owner.clone(),
                            parent,
                            index,
                        },
                        target.clone(),
                    ],
                    vec![target],
                    false,
                ),
            )
        }
        PrimitiveOp::MoveBlocks { owner, plan, .. } => moved(
            SemanticEvent::SubtreeMoved,
            owner,
            plan.outline.roots.iter().collect(),
        ),
        PrimitiveOp::IndentBlocks { owner, plan } | PrimitiveOp::OutdentBlocks { owner, plan } => {
            moved(
                SemanticEvent::SubtreeMoved,
                owner,
                plan.steps.iter().map(|step| &step.block_id).collect(),
            )
        }
        PrimitiveOp::DeleteBlocks { owner, plan } => {
            let state = &plan.before;
            let undo_candidates = plan
                .roots
                .iter()
                .map(|block_id| {
                    let parent = state
                        .parents
                        .get(block_id)
                        .cloned()
                        .expect("a prepared deletion root has a parent entry");
                    let index = state
                        .children
                        .get(&parent)
                        .and_then(|siblings| siblings.iter().position(|id| id == block_id))
                        .expect("a prepared deletion root has a sibling position");
                    HistoryTarget::BlockPosition {
                        owner: owner.clone(),
                        parent,
                        index,
                    }
                })
                .chain(outline(owner))
                .collect();
            let mut redo_candidates = Vec::new();
            if let Some(first) = plan.roots.first()
                && let Some(parent) = state.parents.get(first).cloned()
            {
                if let Some(previous) = state.children.get(&parent).and_then(|siblings| {
                    siblings
                        .iter()
                        .position(|id| id == first)
                        .and_then(|position| position.checked_sub(1))
                        .map(|position| siblings[position].clone())
                }) {
                    redo_candidates.push(block(owner, &previous));
                }
                if let Some(parent) = parent {
                    redo_candidates.push(block(owner, &parent));
                }
            }
            redo_candidates.extend(outline(owner));
            (
                SemanticEvent::SubtreesDeleted,
                history(undo_candidates, redo_candidates, false),
            )
        }
        _ => unreachable!("only structural operations have structural metadata"),
    }
}

impl GraphCore {
    /// Lowers every domain intent exactly once into an immutable owned plan.
    /// Batch and local history are orchestration, so they never enter here.
    pub(super) fn prepare_transition(
        &self,
        command: &Command,
    ) -> Result<NormalizedTransition, CoreError> {
        let transition = match command {
            Command::EnsurePage { page_id, title } => {
                validate_entity_name(title, "page")?;
                if self.doc.get_map("pages").get(page_id.as_str()).is_none() {
                    ensure_page_name_available(&self.doc, page_id, title)?;
                }
                NormalizedTransition::ensure(EntitySeed::RegularPage {
                    page_id: page_id.clone(),
                    title: title.clone(),
                })
            }
            Command::EnsureJournal { date } => {
                NormalizedTransition::ensure(EntitySeed::JournalPage {
                    page_id: self.journal_page_id(date),
                    date: date.clone(),
                })
            }
            Command::RenamePage { page_id, title } => {
                validate_entity_name(title, "page")?;
                self.require_page(page_id)?;
                ensure_page_name_available(&self.doc, page_id, title)?;
                NormalizedTransition::new(
                    SemanticEvent::PageRenamed,
                    vec![PrimitiveOp::AssignName {
                        target: LifecycleEntity::Page(page_id.clone()),
                        name: title.clone(),
                    }],
                    HistoryShape::PageChanged {
                        page_id: page_id.clone(),
                        reveal_on_undo: true,
                        reveal_on_redo: true,
                    },
                )
            }
            Command::DeletePage { page_id } => {
                self.require_page(page_id)?;
                NormalizedTransition::new(
                    SemanticEvent::PageDeleted,
                    vec![PrimitiveOp::AssignDeleted {
                        target: LifecycleEntity::Page(page_id.clone()),
                        deleted: true,
                    }],
                    HistoryShape::PageChanged {
                        page_id: page_id.clone(),
                        reveal_on_undo: true,
                        reveal_on_redo: false,
                    },
                )
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
                NormalizedTransition::new(
                    SemanticEvent::PageRestored,
                    vec![PrimitiveOp::AssignDeleted {
                        target: LifecycleEntity::Page(page_id.clone()),
                        deleted: false,
                    }],
                    HistoryShape::PageChanged {
                        page_id: page_id.clone(),
                        reveal_on_undo: false,
                        reveal_on_redo: true,
                    },
                )
            }
            Command::EnsureTag { tag_id, name } => {
                validate_entity_name(name, "tag")?;
                if self.doc.get_map("tags").get(tag_id.as_str()).is_none() {
                    ensure_tag_name_available(&self.doc, tag_id, name)?;
                }
                NormalizedTransition::ensure(EntitySeed::Tag {
                    tag_id: tag_id.clone(),
                    name: name.clone(),
                })
            }
            Command::RenameTag { tag_id, name } => {
                validate_entity_name(name, "tag")?;
                self.require_tag(tag_id)?;
                ensure_tag_name_available(&self.doc, tag_id, name)?;
                NormalizedTransition::new(
                    SemanticEvent::TagRenamed,
                    vec![PrimitiveOp::AssignName {
                        target: LifecycleEntity::Tag(tag_id.clone()),
                        name: name.clone(),
                    }],
                    HistoryShape::Graph,
                )
            }
            Command::DeleteTag { tag_id } => {
                self.require_live_tag(tag_id)?;
                let mut operations = vec![PrimitiveOp::AssignDeleted {
                    target: LifecycleEntity::Tag(tag_id.clone()),
                    deleted: true,
                }];
                operations.extend(
                    self.tag_reference_targets(tag_id)?
                        .into_iter()
                        .map(|target| PrimitiveOp::RemoveTagReference {
                            target,
                            tag_id: tag_id.clone(),
                        }),
                );
                NormalizedTransition::new(
                    SemanticEvent::TagDeleted,
                    operations,
                    HistoryShape::Graph,
                )
            }
            Command::RestoreTag { tag_id } => {
                let tag = self.require_tag(tag_id)?;
                let name = map_string(&tag, "name")
                    .ok_or_else(|| CoreError::TagNotFound(tag_id.clone()))?;
                validate_name(&name, "tag")?;
                ensure_tag_name_available(&self.doc, tag_id, &name)?;
                NormalizedTransition::new(
                    SemanticEvent::TagRestored,
                    vec![PrimitiveOp::AssignDeleted {
                        target: LifecycleEntity::Tag(tag_id.clone()),
                        deleted: false,
                    }],
                    HistoryShape::Graph,
                )
            }
            Command::InsertBlock {
                owner,
                parent,
                index,
                markdown,
            } => NormalizedTransition::structural(self.lower_insert_block(
                owner,
                parent.as_ref(),
                *index,
                markdown,
            )?),
            Command::SplitBlock {
                owner,
                block_id,
                index,
                placement,
            } => NormalizedTransition::structural(
                self.lower_split_block(owner, block_id, *index, *placement)?,
            ),
            Command::MergeBlockBackward { owner, block_id } => {
                NormalizedTransition::structural(PrimitiveOp::MergeBlockBackward {
                    owner: owner.clone(),
                    plan: Box::new(self.plan_merge_block_backward(owner, block_id)?),
                })
            }
            Command::MoveBlocks {
                block_ids,
                owner,
                parent,
                after,
            } => NormalizedTransition::structural(PrimitiveOp::MoveBlocks {
                owner: owner.clone(),
                requested: block_ids.clone(),
                plan: Box::new(self.plan_move_blocks(
                    owner,
                    block_ids,
                    parent.as_ref(),
                    after.as_ref(),
                )?),
            }),
            Command::IndentBlocks { owner, block_ids } => {
                NormalizedTransition::structural(PrimitiveOp::IndentBlocks {
                    owner: owner.clone(),
                    plan: Box::new(self.plan_indent_blocks(owner, block_ids)?),
                })
            }
            Command::OutdentBlocks { owner, block_ids } => {
                NormalizedTransition::structural(PrimitiveOp::OutdentBlocks {
                    owner: owner.clone(),
                    plan: Box::new(self.plan_outdent_blocks(owner, block_ids)?),
                })
            }
            Command::DeleteBlocks { owner, block_ids } => {
                NormalizedTransition::structural(PrimitiveOp::DeleteBlocks {
                    owner: owner.clone(),
                    plan: Box::new(self.plan_delete_blocks(owner, block_ids)?),
                })
            }
            Command::InsertOutline {
                owner,
                parent,
                index,
                replace,
                items,
            } => NormalizedTransition::structural(self.lower_insert_outline(
                owner,
                parent.as_ref(),
                *index,
                replace.as_ref(),
                items,
            )?),
            Command::PasteOutline {
                owner,
                parent,
                index,
                replace,
                fragment,
            } => NormalizedTransition::structural(self.lower_paste_outline(
                owner,
                parent.as_ref(),
                *index,
                replace.as_ref(),
                fragment,
            )?),
            Command::EditMarkdown {
                owner,
                block_id,
                markdown,
            } => NormalizedTransition::content(vec![
                self.lower_text_splice(owner, block_id, None, markdown)?,
            ]),
            Command::SpliceMarkdown {
                owner,
                block_id,
                index,
                delete,
                insert,
            } => NormalizedTransition::content(vec![self.lower_text_splice(
                owner,
                block_id,
                Some((*index, *delete)),
                insert,
            )?]),
            Command::SpliceMarkdowns { owner, splices } => {
                validate_content_batch(splices.len(), "markdown splice")?;
                let mut seen = BTreeSet::new();
                let mut operations = Vec::with_capacity(splices.len());
                for splice in splices {
                    ensure_distinct_block(&mut seen, &splice.block_id, "markdown splice")?;
                    operations.push(self.lower_text_splice(
                        owner,
                        &splice.block_id,
                        Some((splice.index, splice.delete)),
                        &splice.insert,
                    )?);
                }
                NormalizedTransition::content(operations)
            }
            Command::SpliceBlockContent {
                owner,
                block_id,
                index,
                delete,
                insert,
            } => NormalizedTransition::content(vec![
                self.lower_inline_splice(owner, block_id, *index, *delete, insert)?,
            ]),
            Command::SpliceBlockContents { owner, splices } => {
                validate_content_batch(splices.len(), "block content splice")?;
                let mut staged = BTreeMap::new();
                let mut operations = Vec::with_capacity(splices.len());
                for splice in splices {
                    self.require_block(owner, &splice.block_id)?;
                    if !staged.contains_key(&splice.block_id) {
                        staged.insert(
                            splice.block_id.clone(),
                            self.block_text(owner, &splice.block_id)?.to_string(),
                        );
                    }
                    let current = staged
                        .get_mut(&splice.block_id)
                        .expect("staged block exists");
                    let (atoms, bytes) = self.normalize_inline_insert(&splice.insert)?;
                    checked_text_range(
                        current,
                        Some((splice.index, splice.delete)),
                        bytes,
                        "block content splice",
                    )?;
                    let start = current
                        .char_indices()
                        .nth(splice.index)
                        .map_or(current.len(), |(at, _)| at);
                    let end = current
                        .char_indices()
                        .nth(splice.index + splice.delete)
                        .map_or(current.len(), |(at, _)| at);
                    let inserted: String = atoms
                        .iter()
                        .map(|atom| match atom {
                            InlineAtom::Text(value) => value.clone(),
                            InlineAtom::PageReference(_) => PAGE_REFERENCE_CHAR.to_string(),
                        })
                        .collect();
                    current.replace_range(start..end, &inserted);
                    operations.push(inline_operation(
                        TextTarget {
                            owner: owner.clone(),
                            block_id: splice.block_id.clone(),
                            index: splice.index,
                            delete: splice.delete,
                        },
                        atoms,
                    ));
                }
                NormalizedTransition::content(operations)
            }

            Command::AddTag { entity, tag_id } => {
                self.validate_entity(entity)?;
                self.require_live_tag(tag_id)?;
                let owner = property_owner_from_entity(entity);
                let entity_bag = self.entity_bag(entity)?;
                let mut operations = vec![PrimitiveOp::SetTagMembership {
                    entity: entity.clone(),
                    tag_id: tag_id.clone(),
                    present: true,
                }];
                for field in decode_bag(&self.tag_bag(tag_id, "defaults")?).0 {
                    if bag_contains_key(&entity_bag, &field.key) {
                        continue;
                    }
                    operations.push(PrimitiveOp::DeclareProperty {
                        owner: owner.clone(),
                        key: field.key.clone(),
                        value_type: field.value_type,
                        cardinality: field.cardinality,
                    });
                    operations.extend(field.values.into_iter().map(
                        |value| match field.cardinality {
                            Cardinality::Single => PrimitiveOp::AssignProperty {
                                owner: owner.clone(),
                                key: field.key.clone(),
                                value,
                            },
                            Cardinality::Set => PrimitiveOp::AddPropertyValue {
                                owner: owner.clone(),
                                key: field.key.clone(),
                                value,
                            },
                        },
                    ));
                }
                NormalizedTransition::tag_membership(operations)
            }
            Command::RemoveTag { entity, tag_id } => {
                self.validate_entity(entity)?;
                self.require_tag(tag_id)?;
                NormalizedTransition::tag_membership(vec![PrimitiveOp::SetTagMembership {
                    entity: entity.clone(),
                    tag_id: tag_id.clone(),
                    present: false,
                }])
            }
            Command::EnsureProperty {
                owner,
                key,
                value_type,
                cardinality,
            } => {
                self.validate_property_address(owner, key)?;
                validate_property_shape(key, *value_type, *cardinality)?;
                reject_document_property(key, *value_type)?;
                NormalizedTransition::properties(vec![PrimitiveOp::DeclareProperty {
                    owner: owner.clone(),
                    key: key.clone(),
                    value_type: *value_type,
                    cardinality: *cardinality,
                }])
            }
            Command::SetProperty { owner, key, value } => {
                self.validate_property_address(owner, key)?;
                validate_property(key, value, Cardinality::Single)?;
                reject_document_property(key, value.property_type())?;
                NormalizedTransition::properties(vec![PrimitiveOp::AssignProperty {
                    owner: owner.clone(),
                    key: key.clone(),
                    value: value.clone(),
                }])
            }
            Command::SetProperties { owner, changes } => {
                self.validate_property_owner(owner)?;
                if changes.is_empty() || changes.len() > MAX_PROPERTY_CHANGES {
                    return Err(CoreError::InvalidHierarchy(format!(
                        "property patch must contain between 1 and {MAX_PROPERTY_CHANGES} changes"
                    )));
                }
                let mut keys = BTreeSet::new();
                let mut operations = Vec::with_capacity(changes.len());
                for PropertyChange { key, value } in changes {
                    if !keys.insert(key) {
                        return Err(CoreError::InvalidHierarchy(format!(
                            "property patch contains a duplicate key: {key}"
                        )));
                    }
                    validate_property_write(key, property_owner_target(owner))?;
                    let operation = match value {
                        Some(value) => {
                            validate_property(key, value, Cardinality::Single)?;
                            reject_document_property(key, value.property_type())?;
                            PrimitiveOp::AssignProperty {
                                owner: owner.clone(),
                                key: key.clone(),
                                value: value.clone(),
                            }
                        }
                        None => PrimitiveOp::RemoveProperty {
                            owner: owner.clone(),
                            key: key.clone(),
                        },
                    };
                    operations.push(operation);
                }
                NormalizedTransition::properties(operations)
            }
            Command::ClearPropertyValues { owner, key } => {
                self.validate_property_address(owner, key)?;
                if key.as_str() == QUERY_PROPERTY_KEY {
                    return Err(PropertyError::DocumentCommandRequired(key.to_string()).into());
                }
                NormalizedTransition::properties(vec![PrimitiveOp::ClearPropertyValues {
                    owner: owner.clone(),
                    key: key.clone(),
                }])
            }
            Command::RemoveProperty { owner, key } => {
                self.validate_property_address(owner, key)?;
                NormalizedTransition::properties(vec![PrimitiveOp::RemoveProperty {
                    owner: owner.clone(),
                    key: key.clone(),
                }])
            }
            Command::AddRepeatedProperty { owner, key, value } => {
                self.validate_property_address(owner, key)?;
                validate_property(key, value, Cardinality::Set)?;
                NormalizedTransition::properties(vec![PrimitiveOp::AddPropertyValue {
                    owner: owner.clone(),
                    key: key.clone(),
                    value: value.clone(),
                }])
            }
            Command::RemoveRepeatedProperty { owner, key, value } => {
                self.validate_property_address(owner, key)?;
                validate_property(key, value, Cardinality::Set)?;
                NormalizedTransition::properties(vec![PrimitiveOp::RemovePropertyValue {
                    owner: owner.clone(),
                    key: key.clone(),
                    value: value.clone(),
                }])
            }
            Command::CreateDefaultQuery {
                default_query_id,
                title,
                document,
            } => {
                validate_default_query_title(title)?;
                let document = normalized_query_document(document)?;
                if default_queries_map(&self.doc)?
                    .get(default_query_id.as_str())
                    .is_some()
                {
                    return Err(CoreError::InvalidHierarchy(format!(
                        "default query id already exists: {default_query_id}"
                    )));
                }
                let current = super::graph_settings_snapshot(&self.doc)?.default_queries;
                if current.len() >= MAX_DEFAULT_QUERIES {
                    return Err(CoreError::InvalidHierarchy(
                        "graph already has the maximum number of default queries".to_owned(),
                    ));
                }
                let position = current
                    .last()
                    .map_or(0, |query| query.position.saturating_add(1));
                NormalizedTransition::graph_settings(vec![PrimitiveOp::InsertDefaultQuery {
                    seed: Box::new(DefaultQuerySeed {
                        default_query_id: default_query_id.clone(),
                        title: title.clone(),
                        document,
                        position,
                    }),
                }])
            }
            Command::RenameDefaultQuery {
                default_query_id,
                title,
            } => {
                self.require_default_query(default_query_id)?;
                validate_default_query_title(title)?;
                NormalizedTransition::graph_settings(vec![PrimitiveOp::AssignDefaultQueryTitle {
                    default_query_id: default_query_id.clone(),
                    title: title.clone(),
                }])
            }
            Command::MoveDefaultQuery {
                default_query_id,
                index,
            } => {
                self.require_default_query(default_query_id)?;
                let mut order = super::graph_settings_snapshot(&self.doc)?
                    .default_queries
                    .into_iter()
                    .map(|query| query.id)
                    .collect::<Vec<_>>();
                if *index >= order.len() {
                    return Err(CoreError::InvalidHierarchy(
                        "default query move is out of bounds".to_owned(),
                    ));
                }
                let from = order
                    .iter()
                    .position(|id| id == default_query_id)
                    .ok_or_else(|| {
                        CoreError::InvalidHierarchy(format!(
                            "default query is outside the visible order: {default_query_id}"
                        ))
                    })?;
                let moved = order.remove(from);
                order.insert(*index, moved);
                let positions = order
                    .into_iter()
                    .enumerate()
                    .map(|(position, id)| {
                        (
                            id,
                            u32::try_from(position).expect("default query count is bounded"),
                        )
                    })
                    .collect();
                NormalizedTransition::graph_settings(vec![
                    PrimitiveOp::AssignDefaultQueryPositions { positions },
                ])
            }
            Command::DeleteDefaultQuery { default_query_id } => {
                self.require_default_query(default_query_id)?;
                NormalizedTransition::graph_settings(vec![PrimitiveOp::AssignDefaultQueryDeleted {
                    default_query_id: default_query_id.clone(),
                    deleted: true,
                }])
            }
            Command::SetQuerySource {
                owner,
                view_id,
                source,
            } => {
                let initialize = self.validate_query_definition_target(owner, view_id, true)?;
                if source.len() > MAX_QUERY_SOURCE_BYTES {
                    return Err(CoreError::TextTooLong);
                }
                let target = QueryDefinitionTarget {
                    owner: owner.clone(),
                    view_id: view_id.clone(),
                };
                let mut operations = Vec::with_capacity(3);
                if initialize {
                    operations.push(PrimitiveOp::InitializeQueryDocument {
                        owner: owner.clone(),
                    });
                }
                operations.push(PrimitiveOp::ReplaceQuerySource {
                    target: target.clone(),
                    source: source.clone(),
                });
                operations.push(PrimitiveOp::AssignQueryPlan { target, plan: None });
                NormalizedTransition::query(operations)
            }
            Command::SpliceQuerySource {
                owner,
                view_id,
                index,
                delete,
                insert,
            } => {
                self.validate_query_owner(owner)?;
                let document = self.query_document(owner)?;
                let definition = &document
                    .views
                    .iter()
                    .find(|view| &view.id == view_id)
                    .ok_or_else(|| {
                        PropertyError::InvalidDocument("query view does not exist".to_owned())
                    })?
                    .definition;
                if definition.plan.is_some() {
                    return Err(PropertyError::InvalidDocument(
                        "a built query must be replaced with explicit raw source".to_owned(),
                    )
                    .into());
                }
                let target = QueryDefinitionTarget {
                    owner: owner.clone(),
                    view_id: view_id.clone(),
                };
                let splice = checked_query_source_target(
                    target.clone(),
                    &definition.source,
                    *index,
                    *delete,
                    insert.len(),
                )?;
                NormalizedTransition::query(vec![
                    PrimitiveOp::SpliceQuerySource {
                        target: splice,
                        insert: insert.clone(),
                    },
                    PrimitiveOp::AssignQueryPlan { target, plan: None },
                ])
            }
            Command::SetQueryPlan {
                owner,
                view_id,
                plan,
            } => {
                let initialize = self.validate_query_definition_target(owner, view_id, true)?;
                plan.validate()?;
                let _ = super::derived_query_source(plan)?;
                let target = QueryDefinitionTarget {
                    owner: owner.clone(),
                    view_id: view_id.clone(),
                };
                let mut operations = Vec::with_capacity(2);
                if initialize {
                    operations.push(PrimitiveOp::InitializeQueryDocument {
                        owner: owner.clone(),
                    });
                }
                operations.push(PrimitiveOp::AssignQueryPlan {
                    target,
                    plan: Some(plan.clone()),
                });
                NormalizedTransition::query(operations)
            }
            Command::PutQueryView { owner, view } => {
                self.validate_query_owner(owner)?;
                let mut document = self.query_document(owner)?;
                let normalized = if let Some(existing) =
                    document.views.iter_mut().find(|item| item.id == view.id)
                {
                    let definition = existing.definition.clone();
                    *existing = view.clone();
                    existing.definition = definition;
                    None
                } else {
                    let normalized = normalized_query_view(view)?;
                    document.views.push(normalized.clone());
                    Some(normalized)
                };
                document.validate()?;

                let stored = self.require_query_document_for_owner(owner)?;
                let raw_view_exists = stored
                    .get("views")
                    .and_then(value_into_map)
                    .is_some_and(|views| views.get(view.id.as_str()).is_some());
                let definition = if raw_view_exists {
                    None
                } else {
                    Some(
                        normalized
                            .expect("a missing raw query view is not visible")
                            .definition,
                    )
                };
                NormalizedTransition::query(vec![PrimitiveOp::PutQueryView {
                    owner: owner.clone(),
                    write: Box::new(QueryViewWrite {
                        presentation: QueryViewPresentation::from(view),
                        definition,
                    }),
                }])
            }
            Command::RemoveQueryView { owner, view_id } => {
                self.validate_query_owner(owner)?;
                let document = self.query_document(owner)?;
                let visible = document.views.iter().any(|view| &view.id == view_id);
                let stored = self.require_query_document_for_owner(owner)?;
                let stored_view_exists = stored
                    .get("views")
                    .and_then(value_into_map)
                    .is_some_and(|views| views.get(view_id.as_str()).is_some());
                if !visible && !stored_view_exists {
                    return Err(PropertyError::InvalidDocument(
                        "query view does not exist".to_owned(),
                    )
                    .into());
                }
                if visible && document.views.len() == 1 {
                    return Err(PropertyError::InvalidDocument(
                        "the last query view cannot be removed".to_owned(),
                    )
                    .into());
                }
                let next_default = (visible && document.default_view_id == *view_id).then(|| {
                    document
                        .views
                        .iter()
                        .find(|view| &view.id != view_id)
                        .expect("a removable query view has a successor")
                        .id
                        .clone()
                });
                NormalizedTransition::query(vec![PrimitiveOp::RemoveQueryView {
                    owner: owner.clone(),
                    view_id: view_id.clone(),
                    next_default,
                }])
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
                NormalizedTransition::query(vec![PrimitiveOp::AssignQueryDefaultView {
                    owner: owner.clone(),
                    view_id: view_id.clone(),
                }])
            }
            Command::Batch { .. } | Command::Undo | Command::Redo => {
                unreachable!("orchestration commands do not have domain transitions")
            }
        };
        Ok(transition)
    }

    fn lower_insert_block(
        &self,
        owner: &OutlineOwner,
        parent: Option<&BlockId>,
        index: usize,
        markdown: &str,
    ) -> Result<PrimitiveOp, CoreError> {
        self.require_live_outline_owner(owner)?;
        validate_text(markdown, MAX_BLOCK_TEXT_BYTES)?;
        if let Some(parent) = parent {
            self.require_block(owner, parent)?;
        }
        Ok(PrimitiveOp::InsertOutline {
            plan: Box::new(OutlineInsertPlan {
                owner: owner.clone(),
                parent: parent.cloned(),
                index,
                replace: None,
                items: vec![PlannedOutlineItem {
                    depth: 0,
                    content: PlannedBlockContent::Markdown(markdown.to_owned()),
                    properties: Vec::new(),
                    tags: Vec::new(),
                }],
                dependencies: Vec::new(),
            }),
        })
    }

    fn lower_insert_outline(
        &self,
        owner: &OutlineOwner,
        parent: Option<&BlockId>,
        index: usize,
        replace: Option<&BlockId>,
        items: &[OutlineItem],
    ) -> Result<PrimitiveOp, CoreError> {
        self.require_live_outline_owner(owner)?;
        if replace.is_none()
            && let Some(parent) = parent
        {
            self.require_block(owner, parent)?;
        }
        super::validate_outline_items(items, "insert")?;
        if let Some(block_id) = replace {
            self.require_block(owner, block_id)?;
            if !self.block_text(owner, block_id)?.to_string().is_empty() {
                return Err(CoreError::InvalidHierarchy(
                    "outline replacement block is not empty".into(),
                ));
            }
        }
        Ok(PrimitiveOp::InsertOutline {
            plan: Box::new(OutlineInsertPlan {
                owner: owner.clone(),
                parent: parent.cloned(),
                index,
                replace: replace.cloned(),
                items: items
                    .iter()
                    .map(|item| PlannedOutlineItem {
                        depth: item.depth,
                        content: PlannedBlockContent::Markdown(item.markdown.clone()),
                        properties: Vec::new(),
                        tags: Vec::new(),
                    })
                    .collect(),
                dependencies: Vec::new(),
            }),
        })
    }

    fn lower_paste_outline(
        &self,
        owner: &OutlineOwner,
        parent: Option<&BlockId>,
        index: usize,
        replace: Option<&BlockId>,
        fragment: &OutlineFragment,
    ) -> Result<PrimitiveOp, CoreError> {
        self.require_live_outline_owner(owner)?;
        if replace.is_none()
            && let Some(parent) = parent
        {
            self.require_block(owner, parent)?;
        }
        self.validate_outline_fragment(fragment)?;
        if let Some(block_id) = replace {
            self.require_block(owner, block_id)?;
            if !self.block_is_plain_empty(owner, block_id)? {
                return Err(CoreError::InvalidHierarchy(
                    "outline replacement block contains content or metadata".into(),
                ));
            }
        }

        let resolution = self.resolve_outline_fragment(fragment)?;
        let mut dependencies = Vec::with_capacity(
            resolution
                .new_pages
                .len()
                .saturating_add(resolution.new_tags.len()),
        );
        dependencies.extend(resolution.new_pages.iter().map(|(page_id, reference)| {
            reference.journal_date.as_ref().map_or_else(
                || EntitySeed::RegularPage {
                    page_id: page_id.clone(),
                    title: reference.title.clone(),
                },
                |date| EntitySeed::JournalPage {
                    page_id: page_id.clone(),
                    date: date.clone(),
                },
            )
        }));
        dependencies.extend(
            resolution
                .new_tags
                .iter()
                .map(|(tag_id, name)| EntitySeed::Tag {
                    tag_id: tag_id.clone(),
                    name: name.clone(),
                }),
        );
        let items = fragment
            .items
            .iter()
            .map(|item| self.resolve_fragment_item(item, &resolution))
            .collect::<Result<_, _>>()?;

        Ok(PrimitiveOp::InsertOutline {
            plan: Box::new(OutlineInsertPlan {
                owner: owner.clone(),
                parent: parent.cloned(),
                index,
                replace: replace.cloned(),
                items,
                dependencies,
            }),
        })
    }

    fn resolve_fragment_item(
        &self,
        item: &OutlineFragmentItem,
        resolution: &FragmentResolution,
    ) -> Result<PlannedOutlineItem, CoreError> {
        let content = if item.page_references.is_empty() {
            PlannedBlockContent::Markdown(item.markdown.clone())
        } else {
            let points = item.markdown.chars().collect::<Vec<_>>();
            let mut atoms = Vec::new();
            let mut cursor = 0usize;
            for reference in &item.page_references {
                let prefix = points[cursor..reference.start].iter().collect::<String>();
                if !prefix.is_empty() {
                    atoms.push(InlineAtom::Text(prefix));
                }
                let page_id = resolution
                    .pages
                    .get(&reference.page_id)
                    .cloned()
                    .ok_or_else(|| {
                        CoreError::InvalidHierarchy(format!(
                            "outline fragment page reference is missing: {}",
                            reference.page_id
                        ))
                    })?;
                atoms.push(InlineAtom::PageReference(page_id));
                cursor = reference.end;
            }
            let suffix = points[cursor..].iter().collect::<String>();
            if !suffix.is_empty() {
                atoms.push(InlineAtom::Text(suffix));
            }
            let stored_bytes = atoms
                .iter()
                .map(|atom| match atom {
                    InlineAtom::Text(value) => value.len(),
                    InlineAtom::PageReference(_) => PAGE_REFERENCE_CHAR.len_utf8(),
                })
                .sum::<usize>();
            if stored_bytes > MAX_BLOCK_TEXT_BYTES {
                return Err(CoreError::TextTooLong);
            }
            PlannedBlockContent::Inline(atoms)
        };
        let properties = item
            .properties
            .iter()
            .cloned()
            .map(|mut field| {
                for value in &mut field.values {
                    if let PropertyValue::Page(source) = value
                        && let Some(target) = resolution.pages.get(source)
                    {
                        *source = target.clone();
                    }
                }
                field
            })
            .collect();
        let tags = item
            .tags
            .iter()
            .map(|source_tag| {
                resolution.tags.get(source_tag).cloned().ok_or_else(|| {
                    CoreError::InvalidHierarchy(format!(
                        "outline fragment tag reference is missing: {source_tag}"
                    ))
                })
            })
            .collect::<Result<_, _>>()?;
        Ok(PlannedOutlineItem {
            depth: item.depth,
            content,
            properties,
            tags,
        })
    }

    fn lower_split_block(
        &self,
        owner: &OutlineOwner,
        block_id: &BlockId,
        index: usize,
        placement: SplitPlacement,
    ) -> Result<PrimitiveOp, CoreError> {
        self.require_live_outline_owner(owner)?;
        self.require_block(owner, block_id)?;
        let text = self.block_text(owner, block_id)?;
        let length = text.len_unicode();
        if index > length {
            return Err(CoreError::InvalidHierarchy(
                "block split is out of bounds".into(),
            ));
        }
        if (index == 0) != (placement == SplitPlacement::Before) {
            return Err(CoreError::InvalidHierarchy(
                "a leading split must create a block before the target".into(),
            ));
        }

        let before = self.outline_state(owner)?;
        let destination = match placement {
            SplitPlacement::FirstChild => BlockPosition {
                parent: Some(block_id.clone()),
                index: 0,
            },
            SplitPlacement::Before | SplitPlacement::After => {
                let parent = before
                    .parents
                    .get(block_id)
                    .cloned()
                    .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
                let siblings = before.children.get(&parent).ok_or_else(|| {
                    CoreError::InvalidHierarchy("block parent has no child list".into())
                })?;
                let position = siblings
                    .iter()
                    .position(|candidate| candidate == block_id)
                    .ok_or_else(|| CoreError::BlockNotFound(block_id.clone()))?;
                BlockPosition {
                    parent,
                    index: position + usize::from(placement == SplitPlacement::After),
                }
            }
        };
        let tail = if index == 0 {
            Vec::new()
        } else {
            text.slice_delta(index, length, PosType::Unicode)?
        };
        Ok(PrimitiveOp::SplitBlock {
            plan: Box::new(SplitPlan {
                owner: owner.clone(),
                target: block_id.clone(),
                destination,
                index,
                truncate: if index > 0 { length - index } else { 0 },
                tail,
            }),
        })
    }

    fn lower_text_splice(
        &self,
        owner: &OutlineOwner,
        block_id: &BlockId,
        range: Option<(usize, usize)>,
        insert: &str,
    ) -> Result<PrimitiveOp, CoreError> {
        self.require_block(owner, block_id)?;
        validate_text(insert, MAX_BLOCK_TEXT_BYTES)?;
        Ok(PrimitiveOp::SpliceText {
            target: self.checked_text_target(
                owner,
                block_id,
                range,
                insert.len(),
                "markdown splice",
            )?,
            insert: insert.to_owned(),
        })
    }

    fn lower_inline_splice(
        &self,
        owner: &OutlineOwner,
        block_id: &BlockId,
        index: usize,
        delete: usize,
        insert: &[InlineContent],
    ) -> Result<PrimitiveOp, CoreError> {
        self.require_block(owner, block_id)?;
        let (atoms, inserted_bytes) = self.normalize_inline_insert(insert)?;
        let target = self.checked_text_target(
            owner,
            block_id,
            Some((index, delete)),
            inserted_bytes,
            "block content splice",
        )?;
        Ok(inline_operation(target, atoms))
    }

    fn normalize_inline_insert(
        &self,
        content: &[InlineContent],
    ) -> Result<(Vec<InlineAtom>, usize), CoreError> {
        let mut atoms = Vec::new();
        let mut bytes = 0usize;
        for item in content {
            match item {
                InlineContent::Markdown { value } => {
                    if value.contains(PAGE_REFERENCE_CHAR) {
                        return Err(CoreError::InvalidHierarchy(
                            "plain block content contains the reserved reference atom".into(),
                        ));
                    }
                    bytes = bytes.saturating_add(value.len());
                    if value.is_empty() {
                        continue;
                    }
                    match atoms.last_mut() {
                        Some(InlineAtom::Text(previous)) => previous.push_str(value),
                        _ => atoms.push(InlineAtom::Text(value.clone())),
                    }
                }
                InlineContent::PageReference { page_id } => {
                    self.require_live_page(page_id)?;
                    bytes = bytes.saturating_add(PAGE_REFERENCE_CHAR.len_utf8());
                    atoms.push(InlineAtom::PageReference(page_id.clone()));
                }
            }
        }
        if bytes > MAX_BLOCK_TEXT_BYTES {
            Err(CoreError::TextTooLong)
        } else {
            Ok((atoms, bytes))
        }
    }

    fn checked_text_target(
        &self,
        owner: &OutlineOwner,
        block_id: &BlockId,
        range: Option<(usize, usize)>,
        inserted_bytes: usize,
        operation: &str,
    ) -> Result<TextTarget, CoreError> {
        let current = self.block_text(owner, block_id)?.to_string();
        let (index, delete) = checked_text_range(&current, range, inserted_bytes, operation)?;
        Ok(TextTarget {
            owner: owner.clone(),
            block_id: block_id.clone(),
            index,
            delete,
        })
    }

    pub(super) fn apply_transition(
        &mut self,
        transition: &NormalizedTransition,
        now: &str,
        outcome: &mut MutationOutcome,
    ) -> Result<(), CoreError> {
        outcome.changed = false;
        for operation in &transition.operations {
            match operation {
                PrimitiveOp::EnsureEntity { seed } => match seed {
                    EntitySeed::RegularPage { page_id, title } => {
                        let created =
                            self.ensure_page(page_id, "regular", Some(title), None, now)?;
                        outcome.changed |= created.is_some();
                        outcome.created_page = created;
                    }
                    EntitySeed::JournalPage { page_id, date } => {
                        let created =
                            self.ensure_page(page_id, "journal", None, Some(date.clone()), now)?;
                        outcome.changed |= created.is_some();
                        outcome.created_page = created;
                    }
                    EntitySeed::Tag { tag_id, name } => {
                        let created = self.ensure_tag(tag_id, name, now)?;
                        outcome.changed |= created.is_some();
                        outcome.created_tag = created;
                    }
                },
                PrimitiveOp::AssignName { target, name } => {
                    match target {
                        LifecycleEntity::Page(page_id) => replace_text(
                            &self.page_root(page_id)?.ensure_mergeable_text("content")?,
                            name,
                        )?,
                        LifecycleEntity::Tag(tag_id) => {
                            self.require_tag(tag_id)?.insert("name", name.as_str())?;
                        }
                    }
                    outcome.changed = true;
                }
                PrimitiveOp::AssignDeleted { target, deleted } => {
                    let properties = match target {
                        LifecycleEntity::Page(page_id) => self.page_properties(page_id)?,
                        LifecycleEntity::Tag(tag_id) => self.tag_bag(tag_id, "properties")?,
                    };
                    if *deleted {
                        set_single(
                            &properties,
                            &key("builtin.deleted-at"),
                            &PropertyValue::String(now.to_owned()),
                        )?;
                    } else {
                        remove_property_field(&properties, &key("builtin.deleted-at"))?;
                    }
                    outcome.changed = true;
                }
                PrimitiveOp::RemoveTagReference { target, tag_id } => {
                    match target {
                        TagReferenceTarget::PageRoot(page_id) => {
                            self.page_root(page_id)?
                                .ensure_mergeable_map("tag_refs")?
                                .delete(tag_id.as_str())?;
                        }
                        TagReferenceTarget::Block { owner, block_id } => {
                            let outline = self.outline(owner)?;
                            outline
                                .get_meta(super::require_block_in(&outline, block_id)?)?
                                .ensure_mergeable_map("tag_refs")?
                                .delete(tag_id.as_str())?;
                        }
                    }
                    outcome.changed = true;
                }
                PrimitiveOp::SetTagMembership {
                    entity,
                    tag_id,
                    present,
                } => {
                    let tags = self.entity_tags(entity)?;
                    if *present {
                        tags.insert(tag_id.as_str(), true)?;
                    } else {
                        tags.delete(tag_id.as_str())?;
                    }
                    outcome.changed = true;
                }
                PrimitiveOp::DeclareProperty {
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
                    outcome.changed = true;
                }
                PrimitiveOp::AssignProperty { owner, key, value } => {
                    set_single(&self.property_owner_bag(owner)?, key, value)?;
                    outcome.changed = true;
                }
                PrimitiveOp::ClearPropertyValues { owner, key } => {
                    clear_property_values(&self.property_owner_bag(owner)?, key)?;
                    outcome.changed = true;
                }
                PrimitiveOp::RemoveProperty { owner, key } => {
                    remove_property_field(&self.property_owner_bag(owner)?, key)?;
                    outcome.changed = true;
                }
                PrimitiveOp::AddPropertyValue { owner, key, value } => {
                    set_repeated(&self.property_owner_bag(owner)?, key, value)?;
                    outcome.changed = true;
                }
                PrimitiveOp::RemovePropertyValue { owner, key, value } => {
                    remove_repeated_value(&self.property_owner_bag(owner)?, key, value)?;
                    outcome.changed = true;
                }
                PrimitiveOp::SpliceText { target, insert } => {
                    let text = self.apply_text_range(target)?;
                    if !insert.is_empty() {
                        text.insert(target.index, insert)?;
                    }
                    outcome.changed = true;
                }
                PrimitiveOp::SpliceInline { target, insert } => {
                    let text = self.apply_text_range(target)?;
                    Self::insert_inline_atoms(&text, target.index, insert)?;
                    outcome.changed = true;
                }
                PrimitiveOp::InsertOutline { plan } => {
                    self.apply_outline_insert(plan, now, outcome)?;
                    outcome.changed = true;
                }
                PrimitiveOp::SplitBlock { plan } => {
                    self.apply_split_block(plan, now, outcome)?;
                    outcome.changed = true;
                }
                PrimitiveOp::MergeBlockBackward { owner, plan } => {
                    self.apply_merge_block(owner, plan, now)?;
                    outcome.changed = true;
                }
                PrimitiveOp::MoveBlocks { owner, plan, .. } => {
                    self.move_blocks(
                        &plan.outline.roots,
                        owner,
                        plan.parent.as_ref(),
                        plan.after.as_ref(),
                    )?;
                    outcome.changed = true;
                }
                PrimitiveOp::IndentBlocks { owner, plan }
                | PrimitiveOp::OutdentBlocks { owner, plan } => {
                    self.apply_reparent_plan(owner, plan)?;
                    outcome.changed = true;
                }
                PrimitiveOp::DeleteBlocks { owner, plan } => {
                    let outline = self.outline(owner)?;
                    for block_id in &plan.roots {
                        self.touch_block(owner, block_id, now)?;
                        outline.delete(tree_id(block_id)?)?;
                    }
                    outcome.changed = true;
                }
                PrimitiveOp::InsertDefaultQuery { seed } => {
                    self.apply_default_query_seed(seed)?;
                    outcome.changed = true;
                }
                PrimitiveOp::AssignDefaultQueryTitle {
                    default_query_id,
                    title,
                } => {
                    self.require_default_query(default_query_id)?
                        .insert("title", title.as_str())?;
                    outcome.changed = true;
                }
                PrimitiveOp::AssignDefaultQueryPositions { positions } => {
                    let queries = default_queries_map(&self.doc)?;
                    for (default_query_id, position) in positions {
                        queries
                            .get(default_query_id.as_str())
                            .and_then(value_into_map)
                            .ok_or_else(|| {
                                CoreError::InvalidHierarchy(format!(
                                    "default query does not exist: {default_query_id}"
                                ))
                            })?
                            .insert("position", i64::from(*position))?;
                    }
                    outcome.changed = true;
                }
                PrimitiveOp::AssignDefaultQueryDeleted {
                    default_query_id,
                    deleted,
                } => {
                    self.require_default_query(default_query_id)?
                        .insert("deleted", *deleted)?;
                    outcome.changed = true;
                }
                PrimitiveOp::InitializeQueryDocument { owner } => {
                    self.ensure_query_document_for_owner(owner)?;
                    outcome.changed = true;
                }
                PrimitiveOp::ReplaceQuerySource { target, source } => {
                    let document = self.require_query_document_for_owner(&target.owner)?;
                    let definition = super::require_query_definition(&document, &target.view_id)?;
                    replace_text(&definition.ensure_mergeable_text("source")?, source)?;
                    outcome.changed = true;
                }
                PrimitiveOp::SpliceQuerySource { target, insert } => {
                    let document =
                        self.require_query_document_for_owner(&target.definition.owner)?;
                    let definition =
                        super::require_query_definition(&document, &target.definition.view_id)?;
                    let source = definition.ensure_mergeable_text("source")?;
                    if target.delete > 0 {
                        source.delete(target.index, target.delete)?;
                    }
                    if !insert.is_empty() {
                        source.insert(target.index, insert)?;
                    }
                    outcome.changed = true;
                }
                PrimitiveOp::AssignQueryPlan { target, plan } => {
                    let document = self.require_query_document_for_owner(&target.owner)?;
                    let definition = super::require_query_definition(&document, &target.view_id)?;
                    super::write_query_plan_state(&definition, plan.as_ref())?;
                    outcome.changed = true;
                }
                PrimitiveOp::PutQueryView { owner, write } => {
                    let document = self.require_query_document_for_owner(owner)?;
                    self.apply_query_view_write(&document, write)?;
                    outcome.changed = true;
                }
                PrimitiveOp::RemoveQueryView {
                    owner,
                    view_id,
                    next_default,
                } => {
                    let document = self.require_query_document_for_owner(owner)?;
                    document
                        .ensure_mergeable_map("views")?
                        .get(view_id.as_str())
                        .and_then(value_into_map)
                        .ok_or_else(|| {
                            PropertyError::InvalidDocument("query view does not exist".to_owned())
                        })?
                        .insert("deleted", true)?;
                    if let Some(next_default) = next_default {
                        document.insert("default_view_id", next_default.as_str())?;
                    }
                    outcome.changed = true;
                }
                PrimitiveOp::AssignQueryDefaultView { owner, view_id } => {
                    self.require_query_document_for_owner(owner)?
                        .insert("default_view_id", view_id.as_str())?;
                    outcome.changed = true;
                }
            }
        }
        if outcome.changed {
            self.touch_transition(&transition.footprint, now)?;
        }
        Ok(())
    }

    fn apply_reparent_plan(
        &self,
        owner: &OutlineOwner,
        plan: &ReparentPlan,
    ) -> Result<(), CoreError> {
        let outline = self.outline(owner)?;
        for step in &plan.steps {
            let block = tree_id(&step.block_id)?;
            match &step.destination {
                ReparentDestination::FirstChild { parent } => {
                    outline.mov_to(block, tree_id(parent)?, 0)?;
                }
                ReparentDestination::After { anchor } => {
                    outline.mov_after(block, tree_id(anchor)?)?;
                }
            }
        }
        Ok(())
    }

    fn apply_default_query_seed(&self, seed: &DefaultQuerySeed) -> Result<(), CoreError> {
        let entry =
            default_queries_map(&self.doc)?.ensure_mergeable_map(seed.default_query_id.as_str())?;
        entry.insert("title", seed.title.as_str())?;
        entry.insert("position", i64::from(seed.position))?;
        entry.insert("deleted", false)?;
        self.write_prepared_query_document(&entry.ensure_mergeable_map("document")?, &seed.document)
    }

    fn write_prepared_query_document(
        &self,
        document: &loro::LoroMap,
        snapshot: &PropertyDocument,
    ) -> Result<(), CoreError> {
        document.insert("schema", snapshot.schema.as_str())?;
        document.insert("version", i64::from(snapshot.version))?;
        document.insert("default_view_id", snapshot.default_view_id.as_str())?;
        let views = document.ensure_mergeable_map("views")?;
        for view_id in views.keys() {
            views.delete(&view_id)?;
        }
        for view in &snapshot.views {
            self.apply_query_view_write(
                document,
                &QueryViewWrite {
                    presentation: QueryViewPresentation::from(view),
                    definition: Some(view.definition.clone()),
                },
            )?;
        }
        Ok(())
    }

    fn apply_query_view_write(
        &self,
        document: &loro::LoroMap,
        write: &QueryViewWrite,
    ) -> Result<(), CoreError> {
        let presentation = &write.presentation;
        let stored = document
            .ensure_mergeable_map("views")?
            .ensure_mergeable_map(presentation.id.as_str())?;
        stored.insert("name", presentation.name.as_str())?;
        stored.insert(
            "kind",
            match presentation.kind {
                QueryViewKind::Table => "table",
                QueryViewKind::List => "list",
            },
        )?;
        stored.insert("position", i64::from(presentation.position))?;
        stored.insert("columns", serde_json::to_string(&presentation.columns)?)?;
        stored.insert("options", serde_json::to_string(&presentation.options)?)?;
        if let Some(definition) = &write.definition {
            stored.insert("deleted", false)?;
            let target = stored.ensure_mergeable_map("definition")?;
            target.insert("language", definition.language.as_str())?;
            replace_text(&target.ensure_mergeable_text("source")?, &definition.source)?;
            super::write_query_plan_state(&target, definition.plan.as_ref())?;
        }
        Ok(())
    }

    fn apply_outline_insert(
        &self,
        plan: &OutlineInsertPlan,
        now: &str,
        outcome: &mut MutationOutcome,
    ) -> Result<(), CoreError> {
        for seed in &plan.dependencies {
            match seed {
                EntitySeed::RegularPage { page_id, title } => {
                    self.ensure_page(page_id, "regular", Some(title), None, now)?;
                }
                EntitySeed::JournalPage { page_id, date } => {
                    self.ensure_page(page_id, "journal", None, Some(date.clone()), now)?;
                }
                EntitySeed::Tag { tag_id, name } => {
                    self.ensure_tag(tag_id, name, now)?;
                }
            }
        }
        outcome.created_block = self.insert_outline_items(
            OutlineInsertion {
                owner: &plan.owner,
                parent: plan.parent.as_ref(),
                index: plan.index,
                replace: plan.replace.as_ref(),
                items: &plan.items,
            },
            now,
            |meta, item| {
                if let PlannedBlockContent::Inline(atoms) = &item.content {
                    Self::insert_inline_atoms(&meta.ensure_mergeable_text("content")?, 0, atoms)?;
                }
                let bag = meta.ensure_mergeable_map("properties")?;
                for field in &item.properties {
                    Self::write_planned_property(&bag, field)?;
                }
                let tag_refs = meta.ensure_mergeable_map("tag_refs")?;
                for tag_id in &item.tags {
                    tag_refs.insert(tag_id.as_str(), true)?;
                }
                Ok(())
            },
        )?;
        Ok(())
    }

    fn apply_split_block(
        &self,
        plan: &SplitPlan,
        now: &str,
        outcome: &mut MutationOutcome,
    ) -> Result<(), CoreError> {
        let outline = self.outline(&plan.owner)?;
        let parent = plan.destination.parent.as_ref().map(tree_id).transpose()?;
        let node = outline.create_at(parent, plan.destination.index)?;
        let meta = outline.get_meta(node)?;
        initialize_created_node(&meta, "", now)?;
        if !plan.tail.is_empty() {
            meta.ensure_mergeable_text("content")?
                .apply_delta(&plan.tail)?;
        }
        if plan.truncate > 0 {
            self.block_text(&plan.owner, &plan.target)?
                .delete(plan.index, plan.truncate)?;
        }
        let created = block_id(node);
        self.touch_block(&plan.owner, &created, now)?;
        outcome.created_block = Some(created);
        Ok(())
    }

    fn apply_merge_block(
        &self,
        owner: &OutlineOwner,
        plan: &MergePlan,
        now: &str,
    ) -> Result<(), CoreError> {
        let target = self.block_text(owner, &plan.target)?;
        let source = self.block_text(owner, &plan.source)?;
        let target_length = target.len_unicode();
        let mut tail = source.slice_delta(0, source.len_unicode(), PosType::Unicode)?;
        if !tail.is_empty() && target_length > 0 {
            tail.insert(
                0,
                TextDelta::Retain {
                    retain: target_length,
                    attributes: None,
                },
            );
        }
        if !tail.is_empty() {
            target.apply_delta(&tail)?;
        }
        let outline = self.outline(owner)?;
        let source_node = require_block_in(&outline, &plan.source)?;
        let target_node = require_block_in(&outline, &plan.target)?;
        for child in outline.children(source_node).unwrap_or_default() {
            outline.mov(child, target_node)?;
        }
        self.touch_block(owner, &plan.target, now)?;
        self.touch_block(owner, &plan.source, now)?;
        outline.delete(source_node)?;
        Ok(())
    }

    fn insert_inline_atoms(
        text: &LoroText,
        index: usize,
        atoms: &[InlineAtom],
    ) -> Result<(), CoreError> {
        let mut position = index;
        for atom in atoms {
            match atom {
                InlineAtom::Text(value) => {
                    if !value.is_empty() {
                        text.insert(position, value)?;
                        position += value.chars().count();
                    }
                }
                InlineAtom::PageReference(page_id) => {
                    text.insert(position, &PAGE_REFERENCE_CHAR.to_string())?;
                    text.mark(
                        position..position + 1,
                        PAGE_REFERENCE_MARK,
                        page_id.as_str(),
                    )?;
                    position += 1;
                }
            }
        }
        Ok(())
    }

    fn write_planned_property(bag: &loro::LoroMap, field: &PropertyField) -> Result<(), CoreError> {
        ensure_property_field(bag, &field.key, field.value_type, field.cardinality)?;
        for value in &field.values {
            match value {
                PropertyValue::Document(document) => {
                    write_query_document_snapshot(bag, document)?;
                }
                PropertyValue::UnsupportedDocument(document) => {
                    return Err(PropertyError::UnsupportedDocument {
                        schema: document.schema.clone(),
                        version: document.version,
                    }
                    .into());
                }
                _ => match field.cardinality {
                    Cardinality::Single => set_single(bag, &field.key, value)?,
                    Cardinality::Set => set_repeated(bag, &field.key, value)?,
                },
            }
        }
        Ok(())
    }

    fn apply_text_range(&self, target: &TextTarget) -> Result<LoroText, CoreError> {
        let text = self.block_text(&target.owner, &target.block_id)?;
        if target.delete > 0 {
            text.delete(target.index, target.delete)?;
        }
        Ok(text)
    }

    fn touch_transition(
        &self,
        footprint: &TransitionFootprint,
        now: &str,
    ) -> Result<(), CoreError> {
        for (owner, block_id) in &footprint.blocks {
            self.touch_block(owner, block_id, now)?;
        }
        for owner in &footprint.outlines {
            self.touch_outline_owner(owner, now)?;
        }
        for entity in &footprint.entities {
            match entity {
                TouchedEntity::Page(page_id) => self.touch_page(page_id, now)?,
                TouchedEntity::Block { owner, block_id } => {
                    self.touch_block(owner, block_id, now)?;
                    self.touch_outline_owner(owner, now)?;
                }
                TouchedEntity::Tag(tag_id) => self.touch_tag(tag_id, now)?,
            }
        }
        Ok(())
    }

    fn tag_reference_targets(&self, tag_id: &TagId) -> Result<Vec<TagReferenceTarget>, CoreError> {
        let mut owners = Vec::new();
        self.doc.get_map("pages").for_each(|raw_id, value| {
            if let (Ok(page_id), Some(page)) = (PageId::new(raw_id), value_into_map(value)) {
                owners.push((OutlineOwner::Page { id: page_id }, page));
            }
        });
        self.doc.get_map("tags").for_each(|raw_id, value| {
            if let (Ok(owner_id), Some(tag)) = (TagId::new(raw_id), value_into_map(value)) {
                owners.push((OutlineOwner::Tag { id: owner_id }, tag));
            }
        });
        owners.sort_by(|left, right| left.0.cmp(&right.0));

        let mut targets = Vec::new();
        for (owner, map) in owners {
            let root_tagged = match &owner {
                OutlineOwner::Page { .. } => map
                    .get("root")
                    .and_then(value_into_map)
                    .ok_or_else(|| CoreError::InvalidHierarchy("page root node is missing".into()))
                    .map(|root| node_has_tag(&root, tag_id))?,
                OutlineOwner::Tag { .. } => false,
            };
            let outline = match map.get("outline") {
                Some(value) => value_into_tree(value).ok_or_else(|| {
                    CoreError::InvalidHierarchy("owner outline is invalid".into())
                })?,
                None if matches!(owner, OutlineOwner::Tag { .. }) => continue,
                None => {
                    return Err(CoreError::InvalidHierarchy(
                        "owner outline is missing".into(),
                    ));
                }
            };
            if root_tagged {
                let OutlineOwner::Page { id } = &owner else {
                    unreachable!("only page roots can carry tags")
                };
                targets.push(TagReferenceTarget::PageRoot(id.clone()));
            }
            let mut blocks = Vec::new();
            for node in outline.roots() {
                collect_tagged_blocks(&outline, node, tag_id, &mut blocks)?;
            }
            targets.extend(
                blocks
                    .into_iter()
                    .map(|block_id| TagReferenceTarget::Block {
                        owner: owner.clone(),
                        block_id,
                    }),
            );
        }
        Ok(targets)
    }

    fn validate_property_address(
        &self,
        owner: &PropertyOwner,
        key: &PropertyKey,
    ) -> Result<(), CoreError> {
        self.validate_property_owner(owner)?;
        validate_property_write(key, property_owner_target(owner)).map_err(CoreError::Property)
    }

    /// Resolves the only query-definition creation rule into an owned plan bit.
    /// Downstream operations can therefore require their exact document/view
    /// target without interpreting whether the wire command meant create or edit.
    fn validate_query_definition_target(
        &self,
        owner: &QueryOwner,
        view_id: &QueryViewId,
        allow_initialize: bool,
    ) -> Result<bool, CoreError> {
        self.validate_query_owner(owner)?;
        match self.query_document_if_present(owner)? {
            Some(document) => {
                if !document.views.iter().any(|view| &view.id == view_id) {
                    return Err(PropertyError::InvalidDocument(
                        "query view does not exist".to_owned(),
                    )
                    .into());
                }
                Ok(false)
            }
            None if allow_initialize && view_id.as_str() == "all" => Ok(true),
            None if allow_initialize => Err(PropertyError::InvalidDocument(
                "a new query must begin with view all".to_owned(),
            )
            .into()),
            None => {
                // Preserve the public missing-document error furnished by the
                // canonical decoder instead of inventing a second spelling.
                self.query_document(owner)?;
                unreachable!("a missing query document cannot decode")
            }
        }
    }
}

fn validate_entity_name(value: &str, entity: &'static str) -> Result<(), CoreError> {
    validate_text(value, MAX_ENTITY_NAME_BYTES)?;
    validate_name(value, entity)
}

fn reject_document_property(key: &PropertyKey, value_type: PropertyType) -> Result<(), CoreError> {
    if value_type == PropertyType::Document {
        return Err(PropertyError::DocumentCommandRequired(key.to_string()).into());
    }
    Ok(())
}

fn inline_operation(target: TextTarget, atoms: Vec<InlineAtom>) -> PrimitiveOp {
    if atoms.iter().all(|atom| matches!(atom, InlineAtom::Text(_))) {
        let insert = atoms
            .into_iter()
            .map(|atom| match atom {
                InlineAtom::Text(value) => value,
                InlineAtom::PageReference(_) => unreachable!("plain content has no reference"),
            })
            .collect();
        PrimitiveOp::SpliceText { target, insert }
    } else {
        PrimitiveOp::SpliceInline {
            target,
            insert: atoms,
        }
    }
}

fn checked_text_range(
    current: &str,
    range: Option<(usize, usize)>,
    inserted_bytes: usize,
    operation: &str,
) -> Result<(usize, usize), CoreError> {
    let unicode_len = current.chars().count();
    let (index, delete) = range.unwrap_or((0, unicode_len));
    if index.saturating_add(delete) > unicode_len {
        return Err(CoreError::InvalidHierarchy(format!(
            "{operation} is out of bounds"
        )));
    }
    let deleted_bytes = current
        .chars()
        .skip(index)
        .take(delete)
        .map(char::len_utf8)
        .sum::<usize>();
    let final_bytes = current
        .len()
        .saturating_sub(deleted_bytes)
        .saturating_add(inserted_bytes);
    if final_bytes > MAX_BLOCK_TEXT_BYTES {
        return Err(CoreError::TextTooLong);
    }
    Ok((index, delete))
}

fn validate_content_batch(count: usize, operation: &str) -> Result<(), CoreError> {
    if count == 0 || count > MAX_STRUCTURAL_TARGETS {
        Err(CoreError::InvalidHierarchy(format!(
            "{operation} batch must contain between 1 and {MAX_STRUCTURAL_TARGETS} blocks"
        )))
    } else {
        Ok(())
    }
}

fn ensure_distinct_block(
    seen: &mut BTreeSet<BlockId>,
    block_id: &BlockId,
    operation: &str,
) -> Result<(), CoreError> {
    if seen.insert(block_id.clone()) {
        Ok(())
    } else {
        Err(CoreError::InvalidHierarchy(format!(
            "{operation} batch contains a duplicate block"
        )))
    }
}

fn checked_query_source_target(
    definition: QueryDefinitionTarget,
    source: &str,
    index: usize,
    delete: usize,
    inserted_bytes: usize,
) -> Result<QuerySourceTarget, CoreError> {
    let points = source.chars().count();
    if index.saturating_add(delete) > points {
        return Err(CoreError::InvalidHierarchy(
            "query source splice is out of bounds".to_owned(),
        ));
    }
    let start_byte = source
        .char_indices()
        .nth(index)
        .map_or(source.len(), |(offset, _)| offset);
    let end_byte = source
        .char_indices()
        .nth(index.saturating_add(delete))
        .map_or(source.len(), |(offset, _)| offset);
    let next_len = source
        .len()
        .saturating_sub(end_byte - start_byte)
        .saturating_add(inserted_bytes);
    if next_len > MAX_QUERY_SOURCE_BYTES {
        return Err(CoreError::TextTooLong);
    }
    Ok(QuerySourceTarget {
        definition,
        index,
        delete,
    })
}

fn property_semantic(owner: &PropertyOwner) -> SemanticEvent {
    match owner {
        PropertyOwner::Tag { .. } => SemanticEvent::TagPropertiesChanged,
        PropertyOwner::TagDefault { .. } => SemanticEvent::TagDefaultsChanged,
        PropertyOwner::Page { .. } | PropertyOwner::Block { .. } => {
            SemanticEvent::PropertiesChanged
        }
    }
}

fn query_semantic(owner: &QueryOwner) -> SemanticEvent {
    match owner {
        QueryOwner::Tag { .. } => SemanticEvent::TagPropertiesChanged,
        QueryOwner::Page { .. } | QueryOwner::Block { .. } => SemanticEvent::PropertiesChanged,
        QueryOwner::GraphDefault { .. } => SemanticEvent::GraphSettingsChanged,
    }
}

fn property_owner_from_entity(entity: &EntityId) -> PropertyOwner {
    match entity {
        EntityId::Page { id } => PropertyOwner::Page { id: id.clone() },
        EntityId::Block { owner, id } => PropertyOwner::Block {
            owner: owner.clone(),
            id: id.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{BlockContentSplice, CommandEnvelope, CommandId, GraphId, MarkdownSplice};

    fn execute(core: &mut GraphCore, graph_id: &GraphId, id: &str, command: Command, now: &str) {
        core.execute(
            CommandEnvelope {
                graph_id: graph_id.clone(),
                command_id: CommandId::new(id).unwrap(),
                command,
            },
            now,
        )
        .unwrap();
    }

    fn insert_test_block(
        core: &mut GraphCore,
        graph_id: &GraphId,
        command_id: &str,
        owner: &OutlineOwner,
        parent: Option<BlockId>,
        index: usize,
        markdown: &str,
    ) -> BlockId {
        core.execute(
            CommandEnvelope {
                graph_id: graph_id.clone(),
                command_id: CommandId::new(command_id).unwrap(),
                command: Command::InsertBlock {
                    owner: owner.clone(),
                    parent,
                    index,
                    markdown: markdown.into(),
                },
            },
            "t1",
        )
        .unwrap()
        .result
        .created_block
        .expect("an insert command creates a block")
    }

    #[test]
    fn tag_removal_operations_derive_touch_and_history_footprints() {
        let page_id = PageId::new("page").unwrap();
        let tag_id = TagId::new("tag").unwrap();
        let owner = OutlineOwner::Page {
            id: page_id.clone(),
        };
        let block_id = BlockId::new("1@1").unwrap();
        let transition = NormalizedTransition::new(
            SemanticEvent::TagDeleted,
            vec![
                PrimitiveOp::AssignDeleted {
                    target: LifecycleEntity::Tag(tag_id.clone()),
                    deleted: true,
                },
                PrimitiveOp::RemoveTagReference {
                    target: TagReferenceTarget::PageRoot(page_id),
                    tag_id: tag_id.clone(),
                },
                PrimitiveOp::RemoveTagReference {
                    target: TagReferenceTarget::Block {
                        owner: owner.clone(),
                        block_id: block_id.clone(),
                    },
                    tag_id,
                },
            ],
            HistoryShape::Graph,
        );

        assert_eq!(
            transition.footprint.entities,
            BTreeSet::from([TouchedEntity::Tag(TagId::new("tag").unwrap())])
        );
        assert_eq!(transition.footprint.blocks, vec![(owner.clone(), block_id)]);
        assert_eq!(
            transition.footprint.outlines,
            BTreeSet::from([owner.clone()])
        );
        assert_eq!(transition.history.entry.scope, HistoryScope::Graph);
        assert_eq!(transition.history.entry.affected_outlines, vec![owner]);
    }

    #[test]
    fn journal_seed_derives_identity_semantic_and_history() {
        let page_id = PageId::new("journal").unwrap();
        let transition = NormalizedTransition::ensure(EntitySeed::JournalPage {
            page_id: page_id.clone(),
            date: LocalDate::new("2026-09-04").unwrap(),
        });

        assert_eq!(transition.semantic, SemanticEvent::JournalEnsured);
        assert_eq!(
            transition.footprint.entities,
            BTreeSet::from([TouchedEntity::Page(page_id.clone())])
        );
        assert_eq!(transition.history.entry.scope, HistoryScope::Outline);
        assert_eq!(
            transition.history.entry.affected_outlines,
            vec![OutlineOwner::Page { id: page_id }]
        );
    }

    #[test]
    fn tag_defaults_and_membership_share_one_entity_footprint() {
        let page_id = PageId::new("page").unwrap();
        let entity = EntityId::Page {
            id: page_id.clone(),
        };
        let owner = PropertyOwner::Page {
            id: page_id.clone(),
        };
        let key = PropertyKey::new("user.default").unwrap();
        let transition = NormalizedTransition::tag_membership(vec![
            PrimitiveOp::SetTagMembership {
                entity,
                tag_id: TagId::new("tag").unwrap(),
                present: true,
            },
            PrimitiveOp::DeclareProperty {
                owner: owner.clone(),
                key: key.clone(),
                value_type: PropertyType::String,
                cardinality: Cardinality::Single,
            },
            PrimitiveOp::AssignProperty {
                owner: owner.clone(),
                key,
                value: PropertyValue::String("default".into()),
            },
        ]);

        assert_eq!(
            transition.semantic,
            SemanticEvent::TagAddedAndDefaultsMaterialized
        );
        assert_eq!(
            transition.footprint.entities,
            BTreeSet::from([TouchedEntity::Page(page_id.clone())])
        );
        assert_eq!(transition.footprint.property_owners, vec![owner]);
        assert_eq!(transition.history.entry.scope, HistoryScope::Outline);
        assert_eq!(
            transition.history.entry.affected_outlines,
            vec![OutlineOwner::Page { id: page_id }]
        );
    }

    #[test]
    fn content_edit_wire_variants_share_one_canonical_transition_and_undo_result() {
        let graph_id = GraphId::new("content-transition-test").unwrap();
        let page_id = PageId::new("page").unwrap();
        let owner = OutlineOwner::Page {
            id: page_id.clone(),
        };
        let mut core = GraphCore::new(graph_id.clone(), 1, "t0").unwrap();
        execute(
            &mut core,
            &graph_id,
            "page",
            Command::EnsurePage {
                page_id: page_id.clone(),
                title: "Page".into(),
            },
            "t1",
        );
        let block_id = core
            .execute(
                CommandEnvelope {
                    graph_id: graph_id.clone(),
                    command_id: CommandId::new("block").unwrap(),
                    command: Command::InsertBlock {
                        owner: owner.clone(),
                        parent: None,
                        index: 0,
                        markdown: "한글tail".into(),
                    },
                },
                "t2",
            )
            .unwrap()
            .result
            .created_block
            .unwrap();
        let commands = [
            Command::EditMarkdown {
                owner: owner.clone(),
                block_id: block_id.clone(),
                markdown: "replacement".into(),
            },
            Command::SpliceMarkdown {
                owner: owner.clone(),
                block_id: block_id.clone(),
                index: 0,
                delete: 6,
                insert: "replacement".into(),
            },
            Command::SpliceMarkdowns {
                owner: owner.clone(),
                splices: vec![MarkdownSplice {
                    block_id: block_id.clone(),
                    index: 0,
                    delete: 6,
                    insert: "replacement".into(),
                }],
            },
            Command::SpliceBlockContent {
                owner: owner.clone(),
                block_id: block_id.clone(),
                index: 0,
                delete: 6,
                insert: vec![InlineContent::Markdown {
                    value: "replacement".into(),
                }],
            },
            Command::SpliceBlockContents {
                owner: owner.clone(),
                splices: vec![BlockContentSplice {
                    block_id: block_id.clone(),
                    index: 0,
                    delete: 6,
                    insert: vec![InlineContent::Markdown {
                        value: "replacement".into(),
                    }],
                }],
            },
        ];

        let canonical = core.prepare_transition(&commands[0]).unwrap();
        assert!(matches!(
            canonical.operations.as_slice(),
            [PrimitiveOp::SpliceText {
                target: TextTarget {
                    index: 0,
                    delete: 6,
                    ..
                },
                insert,
            }] if insert == "replacement"
        ));
        assert_eq!(canonical.semantic, SemanticEvent::BlockTextChanged);
        assert_eq!(canonical.history.entry.scope, HistoryScope::Entity);
        assert_eq!(
            canonical.history.entry.affected_outlines,
            vec![owner.clone()]
        );

        let baseline = core.page_snapshot(&page_id).unwrap();
        let mut expected_changed = None;
        let mut expected_undo_effect = None;
        for (index, command) in commands.into_iter().enumerate() {
            let transition = core.prepare_transition(&command).unwrap();
            assert_eq!(transition.operations, canonical.operations);
            assert_eq!(transition.footprint.blocks.len(), 1);
            assert_eq!(transition.history.entry.undo_candidates.len(), 1);

            let mut variant = core.validation_fork();
            let changed = variant
                .execute(
                    CommandEnvelope {
                        graph_id: graph_id.clone(),
                        command_id: CommandId::new(format!("wire-{index}")).unwrap(),
                        command,
                    },
                    "t3",
                )
                .unwrap();
            assert_eq!(changed.semantic, SemanticEvent::BlockTextChanged);
            assert_eq!(
                variant.page_snapshot(&page_id).unwrap().blocks[0].markdown,
                "replacement"
            );
            let changed_snapshot = variant.page_snapshot(&page_id).unwrap();
            let undo = variant
                .execute(
                    CommandEnvelope {
                        graph_id: graph_id.clone(),
                        command_id: CommandId::new(format!("undo-{index}")).unwrap(),
                        command: Command::Undo,
                    },
                    "t4",
                )
                .unwrap();
            let restored = variant.page_snapshot(&page_id).unwrap();
            assert_eq!(restored, baseline);
            if let Some(expected) = &expected_changed {
                assert_eq!(&changed_snapshot, expected);
            } else {
                expected_changed = Some(changed_snapshot);
            }
            if let Some(expected) = &expected_undo_effect {
                assert_eq!(&undo.result.history_effect, expected);
            } else {
                expected_undo_effect = Some(undo.result.history_effect);
            }
        }
    }

    #[test]
    fn content_splices_validate_the_final_block_byte_limit() {
        let graph_id = GraphId::new("content-limit-test").unwrap();
        let page_id = PageId::new("page").unwrap();
        let reference_id = PageId::new("reference").unwrap();
        let owner = OutlineOwner::Page {
            id: page_id.clone(),
        };
        let mut core = GraphCore::new(graph_id.clone(), 1, "t0").unwrap();
        for (id, page_id) in [("page", &page_id), ("reference", &reference_id)] {
            execute(
                &mut core,
                &graph_id,
                id,
                Command::EnsurePage {
                    page_id: page_id.clone(),
                    title: id.into(),
                },
                "t1",
            );
        }
        let initial = "a".repeat(MAX_BLOCK_TEXT_BYTES - PAGE_REFERENCE_CHAR.len_utf8());
        let index = initial.chars().count();
        let block_id = core
            .execute(
                CommandEnvelope {
                    graph_id: graph_id.clone(),
                    command_id: CommandId::new("block").unwrap(),
                    command: Command::InsertBlock {
                        owner: owner.clone(),
                        parent: None,
                        index: 0,
                        markdown: initial,
                    },
                },
                "t2",
            )
            .unwrap()
            .result
            .created_block
            .unwrap();

        let markdown = |delete, insert: &str| Command::SpliceMarkdown {
            owner: owner.clone(),
            block_id: block_id.clone(),
            index: index - delete,
            delete,
            insert: insert.into(),
        };
        assert!(core.prepare_transition(&markdown(0, "xyz")).is_ok());
        assert!(core.prepare_transition(&markdown(1, "wxyz")).is_ok());
        assert!(matches!(
            core.prepare_transition(&markdown(0, "wxyz")),
            Err(CoreError::TextTooLong)
        ));

        let inline = |extra: &str| Command::SpliceBlockContent {
            owner: owner.clone(),
            block_id: block_id.clone(),
            index,
            delete: 0,
            insert: vec![
                InlineContent::PageReference {
                    page_id: reference_id.clone(),
                },
                InlineContent::Markdown {
                    value: extra.into(),
                },
            ],
        };
        let exact = core.prepare_transition(&inline("")).unwrap();
        assert!(matches!(
            exact.operations.as_slice(),
            [PrimitiveOp::SpliceInline {
                insert,
                ..
            }] if matches!(
                insert.as_slice(),
                [InlineAtom::PageReference(page_id)] if page_id == &reference_id
            )
        ));
        assert!(matches!(
            core.prepare_transition(&inline("x")),
            Err(CoreError::TextTooLong)
        ));
    }

    #[test]
    fn block_insert_wire_variants_share_one_owned_plan_and_undo_result() {
        let graph_id = GraphId::new("insert-transition-test").unwrap();
        let page_id = PageId::new("page").unwrap();
        let owner = OutlineOwner::Page {
            id: page_id.clone(),
        };
        let mut core = GraphCore::new(graph_id.clone(), 1, "t0").unwrap();
        execute(
            &mut core,
            &graph_id,
            "page",
            Command::EnsurePage {
                page_id: page_id.clone(),
                title: "Page".into(),
            },
            "t1",
        );
        let commands = [
            Command::InsertBlock {
                owner: owner.clone(),
                parent: None,
                index: 0,
                markdown: "same block".into(),
            },
            Command::InsertOutline {
                owner: owner.clone(),
                parent: None,
                index: 0,
                replace: None,
                items: vec![OutlineItem {
                    depth: 0,
                    markdown: "same block".into(),
                }],
            },
        ];
        let canonical = core.prepare_transition(&commands[0]).unwrap();
        assert!(matches!(
            canonical.operations.as_slice(),
            [PrimitiveOp::InsertOutline { plan }]
                if plan.items.len() == 1 && plan.dependencies.is_empty()
        ));
        assert_eq!(canonical.semantic, SemanticEvent::BlockInserted);
        assert!(canonical.history.redo_created_block);
        assert_eq!(canonical.history.entry.affected_outlines, vec![owner]);

        let baseline = core.page_snapshot(&page_id).unwrap();
        let baseline_bytes = core.export_snapshot().unwrap();
        let mut expected = None;
        for (index, command) in commands.into_iter().enumerate() {
            let transition = core.prepare_transition(&command).unwrap();
            assert_eq!(transition.operations, canonical.operations);

            let mut variant =
                GraphCore::from_snapshot(graph_id.clone(), 2, &baseline_bytes).unwrap();
            let inserted = variant
                .execute(
                    CommandEnvelope {
                        graph_id: graph_id.clone(),
                        command_id: CommandId::new(format!("insert-{index}")).unwrap(),
                        command,
                    },
                    "t2",
                )
                .unwrap();
            assert_eq!(inserted.semantic, SemanticEvent::BlockInserted);
            assert!(inserted.result.created_block.is_some());
            let snapshot = variant.page_snapshot(&page_id).unwrap();
            assert_eq!(snapshot.blocks[0].markdown, "same block");
            if let Some(expected) = &expected {
                assert_eq!(&snapshot, expected);
            } else {
                expected = Some(snapshot);
            }

            variant
                .execute(
                    CommandEnvelope {
                        graph_id: graph_id.clone(),
                        command_id: CommandId::new(format!("undo-{index}")).unwrap(),
                        command: Command::Undo,
                    },
                    "t3",
                )
                .unwrap();
            assert_eq!(variant.page_snapshot(&page_id).unwrap(), baseline);
        }
    }

    #[test]
    fn reparent_plans_own_ordered_destinations_and_apply_without_replanning() {
        let graph_id = GraphId::new("reparent-transition-test").unwrap();
        let page_id = PageId::new("page").unwrap();
        let owner = OutlineOwner::Page {
            id: page_id.clone(),
        };
        let mut base = GraphCore::new(graph_id.clone(), 1, "t0").unwrap();
        execute(
            &mut base,
            &graph_id,
            "page",
            Command::EnsurePage {
                page_id: page_id.clone(),
                title: "Page".into(),
            },
            "t1",
        );
        let parent = insert_test_block(&mut base, &graph_id, "parent", &owner, None, 0, "parent");
        let first = insert_test_block(&mut base, &graph_id, "first", &owner, None, 1, "first");
        let second = insert_test_block(&mut base, &graph_id, "second", &owner, None, 2, "second");
        let next = insert_test_block(&mut base, &graph_id, "next", &owner, None, 3, "next");
        let existing = insert_test_block(
            &mut base,
            &graph_id,
            "existing",
            &owner,
            Some(parent.clone()),
            0,
            "existing",
        );
        let baseline = base.page_snapshot(&page_id).unwrap();
        let baseline_bytes = base.export_snapshot().unwrap();
        let indent = Command::IndentBlocks {
            owner: owner.clone(),
            block_ids: vec![second.clone(), first.clone(), second.clone()],
        };

        let mut expected = GraphCore::from_snapshot(graph_id.clone(), 2, &baseline_bytes).unwrap();
        execute(&mut expected, &graph_id, "indent", indent.clone(), "t2");
        let indented = expected.page_snapshot(&page_id).unwrap();

        let mut planned = GraphCore::from_snapshot(graph_id.clone(), 3, &baseline_bytes).unwrap();
        let transition = planned.prepare_transition(&indent).unwrap();
        let [
            PrimitiveOp::IndentBlocks {
                owner: planned_owner,
                plan,
            },
        ] = transition.operations.as_slice()
        else {
            panic!("indent must lower to one reparent plan")
        };
        assert_eq!(planned_owner, &owner);
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.steps[0].block_id, first);
        assert_eq!(
            plan.steps[0].destination,
            ReparentDestination::After {
                anchor: existing.clone()
            }
        );
        assert_eq!(plan.steps[1].block_id, second);
        assert_eq!(
            plan.steps[1].destination,
            ReparentDestination::After {
                anchor: first.clone()
            }
        );
        assert_eq!(
            transition.footprint.blocks,
            vec![
                (owner.clone(), first.clone()),
                (owner.clone(), second.clone()),
            ]
        );

        // Perturb the hierarchy after preparation. Applying the immutable plan
        // must still use its owned destinations, not the block's new siblings.
        planned
            .outline(&owner)
            .unwrap()
            .mov_after(tree_id(&first).unwrap(), tree_id(&next).unwrap())
            .unwrap();
        let mut outcome = MutationOutcome::default();
        planned
            .apply_transition(&transition, "t2", &mut outcome)
            .unwrap();
        planned.doc.commit();
        assert!(outcome.changed);
        assert_eq!(planned.page_snapshot(&page_id).unwrap(), indented);

        execute(&mut expected, &graph_id, "undo-indent", Command::Undo, "t3");
        assert_eq!(expected.page_snapshot(&page_id).unwrap(), baseline);
        execute(&mut expected, &graph_id, "redo-indent", Command::Redo, "t4");
        assert_eq!(expected.page_snapshot(&page_id).unwrap(), indented);

        let nested_bytes = expected.export_snapshot().unwrap();
        let outdent = Command::OutdentBlocks {
            owner: owner.clone(),
            block_ids: vec![first.clone(), second.clone(), first.clone()],
        };
        execute(&mut expected, &graph_id, "outdent", outdent.clone(), "t5");
        let outdented = expected.page_snapshot(&page_id).unwrap();

        let mut planned = GraphCore::from_snapshot(graph_id.clone(), 4, &nested_bytes).unwrap();
        let transition = planned.prepare_transition(&outdent).unwrap();
        let [PrimitiveOp::OutdentBlocks { plan, .. }] = transition.operations.as_slice() else {
            panic!("outdent must lower to one reparent plan")
        };
        assert_eq!(
            plan.steps
                .iter()
                .map(|step| step.block_id.clone())
                .collect::<Vec<_>>(),
            vec![second.clone(), first.clone()]
        );
        assert!(plan.steps.iter().all(|step| {
            step.destination
                == ReparentDestination::After {
                    anchor: parent.clone(),
                }
        }));

        planned
            .outline(&owner)
            .unwrap()
            .mov(tree_id(&first).unwrap(), tree_id(&next).unwrap())
            .unwrap();
        let mut outcome = MutationOutcome::default();
        planned
            .apply_transition(&transition, "t5", &mut outcome)
            .unwrap();
        planned.doc.commit();
        assert_eq!(planned.page_snapshot(&page_id).unwrap(), outdented);

        execute(
            &mut expected,
            &graph_id,
            "undo-outdent",
            Command::Undo,
            "t6",
        );
        assert_eq!(expected.page_snapshot(&page_id).unwrap(), indented);
        execute(
            &mut expected,
            &graph_id,
            "redo-outdent",
            Command::Redo,
            "t7",
        );
        assert_eq!(expected.page_snapshot(&page_id).unwrap(), outdented);
    }

    #[test]
    fn reparent_boundaries_fail_during_planning_without_a_partial_change() {
        let graph_id = GraphId::new("reparent-boundary-test").unwrap();
        let page_id = PageId::new("page").unwrap();
        let owner = OutlineOwner::Page {
            id: page_id.clone(),
        };
        let mut core = GraphCore::new(graph_id.clone(), 1, "t0").unwrap();
        execute(
            &mut core,
            &graph_id,
            "page",
            Command::EnsurePage {
                page_id: page_id.clone(),
                title: "Page".into(),
            },
            "t1",
        );
        let first = insert_test_block(&mut core, &graph_id, "first", &owner, None, 0, "first");
        let before = core.page_snapshot(&page_id).unwrap();

        for command in [
            Command::IndentBlocks {
                owner: owner.clone(),
                block_ids: Vec::new(),
            },
            Command::OutdentBlocks {
                owner: owner.clone(),
                block_ids: Vec::new(),
            },
        ] {
            assert!(matches!(
                core.prepare_transition(&command),
                Err(CoreError::InvalidHierarchy(_))
            ));
        }
        assert!(matches!(
            core.prepare_transition(&Command::IndentBlocks {
                owner: owner.clone(),
                block_ids: vec![first.clone()],
            }),
            Err(CoreError::FirstSiblingIndent)
        ));
        assert!(matches!(
            core.prepare_transition(&Command::OutdentBlocks {
                owner: owner.clone(),
                block_ids: vec![first.clone()],
            }),
            Err(CoreError::RootBlockOutdent)
        ));
        assert_eq!(core.page_snapshot(&page_id).unwrap(), before);
    }

    #[test]
    fn property_patch_matches_its_primitive_operation_sequence() {
        let graph_id = GraphId::new("property-transition-test").unwrap();
        let page_id = PageId::new("page").unwrap();
        let owner = PropertyOwner::Page {
            id: page_id.clone(),
        };
        let alpha = PropertyKey::new("user.alpha").unwrap();
        let beta = PropertyKey::new("user.beta").unwrap();
        let mut patched = GraphCore::new(graph_id.clone(), 1, "t0").unwrap();
        let mut primitive = GraphCore::new(graph_id.clone(), 2, "t0").unwrap();

        for core in [&mut patched, &mut primitive] {
            execute(
                core,
                &graph_id,
                "page",
                Command::EnsurePage {
                    page_id: page_id.clone(),
                    title: "Page".into(),
                },
                "t1",
            );
        }
        execute(
            &mut patched,
            &graph_id,
            "patch-initial",
            Command::SetProperties {
                owner: owner.clone(),
                changes: vec![
                    PropertyChange {
                        key: alpha.clone(),
                        value: Some(PropertyValue::String("old".into())),
                    },
                    PropertyChange {
                        key: beta.clone(),
                        value: Some(PropertyValue::String("remove".into())),
                    },
                ],
            },
            "t2",
        );
        for (id, key, value) in [
            ("set-alpha", alpha.clone(), "old"),
            ("set-beta", beta.clone(), "remove"),
        ] {
            execute(
                &mut primitive,
                &graph_id,
                id,
                Command::SetProperty {
                    owner: owner.clone(),
                    key,
                    value: PropertyValue::String(value.into()),
                },
                "t2",
            );
        }

        execute(
            &mut patched,
            &graph_id,
            "patch-final",
            Command::SetProperties {
                owner: owner.clone(),
                changes: vec![
                    PropertyChange {
                        key: alpha.clone(),
                        value: Some(PropertyValue::String("new".into())),
                    },
                    PropertyChange {
                        key: beta.clone(),
                        value: None,
                    },
                ],
            },
            "t3",
        );
        execute(
            &mut primitive,
            &graph_id,
            "replace-alpha",
            Command::SetProperty {
                owner: owner.clone(),
                key: alpha,
                value: PropertyValue::String("new".into()),
            },
            "t3",
        );
        execute(
            &mut primitive,
            &graph_id,
            "remove-beta",
            Command::RemoveProperty { owner, key: beta },
            "t3",
        );

        assert_eq!(
            patched.page_snapshot(&page_id).unwrap(),
            primitive.page_snapshot(&page_id).unwrap()
        );
    }

    #[test]
    fn query_plan_lowers_to_an_owned_definition_transition_and_undoes() {
        let graph_id = GraphId::new("query-transition-test").unwrap();
        let page_id = PageId::new("page").unwrap();
        let owner = QueryOwner::Page {
            id: page_id.clone(),
        };
        let view_id = QueryViewId::new("all").unwrap();
        let plan = QueryPlan {
            version: domain::QUERY_PLAN_VERSION,
            payload: serde_json::json!({
                "version": domain::QUERY_PLAN_VERSION,
                "grain": "entity",
                "subject": "block",
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
        };
        let mut core = GraphCore::new(graph_id.clone(), 1, "t0").unwrap();
        execute(
            &mut core,
            &graph_id,
            "page",
            Command::EnsurePage {
                page_id: page_id.clone(),
                title: "Page".into(),
            },
            "t1",
        );
        let baseline = core.page_snapshot(&page_id).unwrap();
        let command = Command::SetQueryPlan {
            owner: owner.clone(),
            view_id: view_id.clone(),
            plan: plan.clone(),
        };
        let transition = core.prepare_transition(&command).unwrap();
        drop(command);

        assert!(matches!(
            transition.operations.as_slice(),
            [
                PrimitiveOp::InitializeQueryDocument { owner: initialized },
                PrimitiveOp::AssignQueryPlan {
                    target: plan_target,
                    plan: Some(stored_plan),
                },
            ] if initialized == &owner
                && plan_target.owner == owner
                && plan_target.view_id == view_id
                && stored_plan == &plan
        ));
        assert_eq!(transition.semantic, SemanticEvent::PropertiesChanged);
        assert_eq!(transition.footprint.query_owners, vec![owner.clone()]);
        assert_eq!(transition.history.entry.scope, HistoryScope::Outline);

        execute(
            &mut core,
            &graph_id,
            "plan",
            Command::SetQueryPlan {
                owner,
                view_id,
                plan,
            },
            "t2",
        );
        assert!(core.page_snapshot(&page_id).unwrap() != baseline);
        execute(&mut core, &graph_id, "undo", Command::Undo, "t3");
        assert_eq!(core.page_snapshot(&page_id).unwrap(), baseline);
    }
}
