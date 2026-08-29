use crate::{
    metrics::Metrics,
    store::{GraphStore, Membership, StoreError},
};
use domain::GraphId;
use graph_core::{GraphCore, SCHEMA_VERSION};
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::{collections::HashMap, sync::Arc};
use sync_protocol::{
    Ack, ErrorCode, ErrorMessage, Limits, Message, Presence, ResyncRequired, Update, Welcome,
};
use thiserror::Error;
use tokio::sync::{Mutex, OnceCell, mpsc};

const SERVER_PEER_ID: u64 = u64::MAX - 1;
const CHECKPOINT_TAIL_UPDATES: usize = 256;
const CHECKPOINT_TAIL_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct RoomConfig {
    pub limits: Limits,
    pub max_rooms: usize,
    pub max_sessions_per_room: usize,
}

impl Default for RoomConfig {
    fn default() -> Self {
        Self {
            limits: Limits::default(),
            max_rooms: 1_024,
            max_sessions_per_room: 256,
        }
    }
}

#[derive(Debug, Error)]
pub enum RoomError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("invalid graph identifier")]
    InvalidGraph,
    #[error("invalid Loro version vector")]
    InvalidVersionVector,
    #[error("invalid Loro update")]
    InvalidUpdate,
    #[error("graph schema is unsupported")]
    UnsupportedSchema,
    #[error("room or connection limit reached")]
    LimitReached,
    #[error("session is missing or no longer valid")]
    InvalidSession,
    #[error("session queue is full")]
    SlowConsumer,
    #[error("durable update requires reconnect before acknowledgement")]
    ReconnectRequired,
    #[error("client history epoch is stale")]
    StaleHistory,
}

struct RoomSlot {
    room: OnceCell<Arc<Mutex<Room>>>,
}

struct Room {
    core: GraphCore,
    cursor: u64,
    history_epoch: u64,
    tail_updates: usize,
    tail_bytes: usize,
    sessions: HashMap<String, SessionState>,
    valid: bool,
}

struct SessionState {
    account_id: String,
    membership_version: u64,
    outbound: mpsc::Sender<Message>,
}

pub struct RoomConnection {
    pub graph_id: String,
    pub session_id: String,
    pub account_id: String,
    pub membership_version: u64,
    room: Arc<Mutex<Room>>,
    outbound: Option<mpsc::Receiver<Message>>,
}

impl RoomConnection {
    pub fn take_outbound(&mut self) -> mpsc::Receiver<Message> {
        self.outbound
            .take()
            .expect("outbound receiver can only be taken once")
    }
}

pub struct OpenedRoom {
    pub connection: RoomConnection,
    pub welcome: Welcome,
}

pub struct RoomManager<S: GraphStore> {
    store: Arc<S>,
    config: RoomConfig,
    metrics: Arc<Metrics>,
    rooms: Mutex<HashMap<String, Arc<RoomSlot>>>,
    #[cfg(debug_assertions)]
    fail_live_apply_once: AtomicBool,
}

impl<S: GraphStore> RoomManager<S> {
    pub fn new(store: Arc<S>, config: RoomConfig, metrics: Arc<Metrics>) -> Self {
        Self {
            store,
            config,
            metrics,
            rooms: Mutex::new(HashMap::new()),
            #[cfg(debug_assertions)]
            fail_live_apply_once: AtomicBool::new(false),
        }
    }

    pub fn store(&self) -> &Arc<S> {
        &self.store
    }

    pub fn limits(&self) -> Limits {
        self.config.limits
    }

    #[cfg(debug_assertions)]
    /// Debug-build fault hook for the commit/live-import boundary.
    pub fn inject_live_apply_failure_once(&self) {
        self.fail_live_apply_once.store(true, Ordering::SeqCst);
    }

