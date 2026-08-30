#![allow(dead_code)]

pub mod memory_store;

use async_trait::async_trait;
use domain::{Command, CommandEnvelope, CommandId, GraphId, PageId};
use graph_core::{GraphCore, SCHEMA_VERSION};
use neoseq_server::{
    AccountPatch, AccountStatus, AccountView, AuthError, GraphRole, GraphStore, IdentityService,
    LoginSession, Metrics, Principal, RoomConfig, RoomManager, ServerRole, SessionPurpose,
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use sync_protocol::{Message, Update};
use tokio::{
    sync::mpsc,
    time::{Duration, timeout},
};

pub use memory_store::MemoryStore;

pub const GRAPH: &str = "sync-test-graph";
pub const OWNER: &str = "acct-owner";
pub const PEER: &str = "acct-peer";
pub const INVITED: &str = "acct-invited";
pub const OWNER_USERNAME: &str = "owner";
pub const PEER_USERNAME: &str = "peer";
pub const INVITED_USERNAME: &str = "invited-editor";
pub const OWNER_TOKEN: &str = "session-owner";
pub const PEER_TOKEN: &str = "session-peer";

#[derive(Default)]
pub struct TestIdentity;

impl TestIdentity {
    fn principal(account_id: &str, username: &str) -> Principal {
        Principal {
            id: account_id.to_owned(),
            username: username.to_owned(),
            is_admin: false,
            purpose: SessionPurpose::Client,
        }
    }

    fn account(account_id: &str, username: &str) -> AccountView {
        AccountView {
            account_id: account_id.to_owned(),
            username: username.to_owned(),
            status: AccountStatus::Active,
            server_role: ServerRole::User,
            created_at: "test".to_owned(),
        }
    }
}

#[async_trait]
impl IdentityService for TestIdentity {
    async fn verify(&self, token: &str) -> Result<Principal, AuthError> {
        match token {
            OWNER_TOKEN => Ok(Self::principal(OWNER, OWNER_USERNAME)),
            PEER_TOKEN => Ok(Self::principal(PEER, PEER_USERNAME)),
            _ => Err(AuthError::Invalid),
        }
    }

    async fn login(
        &self,
        username: &str,
        _password: &str,
        purpose: SessionPurpose,
        _persistent: bool,
    ) -> Result<LoginSession, AuthError> {
        if purpose != SessionPurpose::Client {
            return Err(AuthError::Invalid);
        }
        let (account_id, token) = match username {
            OWNER_USERNAME => (OWNER, OWNER_TOKEN),
            PEER_USERNAME => (PEER, PEER_TOKEN),
            _ => return Err(AuthError::Invalid),
        };
        Ok(LoginSession {
            access_token: token.to_owned(),
            account: Self::account(account_id, username),
            purpose,
            expires_at: 4_102_444_800,
        })
    }

    async fn logout(&self, token: &str) -> Result<(), AuthError> {
        self.verify(token).await.map(|_| ())
    }

    async fn change_password(
        &self,
        _principal: &Principal,
        _current_password: &str,
        _new_password: &str,
    ) -> Result<(), AuthError> {
        Err(AuthError::Forbidden)
    }

    async fn list_accounts(&self, _actor: &Principal) -> Result<Vec<AccountView>, AuthError> {
        Err(AuthError::Forbidden)
    }

    async fn create_account(
        &self,
        _actor: &Principal,
        _username: &str,
        _password: &str,
        _role: ServerRole,
    ) -> Result<AccountView, AuthError> {
        Err(AuthError::Forbidden)
    }

    async fn update_account(
        &self,
        _actor: &Principal,
        _account_id: &str,
        _patch: AccountPatch,
    ) -> Result<AccountView, AuthError> {
        Err(AuthError::Forbidden)
    }

    async fn reset_password(
        &self,
        _actor: &Principal,
        _account_id: &str,
        _password: &str,
    ) -> Result<(), AuthError> {
        Err(AuthError::Forbidden)
    }

    async fn revoke_sessions(
        &self,
        _actor: &Principal,
        _account_id: &str,
    ) -> Result<(), AuthError> {
        Err(AuthError::Forbidden)
    }

    async fn resolve_username(&self, username: &str) -> Result<String, AuthError> {
        match username {
            OWNER_USERNAME => Ok(OWNER.to_owned()),
            PEER_USERNAME => Ok(PEER.to_owned()),
            INVITED_USERNAME => Ok(INVITED.to_owned()),
            _ => Err(AuthError::InvalidInput("unknown or disabled account")),
        }
    }

    async fn username_for(&self, account_id: &str) -> Result<Option<String>, AuthError> {
        Ok(match account_id {
            OWNER => Some(OWNER_USERNAME.to_owned()),
            PEER => Some(PEER_USERNAME.to_owned()),
            INVITED => Some(INVITED_USERNAME.to_owned()),
            _ => None,
        })
    }
}

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
            history_epoch: 0,
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

pub async fn room_fingerprint<S: GraphStore>(
    manager: &RoomManager<S>,
    graph_id: &str,
    account_id: &str,
) -> String {
    static SESSION: AtomicU64 = AtomicU64::new(1);
    let suffix = SESSION.fetch_add(1, Ordering::Relaxed);
    manager.evict(graph_id).await;
    let opened = manager
        .open(
            graph_id,
            &format!("fingerprint-{suffix}"),
            account_id,
            u64::MAX,
            &graph_core::empty_version_vector(),
        )
        .await
        .unwrap();
    assert!(opened.welcome.replace_checkpoint);
    let core = GraphCore::from_snapshot(
        GraphId::new(graph_id).unwrap(),
        u64::MAX - 10,
        &opened.welcome.checkpoint,
    )
    .unwrap();
    manager.disconnect(&opened.connection).await;
    core.fingerprint().unwrap()
}
