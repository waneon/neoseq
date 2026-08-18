use domain::GraphId;
use futures_util::{SinkExt, StreamExt};
use graph_core::{GraphCore, SCHEMA_VERSION};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use sync_protocol::{Hello, Message, PROTOCOL_VERSION, VersionRange, decode, encode};
use sync_server::{
    AppState, GraphAdmin, GraphRole, GraphStore, Metrics, PgStore, RoomConfig, RoomManager,
    StoreError, TestIssuer, router,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message as WsMessage, client::IntoClientRequest, http::HeaderValue},
};

#[tokio::test]
#[ignore = "requires PostgreSQL; run with devenv tasks run sync-server:test"]
async fn postgres_migration_idempotency_authz_backup_and_restore() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be provided by the PostgreSQL integration test fixture");
    let store = PgStore::connect(&database_url, 4).await.unwrap();
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let graph_id = format!("postgres-sync-{suffix}");
    let graph = GraphId::new(&graph_id).unwrap();
    let base = GraphCore::new(graph.clone(), 1, "base").unwrap();
    let snapshot = base.export_snapshot().unwrap();
    store
        .create_graph(
            &graph_id,
            "postgres-owner",
            SCHEMA_VERSION,
            8 * 1024 * 1024,
            &snapshot,
            &base.version_vector(),
        )
        .await
        .unwrap();
    store
        .grant(&graph_id, "postgres-editor", GraphRole::Editor)
        .await
        .unwrap();
    store
        .grant(&graph_id, "postgres-viewer", GraphRole::Viewer)
        .await
        .unwrap();
    store
        .grant_membership(&graph_id, "postgres-api-editor", GraphRole::Editor)
        .await
        .unwrap();
    let memberships = store.list_memberships(&graph_id).await.unwrap();
    assert!(memberships.iter().any(|membership| {
        membership.principal_id == "postgres-api-editor" && membership.role == GraphRole::Editor
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

    let durable_cursor =
        websocket_commit(&store, &graph_id, &base.version_vector(), update.clone()).await;
    let duplicate = store
        .commit_update(
            &graph_id,
            "postgres-editor",
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
                "postgres-editor",
                &update.message_id,
                b"different bytes",
            )
            .await,
        Err(StoreError::MessageConflict)
    ));
    assert!(matches!(
        store
            .commit_update(&graph_id, "postgres-viewer", "viewer-write", &update.bytes)
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
    let compacted_duplicate = store
        .commit_update(
            &graph_id,
            "postgres-editor",
            &update.message_id,
            &update.bytes,
        )
        .await
        .unwrap();
    assert!(!compacted_duplicate.inserted);
    assert_eq!(compacted_duplicate.cursor, durable_cursor);

    let expected = client.fingerprint().unwrap();
    let backup = store.backup_graph(&graph_id).await.unwrap();
    let manager = RoomManager::new(
        Arc::new(store.clone()),
        RoomConfig::default(),
        Arc::new(Metrics::default()),
    );
    assert_eq!(
        manager.durable_fingerprint(&graph_id).await.unwrap(),
        expected
    );

    sqlx::query("DELETE FROM graph WHERE graph_id = $1")
        .bind(&graph_id)
        .execute(store.pool())
        .await
        .unwrap();
    store.restore_graph(&backup).await.unwrap();
    let restored = RoomManager::new(
        Arc::new(store.clone()),
        RoomConfig::default(),
        Arc::new(Metrics::default()),
    );
    assert_eq!(
        restored.durable_fingerprint(&graph_id).await.unwrap(),
        expected
    );

    store.revoke(&graph_id, "postgres-editor").await.unwrap();
    assert!(matches!(
        store.authorize(&graph_id, "postgres-editor").await,
        Err(StoreError::AccessDenied)
    ));
    store
        .revoke_membership(&graph_id, "postgres-api-editor")
        .await
        .unwrap();
    assert!(
        store
            .list_memberships(&graph_id)
            .await
            .unwrap()
            .iter()
            .all(|membership| membership.principal_id != "postgres-api-editor")
    );

    PgStore::from_pool(store.pool().clone()).await.unwrap();
    sqlx::query("UPDATE neoseq_schema_version SET version = 3 WHERE singleton = TRUE")
        .execute(store.pool())
        .await
        .unwrap();
    assert!(matches!(
        PgStore::from_pool(store.pool().clone()).await,
        Err(StoreError::SchemaTooNew {
            found: 3,
            supported: 2
        })
    ));
    sqlx::query("UPDATE neoseq_schema_version SET version = 2 WHERE singleton = TRUE")
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
    graph_id: &str,
    base_version: &[u8],
    update: sync_protocol::Update,
) -> u64 {
    let issuer = Arc::new(TestIssuer::new(b"0123456789abcdef").unwrap());
    let token = issuer.issue("postgres-editor").unwrap();
    let metrics = Arc::new(Metrics::default());
    let rooms = Arc::new(RoomManager::new(
        Arc::new(store.clone()),
        RoomConfig::default(),
        metrics.clone(),
    ));
    let state = AppState::new(rooms, issuer, metrics, 8, Duration::from_secs(1));
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
