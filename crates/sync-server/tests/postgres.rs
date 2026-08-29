use domain::GraphId;
use futures_util::{SinkExt, StreamExt};
use graph_core::{GraphCore, SCHEMA_VERSION};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use sync_protocol::{Hello, Message, PROTOCOL_VERSION, VersionRange, decode, encode};
use sync_server::{
    AccountPatch, AccountStatus, AppState, GraphAdmin, GraphRole, GraphStore, IdentityService,
    Metrics, PgIdentity, PgStore, RoomConfig, RoomManager, ServerRole, SessionPurpose, StoreError,
    router,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message as WsMessage, client::IntoClientRequest, http::HeaderValue},
};

#[tokio::test]
#[ignore = "requires PostgreSQL; run with devenv tasks run sync-server:postgres-test"]
async fn postgres_migration_idempotency_and_authorization() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be provided by the PostgreSQL integration test fixture");
    let store = PgStore::connect(&database_url, 4).await.unwrap();
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let identity = Arc::new(PgIdentity::new(store.pool().clone()).unwrap());
    let admin_username = format!("admin-{suffix}");
    let admin_password = "a deliberately long admin passphrase";
    let admin = identity
        .bootstrap_admin_if_absent(&admin_username, admin_password)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(admin.server_role, ServerRole::Admin);
    let ignored_password = "a replacement bootstrap password";
    assert!(
        identity
            .bootstrap_admin_if_absent(&admin_username, ignored_password)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        identity
            .login(
                &admin_username,
                "wrong password long enough",
                SessionPurpose::Admin,
            )
            .await
            .is_err()
    );
    assert!(
        identity
            .login(&admin_username, ignored_password, SessionPurpose::Admin)
            .await
            .is_err()
    );
    let admin_session = identity
        .login(&admin_username, admin_password, SessionPurpose::Admin)
        .await
        .unwrap();
    let admin_principal = identity.verify(&admin_session.access_token).await.unwrap();
    assert!(admin_principal.is_admin);

    let user_username = format!("member-{suffix}");
    let first_password = "a first sufficiently long password";
    let user = identity
        .create_account(
            &admin_principal,
            &user_username,
            first_password,
            ServerRole::User,
        )
        .await
        .unwrap();
    assert_eq!(
        identity.resolve_username(&user_username).await.unwrap(),
        user.account_id
    );
    let user_session = identity
        .login(&user_username, first_password, SessionPurpose::Client)
        .await
        .unwrap();
    assert_eq!(
        identity
            .verify(&user_session.access_token)
            .await
            .unwrap()
            .id,
        user.account_id
    );
    identity
        .reset_password(
            &admin_principal,
            &user.account_id,
            "a replacement password that is long",
        )
        .await
        .unwrap();
    assert!(identity.verify(&user_session.access_token).await.is_err());
    identity
        .update_account(
            &admin_principal,
            &user.account_id,
            AccountPatch {
                status: Some(AccountStatus::Disabled),
                server_role: None,
            },
        )
        .await
        .unwrap();
    assert!(identity.resolve_username(&user_username).await.is_err());

    let owner = identity
        .create_account(
            &admin_principal,
            &format!("owner-{suffix}"),
            "an owner password long enough",
            ServerRole::User,
        )
        .await
        .unwrap();
    let editor_username = format!("editor-{suffix}");
    let editor_password = "an editor password long enough";
    let editor = identity
        .create_account(
            &admin_principal,
            &editor_username,
            editor_password,
            ServerRole::User,
        )
        .await
        .unwrap();
    let viewer = identity
        .create_account(
            &admin_principal,
            &format!("viewer-{suffix}"),
            "a viewer password long enough",
            ServerRole::User,
        )
        .await
        .unwrap();
    let api_editor = identity
        .create_account(
            &admin_principal,
            &format!("api-editor-{suffix}"),
            "an api editor password long enough",
            ServerRole::User,
        )
        .await
        .unwrap();
    let editor_session = identity
        .login(&editor_username, editor_password, SessionPurpose::Client)
        .await
        .unwrap();
    let graph_id = format!("postgres-sync-{suffix}");
    let graph = GraphId::new(&graph_id).unwrap();
    let base = GraphCore::new(graph.clone(), 1, "base").unwrap();
    let snapshot = base.export_snapshot().unwrap();
    store
        .create_graph(
            &graph_id,
            &owner.account_id,
            SCHEMA_VERSION,
            8 * 1024 * 1024,
            &snapshot,
            &base.version_vector(),
        )
        .await
        .unwrap();
    store
        .grant_membership(&graph_id, &editor.account_id, GraphRole::Editor)
        .await
        .unwrap();
    store
        .grant_membership(&graph_id, &viewer.account_id, GraphRole::Viewer)
        .await
        .unwrap();
    store
        .grant_membership(&graph_id, &api_editor.account_id, GraphRole::Editor)
        .await
        .unwrap();
    let memberships = store.list_memberships(&graph_id).await.unwrap();
    assert!(memberships.iter().any(|membership| {
        membership.account_id == api_editor.account_id && membership.role == GraphRole::Editor
    }));

    let mut client = GraphCore::from_snapshot(graph.clone(), 2, &snapshot).unwrap();
    let before = client.version_vector();
    let execution = client
        .execute(
            domain::CommandEnvelope {
                graph_id: graph,
                command_id: domain::CommandId::new("postgres-create").unwrap(),
                command: domain::Command::EnsurePage {
                    page_id: domain::PageId::new("postgres-page").unwrap(),
                    title: "Postgres".into(),
                },
            },
            "postgres-client",
        )
        .unwrap();
    let update = sync_protocol::Update {
        history_epoch: 0,
        message_id: "postgres-message".into(),
        base_version_vector: before,
        bytes: execution.update,
    };

    let durable_cursor = websocket_commit(
        &store,
        identity.clone(),
        &editor_session.access_token,
        &graph_id,
        &base.version_vector(),
        update.clone(),
    )
    .await;
    let duplicate = store
        .commit_update(
            &graph_id,
            &editor.account_id,
            &update.message_id,
            &update.bytes,
        )
        .await
        .unwrap();
    assert!(!duplicate.inserted);
    assert_eq!(duplicate.cursor, durable_cursor);
    assert!(matches!(
        store
            .commit_update(
                &graph_id,
                &editor.account_id,
                &update.message_id,
                b"different bytes",
            )
            .await,
        Err(StoreError::MessageConflict)
    ));
    assert!(matches!(
        store
            .commit_update(&graph_id, &viewer.account_id, "viewer-write", &update.bytes)
            .await,
        Err(StoreError::ReadOnly)
    ));

    let rotated = client.export_gc_checkpoint().unwrap();
    assert_eq!(
        store
            .install_checkpoint(
                &graph_id,
                0,
                durable_cursor,
                SCHEMA_VERSION,
                &rotated,
                &client.version_vector(),
            )
            .await
            .unwrap(),
        1
    );
    let compacted = store.load_graph(&graph_id).await.unwrap();
    assert_eq!(compacted.history_epoch, 1);
    assert!(compacted.updates.is_empty());
    let retained_checkpoints: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM graph_checkpoint WHERE graph_id = $1")
            .bind(&graph_id)
            .fetch_one(store.pool())
            .await
            .unwrap();
    let retained_tail: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM graph_update WHERE graph_id = $1")
            .bind(&graph_id)
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(retained_checkpoints, 2);
    assert_eq!(retained_tail, 1);
    assert_eq!(
        store
            .install_checkpoint(
                &graph_id,
                1,
                durable_cursor,
                SCHEMA_VERSION,
                &rotated,
                &client.version_vector(),
            )
            .await
            .unwrap(),
        2
    );
    let reclaimed_tail: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM graph_update WHERE graph_id = $1")
            .bind(&graph_id)
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(reclaimed_tail, 0);
    let compacted_duplicate = store
        .commit_update(
            &graph_id,
            &editor.account_id,
            &update.message_id,
            &update.bytes,
        )
        .await
        .unwrap();
    assert!(!compacted_duplicate.inserted);
    assert_eq!(compacted_duplicate.cursor, durable_cursor);

    store
        .revoke_membership(&graph_id, &editor.account_id)
        .await
        .unwrap();
    assert!(matches!(
        store.authorize(&graph_id, &editor.account_id).await,
        Err(StoreError::AccessDenied)
    ));
    store
        .revoke_membership(&graph_id, &api_editor.account_id)
        .await
        .unwrap();
    assert!(
        store
            .list_memberships(&graph_id)
            .await
            .unwrap()
            .iter()
            .all(|membership| membership.account_id != api_editor.account_id)
    );

    PgStore::from_pool(store.pool().clone()).await.unwrap();
    sqlx::query("UPDATE neoseq_schema_version SET version = 4 WHERE singleton = TRUE")
        .execute(store.pool())
        .await
        .unwrap();
    assert!(matches!(
        PgStore::from_pool(store.pool().clone()).await,
        Err(StoreError::SchemaTooNew {
            found: 4,
            supported: 3
        })
    ));
    sqlx::query("UPDATE neoseq_schema_version SET version = 3 WHERE singleton = TRUE")
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query("DELETE FROM graph WHERE graph_id = $1")
        .bind(&graph_id)
        .execute(store.pool())
        .await
        .unwrap();
}

