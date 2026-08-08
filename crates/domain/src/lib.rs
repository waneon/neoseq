//! Pure graph vocabulary and command semantics.

pub mod generated {
    pub mod core_port;
}
mod ids;
mod model;
mod property;

pub use generated::core_port::*;
pub use ids::{BlockId, CommandId, GraphId, IdError, LocalDate, PageId, PropertyKey, TagId};
pub use model::{
    BlockSnapshot, Command, CommandEnvelope, CommandResult, EntityId, GraphSnapshot, GraphSummary,
    HistoryEffect, HistoryScope, OutlineItem, PageSnapshot, PageSummary, PropertyOwner,
    SplitPlacement, TagSnapshot,
};
pub use property::{
    Cardinality, PropertyAccess, PropertyBag, PropertyError, PropertyField, PropertyPlacement,
    PropertyShape, PropertySpec, PropertyTarget, PropertyType, PropertyValue, PropertyValueSpec,
    REGISTRY_VERSION, StringSpec, definition, registry, registry_fixture, validate_property,
    validate_property_field, validate_property_shape, validate_property_target,
    validate_property_write,
};
