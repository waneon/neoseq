//! Loro-backed graph core and runtime contracts.

#[cfg(test)]
mod convergence_tests;
mod core;
mod document;
#[cfg(test)]
mod merge_law_tests;
mod persistence;
mod runtime;
mod server_graph;

pub use core::{
    CoreError, CoreExecution, GraphChangeSet, GraphCore, SCHEMA_VERSION, empty_version_vector,
};

/// Server-only remote-update preparation and disposable baseline adoption.
///
/// Client runtimes should use [`GraphCore::import_remote`] so their local undo
/// history remains attached to the live document.
pub mod server {
    pub use crate::server_graph::{PreparedServerUpdate, ServerGraph};
}
pub use domain::SemanticEvent;
pub use persistence::{
    AppendReceipt, CheckpointRecord, GraphLocator, GraphMetadata, LocalGraphRepository,
    QuarantineRecord, RecoveryError, RecoveryReport, StorageCapabilities, StorageErrorKind,
    UpdateRecord, checksum, recover_graph, valid_checksum,
};
pub use runtime::{
    Clock, EventBatch, EventSource, GraphEvent, GraphEventKind, GraphRepository, GraphRuntime,
    InMemoryClock, RuntimeError, RuntimeExecution, RuntimePersistence, apply_index_changes,
};
