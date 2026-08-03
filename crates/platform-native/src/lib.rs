//! Native core and SQLite persistence adapters.

pub mod core_port;
pub mod repository;

pub use core_port::NativeCorePort;
pub use repository::{
    FaultPoint, SQLITE_SCHEMA_VERSION, SqliteGraphRepository, SqliteRepositoryError,
};

#[cfg(test)]
mod core_port_tests;
#[cfg(test)]
mod persistence_tests;
