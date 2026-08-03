//! Pure graph vocabulary and command semantics.

pub mod generated {
    pub mod core_port;
}
mod ids;
mod model;
mod property;

pub use generated::core_port::*;
pub use ids::{BlockId, CommandId, GraphId, IdError, LocalDate, PageId, PropertyKey};
pub use model::{
    BlockSnapshot, Command, CommandEnvelope, CommandResult, EntityId, GraphSnapshot, PageSnapshot,
};
pub use property::{
    Cardinality, PropertyBag, PropertyDefinition, PropertyEntry, PropertyError, PropertyType,
    PropertyValue, REGISTRY_VERSION, definition, registry, registry_fixture, validate_default,
    validate_property,
};
