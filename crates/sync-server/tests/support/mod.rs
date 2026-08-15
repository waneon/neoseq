#![allow(dead_code)]

use domain::{Command, CommandEnvelope, CommandId, GraphId, PageId};
use graph_core::{GraphCore, SCHEMA_VERSION};
use std::sync::Arc;
use sync_protocol::{Message, Update};
use sync_server::{GraphRole, MemoryStore, Metrics, RoomConfig, RoomManager};
use tokio::{
    sync::mpsc,
    time::{Duration, timeout},
};

pub const GRAPH: &str = "sync-test-graph";
pub const OWNER: &str = "principal-owner";
pub const PEER: &str = "principal-peer";

pub struct Fixture {
    pub store: Arc<MemoryStore>,
    pub manager: Arc<RoomManager<MemoryStore>>,
    pub snapshot: Vec<u8>,
    pub base_version: Vec<u8>,
}

pub fn fixture(config: RoomConfig) -> Fixture {
    let graph = GraphId::new(GRAPH).unwrap();
    let base = GraphCore::new(graph, 1, "base").unwrap();
    let snapshot = base.export_snapshot().unwrap();
    let base_version = base.version_vector();
    let store = Arc::new(MemoryStore::new());
    store.seed_graph(
        GRAPH,
        OWNER,
        SCHEMA_VERSION,
        8 * 1024 * 1024,
        snapshot.clone(),
        base_version.clone(),
    );
    store.grant(GRAPH, PEER, GraphRole::Editor);
    let metrics = Arc::new(Metrics::default());
    let manager = Arc::new(RoomManager::new(store.clone(), config, metrics));
    Fixture {
        store,
        manager,
        snapshot,
        base_version,
    }
}

pub fn client_update(
    snapshot: &[u8],
    peer: u64,
    command_id: &str,
    message_id: &str,
    page_id: &str,
    title: &str,
) -> (GraphCore, Update) {
    let graph = GraphId::new(GRAPH).unwrap();
    let mut core = GraphCore::from_snapshot(graph.clone(), peer, snapshot).unwrap();
    let base_version_vector = core.version_vector();
    let execution = core
        .execute(
            CommandEnvelope {
                graph_id: graph,
                command_id: CommandId::new(command_id).unwrap(),
                command: Command::EnsurePage {
                    page_id: PageId::new(page_id).unwrap(),
                    title: title.to_owned(),
                },
            },
            "client-edit",
        )
        .unwrap();
    (
        core,
        Update {
            message_id: message_id.to_owned(),
            base_version_vector,
            bytes: execution.update,
        },
    )
}

pub async fn receive(receiver: &mut mpsc::Receiver<Message>) -> Option<Message> {
    timeout(Duration::from_millis(200), receiver.recv())
        .await
        .ok()
        .flatten()
}

pub async fn assert_ack(receiver: &mut mpsc::Receiver<Message>, message_id: &str) -> u64 {
    match receive(receiver).await {
        Some(Message::Ack(ack)) => {
            assert_eq!(ack.message_id, message_id);
            ack.server_cursor
        }
        other => panic!("expected ack for {message_id}, got {other:?}"),
    }
}

pub async fn assert_update(receiver: &mut mpsc::Receiver<Message>, message_id: &str) -> Update {
    match receive(receiver).await {
        Some(Message::Update(update)) => {
            assert_eq!(update.message_id, message_id);
            update
        }
        other => panic!("expected update for {message_id}, got {other:?}"),
    }
}

pub async fn assert_no_ack_or_update(receiver: &mut mpsc::Receiver<Message>) {
    while let Some(message) = receive(receiver).await {
        assert!(
            !matches!(message, Message::Ack(_) | Message::Update(_)),
            "commit failure leaked an ack or update: {message:?}"
        );
    }
}
