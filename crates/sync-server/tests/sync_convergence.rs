mod support;

use support::*;
use sync_protocol::Limits;
use sync_server::{GraphStore, RoomConfig};

#[tokio::test]
async fn duplicate_and_reordered_updates_converge_after_room_eviction() {
    let fixture = fixture(RoomConfig::default());
    let (mut client_a, update_a) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let (mut client_b, update_b) =
        client_update(&fixture.snapshot, 3, "create-b", "message-b", "page-b", "B");
    let mut a = fixture
        .manager
        .open(GRAPH, "a", OWNER, 0, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut a_rx = a.take_outbound();
    let mut b = fixture
        .manager
        .open(GRAPH, "b", PEER, 0, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut b_rx = b.take_outbound();

    // Server receipt order is deliberately opposite the client creation order.
    fixture
        .manager
        .submit_update(&b, update_b.clone())
        .await
        .unwrap();
    assert_ack(&mut b_rx, "message-b").await;
    let received_b = assert_update(&mut a_rx, "message-b").await;
    client_a.import_remote(&received_b.bytes).unwrap();

    fixture
        .manager
        .submit_update(&a, update_a.clone())
        .await
        .unwrap();
    assert_ack(&mut a_rx, "message-a").await;
    let received_a = assert_update(&mut b_rx, "message-a").await;
    client_b.import_remote(&received_a.bytes).unwrap();

    // Idempotent retry gets the original durable cursor and is not fanned out.
    fixture.manager.submit_update(&a, update_a).await.unwrap();
    assert_ack(&mut a_rx, "message-a").await;
    assert!(receive(&mut b_rx).await.is_none());
    assert_eq!(fixture.store.update_count(GRAPH), 2);

    let expected = client_a.fingerprint().unwrap();
    assert_eq!(expected, client_b.fingerprint().unwrap());

    // A client that missed every live broadcast reconciles from its Loro
    // version vector; transport cursors are not used as CRDT truth.
    let reconnect = fixture
        .manager
        .open(GRAPH, "reconnect", OWNER, 0, &fixture.base_version)
        .await
        .unwrap();
    let mut client_c = graph_core::GraphCore::from_snapshot(
        domain::GraphId::new(GRAPH).unwrap(),
        4,
        &fixture.snapshot,
    )
    .unwrap();
    if reconnect.welcome.checkpoint.is_empty() {
        client_c
            .import_remote(&reconnect.welcome.missing_update)
            .unwrap();
    } else {
        assert!(reconnect.welcome.replace_checkpoint);
        client_c = graph_core::GraphCore::from_snapshot(
            domain::GraphId::new(GRAPH).unwrap(),
            4,
            &reconnect.welcome.checkpoint,
        )
        .unwrap();
    }
    assert_eq!(expected, client_c.fingerprint().unwrap());

    fixture.manager.evict(GRAPH).await;
    assert_eq!(
        expected,
        room_fingerprint(&fixture.manager, GRAPH, OWNER).await
    );
}

#[tokio::test]
async fn reconnect_receives_checkpoint_when_incremental_delta_exceeds_limit() {
    let config = RoomConfig {
        limits: Limits {
            max_update_bytes: 1,
            ..Limits::default()
        },
        ..RoomConfig::default()
    };
    let fixture = fixture(config);
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    fixture
        .store
        .commit_update(GRAPH, OWNER, &update.message_id, &update.bytes)
        .await
        .unwrap();
    let opened = fixture
        .manager
        .open(GRAPH, "checkpoint-client", OWNER, 0, &fixture.base_version)
        .await
        .unwrap();
    assert!(opened.welcome.missing_update.is_empty());
    assert!(!opened.welcome.checkpoint.is_empty());
    assert!(opened.welcome.replace_checkpoint);
    let reconnect = graph_core::GraphCore::from_snapshot(
        domain::GraphId::new(GRAPH).unwrap(),
        3,
        &opened.welcome.checkpoint,
    )
    .unwrap();
    assert_eq!(
        client.fingerprint().unwrap(),
        reconnect.fingerprint().unwrap()
    );
}

#[tokio::test]
async fn history_epoch_rotation_keeps_one_fallback_generation_before_reclaim() {
    let fixture = fixture(RoomConfig::default());
    let (client, update) = client_update(
        &fixture.snapshot,
        2,
        "rotate",
        "rotate-message",
        "page-a",
        "A",
    );
    let committed = fixture
        .store
        .commit_update(GRAPH, OWNER, &update.message_id, &update.bytes)
        .await
        .unwrap();
    let checkpoint = client.export_gc_checkpoint().unwrap();
    let epoch = fixture
        .store
        .install_checkpoint(
            GRAPH,
            0,
            committed.cursor,
            graph_core::SCHEMA_VERSION,
            &checkpoint,
            &client.version_vector(),
        )
        .await
        .unwrap();
    assert_eq!(epoch, 1);
    assert_eq!(fixture.store.checkpoint_count(GRAPH), 2);
    assert_eq!(fixture.store.update_count(GRAPH), 1);

    let epoch = fixture
        .store
        .install_checkpoint(
            GRAPH,
            1,
            committed.cursor,
            graph_core::SCHEMA_VERSION,
            &checkpoint,
            &client.version_vector(),
        )
        .await
        .unwrap();
    assert_eq!(epoch, 2);
    assert_eq!(fixture.store.checkpoint_count(GRAPH), 2);
    assert_eq!(fixture.store.update_count(GRAPH), 0);

    let duplicate = fixture
        .store
        .commit_update(GRAPH, OWNER, &update.message_id, &update.bytes)
        .await
        .unwrap();
    assert_eq!(duplicate.cursor, committed.cursor);
    assert!(!duplicate.inserted);

    let mut opened = fixture
        .manager
        .open(GRAPH, "stale-client", OWNER, 0, &fixture.base_version)
        .await
        .unwrap();
    assert_eq!(opened.welcome.history_epoch, 2);
    assert!(opened.welcome.replace_checkpoint);
    let mut stale = update;
    stale.history_epoch = 0;
    assert!(matches!(
        fixture
            .manager
            .submit_update(&opened.connection, stale)
            .await,
        Err(sync_server::RoomError::StaleHistory)
    ));
    let restored = graph_core::GraphCore::from_snapshot(
        domain::GraphId::new(GRAPH).unwrap(),
        3,
        &opened.welcome.checkpoint,
    )
    .unwrap();
    assert_eq!(
        client.fingerprint().unwrap(),
        restored.fingerprint().unwrap()
    );
    let _ = opened.connection.take_outbound();
}