    pub async fn open(
        &self,
        graph_id: &str,
        session_id: &str,
        account_id: &str,
        client_history_epoch: u64,
        client_version_vector: &[u8],
    ) -> Result<OpenedRoom, RoomError> {
        if session_id.is_empty() || session_id.len() > 128 {
            return Err(RoomError::InvalidSession);
        }
        let membership = self.store.authorize(graph_id, account_id).await?;
        if membership.schema_version != SCHEMA_VERSION {
            return Err(RoomError::UnsupportedSchema);
        }
        let room = self.room_for(graph_id).await?;
        let mut guard = room.lock().await;
        if !guard.valid {
            return Err(RoomError::ReconnectRequired);
        }
        if guard.sessions.len() >= self.config.max_sessions_per_room
            || guard.sessions.contains_key(session_id)
        {
            return Err(RoomError::LimitReached);
        }
        let epoch_changed = client_history_epoch != guard.history_epoch;
        let (mut missing_update, invalid_vector) = if epoch_changed {
            (Vec::new(), false)
        } else {
            match guard.core.export_updates_since(client_version_vector) {
                Ok(update) => (update, false),
                Err(_) => (Vec::new(), true),
            }
        };
        let replace_checkpoint = epoch_changed
            || invalid_vector
            || missing_update.len() > self.config.limits.max_update_bytes as usize;
        let checkpoint = if replace_checkpoint {
            missing_update.clear();
            guard
                .core
                .export_gc_checkpoint()
                .map_err(|_| RoomError::InvalidUpdate)?
        } else {
            Vec::new()
        };
        let (outbound, receiver) =
            mpsc::channel(self.config.limits.session_queue_capacity as usize);
        guard.sessions.insert(
            session_id.to_owned(),
            SessionState {
                account_id: account_id.to_owned(),
                membership_version: membership.version,
                outbound,
            },
        );
        let welcome = Welcome {
            history_epoch: guard.history_epoch,
            server_version_vector: guard.core.version_vector(),
            missing_update,
            checkpoint,
            replace_checkpoint,
        };
        self.metrics.session_opened();
        let graph_log_id = telemetry_id(graph_id);
        let session_log_id = telemetry_id(session_id);
        let account_log_id = telemetry_id(account_id);
        tracing::info!(
            graph_id = graph_log_id,
            session_id = session_log_id,
            account_id = account_log_id,
            cursor = guard.cursor,
            "sync session opened"
        );
        drop(guard);
        Ok(OpenedRoom {
            connection: RoomConnection {
                graph_id: graph_id.to_owned(),
                session_id: session_id.to_owned(),
                account_id: account_id.to_owned(),
                membership_version: membership.version,
                room,
                outbound: Some(receiver),
            },
            welcome,
        })
    }

    async fn room_for(&self, graph_id: &str) -> Result<Arc<Mutex<Room>>, RoomError> {
        GraphId::new(graph_id).map_err(|_| RoomError::InvalidGraph)?;
        let slot = {
            let mut rooms = self.rooms.lock().await;
            if let Some(slot) = rooms.get(graph_id) {
                slot.clone()
            } else {
                if rooms.len() >= self.config.max_rooms {
                    return Err(RoomError::LimitReached);
                }
                let slot = Arc::new(RoomSlot {
                    room: OnceCell::new(),
                });
                rooms.insert(graph_id.to_owned(), slot.clone());
                slot
            }
        };
        let room = slot
            .room
            .get_or_try_init(|| async { self.reconstruct(graph_id).await })
            .await?;
        Ok(room.clone())
    }

