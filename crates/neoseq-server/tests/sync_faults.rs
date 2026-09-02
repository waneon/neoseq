mod support;

use domain::GraphId;
use neoseq_server::{GraphStore, RoomConfig, RoomError, StoreError};
use support::memory_store::FaultPoint;
use support::*;
use sync_protocol::{Limits, Message};

#[tokio::test]
async fn no_ack_or_fanout_before_commit_and_retry_converges() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let mut owner = fixture
        .manager
        .open(&graph_id, "owner-1", OWNER, 0, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut owner_rx = owner.take_outbound();
    let mut peer = fixture
        .manager
        .open(&graph_id, "peer-1", PEER, 0, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut peer_rx = peer.take_outbound();

    fixture.store.inject_once(FaultPoint::BeforeCommit);
    assert!(matches!(
        fixture.manager.submit_update(&owner, update.clone()).await,
        Err(RoomError::Store(StoreError::Unavailable(_)))
    ));
    assert_eq!(fixture.store.update_count(&graph_id), 0);
    assert_no_ack_or_update(&mut owner_rx).await;
    assert_no_ack_or_update(&mut peer_rx).await;

    let mut retry = fixture
        .manager
        .open(&graph_id, "owner-retry", OWNER, 0, &client.version_vector())
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
    assert_eq!(fixture.store.update_count(&graph_id), 1);
    assert_eq!(
        room_fingerprint(&fixture.manager, &graph_id, OWNER).await,
        client.fingerprint().unwrap()
    );
}

#[tokio::test]
async fn ambiguous_post_commit_failure_is_durable_but_never_acknowledged_early() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let mut opened = fixture
        .manager
        .open(&graph_id, "owner-1", OWNER, 0, &fixture.base_version)
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
    assert_eq!(fixture.store.update_count(&graph_id), 1);
    assert_no_ack_or_update(&mut receiver).await;

    let mut retry = fixture
        .manager
        .open(&graph_id, "owner-retry", OWNER, 0, &client.version_vector())
        .await
        .unwrap()
        .connection;
    let mut retry_rx = retry.take_outbound();
    fixture.manager.submit_update(&retry, update).await.unwrap();
    assert_ack(&mut retry_rx, "message-a").await;
    assert_eq!(fixture.store.update_count(&graph_id), 1);
    assert_eq!(
        room_fingerprint(&fixture.manager, &graph_id, OWNER).await,
        client.fingerprint().unwrap()
    );
}

#[tokio::test]
async fn durable_duplicate_discards_the_unadopted_candidate() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let base_fingerprint =
        graph_core::GraphCore::from_snapshot(graph_id.clone(), 90, &fixture.snapshot)
            .unwrap()
            .fingerprint()
            .unwrap();
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let mut opened = fixture
        .manager
        .open(&graph_id, "owner-1", OWNER, 0, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut receiver = opened.take_outbound();

    // Simulate another process durably receiving the update while this
    // disposable room still holds the preceding baseline. The retry prepares
    // an advanced candidate, but the duplicate outcome must not adopt it.
    let committed = fixture
        .store
        .commit_update(&graph_id, OWNER, &update.message_id, &update.bytes)
        .await
        .unwrap();
    assert!(committed.inserted);
    fixture
        .manager
        .submit_update(&opened, update)
        .await
        .unwrap();
    assert_ack(&mut receiver, "message-a").await;
    assert_eq!(fixture.store.update_count(&graph_id), 1);

    let live = fixture
        .manager
        .export_checkpoint(&graph_id, OWNER)
        .await
        .unwrap();
    let live_fingerprint = graph_core::GraphCore::from_snapshot(graph_id.clone(), 91, &live.bytes)
        .unwrap()
        .fingerprint()
        .unwrap();
    assert_eq!(live_fingerprint, base_fingerprint);
    assert_ne!(live_fingerprint, client.fingerprint().unwrap());

    // Reconstructing from durable state does include the committed update.
    assert_eq!(
        room_fingerprint(&fixture.manager, &graph_id, OWNER).await,
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
    let graph_id = GraphId::new(GRAPH).unwrap();
    let (_, first) = client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let (_, second) = client_update(&fixture.snapshot, 3, "create-b", "message-b", "page-b", "B");
    let mut fast = fixture
        .manager
        .open(&graph_id, "fast", OWNER, 0, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut fast_rx = fast.take_outbound();
    let mut slow = fixture
        .manager
        .open(&graph_id, "slow", PEER, 0, &fixture.base_version)
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
    let graph_id = GraphId::new(GRAPH).unwrap();
    let (_, update) = client_update(&fixture.snapshot, 3, "create-b", "message-b", "page-b", "B");
    let opened = fixture
        .manager
        .open(&graph_id, "peer", PEER, 0, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    fixture.store.revoke(&graph_id, PEER);
    assert!(matches!(
        fixture.manager.recheck(&opened).await,
        Err(RoomError::Store(StoreError::AccessDenied))
    ));
    assert!(matches!(
        fixture.manager.submit_update(&opened, update).await,
        Err(RoomError::Store(StoreError::AccessDenied))
    ));
    assert_eq!(fixture.store.update_count(&graph_id), 0);
}

#[tokio::test]
async fn unauthorized_and_unknown_graphs_have_the_same_error_shape() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let unknown_graph_id = GraphId::new("unknown-graph").unwrap();
    let existing = fixture
        .manager
        .open(
            &graph_id,
            "intruder-existing",
            "principal-intruder",
            0,
            &fixture.base_version,
        )
        .await
        .err()
        .unwrap();
    let unknown = fixture
        .manager
        .open(
            &unknown_graph_id,
            "intruder-unknown",
            "principal-intruder",
            0,
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
    let graph_id = GraphId::new(GRAPH).unwrap();
    let mut opened = fixture
        .manager
        .open(&graph_id, "owner", OWNER, 0, &fixture.base_version)
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
    assert_eq!(fixture.store.update_count(&graph_id), 0);
}

#[tokio::test]
async fn reconstructed_document_limit_rejects_expansion_before_commit() {
    let graph_id = GraphId::new(GRAPH).unwrap();
    let base = graph_core::GraphCore::new(graph_id.clone(), 1, "base").unwrap();
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
        .open(&graph_id, "owner-limit", OWNER, 0, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let _receiver = opened.take_outbound();
    assert!(matches!(
        fixture.manager.submit_update(&opened, update).await,
        Err(RoomError::Store(StoreError::QuotaExceeded))
    ));
    assert_eq!(fixture.store.update_count(&graph_id), 0);
}

#[tokio::test]
async fn reused_message_id_with_different_bytes_is_rejected() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
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
        .open(&graph_id, "owner", OWNER, 0, &fixture.base_version)
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
    assert_eq!(fixture.store.update_count(&graph_id), 1);
}

#[tokio::test]
async fn new_server_manager_reconstructs_all_acknowledged_updates() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let mut opened = fixture
        .manager
        .open(&graph_id, "owner", OWNER, 0, &fixture.base_version)
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

    let restarted = neoseq_server::RoomManager::new(
        fixture.store.clone(),
        RoomConfig::default(),
        std::sync::Arc::new(neoseq_server::Metrics::default()),
    );
    assert_eq!(
        room_fingerprint(&restarted, &graph_id, OWNER).await,
        client.fingerprint().unwrap()
    );
}