async fn websocket_commit(
    store: &PgStore,
    identity: Arc<PgIdentity>,
    token: &str,
    graph_id: &str,
    base_version: &[u8],
    update: sync_protocol::Update,
) -> u64 {
    let metrics = Arc::new(Metrics::default());
    let rooms = Arc::new(RoomManager::new(
        Arc::new(store.clone()),
        RoomConfig::default(),
        metrics.clone(),
    ));
    let state = AppState::new(rooms, identity, metrics, 8, Duration::from_secs(1));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router(state)).await.unwrap();
    });
    let mut request = format!("ws://{address}/v1/sync")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();
    let hello = Message::Hello(Hello {
        protocol: VersionRange::exact(PROTOCOL_VERSION),
        schema: VersionRange::exact(SCHEMA_VERSION as u16),
        graph_id: graph_id.to_owned(),
        session_id: "postgres-websocket".into(),
        replica_id: 2,
        history_epoch: 0,
        version_vector: base_version.to_vec(),
    });
    socket
        .send(WsMessage::Binary(
            encode(
                &hello,
                sync_protocol::Limits::default().max_frame_bytes as usize,
            )
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        wire_message(&mut socket).await,
        Message::Welcome(_)
    ));
    socket
        .send(WsMessage::Binary(
            encode(
                &Message::Update(update),
                sync_protocol::Limits::default().max_frame_bytes as usize,
            )
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let cursor = match wire_message(&mut socket).await {
        Message::Ack(ack) => ack.server_cursor,
        other => panic!("expected PostgreSQL-backed ack, got {other:?}"),
    };
    socket.close(None).await.unwrap();
    server.abort();
    cursor
}

async fn wire_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Message {
    let WsMessage::Binary(frame) = socket.next().await.unwrap().unwrap() else {
        panic!("expected binary sync frame")
    };
    decode(
        &frame,
        sync_protocol::Limits::default().max_frame_bytes as usize,
    )
    .unwrap()
}
