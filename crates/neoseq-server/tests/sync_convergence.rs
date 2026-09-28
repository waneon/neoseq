mod support;

use domain::GraphId;
use neoseq_server::{CommitOutcome, GraphStore, RoomConfig};
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
    let (mut client_a, update_a) = client_update(&fixture.snapshot, 2, "create-a", "page-a", "A");
    let (mut client_b, update_b) = client_update(&fixture.snapshot, 3, "create-b", "page-b", "B");
    let update_a_id = update_a.message_id.clone();
    let update_b_id = update_b.message_id.clone();
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
    assert_ack(&mut b_rx, &update_b_id).await;
    let received_b = assert_update(&mut a_rx, &update_b_id).await;
    client_a.import_remote(&received_b.bytes).unwrap();

    fixture
        .manager
        .submit_update(&a, update_a.clone())
        .await
        .unwrap();
    assert_ack(&mut a_rx, &update_a_id).await;
    let received_a = assert_update(&mut b_rx, &update_a_id).await;
    client_b.import_remote(&received_a.bytes).unwrap();

    // Idempotent retry gets the original durable cursor and is not fanned out.
    fixture.manager.submit_update(&a, update_a).await.unwrap();
    assert_ack(&mut a_rx, &update_a_id).await;
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
        WelcomePayload::ReplaceDownload {} | WelcomePayload::MergeDownload {} => {
            panic!("small test checkpoint must remain inline")
        }
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
    let (client, update) = client_update(&fixture.snapshot, 2, "create-a", "page-a", "A");
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
    assert!(matches!(
        opened.welcome.payload,
        WelcomePayload::MergeDownload {}
    ));
    let downloaded = fixture
        .manager
        .export_checkpoint(&graph_id, OWNER)
        .await
        .unwrap();
    let (mut reconnect, offline) =
        client_update(&fixture.snapshot, 3, "offline", "offline-page", "Offline");
    reconnect.import_remote(&downloaded.bytes).unwrap();
    let mut expected = client;
    expected.import_remote(&offline.bytes).unwrap();
    assert_eq!(
        expected.fingerprint().unwrap(),
        reconnect.fingerprint().unwrap()
    );
}

#[tokio::test]
async fn checkpoint_compaction_preserves_epoch_and_one_fallback_generation() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let (client, update) = client_update(&fixture.snapshot, 2, "rotate", "page-a", "A");
    let committed = fixture
        .store
        .commit_update(&graph_id, OWNER, &update.message_id, &update.bytes)
        .await
        .unwrap();
    let checkpoint = client.export_snapshot().unwrap();
    fixture
        .store
        .compact_checkpoint(
            &graph_id,
            0,
            committed.cursor(),
            graph_core::SCHEMA_VERSION,
            &checkpoint,
            &client.version_vector(),
        )
        .await
        .unwrap();
    assert_eq!(fixture.store.checkpoint_count(&graph_id), 2);
    assert_eq!(fixture.store.update_count(&graph_id), 1);

    fixture
        .store
        .compact_checkpoint(
            &graph_id,
            0,
            committed.cursor(),
            graph_core::SCHEMA_VERSION,
            &checkpoint,
            &client.version_vector(),
        )
        .await
        .unwrap();
    assert_eq!(fixture.store.checkpoint_count(&graph_id), 2);
    assert_eq!(fixture.store.update_count(&graph_id), 0);

    let duplicate = fixture
        .store
        .commit_update(&graph_id, OWNER, &update.message_id, &update.bytes)
        .await
        .unwrap();
    assert_eq!(
        duplicate,
        CommitOutcome::Duplicate {
            cursor: committed.cursor()
        }
    );

    let mut opened = fixture
        .manager
        .open(&graph_id, "stale-client", OWNER, 0, &fixture.base_version)
        .await
        .unwrap();
    assert_eq!(opened.welcome.history_epoch, 0);
    let update = match &opened.welcome.payload {
        WelcomePayload::Delta { update } => update,
        payload => panic!("expected delta after storage compaction, got {payload:?}"),
    };
    let mut restored =
        graph_core::GraphCore::from_snapshot(graph_id, 3, &fixture.snapshot).unwrap();
    restored.import_remote(update).unwrap();
    assert_eq!(
        client.fingerprint().unwrap(),
        restored.fingerprint().unwrap()
    );
    let _ = opened.connection.take_outbound();
}

#[tokio::test]
async fn repeated_compaction_keeps_sessions_and_offline_history_mergeable() {
    use domain::{Command, CommandEnvelope, CommandId, PageId};
    use sync_protocol::{ContentId, Update};
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let (mut writer, first) = client_update(&fixture.snapshot, 2, "first", "page", "Start");
    let (mut offline, offline_update) =
        client_update(&fixture.snapshot, 3, "offline", "offline", "Offline");
    let mut opened = fixture
        .manager
        .open(&graph_id, "writer", OWNER, 0, &fixture.base_version)
        .await
        .unwrap();
    let mut rx = opened.connection.take_outbound();
    fixture
        .manager
        .submit_update(&opened.connection, first.clone())
        .await
        .unwrap();
    assert_ack(&mut rx, &first.message_id).await;
    for index in 0..520 {
        let base_version_vector = writer.version_vector();
        let bytes = writer
            .execute(
                CommandEnvelope {
                    graph_id: graph_id.clone(),
                    command_id: CommandId::new(format!("rename-{index}")).unwrap(),
                    command: Command::RenamePage {
                        page_id: PageId::new("page").unwrap(),
                        title: format!("Title {index}"),
                    },
                },
                "edit",
            )
            .unwrap()
            .update;
        let update = Update {
            history_epoch: 0,
            message_id: ContentId::for_bytes(&bytes),
            base_version_vector,
            bytes,
        };
        fixture
            .manager
            .submit_update(&opened.connection, update.clone())
            .await
            .unwrap();
        // The same session still receives only durable ACKs across two compactions.
        assert_ack(&mut rx, &update.message_id).await;
    }
    let stored = fixture.store.load_graph(&graph_id).await.unwrap();
    assert_eq!(stored.history_epoch, 0);
    assert_eq!(stored.updates.len(), 9);
    assert_eq!(fixture.store.checkpoint_count(&graph_id), 2);
    fixture
        .manager
        .submit_update(&opened.connection, offline_update.clone())
        .await
        .unwrap();
    assert_ack(&mut rx, &offline_update.message_id).await;
    writer.import_remote(&offline_update.bytes).unwrap();
    fixture.manager.disconnect(&opened.connection).await;
    fixture.manager.evict(&graph_id).await;
    let rejoined = fixture
        .manager
        .open(&graph_id, "offline", OWNER, 0, &offline.version_vector())
        .await
        .unwrap();
    let WelcomePayload::Delta { update } = rejoined.welcome.payload else {
        panic!("compaction must preserve delta sync")
    };
    offline.import_remote(&update).unwrap();
    assert_eq!(
        writer.fingerprint().unwrap(),
        offline.fingerprint().unwrap()
    );
}