    async fn reconstruct(&self, graph_id: &str) -> Result<Arc<Mutex<Room>>, RoomError> {
        let durable = self.store.load_graph(graph_id).await?;
        if durable.schema_version != SCHEMA_VERSION {
            return Err(RoomError::UnsupportedSchema);
        }
        if graph_core::checksum(&durable.checkpoint.snapshot) != durable.checkpoint.checksum {
            return Err(StoreError::Corrupt("checkpoint checksum mismatch").into());
        }
        if durable.checkpoint.snapshot.len() > self.config.limits.max_decompressed_bytes as usize {
            return Err(StoreError::QuotaExceeded.into());
        }
        let graph = GraphId::new(graph_id).map_err(|_| RoomError::InvalidGraph)?;
        let mut core = GraphCore::from_recovery_snapshot(
            graph.clone(),
            SERVER_PEER_ID,
            &durable.checkpoint.snapshot,
        )
        .map_err(|_| StoreError::Corrupt("checkpoint Loro snapshot is invalid"))?;
        for update in &durable.updates {
            if graph_core::checksum(&update.bytes) != update.checksum {
                return Err(StoreError::Corrupt("update checksum mismatch").into());
            }
            core.import_recovery_update(&update.bytes)
                .map_err(|_| StoreError::Corrupt("durable Loro update is invalid"))?;
        }
        core.finish_recovery()
            .map_err(|_| StoreError::Corrupt("durable graph validation failed"))?;
        let history_epoch = durable.history_epoch;
        let tail_updates = durable.updates.len();
        let tail_bytes = durable
            .updates
            .iter()
            .map(|update| update.bytes.len())
            .sum();
        core.reset_local_history();
        self.metrics.room_opened();
        let graph_log_id = telemetry_id(graph_id);
        tracing::info!(
            graph_id = graph_log_id,
            cursor = durable.latest_cursor(),
            tail_updates = durable.updates.len(),
            "graph room reconstructed"
        );
        Ok(Arc::new(Mutex::new(Room {
            core,
            cursor: durable.latest_cursor(),
            history_epoch,
            tail_updates,
            tail_bytes,
            sessions: HashMap::new(),
            valid: true,
        })))
    }

