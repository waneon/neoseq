//! Loro-backed graph core and runtime contracts.

mod core;
mod persistence;
mod runtime;
#[cfg(feature = "test-support")]
pub mod scenario;

#[cfg(test)]
mod convergence_tests;

pub use core::{CoreError, CoreExecution, GraphCore, SCHEMA_VERSION};
pub use persistence::{
    AppendReceipt, CheckpointPolicy, CheckpointRecord, CheckpointTracker, GraphLocation,
    GraphLocator, GraphMetadata, LocalGraphRepository, QuarantineRecord, RecoveryError,
    RecoveryReport, StorageCapabilities, UpdateRecord, checksum, recover_graph, valid_checksum,
};
pub use runtime::{
    Clock, EventBatch, EventSource, GraphEvent, GraphEventKind, GraphRepository, GraphRuntime,
    InMemoryClock, InMemoryRepository, RuntimeError,
};
