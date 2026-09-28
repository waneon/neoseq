//! Pure graph vocabulary and command semantics.

pub mod generated {
    pub mod core_port;
    pub mod graph_schema;
}
mod ids;
mod model;
mod property;

pub use generated::core_port::*;
pub use generated::graph_schema::*;
pub use ids::{
    BlockId, CommandId, DefaultQueryId, GraphId, IdError, LocalDate, PageId, PropertyKey,
    QueryViewId, TagId,
};
pub use model::{
    BlockContentSplice, BlockContentUpdate, BlockSnapshot, Command, CommandEnvelope, CommandResult,
    ContentRangeChange, DefaultQuerySnapshot, EntityId, EntityKind, GraphChanges, GraphConflict,
    GraphSettings, GraphSnapshot, GraphSummary, HistoryEffect, HistoryScope, InlineContent,
    MarkdownSplice, OUTLINE_FRAGMENT_KIND, OUTLINE_FRAGMENT_VERSION, OutlineFragment,
    OutlineFragmentItem, OutlineFragmentPage, OutlineFragmentTag, OutlineItem, OutlineOwner,
    OutlineSnapshot, PageDirectoryEntry, PageReferenceSpan, PageSnapshot, PageSummary,
    PropertyChange, PropertyOwner, QueryDefinition, QueryOwner, QueryView, QueryViewColumn,
    QueryViewFieldSort, QueryViewKind, QueryViewOptions, QueryViewSort, SplitPlacement,
    TagSnapshot, TagSummary, TextTarget,
};
pub use property::{
    Cardinality, DocumentSpec, MAX_QUERY_SOURCE_BYTES, MAX_QUERY_VIEWS, PropertyAccess,
    PropertyBag, PropertyCopyPolicy, PropertyDocument, PropertyDocumentHeader, PropertyError,
    PropertyField, PropertyOrdering, PropertyPlacement, PropertyShape, PropertySpec,
    PropertyTarget, PropertyType, PropertyValue, PropertyValueSpec, QUERY_DOCUMENT_SCHEMA,
    QUERY_DOCUMENT_VERSION, QUERY_LANGUAGE, QUERY_PLAN_LIMIT, QUERY_PROPERTY_KEY, QueryPlan,
    REGISTRY_VERSION, StringSpec, definition, property_copy_policy, registry_fixture,
    validate_property, validate_property_field, validate_property_shape, validate_property_target,
    validate_property_write,
};
