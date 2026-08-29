use async_trait::async_trait;
use graph_core::checksum;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use sync_protocol::GraphStatus;
use sync_server::store::{
    CommitOutcome, GraphAdmin, GraphListing, GraphLoad, GraphRole, GraphStore, Membership,
    MembershipListing, StoreError, StoredCheckpoint, StoredUpdate,
};

const MAX_RETAINED_RECEIPTS: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultPoint {
    BeforeCommit,
    AfterCommit,
}

#[derive(Clone, Default)]
pub struct MemoryStore {
    inner: Arc<Mutex<MemoryState>>,
}

#[derive(Default)]
struct MemoryState {
    graphs: HashMap<String, MemoryGraph>,
    next_cursor: u64,
    fault: Option<FaultPoint>,
    available: bool,
}

struct MemoryGraph {
    owner_principal_id: String,
    status: GraphStatus,
    schema_version: u32,
    byte_quota: u64,
    history_epoch: u64,
    used_bytes: u64,
    checkpoint: StoredCheckpoint,
    prior_checkpoint: Option<StoredCheckpoint>,
    updates: Vec<StoredUpdate>,
    receipts: HashMap<String, (String, u64)>,
    memberships: HashMap<String, MemoryMembership>,
    membership_version: u64,
}

struct MemoryMembership {
    role: GraphRole,
    version: u64,
    revoked: bool,
}

impl MemoryStore {
    pub fn new() -> Self {
        let store = Self::default();
        store.inner.lock().expect("memory store mutex").available = true;
        store
    }

    pub fn seed_graph(
        &self,
        graph_id: &str,
        owner_principal_id: &str,
        schema_version: u32,
        byte_quota: u64,
        snapshot: Vec<u8>,
        version_vector: Vec<u8>,
    ) {
        let mut memberships = HashMap::new();
        memberships.insert(
            owner_principal_id.to_owned(),
            MemoryMembership {
                role: GraphRole::Owner,
                version: 1,
                revoked: false,
            },
        );
        self.inner
            .lock()
            .expect("memory store mutex")
            .graphs
            .insert(
                graph_id.to_owned(),
                MemoryGraph {
                    owner_principal_id: owner_principal_id.to_owned(),
                    status: GraphStatus::Active,
                    schema_version,
                    byte_quota,
                    history_epoch: 0,
                    used_bytes: snapshot.len() as u64,
                    checkpoint: StoredCheckpoint {
                        history_epoch: 0,
                        included_cursor: 0,
                        checksum: checksum(&snapshot),
                        snapshot,
                        version_vector,
                    },
                    prior_checkpoint: None,
                    updates: Vec::new(),
                    receipts: HashMap::new(),
                    memberships,
                    membership_version: 1,
                },
            );
    }

    pub fn grant(&self, graph_id: &str, principal_id: &str, role: GraphRole) {
        let mut state = self.inner.lock().expect("memory store mutex");
        let graph = state.graphs.get_mut(graph_id).expect("seeded graph");
        graph.membership_version += 1;
        graph.memberships.insert(
            principal_id.to_owned(),
            MemoryMembership {
                role,
                version: graph.membership_version,
                revoked: false,
            },
        );
    }

    pub fn revoke(&self, graph_id: &str, principal_id: &str) {
        let mut state = self.inner.lock().expect("memory store mutex");
        let graph = state.graphs.get_mut(graph_id).expect("seeded graph");
        graph.membership_version += 1;
        let membership = graph
            .memberships
            .get_mut(principal_id)
            .expect("granted principal");
        membership.version = graph.membership_version;
        membership.revoked = true;
    }

    pub fn inject_once(&self, point: FaultPoint) {
        self.inner.lock().expect("memory store mutex").fault = Some(point);
    }

    pub fn set_available(&self, available: bool) {
        self.inner.lock().expect("memory store mutex").available = available;
    }

    pub fn update_count(&self, graph_id: &str) -> usize {
        self.inner
            .lock()
            .expect("memory store mutex")
            .graphs
            .get(graph_id)
            .map_or(0, |graph| graph.updates.len())
    }

    pub fn checkpoint_count(&self, graph_id: &str) -> usize {
        self.inner
            .lock()
            .expect("memory store mutex")
            .graphs
            .get(graph_id)
            .map_or(0, |graph| 1 + usize::from(graph.prior_checkpoint.is_some()))
    }
}

fn memory_load(graph_id: &str, graph: &MemoryGraph) -> GraphLoad {
    GraphLoad {
        graph_id: graph_id.to_owned(),
        owner_principal_id: graph.owner_principal_id.clone(),
        status: graph.status,
        schema_version: graph.schema_version,
        byte_quota: graph.byte_quota,
        history_epoch: graph.history_epoch,
        checkpoint: graph.checkpoint.clone(),
        // Covered rows remain physically available for the prior checkpoint,
        // but the logical load starts after the current checkpoint.
        updates: graph
            .updates
            .iter()
            .filter(|update| update.cursor > graph.checkpoint.included_cursor)
            .cloned()
            .collect(),
    }
}

