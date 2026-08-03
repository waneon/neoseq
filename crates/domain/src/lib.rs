//! Pure graph vocabulary and command semantics.

pub mod generated {
    pub mod core_port;
}
mod ids;
mod model;
mod property;

pub use generated::core_port::{CORE_PORT_VERSION, PingRequest, PingResponse};
pub use ids::{BlockId, CommandId, GraphId, IdError, LocalDate, PageId, PropertyKey};
pub use model::{
    BlockSnapshot, Command, CommandEnvelope, CommandResult, EntityId, GraphSnapshot, PageSnapshot,
};
pub use property::{
    Cardinality, PropertyBag, PropertyDefinition, PropertyEntry, PropertyError, PropertyType,
    PropertyValue, REGISTRY_VERSION, definition, registry, registry_fixture, validate_default,
    validate_property,
};

pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn ping(request: PingRequest) -> PingResponse {
    PingResponse {
        contract_version: CORE_PORT_VERSION,
        core_version: CORE_VERSION.to_owned(),
        echo: request.client_version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_negotiates_the_spike_contract() {
        let response = ping(PingRequest {
            client_version: "web-spike".to_owned(),
        });
        assert_eq!(response.contract_version, 1);
        assert_eq!(response.echo, "web-spike");
    }
}
