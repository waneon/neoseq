//! Durable, authorization-aware synchronization service.

pub mod auth;
pub mod metrics;
pub mod room;
pub mod store;
pub mod web;

pub use auth::{Principal, TestIssuer, TokenVerifier};
pub use metrics::Metrics;
pub use room::{RoomConfig, RoomConnection, RoomError, RoomManager};
pub use store::{
    CommitOutcome, FaultPoint, GraphAdmin, GraphBackup, GraphListing, GraphLoad, GraphRole,
    GraphStore, Membership, MembershipListing, MemoryStore, PgStore, StoreError,
};
pub use web::{AppState, router};
