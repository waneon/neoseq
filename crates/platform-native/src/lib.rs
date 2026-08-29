//! Native core and SQLite persistence adapters.

pub mod core_port;
pub mod repository;

pub use core_port::NativeCorePort;
#[cfg(debug_assertions)]
pub use repository::FaultPoint;
pub use repository::{SQLITE_SCHEMA_VERSION, SqliteGraphRepository, SqliteRepositoryError};

#[cfg(test)]
mod core_port_tests;
#[cfg(test)]
mod persistence_tests;
