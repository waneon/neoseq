//! Durable, authorization-aware synchronization service.

pub mod auth;
pub mod metrics;
pub mod room;
pub mod store;
pub mod web;

pub use auth::{
    AccountPatch, AccountStatus, AccountView, AuthError, IdentityService, LoginSession, PgIdentity,
    Principal, ServerRole, SessionPurpose,
};
pub use metrics::Metrics;
pub use room::{RoomConfig, RoomConnection, RoomError, RoomManager};
pub use store::{
    CommitOutcome, GraphAdmin, GraphListing, GraphLoad, GraphRole, GraphStatus, GraphStore,
    Membership, MembershipListing, NewGraph, PgStore, StoreError,
};
pub use web::{AppState, router};
