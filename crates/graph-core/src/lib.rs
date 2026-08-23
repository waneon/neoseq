//! Loro-backed graph core and runtime contracts.

#[cfg(test)]
mod convergence_tests;
mod core;
mod persistence;
mod runtime;

pub use core::{
    CoreError, CoreExecution, GRAPH_SETTINGS_MIGRATION_ID, GraphChangeSet, GraphCore,
    LIFECYCLE_MIGRATION_ID, MIN_MIGRATABLE_SCHEMA_VERSION, MINIMUM_WRITER_SCHEMA, MigrationReport,
    SCHEMA_VERSION, TAG_OUTLINES_MIGRATION_ID, empty_version_vector,
};
pub use persistence::{
    AppendReceipt, CheckpointRecord, GraphLocator, GraphMetadata, LocalGraphRepository,
    QuarantineRecord, RecoveryError, RecoveryReport, StorageCapabilities, UpdateRecord, checksum,
    recover_graph, valid_checksum,
};
pub use runtime::{
    Clock, EventBatch, EventSource, GraphEvent, GraphEventKind, GraphRepository, GraphRuntime,
    InMemoryClock, RuntimeError,
};