#[async_trait]
impl GraphStore for MemoryStore {
    async fn ready(&self) -> Result<(), StoreError> {
        if self.inner.lock().expect("memory store mutex").available {
            Ok(())
        } else {
            Err(StoreError::Unavailable("injected outage"))
        }
    }

    async fn authorize(
        &self,
        graph_id: &str,
        principal_id: &str,
    ) -> Result<Membership, StoreError> {
        let state = self.inner.lock().expect("memory store mutex");
        if !state.available {
            return Err(StoreError::Unavailable("injected outage"));
        }
        let graph = state.graphs.get(graph_id).ok_or(StoreError::AccessDenied)?;
        let member = graph
            .memberships
            .get(principal_id)
            .filter(|member| !member.revoked)
            .ok_or(StoreError::AccessDenied)?;
        Ok(Membership {
            principal_id: principal_id.to_owned(),
            role: member.role,
            version: member.version,
            schema_version: graph.schema_version,
        })
    }

    async fn load_graph(&self, graph_id: &str) -> Result<GraphLoad, StoreError> {
        let state = self.inner.lock().expect("memory store mutex");
        if !state.available {
            return Err(StoreError::Unavailable("injected outage"));
        }
        state
            .graphs
            .get(graph_id)
            .map(|graph| memory_load(graph_id, graph))
            .ok_or(StoreError::AccessDenied)
    }

    async fn commit_update(
        &self,
        graph_id: &str,
        principal_id: &str,
        message_id: &str,
        bytes: &[u8],
    ) -> Result<CommitOutcome, StoreError> {
        let mut state = self.inner.lock().expect("memory store mutex");
        if !state.available {
            return Err(StoreError::Unavailable("injected outage"));
        }
        let fault = state.fault.take();
        if fault == Some(FaultPoint::BeforeCommit) {
            return Err(StoreError::Unavailable("injected before commit"));
        }
        let next_cursor = state.next_cursor + 1;
        let graph = state
            .graphs
            .get_mut(graph_id)
            .ok_or(StoreError::AccessDenied)?;
        let member = graph
            .memberships
            .get(principal_id)
            .filter(|member| !member.revoked)
            .ok_or(StoreError::AccessDenied)?;
        if !member.role.can_write() || graph.status == GraphStatus::ReadOnly {
            return Err(StoreError::ReadOnly);
        }
        if let Some(update) = graph
            .updates
            .iter()
            .find(|update| update.message_id == message_id)
        {
            if update.checksum != checksum(bytes) {
                return Err(StoreError::MessageConflict);
            }
            return Ok(CommitOutcome {
                cursor: update.cursor,
                inserted: false,
            });
        }
        if let Some((stored_checksum, cursor)) = graph.receipts.get(message_id) {
            if stored_checksum != &checksum(bytes) {
                return Err(StoreError::MessageConflict);
            }
            return Ok(CommitOutcome {
                cursor: *cursor,
                inserted: false,
            });
        }
        let next_used = graph
            .used_bytes
            .checked_add(bytes.len() as u64)
            .ok_or(StoreError::QuotaExceeded)?;
        if next_used > graph.byte_quota {
            return Err(StoreError::QuotaExceeded);
        }
        graph.updates.push(StoredUpdate {
            cursor: next_cursor,
            message_id: message_id.to_owned(),
            principal_id: principal_id.to_owned(),
            checksum: checksum(bytes),
            bytes: bytes.to_vec(),
        });
        graph.used_bytes = next_used;
        state.next_cursor = next_cursor;
        if fault == Some(FaultPoint::AfterCommit) {
            return Err(StoreError::Unavailable("injected after commit"));
        }
        Ok(CommitOutcome {
            cursor: next_cursor,
            inserted: true,
        })
    }

