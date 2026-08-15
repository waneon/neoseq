//! Loro-backed graph core and runtime contracts.

#[cfg(test)]
mod convergence_tests;
mod core;
mod persistence;
mod runtime;

pub use core::{CoreError, CoreExecution, GraphCore, SCHEMA_VERSION, empty_version_vector};
pub use persistence::{
    AppendReceipt, CheckpointPolicy, CheckpointRecord, CheckpointTracker, GraphLocator,
    GraphMetadata, LocalGraphRepository, QuarantineRecord, RecoveryError, RecoveryReport,
    StorageCapabilities, UpdateRecord, checksum, recover_graph, valid_checksum,
};
pub use runtime::{
    Clock, EventBatch, EventSource, GraphEvent, GraphEventKind, GraphRepository, GraphRuntime,
    InMemoryClock, InMemoryRepository, RuntimeError,
};