    pub async fn submit_update(
        &self,
        connection: &RoomConnection,
        update: Update,
    ) -> Result<(), RoomError> {
        if update.bytes.len() > self.config.limits.max_update_bytes as usize
            || update.message_id.is_empty()
            || update.message_id.len() > 128
        {
            return Err(RoomError::InvalidUpdate);
        }
        let membership = self
            .store
            .authorize(&connection.graph_id, &connection.account_id)
            .await?;
        require_same_membership(connection, &membership)?;

        let mut room = connection.room.lock().await;
        if !room.valid {
            return Err(RoomError::ReconnectRequired);
        }
        if update.history_epoch != room.history_epoch {
            return Err(RoomError::StaleHistory);
        }
        let session = room
            .sessions
            .get(&connection.session_id)
            .ok_or(RoomError::InvalidSession)?;
        if session.account_id != connection.account_id
            || session.membership_version != membership.version
        {
            return Err(RoomError::InvalidSession);
        }
        room.core
            .export_updates_since(&update.base_version_vector)
            .map_err(|_| RoomError::InvalidVersionVector)?;
        let snapshot = room
            .core
            .export_snapshot()
            .map_err(|_| RoomError::InvalidUpdate)?;
        let graph_id = room.core.graph_id().clone();
        let mut candidate = GraphCore::from_snapshot(graph_id, SERVER_PEER_ID, &snapshot)
            .map_err(|_| RoomError::InvalidUpdate)?;
        candidate
            .import_remote(&update.bytes)
            .map_err(|_| RoomError::InvalidUpdate)?;
        let candidate_size = candidate
            .export_gc_checkpoint()
            .map_err(|_| RoomError::InvalidUpdate)?
            .len();
        if candidate_size > self.config.limits.max_decompressed_bytes as usize {
            return Err(StoreError::QuotaExceeded.into());
        }

        let outcome = match self
            .store
            .commit_update(
                &connection.graph_id,
                &connection.account_id,
                &update.message_id,
                &update.bytes,
            )
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                invalidate_room(&mut room, ErrorCode::StorageUnavailable);
                drop(room);
                self.evict(&connection.graph_id).await;
                return Err(error.into());
            }
        };

        if outcome.inserted {
            #[cfg(debug_assertions)]
            let injected = self.fail_live_apply_once.swap(false, Ordering::SeqCst);
            #[cfg(not(debug_assertions))]
            let injected = false;
            if injected || room.core.import_remote(&update.bytes).is_err() {
                invalidate_room(&mut room, ErrorCode::Internal);
                drop(room);
                self.evict(&connection.graph_id).await;
                // Rehydrate before reporting the no-ack outcome. A reconnect and
                // retry will observe the durable duplicate and receive its cursor.
                let _ = self.room_for(&connection.graph_id).await?;
                return Err(RoomError::ReconnectRequired);
            }
            room.cursor = outcome.cursor;
            room.tail_updates += 1;
            room.tail_bytes += update.bytes.len();
        }

        let ack = Message::Ack(Ack {
            history_epoch: room.history_epoch,
            message_id: update.message_id.clone(),
            server_cursor: outcome.cursor,
        });
        let sender_full = room
            .sessions
            .get(&connection.session_id)
            .ok_or(RoomError::InvalidSession)?
            .outbound
            .try_send(ack)
            .is_err();
        if sender_full {
            room.sessions.remove(&connection.session_id);
            self.metrics.slow_consumer();
            return Err(RoomError::SlowConsumer);
        }
        if outcome.inserted {
            let fanout = Message::Update(update);
            let slow = room
                .sessions
                .iter()
                .filter(|(session_id, _)| *session_id != &connection.session_id)
                .filter_map(|(session_id, session)| {
                    if session.outbound.try_send(fanout.clone()).is_err() {
                        Some(session_id.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            for session_id in slow {
                room.sessions.remove(&session_id);
                self.metrics.slow_consumer();
            }
            self.metrics.update_accepted();
            let graph_log_id = telemetry_id(&connection.graph_id);
            let session_log_id = telemetry_id(&connection.session_id);
            tracing::info!(
                graph_id = graph_log_id,
                session_id = session_log_id,
                cursor = outcome.cursor,
                update_bytes = fanout_size(&fanout),
                "durable update accepted"
            );
        }
        if outcome.inserted
            && (room.tail_updates >= CHECKPOINT_TAIL_UPDATES
                || room.tail_bytes >= CHECKPOINT_TAIL_BYTES)
        {
            // Checkpoint rotation is maintenance after the update is durable and
            // acknowledged. A failed rotation leaves the current epoch intact so
            // a later update can retry without turning success into a false NACK.
            if let Err(error) = self.rotate_history(&connection.graph_id, &mut room).await {
                tracing::warn!(
                    graph_id = telemetry_id(&connection.graph_id),
                    error = %error,
                    "history checkpoint rotation deferred"
                );
            }
        }
        Ok(())
    }

    async fn rotate_history(&self, graph_id: &str, room: &mut Room) -> Result<(), RoomError> {
        let snapshot = room
            .core
            .export_gc_checkpoint()
            .map_err(|_| RoomError::InvalidUpdate)?;
        let version_vector = room.core.version_vector();
        let graph = room.core.graph_id().clone();
        let replacement = GraphCore::from_snapshot(graph, SERVER_PEER_ID, &snapshot)
            .map_err(|_| StoreError::Corrupt("candidate checkpoint is invalid"))?;
        let next_epoch = self
            .store
            .install_checkpoint(
                graph_id,
                room.history_epoch,
                room.cursor,
                SCHEMA_VERSION,
                &snapshot,
                &version_vector,
            )
            .await?;
        room.core = replacement;
        room.history_epoch = next_epoch;
        room.tail_updates = 0;
        room.tail_bytes = 0;
        let message = Message::ResyncRequired(ResyncRequired {
            code: ErrorCode::StaleHistory,
            server_cursor: room.cursor,
            history_epoch: room.history_epoch,
            diagnostic: "history checkpoint rotated; reconnect from the new epoch".into(),
        });
        for session in room.sessions.values() {
            let _ = session.outbound.try_send(message.clone());
        }
        room.sessions.clear();
        Ok(())
    }

    pub async fn relay_presence(
        &self,
        connection: &RoomConnection,
        presence: Presence,
    ) -> Result<(), RoomError> {
        if presence.payload.len() > self.config.limits.max_presence_bytes as usize
            || presence.expires_in_ms > 30_000
        {
            return Err(RoomError::InvalidSession);
        }
        let membership = self
            .store
            .authorize(&connection.graph_id, &connection.account_id)
            .await?;
        require_same_membership(connection, &membership)?;
        let mut room = connection.room.lock().await;
        if !room.valid || !room.sessions.contains_key(&connection.session_id) {
            return Err(RoomError::InvalidSession);
        }
        let message = Message::Presence(presence);
        let slow = room
            .sessions
            .iter()
            .filter(|(session_id, _)| *session_id != &connection.session_id)
            .filter_map(|(session_id, session)| {
                if session.outbound.try_send(message.clone()).is_err() {
                    Some(session_id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        for session_id in slow {
            room.sessions.remove(&session_id);
            self.metrics.slow_consumer();
        }
        Ok(())
    }

    pub async fn recheck(&self, connection: &RoomConnection) -> Result<(), RoomError> {
        match self
            .store
            .authorize(&connection.graph_id, &connection.account_id)
            .await
        {
            Ok(membership) if membership.version == connection.membership_version => Ok(()),
            Ok(_) | Err(StoreError::AccessDenied) => {
                let mut room = connection.room.lock().await;
                if let Some(session) = room.sessions.remove(&connection.session_id) {
                    let _ = session.outbound.try_send(Message::Error(ErrorMessage {
                        code: ErrorCode::MembershipRevoked,
                        recoverable: false,
                        diagnostic: "membership changed or was revoked".into(),
                    }));
                }
                Err(StoreError::AccessDenied.into())
            }
            Err(error) => Err(error.into()),
        }
    }

    pub async fn disconnect(&self, connection: &RoomConnection) {
        let mut room = connection.room.lock().await;
        room.sessions.remove(&connection.session_id);
        self.metrics.session_closed();
        let graph_log_id = telemetry_id(&connection.graph_id);
        let session_log_id = telemetry_id(&connection.session_id);
        let account_log_id = telemetry_id(&connection.account_id);
        tracing::info!(
            graph_id = graph_log_id,
            session_id = session_log_id,
            account_id = account_log_id,
            "sync session closed"
        );
    }

    pub async fn evict(&self, graph_id: &str) {
        let slot = self.rooms.lock().await.remove(graph_id);
        if slot.as_ref().is_some_and(|slot| slot.room.initialized()) {
            self.metrics.room_closed();
        }
    }
}

fn require_same_membership(
    connection: &RoomConnection,
    membership: &Membership,
) -> Result<(), RoomError> {
    if membership.version == connection.membership_version {
        Ok(())
    } else {
        Err(StoreError::AccessDenied.into())
    }
}

fn invalidate_room(room: &mut Room, code: ErrorCode) {
    room.valid = false;
    let message = Message::ResyncRequired(ResyncRequired {
        code,
        server_cursor: room.cursor,
        history_epoch: room.history_epoch,
        diagnostic: "room was discarded; reconnect from durable state".into(),
    });
    for session in room.sessions.values() {
        let _ = session.outbound.try_send(message.clone());
    }
    room.sessions.clear();
}

fn fanout_size(message: &Message) -> usize {
    match message {
        Message::Update(update) => update.bytes.len(),
        _ => 0,
    }
}

fn telemetry_id(value: &str) -> String {
    graph_core::checksum(value.as_bytes())[..16].to_owned()
}
