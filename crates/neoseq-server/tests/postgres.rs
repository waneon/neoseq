use domain::GraphId;
use futures_util::{SinkExt, StreamExt};
use graph_core::{GraphCore, SCHEMA_VERSION};
use neoseq_server::{
    AccountPatch, AccountStatus, AppState, CommitOutcome, CreateGraphOutcome, GraphAdmin,
    GraphRole, GraphStore, IdentityService, Metrics, NewGraph, PgIdentity, PgStore, RoomConfig,
    ServerRole, SessionPurpose, StoreError, router,
};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use sync_protocol::{Hello, Message, PROTOCOL_VERSION, decode, encode};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message as WsMessage, client::IntoClientRequest, http::HeaderValue},
};

#[tokio::test]
#[ignore = "requires PostgreSQL; run with devenv tasks run neoseq-server:postgres-test"]
async fn postgres_schema_persistence_and_authorization() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be provided by the PostgreSQL integration test fixture");
    let store = PgStore::connect(&database_url, 4).await.unwrap();
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let identity = Arc::new(PgIdentity::new(store.pool().clone()).unwrap());
    let admin_username = format!("admin-{suffix}");
    let admin_password = "x";
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
                false,
            )
            .await
            .is_err()
    );
    assert!(
        identity
            .login(
                &admin_username,
                ignored_password,
                SessionPurpose::Admin,
                false,
            )
            .await
            .is_err()
    );
    let admin_session = identity
        .login(&admin_username, admin_password, SessionPurpose::Admin, true)
        .await
        .unwrap();
    assert_session_lifetime(&admin_session, 60 * 60);
    let admin_principal = identity.verify(&admin_session.access_token).await.unwrap();
    assert!(admin_principal.is_admin());

    let user_username = format!("member-{suffix}");
    let first_password = "";
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
        .login(
            &user_username,
            first_password,
            SessionPurpose::Client,
            false,
        )
        .await
        .unwrap();
    assert_session_lifetime(&user_session, 12 * 60 * 60);
    assert_eq!(
        identity
            .verify(&user_session.access_token)
            .await
            .unwrap()
            .id,
        user.account_id
    );
    let replacement_password = "y";
    identity
        .reset_password(&admin_principal, &user.account_id, replacement_password)
        .await
        .unwrap();
    assert!(identity.verify(&user_session.access_token).await.is_err());
    let persistent_session = identity
        .login(
            &user_username,
            replacement_password,
            SessionPurpose::Client,
            true,
        )
        .await
        .unwrap();
    assert_session_lifetime(&persistent_session, 30 * 24 * 60 * 60);
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
        .login(
            &editor_username,
            editor_password,
            SessionPurpose::Client,
            false,
        )
        .await
        .unwrap();
    let graph_id = GraphId::new(format!("postgres-sync-{suffix}")).unwrap();
    let graph = graph_id.clone();
    let base = GraphCore::new(graph.clone(), 1, "base").unwrap();
    let snapshot = base.export_snapshot().unwrap();
    let version_vector = base.version_vector();
    assert_eq!(
        store
            .create_graph(NewGraph {
                graph_id: &graph_id,
                display_name: "Postgres graph",
                owner_account_id: &owner.account_id,
                schema_version: SCHEMA_VERSION,
                byte_quota: 8 * 1024 * 1024,
                snapshot: &snapshot,
                version_vector: &version_vector,
            })
            .await
            .unwrap(),
        CreateGraphOutcome::Created
    );
    assert_eq!(
        store
            .create_graph(NewGraph {
                graph_id: &graph_id,
                display_name: "Postgres graph",
                owner_account_id: &owner.account_id,
                schema_version: SCHEMA_VERSION,
                byte_quota: 8 * 1024 * 1024,
                snapshot: &snapshot,
                version_vector: &version_vector,
            })
            .await
            .unwrap(),
        CreateGraphOutcome::Existing
    );
    assert!(matches!(
        store
            .create_graph(NewGraph {
                graph_id: &graph_id,
                display_name: "Conflicting graph",
                owner_account_id: &owner.account_id,
                schema_version: SCHEMA_VERSION,
                byte_quota: 8 * 1024 * 1024,
                snapshot: &snapshot,
                version_vector: &version_vector,
            })
            .await,
        Err(StoreError::GraphAlreadyExists)
    ));
    assert!(matches!(
        store
            .grant_membership(
                &graph_id,
                &editor.account_id,
                &viewer.account_id,
                GraphRole::Viewer,
            )
            .await,
        Err(StoreError::AccessDenied)
    ));
    assert!(matches!(
        store
            .grant_membership(
                &graph_id,
                &owner.account_id,
                &editor.account_id,
                GraphRole::Owner,
            )
            .await,
        Err(StoreError::InvalidMembershipRole)
    ));
    assert!(matches!(
        store
            .revoke_membership(&graph_id, &owner.account_id, &owner.account_id)
            .await,
        Err(StoreError::InvalidMembershipRole)
    ));
    assert_eq!(
        store
            .authorize(&graph_id, &owner.account_id)
            .await
            .unwrap()
            .role,
        GraphRole::Owner
    );
    store
        .grant_membership(
            &graph_id,
            &owner.account_id,
            &editor.account_id,
            GraphRole::Editor,
        )
        .await
        .unwrap();
    store
        .grant_membership(
            &graph_id,
            &owner.account_id,
            &viewer.account_id,
            GraphRole::Viewer,
        )
        .await
        .unwrap();
    store
        .grant_membership(
            &graph_id,
            &owner.account_id,
            &api_editor.account_id,
            GraphRole::Editor,
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .revoke_membership(&graph_id, &editor.account_id, &viewer.account_id)
            .await,
        Err(StoreError::AccessDenied)
    ));
    assert_eq!(
        store
            .authorize(&graph_id, &viewer.account_id)
            .await
            .unwrap()
            .role,
        GraphRole::Viewer
    );
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
        message_id: sync_protocol::ContentId::for_bytes(&execution.update),
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
    assert_eq!(
        duplicate,
        CommitOutcome::Duplicate {
            cursor: durable_cursor
        }
    );
    assert!(matches!(
        store
            .commit_update(
                &graph_id,
                &editor.account_id,
                &update.message_id,
                b"different bytes",
            )
            .await,
        Err(StoreError::InvalidUpdateIdentity)
    ));
    assert!(matches!(
        store
            .commit_update(
                &graph_id,
                &viewer.account_id,
                &update.message_id,
                &update.bytes,
            )
            .await,
        Err(StoreError::ReadOnly)
    ));

    let rotated = client.export_snapshot().unwrap();
    store
        .compact_checkpoint(
            &graph_id,
            0,
            durable_cursor,
            SCHEMA_VERSION,
            &rotated,
            &client.version_vector(),
        )
        .await
        .unwrap();
    let compacted = store.load_graph(&graph_id).await.unwrap();
    assert_eq!(compacted.history_epoch, 0);
    assert!(compacted.updates.is_empty());
    let retained_checkpoints: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM graph_checkpoint WHERE graph_id = $1")
            .bind(graph_id.as_str())
            .fetch_one(store.pool())
            .await
            .unwrap();
    let retained_tail: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM graph_update WHERE graph_id = $1")
            .bind(graph_id.as_str())
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(retained_checkpoints, 2);
    assert_eq!(retained_tail, 1);
    store
        .compact_checkpoint(
            &graph_id,
            0,
            durable_cursor,
            SCHEMA_VERSION,
            &rotated,
            &client.version_vector(),
        )
        .await
        .unwrap();
    let reclaimed_tail: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM graph_update WHERE graph_id = $1")
            .bind(graph_id.as_str())
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
    assert_eq!(
        compacted_duplicate,
        CommitOutcome::Duplicate {
            cursor: durable_cursor
        }
    );

    store
        .revoke_membership(&graph_id, &owner.account_id, &editor.account_id)
        .await
        .unwrap();
    assert!(matches!(
        store.authorize(&graph_id, &editor.account_id).await,
        Err(StoreError::AccessDenied)
    ));
    store
        .revoke_membership(&graph_id, &owner.account_id, &api_editor.account_id)
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
    sqlx::query("UPDATE neoseq_schema_version SET version = 5 WHERE singleton = TRUE")
        .execute(store.pool())
        .await
        .unwrap();
    assert!(matches!(
        PgStore::from_pool(store.pool().clone()).await,
        Err(StoreError::SchemaMismatch {
            found: 5,
            required: 4
        })
    ));
    sqlx::query("UPDATE graph SET byte_quota = 67108864 WHERE graph_id = $1")
        .bind(graph_id.as_str())
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query(
        "ALTER TABLE graph_update_receipt
         DROP CONSTRAINT graph_update_receipt_content_identity",
    )
    .execute(store.pool())
    .await
    .unwrap();
    sqlx::query("ALTER TABLE graph_update_receipt ADD COLUMN checksum TEXT")
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE graph_update_receipt SET checksum = message_id")
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query("ALTER TABLE graph_update_receipt ALTER COLUMN checksum SET NOT NULL")
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE graph_update_receipt SET message_id = 'legacy-random-id'")
        .execute(store.pool())
        .await
        .unwrap();
    let swapped_receipt_id_a = sync_protocol::ContentId::for_bytes(b"legacy-receipt-key-swap-a");
    let swapped_receipt_id_b = sync_protocol::ContentId::for_bytes(b"legacy-receipt-key-swap-b");
    sqlx::query(
        "INSERT INTO graph_update_receipt(
             graph_id, message_id, checksum, cursor, received_at
         ) VALUES
             ($1, $3, $2, $4, NOW()),
             ($1, $2, $3, $5, NOW())",
    )
    .bind(graph_id.as_str())
    .bind(swapped_receipt_id_a.as_str())
    .bind(swapped_receipt_id_b.as_str())
    .bind(durable_cursor as i64 + 1)
    .bind(durable_cursor as i64 + 2)
    .execute(store.pool())
    .await
    .unwrap();
    sqlx::query("ALTER TABLE graph_update DROP CONSTRAINT graph_update_content_identity")
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query("ALTER TABLE graph_update ADD COLUMN checksum TEXT")
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE graph_update SET checksum = message_id")
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query("ALTER TABLE graph_update ALTER COLUMN checksum SET NOT NULL")
        .execute(store.pool())
        .await
        .unwrap();
    let swapped_payload_a = b"legacy-key-swap-a";
    let swapped_payload_b = b"legacy-key-swap-b";
    let swapped_id_a = sync_protocol::ContentId::for_bytes(swapped_payload_a);
    let swapped_id_b = sync_protocol::ContentId::for_bytes(swapped_payload_b);
    sqlx::query(
        "INSERT INTO graph_update(
             graph_id, message_id, account_id, checksum, payload, size_bytes
         ) VALUES
             ($1, 'legacy-duplicate-a', $2, $3, $4, $5),
             ($1, 'legacy-duplicate-b', $2, $3, $4, $5),
             ($1, $7, $2, $6, $8, $9),
             ($1, $6, $2, $7, $10, $11)",
    )
    .bind(graph_id.as_str())
    .bind(&editor.account_id)
    .bind(update.message_id.as_str())
    .bind(&update.bytes)
    .bind(update.bytes.len() as i64)
    .bind(swapped_id_a.as_str())
    .bind(swapped_id_b.as_str())
    .bind(swapped_payload_a.as_slice())
    .bind(swapped_payload_a.len() as i64)
    .bind(swapped_payload_b.as_slice())
    .bind(swapped_payload_b.len() as i64)
    .execute(store.pool())
    .await
    .unwrap();
    let used_before_legacy_duplicates: i64 =
        sqlx::query_scalar("SELECT used_bytes FROM graph WHERE graph_id = $1")
            .bind(graph_id.as_str())
            .fetch_one(store.pool())
            .await
            .unwrap();
    sqlx::query("UPDATE graph SET used_bytes = used_bytes + $2 WHERE graph_id = $1")
        .bind(graph_id.as_str())
        .bind((update.bytes.len() * 2 + swapped_payload_a.len() + swapped_payload_b.len()) as i64)
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE neoseq_schema_version SET version = 2 WHERE singleton = TRUE")
        .execute(store.pool())
        .await
        .unwrap();
    PgStore::from_pool(store.pool().clone()).await.unwrap();
    let migrated_quota: i64 =
        sqlx::query_scalar("SELECT byte_quota FROM graph WHERE graph_id = $1")
            .bind(graph_id.as_str())
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(migrated_quota, 1_073_741_824);
    let migrated_receipt: String = sqlx::query_scalar(
        "SELECT message_id FROM graph_update_receipt
         WHERE graph_id = $1 AND message_id = $2",
    )
    .bind(graph_id.as_str())
    .bind(update.message_id.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(migrated_receipt, update.message_id.as_str());
    let migrated_swapped_receipts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM graph_update_receipt
         WHERE graph_id = $1 AND message_id IN ($2, $3)",
    )
    .bind(graph_id.as_str())
    .bind(swapped_receipt_id_a.as_str())
    .bind(swapped_receipt_id_b.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(migrated_swapped_receipts, 2);
    let migrated_updates: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM graph_update
         WHERE graph_id = $1 AND message_id = $2",
    )
    .bind(graph_id.as_str())
    .bind(update.message_id.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(migrated_updates, 0);
    let migrated_swapped_updates: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM graph_update
         WHERE graph_id = $1 AND message_id IN ($2, $3)",
    )
    .bind(graph_id.as_str())
    .bind(swapped_id_a.as_str())
    .bind(swapped_id_b.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(migrated_swapped_updates, 2);
    let redundant_identity_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('graph_update', 'graph_update_receipt')
           AND column_name = 'checksum'",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(redundant_identity_columns, 0);
    let used_after_content_migration: i64 =
        sqlx::query_scalar("SELECT used_bytes FROM graph WHERE graph_id = $1")
            .bind(graph_id.as_str())
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(
        used_after_content_migration,
        used_before_legacy_duplicates
            + swapped_payload_a.len() as i64
            + swapped_payload_b.len() as i64
    );
    sqlx::query("UPDATE graph_update SET payload = $3 WHERE graph_id = $1 AND message_id = $2")
        .bind(graph_id.as_str())
        .bind(swapped_id_a.as_str())
        .bind(b"forged-payload".as_slice())
        .execute(store.pool())
        .await
        .unwrap();
    assert!(matches!(
        store.load_graph(&graph_id).await,
        Err(StoreError::Corrupt("update content identity mismatch"))
    ));
    assert!(matches!(
        store.delete_graph(&graph_id, &editor.account_id).await,
        Err(StoreError::AccessDenied)
    ));
    store
        .delete_graph(&graph_id, &owner.account_id)
        .await
        .unwrap();
    assert!(matches!(
        store.load_graph(&graph_id).await,
        Err(StoreError::AccessDenied)
    ));
    for table in [
        "graph_membership",
        "graph_checkpoint",
        "graph_update",
        "graph_update_receipt",
    ] {
        let remaining: i64 =
            sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE graph_id = $1"))
                .bind(graph_id.as_str())
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(remaining, 0, "graph deletion must clear {table}");
    }
    let audit_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM graph_audit_event WHERE account_id = $1 AND action = 'graph.delete' AND graph_id IS NULL")
        .bind(&owner.account_id)
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(audit_count, 1);
}

fn assert_session_lifetime(session: &neoseq_server::LoginSession, expected_seconds: i64) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let remaining = session.expires_at - now;
    assert!(
        (expected_seconds - 5..=expected_seconds + 5).contains(&remaining),
        "expected a {expected_seconds}s session, got {remaining}s"
    );
}

async fn websocket_commit(
    store: &PgStore,
    identity: Arc<PgIdentity>,
    token: &str,
    graph_id: &GraphId,
    base_version: &[u8],
    update: sync_protocol::Update,
) -> u64 {
    let metrics = Arc::new(Metrics::default());
    let store = Arc::new(store.clone());
    let state = AppState::new(
        store,
        identity,
        metrics,
        RoomConfig::default(),
        8,
        Duration::from_secs(1),
    );
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
        protocol: PROTOCOL_VERSION,
        schema: SCHEMA_VERSION as u16,
        graph_id: graph_id.clone(),
        session_id: "postgres-websocket".into(),
        history_epoch: 0,
        has_server_base: true,
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
