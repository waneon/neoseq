mod support;

use domain::GraphId;
use neoseq_server::{GraphStore, RoomConfig};
use support::*;
use sync_protocol::{Limits, WelcomePayload};

#[tokio::test]
async fn replica_without_server_base_is_forced_onto_the_authoritative_checkpoint() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let opened = fixture
        .manager
        .open_with_base_status(
            &graph_id,
            "unbased-client",
            OWNER,
            0,
            &fixture.base_version,
            false,
        )
        .await
        .unwrap();

    let checkpoint = match &opened.welcome.payload {
        WelcomePayload::ReplaceInline { checkpoint } => checkpoint,
        payload => panic!("expected inline replacement, got {payload:?}"),
    };
    let restored = graph_core::GraphCore::from_snapshot(graph_id.clone(), 9, checkpoint).unwrap();
    let expected = graph_core::GraphCore::from_snapshot(graph_id, 10, &fixture.snapshot).unwrap();
    assert_eq!(
        expected.fingerprint().unwrap(),
        restored.fingerprint().unwrap()
    );
}

#[tokio::test]
async fn duplicate_and_reordered_updates_converge_after_room_eviction() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let (mut client_a, update_a) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    let (mut client_b, update_b) =
        client_update(&fixture.snapshot, 3, "create-b", "message-b", "page-b", "B");
    let mut a = fixture
        .manager
        .open(&graph_id, "a", OWNER, 0, &fixture.base_version)
        .await
        .unwrap()
        .connection;
    let mut a_rx = a.take_outbound();
    let mut b = fixture
        .manager
        .open(&graph_id, "b", PEER, 0, &fixture.base_version)
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
    assert_eq!(fixture.store.update_count(&graph_id), 2);

    let expected = client_a.fingerprint().unwrap();
    assert_eq!(expected, client_b.fingerprint().unwrap());

    // A client that missed every live broadcast reconciles from its Loro
    // version vector; transport cursors are not used as CRDT truth.
    let reconnect = fixture
        .manager
        .open(&graph_id, "reconnect", OWNER, 0, &fixture.base_version)
        .await
        .unwrap();
    let mut client_c =
        graph_core::GraphCore::from_snapshot(graph_id.clone(), 4, &fixture.snapshot).unwrap();
    match &reconnect.welcome.payload {
        WelcomePayload::Delta { update } => client_c.import_remote(update).unwrap(),
        WelcomePayload::ReplaceInline { checkpoint } => {
            client_c =
                graph_core::GraphCore::from_snapshot(graph_id.clone(), 4, checkpoint).unwrap();
        }
        WelcomePayload::ReplaceDownload {} => panic!("small test checkpoint must remain inline"),
    }
    assert_eq!(expected, client_c.fingerprint().unwrap());

    fixture.manager.evict(&graph_id).await;
    assert_eq!(
        expected,
        room_fingerprint(&fixture.manager, &graph_id, OWNER).await
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
    let graph_id = GraphId::new(GRAPH).unwrap();
    let (client, update) =
        client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    fixture
        .store
        .commit_update(&graph_id, OWNER, &update.message_id, &update.bytes)
        .await
        .unwrap();
    let opened = fixture
        .manager
        .open(
            &graph_id,
            "checkpoint-client",
            OWNER,
            0,
            &fixture.base_version,
        )
        .await
        .unwrap();
    let checkpoint = match &opened.welcome.payload {
        WelcomePayload::ReplaceInline { checkpoint } => checkpoint,
        payload => panic!("expected inline replacement, got {payload:?}"),
    };
    let reconnect = graph_core::GraphCore::from_snapshot(graph_id, 3, checkpoint).unwrap();
    assert_eq!(
        client.fingerprint().unwrap(),
        reconnect.fingerprint().unwrap()
    );
}

#[tokio::test]
async fn history_epoch_rotation_keeps_one_fallback_generation_before_reclaim() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
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
        .commit_update(&graph_id, OWNER, &update.message_id, &update.bytes)
        .await
        .unwrap();
    let checkpoint = client.export_gc_checkpoint().unwrap();
    let epoch = fixture
        .store
        .install_checkpoint(
            &graph_id,
            0,
            committed.cursor,
            graph_core::SCHEMA_VERSION,
            &checkpoint,
            &client.version_vector(),
        )
        .await
        .unwrap();
    assert_eq!(epoch, 1);
    assert_eq!(fixture.store.checkpoint_count(&graph_id), 2);
    assert_eq!(fixture.store.update_count(&graph_id), 1);

    let epoch = fixture
        .store
        .install_checkpoint(
            &graph_id,
            1,
            committed.cursor,
            graph_core::SCHEMA_VERSION,
            &checkpoint,
            &client.version_vector(),
        )
        .await
        .unwrap();
    assert_eq!(epoch, 2);
    assert_eq!(fixture.store.checkpoint_count(&graph_id), 2);
    assert_eq!(fixture.store.update_count(&graph_id), 0);

    let duplicate = fixture
        .store
        .commit_update(&graph_id, OWNER, &update.message_id, &update.bytes)
        .await
        .unwrap();
    assert_eq!(duplicate.cursor, committed.cursor);
    assert!(!duplicate.inserted);

    let mut opened = fixture
        .manager
        .open(&graph_id, "stale-client", OWNER, 0, &fixture.base_version)
        .await
        .unwrap();
    assert_eq!(opened.welcome.history_epoch, 2);
    let checkpoint = match &opened.welcome.payload {
        WelcomePayload::ReplaceInline { checkpoint } => checkpoint,
        payload => panic!("expected inline replacement, got {payload:?}"),
    };
    let mut stale = update;
    stale.history_epoch = 0;
    assert!(matches!(
        fixture
            .manager
            .submit_update(&opened.connection, stale)
            .await,
        Err(neoseq_server::RoomError::StaleHistory)
    ));
    let restored = graph_core::GraphCore::from_snapshot(graph_id, 3, checkpoint).unwrap();
    assert_eq!(
        client.fingerprint().unwrap(),
        restored.fingerprint().unwrap()
    );
    let _ = opened.connection.take_outbound();
}
