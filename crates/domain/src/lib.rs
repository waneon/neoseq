//! Pure graph vocabulary and command semantics.

pub mod generated {
    pub mod core_port;
}
mod ids;
mod model;
mod property;

pub use generated::core_port::*;
pub use ids::{
    BlockId, CommandId, GraphId, IdError, LocalDate, PageId, PropertyKey, QueryViewId, TagId,
};
pub use model::{
    BlockSnapshot, Command, CommandEnvelope, CommandResult, EntityId, GraphSnapshot, GraphSummary,
    HistoryEffect, HistoryScope, OutlineItem, PageSnapshot, PageSummary, PropertyOwner, QueryView,
    QueryViewKind, SplitPlacement, TagSnapshot,
};
pub use property::{
    Cardinality, DocumentSpec, PropertyAccess, PropertyBag, PropertyDocument,
    PropertyDocumentHeader, PropertyError, PropertyField, PropertyPlacement, PropertyShape,
    PropertySpec, PropertyTarget, PropertyType, PropertyValue, PropertyValueSpec,
    QUERY_DOCUMENT_SCHEMA, QUERY_DOCUMENT_VERSION, QUERY_LANGUAGE, QUERY_PROPERTY_KEY,
    REGISTRY_VERSION, StringSpec, definition, registry_fixture, validate_property,
    validate_property_field, validate_property_shape, validate_property_target,
    validate_property_write,
};
