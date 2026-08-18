mod support;

use support::*;
use sync_protocol::{Limits, Message};
use sync_server::{FaultPoint, RoomConfig, RoomError, StoreError};

#[tokio::test]
async fn no_ack_or_fanout_before_commit_and_retry_converges() {
    let fixture = fixture(RoomConfig::default());
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let mut owner = fixture
        .manager
        .open(GRAPH, "owner-1", OWNER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut owner_rx = owner.take_outbound();
    let mut peer = fixture
        .manager
        .open(GRAPH, "peer-1", PEER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut peer_rx = peer.take_outbound();

    fixture.store.inject_once(FaultPoint::BeforeCommit);
    assert!(matches!(
        fixture.manager.submit_update(&owner, update.clone()).await,
        Err(RoomError::Store(StoreError::Unavailable(_)))
    ));
    assert_eq!(fixture.store.update_count(GRAPH), 0);
    assert_no_ack_or_update(&mut owner_rx).await;
    assert_no_ack_or_update(&mut peer_rx).await;

    let mut retry = fixture
        .manager
        .open(GRAPH, "owner-retry", OWNER, &client.version_vector())
        .await
        .unwrap()
        .connection;
    let mut retry_rx = retry.take_outbound();
    fixture
        .manager
        .submit_update(&retry, update.clone())
        .await
        .unwrap();
    assert_ack(&mut retry_rx, "message-a").await;
    assert_eq!(fixture.store.update_count(GRAPH), 1);
    assert_eq!(
        fixture.manager.durable_fingerprint(GRAPH).await.unwrap(),
        client.fingerprint().unwrap()
    );
}

#[tokio::test]
async fn ambiguous_post_commit_failure_is_durable_but_never_acknowledged_early() {
    let fixture = fixture(RoomConfig::default());
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let mut opened = fixture
        .manager
        .open(GRAPH, "owner-1", OWNER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut receiver = opened.take_outbound();
    fixture.store.inject_once(FaultPoint::AfterCommit);
    assert!(
        fixture
            .manager
            .submit_update(&opened, update.clone())
            .await
            .is_err()
    );
    assert_eq!(fixture.store.update_count(GRAPH), 1);
    assert_no_ack_or_update(&mut receiver).await;

    let mut retry = fixture
        .manager
        .open(GRAPH, "owner-retry", OWNER, &client.version_vector())
        .await
        .unwrap()
        .connection;
    let mut retry_rx = retry.take_outbound();
    fixture.manager.submit_update(&retry, update).await.unwrap();
    assert_ack(&mut retry_rx, "message-a").await;
    assert_eq!(fixture.store.update_count(GRAPH), 1);
    assert_eq!(
        fixture.manager.durable_fingerprint(GRAPH).await.unwrap(),
        client.fingerprint().unwrap()
    );
}

#[tokio::test]
async fn failed_live_import_discards_and_rehydrates_before_reconnect() {
    let fixture = fixture(RoomConfig::default());
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let mut opened = fixture
        .manager
        .open(GRAPH, "owner-1", OWNER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut receiver = opened.take_outbound();
    fixture.manager.inject_live_apply_failure_once();
    assert!(matches!(
        fixture.manager.submit_update(&opened, update).await,
        Err(RoomError::ReconnectRequired)
    ));
    assert_eq!(fixture.store.update_count(GRAPH), 1);
    assert_no_ack_or_update(&mut receiver).await;
    assert_eq!(
        fixture.manager.durable_fingerprint(GRAPH).await.unwrap(),
        client.fingerprint().unwrap()
    );
}

#[tokio::test]
async fn bounded_queue_disconnects_a_slow_consumer() {
    let config = RoomConfig {
        limits: Limits {
            session_queue_capacity: 1,
            ..Limits::default()
        },
        ..RoomConfig::default()
    };
    let fixture = fixture(config);
    let (_, first) = client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let (_, second) = client_update(&fixture.snapshot, 3, "create-b", "message-b", "page-b", "B");
    let mut fast = fixture
        .manager
        .open(GRAPH, "fast", OWNER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut fast_rx = fast.take_outbound();
    let mut slow = fixture
        .manager
        .open(GRAPH, "slow", PEER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut slow_rx = slow.take_outbound();

    fixture.manager.submit_update(&fast, first).await.unwrap();
    assert_ack(&mut fast_rx, "message-a").await;
    fixture.manager.submit_update(&fast, second).await.unwrap();
    assert_ack(&mut fast_rx, "message-b").await;
    assert!(matches!(
        receive(&mut slow_rx).await,
        Some(Message::Update(_))
    ));
    assert!(receive(&mut slow_rx).await.is_none());
}

#[tokio::test]
async fn membership_revocation_closes_the_authorization_seam() {
    let fixture = fixture(RoomConfig::default());
    let (_, update) = client_update(&fixture.snapshot, 3, "create-b", "message-b", "page-b", "B");
    let opened = fixture
        .manager
        .open(GRAPH, "peer", PEER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    fixture.store.revoke(GRAPH, PEER);
    assert!(matches!(
        fixture.manager.recheck(&opened).await,
        Err(RoomError::Store(StoreError::AccessDenied))
    ));
    assert!(matches!(
        fixture.manager.submit_update(&opened, update).await,
        Err(RoomError::Store(StoreError::AccessDenied))
    ));
    assert_eq!(fixture.store.update_count(GRAPH), 0);
}

#[tokio::test]
async fn unauthorized_and_unknown_graphs_have_the_same_error_shape() {
    let fixture = fixture(RoomConfig::default());
    let existing = fixture
        .manager
        .open(
            GRAPH,
            "intruder-existing",
            "principal-intruder",
            &fixture.base_version,
        )
        .await
        .err()
        .unwrap();
    let unknown = fixture
        .manager
        .open(
            "unknown-graph",
            "intruder-unknown",
            "principal-intruder",
            &fixture.base_version,
        )
        .await
        .err()
        .unwrap();
    assert!(matches!(
        existing,
        RoomError::Store(StoreError::AccessDenied)
    ));
    assert!(matches!(
        unknown,
        RoomError::Store(StoreError::AccessDenied)
    ));
}

#[tokio::test]
async fn malformed_loro_bytes_never_reach_durable_storage() {
    let fixture = fixture(RoomConfig::default());
    let mut opened = fixture
        .manager
        .open(GRAPH, "owner", OWNER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let _receiver = opened.take_outbound();
    let malformed = sync_protocol::Update {
        history_epoch: 0,
        message_id: "malformed".into(),
        base_version_vector: fixture.base_version,
        bytes: vec![0xde, 0xad, 0xbe, 0xef],
    };
    assert!(matches!(
        fixture.manager.submit_update(&opened, malformed).await,
        Err(RoomError::InvalidUpdate)
    ));
    assert_eq!(fixture.store.update_count(GRAPH), 0);
}

#[tokio::test]
async fn reconstructed_document_limit_rejects_expansion_before_commit() {
    let graph = domain::GraphId::new(GRAPH).unwrap();
    let base = graph_core::GraphCore::new(graph, 1, "base").unwrap();
    let config = RoomConfig {
        limits: sync_protocol::Limits {
            max_decompressed_bytes: base.export_snapshot().unwrap().len() as u32 + 1,
            ..sync_protocol::Limits::default()
        },
        ..RoomConfig::default()
    };
    let fixture = fixture(config);
    let (_, update) = client_update(
        &fixture.snapshot,
        2,
        "expand",
        "expand-message",
        "expanded-page",
        "content that expands the reconstructed document",
    );
    let mut opened = fixture
        .manager
        .open(GRAPH, "owner-limit", OWNER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let _receiver = opened.take_outbound();
    assert!(matches!(
        fixture.manager.submit_update(&opened, update).await,
        Err(RoomError::Store(StoreError::QuotaExceeded))
    ));
    assert_eq!(fixture.store.update_count(GRAPH), 0);
}

#[tokio::test]
async fn reused_message_id_with_different_bytes_is_rejected() {
    let fixture = fixture(RoomConfig::default());
    let (_, first) = client_update(
        &fixture.snapshot,
        2,
        "create-a",
        "same-message",
        "page-a",
        "A",
    );
    let (_, mut conflicting) = client_update(
        &fixture.snapshot,
        3,
        "create-b",
        "different-message",
        "page-b",
        "B",
    );
    conflicting.message_id = "same-message".into();
    let mut opened = fixture
        .manager
        .open(GRAPH, "owner", OWNER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut receiver = opened.take_outbound();
    fixture.manager.submit_update(&opened, first).await.unwrap();
    assert_ack(&mut receiver, "same-message").await;
    assert!(matches!(
        fixture.manager.submit_update(&opened, conflicting).await,
        Err(RoomError::Store(StoreError::MessageConflict))
    ));
    assert_eq!(fixture.store.update_count(GRAPH), 1);
}

#[tokio::test]
async fn logical_backup_restore_rehydrates_the_same_graph() {
    let fixture = fixture(RoomConfig::default());
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let mut opened = fixture
        .manager
        .open(GRAPH, "owner", OWNER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut receiver = opened.take_outbound();
    fixture
        .manager
        .submit_update(&opened, update)
        .await
        .unwrap();
    assert_ack(&mut receiver, "message-a").await;

    let backup = fixture.store.backup_graph(GRAPH).unwrap();
    let restored = std::sync::Arc::new(sync_server::MemoryStore::new());
    restored.restore_graph(backup).unwrap();
    let manager = sync_server::RoomManager::new(
        restored,
        RoomConfig::default(),
        std::sync::Arc::new(sync_server::Metrics::default()),
    );
    assert_eq!(
        manager.durable_fingerprint(GRAPH).await.unwrap(),
        client.fingerprint().unwrap()
    );
}

#[tokio::test]
async fn new_server_manager_reconstructs_all_acknowledged_updates() {
    let fixture = fixture(RoomConfig::default());
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let mut opened = fixture
        .manager
        .open(GRAPH, "owner", OWNER, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut receiver = opened.take_outbound();
    fixture
        .manager
        .submit_update(&opened, update)
        .await
        .unwrap();
    assert_ack(&mut receiver, "message-a").await;

    let restarted = sync_server::RoomManager::new(
        fixture.store.clone(),
        RoomConfig::default(),
        std::sync::Arc::new(sync_server::Metrics::default()),
    );
    assert_eq!(
        restarted.durable_fingerprint(GRAPH).await.unwrap(),
        client.fingerprint().unwrap()
    );
}