    async fn install_checkpoint(
        &self,
        graph_id: &str,
        expected_epoch: u64,
        included_cursor: u64,
        schema_version: u32,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<u64, StoreError> {
        let mut state = self.inner.lock().expect("memory store mutex");
        if !state.available {
            return Err(StoreError::Unavailable("injected outage"));
        }
        let graph = state
            .graphs
            .get_mut(graph_id)
            .ok_or(StoreError::AccessDenied)?;
        if graph.history_epoch != expected_epoch {
            return Err(StoreError::StaleHistory);
        }
        let next_epoch = expected_epoch
            .checked_add(1)
            .ok_or(StoreError::Corrupt("history epoch overflow"))?;
        let prior = graph.checkpoint.clone();
        if included_cursor < prior.included_cursor {
            return Err(StoreError::StaleHistory);
        }
        let tail_bytes = graph
            .updates
            .iter()
            .filter(|update| update.cursor > prior.included_cursor)
            .map(|update| update.bytes.len() as u64)
            .sum::<u64>();
        let used_bytes = (snapshot.len() as u64)
            .checked_add(prior.snapshot.len() as u64)
            .ok_or(StoreError::QuotaExceeded)?
            .checked_add(tail_bytes)
            .ok_or(StoreError::QuotaExceeded)?;
        if used_bytes > graph.byte_quota {
            return Err(StoreError::QuotaExceeded);
        }
        let mut retained = Vec::new();
        for update in graph.updates.drain(..) {
            if update.cursor <= included_cursor {
                graph
                    .receipts
                    .entry(update.message_id.clone())
                    .or_insert((update.checksum.clone(), update.cursor));
            }
            if update.cursor > prior.included_cursor {
                retained.push(update);
            }
        }
        if graph.receipts.len() > MAX_RETAINED_RECEIPTS {
            let mut cursors = graph
                .receipts
                .values()
                .map(|(_, cursor)| *cursor)
                .collect::<Vec<_>>();
            cursors.sort_unstable_by(|left, right| right.cmp(left));
            let minimum = cursors[MAX_RETAINED_RECEIPTS - 1];
            graph.receipts.retain(|_, (_, cursor)| *cursor >= minimum);
        }
        graph.history_epoch = next_epoch;
        graph.schema_version = schema_version;
        graph.used_bytes = used_bytes;
        graph.prior_checkpoint = Some(prior);
        graph.checkpoint = StoredCheckpoint {
            history_epoch: next_epoch,
            included_cursor,
            snapshot: snapshot.to_vec(),
            version_vector: version_vector.to_vec(),
            checksum: checksum(snapshot),
        };
        graph.updates = retained;
        Ok(next_epoch)
    }
}

#[async_trait]
impl GraphAdmin for MemoryStore {
    async fn create_graph(
        &self,
        graph_id: &str,
        owner_principal_id: &str,
        schema_version: u32,
        byte_quota: u64,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<(), StoreError> {
        let mut state = self.inner.lock().expect("memory store mutex");
        if state.graphs.contains_key(graph_id) {
            return Err(StoreError::Database("graph already exists".into()));
        }
        let mut memberships = HashMap::new();
        memberships.insert(
            owner_principal_id.to_owned(),
            MemoryMembership {
                role: GraphRole::Owner,
                version: 1,
                revoked: false,
            },
        );
        state.graphs.insert(
            graph_id.to_owned(),
            MemoryGraph {
                owner_principal_id: owner_principal_id.to_owned(),
                status: GraphStatus::Active,
                schema_version,
                byte_quota,
                history_epoch: 0,
                used_bytes: snapshot.len() as u64,
                checkpoint: StoredCheckpoint {
                    history_epoch: 0,
                    included_cursor: 0,
                    snapshot: snapshot.to_vec(),
                    version_vector: version_vector.to_vec(),
                    checksum: checksum(snapshot),
                },
                prior_checkpoint: None,
                updates: Vec::new(),
                receipts: HashMap::new(),
                memberships,
                membership_version: 1,
            },
        );
        Ok(())
    }

    async fn list_graphs(&self, principal_id: &str) -> Result<Vec<GraphListing>, StoreError> {
        let state = self.inner.lock().expect("memory store mutex");
        let mut graphs = state
            .graphs
            .iter()
            .filter_map(|(graph_id, graph)| {
                let member = graph.memberships.get(principal_id)?;
                (!member.revoked).then_some(GraphListing {
                    graph_id: graph_id.clone(),
                    role: member.role,
                    status: graph.status,
                    membership_version: graph.membership_version,
                })
            })
            .collect::<Vec<_>>();
        graphs.sort_by(|left, right| left.graph_id.cmp(&right.graph_id));
        Ok(graphs)
    }

    async fn list_memberships(&self, graph_id: &str) -> Result<Vec<MembershipListing>, StoreError> {
        let state = self.inner.lock().expect("memory store mutex");
        let graph = state.graphs.get(graph_id).ok_or(StoreError::AccessDenied)?;
        let mut memberships = graph
            .memberships
            .iter()
            .filter_map(|(principal_id, membership)| {
                (!membership.revoked).then_some(MembershipListing {
                    account_id: principal_id.clone(),
                    role: membership.role,
                    version: membership.version,
                })
            })
            .collect::<Vec<_>>();
        memberships.sort_by(|left, right| left.account_id.cmp(&right.account_id));
        Ok(memberships)
    }

    async fn grant_membership(
        &self,
        graph_id: &str,
        principal_id: &str,
        role: GraphRole,
    ) -> Result<u64, StoreError> {
        if role == GraphRole::Owner {
            return Err(StoreError::InvalidMembershipRole);
        }
        self.grant(graph_id, principal_id, role);
        self.authorize(graph_id, principal_id)
            .await
            .map(|membership| membership.version)
    }

    async fn revoke_membership(
        &self,
        graph_id: &str,
        principal_id: &str,
    ) -> Result<u64, StoreError> {
        self.revoke(graph_id, principal_id);
        let state = self.inner.lock().expect("memory store mutex");
        state
            .graphs
            .get(graph_id)
            .and_then(|graph| graph.memberships.get(principal_id))
            .map(|membership| membership.version)
            .ok_or(StoreError::AccessDenied)
    }
}
