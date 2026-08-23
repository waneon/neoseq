use crate::{FaultPoint, SqliteGraphRepository, SqliteRepositoryError};
use domain::{Command, CommandEnvelope, CommandId, GraphId, PageId};
use graph_core::{
    GraphCore, GraphLocator, GraphRepository, GraphRuntime, InMemoryClock, LocalGraphRepository,
    recover_graph,
};
use std::path::{Path, PathBuf};

struct TempDb(PathBuf);

impl TempDb {
    fn new(name: &str) -> Self {
        Self(std::env::temp_dir().join(format!(
            "neoseq-step3-{name}-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-shm", "-wal"] {
            let _ = std::fs::remove_file(format!("{}{}", self.0.display(), suffix));
        }
    }
}

fn envelope(graph: &GraphId, command_id: &str, command: Command) -> CommandEnvelope {
    CommandEnvelope {
        graph_id: graph.clone(),
        command_id: CommandId::new(command_id).unwrap(),
        command,
    }
}

fn open(
    path: &Path,
    graph: &GraphId,
    peer: u64,
) -> (
    GraphRuntime<SqliteGraphRepository, InMemoryClock>,
    graph_core::RecoveryReport,
) {
    let mut repository = SqliteGraphRepository::open(
        path,
        GraphLocator::local(graph.clone()),
        "2026-08-03T12:00:00Z",
        peer,
    )
    .unwrap();
    let (core, report) =
        recover_graph(&mut repository, graph.clone(), "2026-08-03T12:00:01Z").unwrap();
    if repository.checkpoints_descending().unwrap().is_empty() {
        repository
            .install_checkpoint(
                &core.export_gc_checkpoint().unwrap(),
                0,
                "2026-08-03T12:00:02Z",
            )
            .unwrap();
    }
    (
        GraphRuntime::from_core(core, repository, InMemoryClock::new("native-step3"), 32).unwrap(),
        report,
    )
}

fn ensure_page(runtime: &mut GraphRuntime<SqliteGraphRepository, InMemoryClock>, graph: &GraphId) {
    runtime
        .execute(envelope(
            graph,
            "ensure-home",
            Command::EnsurePage {
                page_id: PageId::new("home").unwrap(),
                title: "Home".to_owned(),
            },
        ))
        .unwrap();
}

#[test]
fn persistence_sqlite_conformance_reopens_checkpoint_and_tail() {
    let database = TempDb::new("conformance");
    let graph = GraphId::new("persistence-conformance").unwrap();
    let (mut runtime, _) = open(database.path(), &graph, 31);
    ensure_page(&mut runtime, &graph);
    runtime
        .execute(envelope(
            &graph,
            "ensure-notes",
            Command::EnsurePage {
                page_id: PageId::new("notes").unwrap(),
                title: "Notes".to_owned(),
            },
        ))
        .unwrap();
    let checkpoint = runtime.core().export_snapshot().unwrap();
    let checkpoint_sequence = runtime.repository_mut().metadata().unwrap().next_sequence - 1;
    runtime
        .repository_mut()
        .install_checkpoint(&checkpoint, checkpoint_sequence, "2026-08-03T12:01:00Z")
        .unwrap();
    runtime
        .execute(envelope(
            &graph,
            "rename-home",
            Command::RenamePage {
                page_id: PageId::new("home").unwrap(),
                title: "Home after checkpoint".to_owned(),
            },
        ))
        .unwrap();
    let expected = runtime.core().fingerprint().unwrap();
    assert_eq!(runtime.repository().journal_mode().unwrap(), "wal");
    assert_eq!(runtime.repository().schema_version().unwrap(), 2);
    drop(runtime);

    let (mut restored, report) = open(database.path(), &graph, 32);
    assert_eq!(report.checkpoint_sequence, checkpoint_sequence);
    assert_eq!(report.replayed_updates, 1);
    assert_eq!(restored.core().fingerprint().unwrap(), expected);
    assert_eq!(
        restored
            .repository_mut()
            .metadata()
            .unwrap()
            .compacted_through,
        checkpoint_sequence
    );
}

#[test]
fn persistence_acknowledged_tail_survives_abrupt_runtime_drop() {
    let database = TempDb::new("kill-after-append");
    let graph = GraphId::new("kill-after-append").unwrap();
    let (mut runtime, _) = open(database.path(), &graph, 41);
    ensure_page(&mut runtime, &graph);
    let expected = runtime.core().fingerprint().unwrap();
    drop(runtime);

    let (restored, report) = open(database.path(), &graph, 42);
    assert_eq!(report.replayed_updates, 1);
    assert_eq!(restored.core().fingerprint().unwrap(), expected);
}

#[test]
fn checkpoint_rotation_keeps_one_fallback_generation_then_reclaims_it() {
    let database = TempDb::new("checkpoint-generations");
    let graph = GraphId::new("checkpoint-generations").unwrap();
    let (mut runtime, _) = open(database.path(), &graph, 43);
    ensure_page(&mut runtime, &graph);
    let first = runtime.core().export_gc_checkpoint().unwrap();
    runtime
        .repository_mut()
        .install_checkpoint(&first, 1, "2026-08-03T12:01:00Z")
        .unwrap();
    assert_eq!(runtime.repository().checkpoint_count().unwrap(), 2);
    assert_eq!(runtime.repository().update_count().unwrap(), 1);

    runtime
        .execute(envelope(
            &graph,
            "second-generation",
            Command::RenamePage {
                page_id: PageId::new("home").unwrap(),
                title: "Second generation".to_owned(),
            },
        ))
        .unwrap();
    let second = runtime.core().export_gc_checkpoint().unwrap();
    runtime
        .repository_mut()
        .install_checkpoint(&second, 2, "2026-08-03T12:02:00Z")
        .unwrap();
    assert_eq!(runtime.repository().checkpoint_count().unwrap(), 2);
    assert_eq!(runtime.repository().update_count().unwrap(), 1);
    assert_eq!(
        runtime.repository_mut().updates_after(0).unwrap()[0].local_sequence,
        2
    );
    assert!(matches!(
        runtime
            .repository_mut()
            .install_checkpoint(&first, 1, "2026-08-03T12:03:00Z"),
        Err(SqliteRepositoryError::Corrupt(_))
    ));
    assert_eq!(runtime.repository().checkpoint_count().unwrap(), 2);
    assert_eq!(runtime.repository().update_count().unwrap(), 1);
}

#[test]
fn recovery_starts_a_fresh_undo_session_before_new_durable_edits() {
    let database = TempDb::new("reopen-undo-boundary");
    let graph = GraphId::new("reopen-undo-boundary").unwrap();
    let (mut writer, _) = open(database.path(), &graph, 46);
    ensure_page(&mut writer, &graph);
    drop(writer);

    let (mut reopened, report) = open(database.path(), &graph, 47);
    assert_eq!(report.replayed_updates, 1);
    reopened
        .execute(envelope(
            &graph,
            "transient-after-reopen",
            Command::RenamePage {
                page_id: PageId::new("home").unwrap(),
                title: "Transient".to_owned(),
            },
        ))
        .unwrap();
    let first_session_undo = reopened
        .execute(envelope(&graph, "first-session-undo", Command::Undo))
        .unwrap();
    assert!(first_session_undo.changed);
    assert_eq!(reopened.core().summary().unwrap().pages[0].title, "Home");
    reopened
        .execute(envelope(
            &graph,
            "after-reopen",
            Command::RenamePage {
                page_id: PageId::new("home").unwrap(),
                title: "After reopen".to_owned(),
            },
        ))
        .unwrap();
    drop(reopened);

    let (mut durable, report) = open(database.path(), &graph, 48);
    assert_eq!(report.replayed_updates, 4);
    assert_eq!(
        durable.core().summary().unwrap().pages[0].title,
        "After reopen"
    );
    let old_session = durable
        .execute(envelope(&graph, "old-session-undo", Command::Undo))
        .unwrap();
    assert!(!old_session.changed);
    durable
        .execute(envelope(
            &graph,
            "current-session",
            Command::RenamePage {
                page_id: PageId::new("home").unwrap(),
                title: "Current session".to_owned(),
            },
        ))
        .unwrap();
    let current_session = durable
        .execute(envelope(&graph, "current-session-undo", Command::Undo))
        .unwrap();
    assert!(current_session.changed);
    assert_eq!(
        durable.core().summary().unwrap().pages[0].title,
        "After reopen"
    );
}

#[test]
fn persistence_append_faults_preserve_dirty_bytes_and_after_commit_is_idempotent() {
    let database = TempDb::new("append-faults");
    let graph = GraphId::new("append-faults").unwrap();
    let (mut runtime, _) = open(database.path(), &graph, 51);
    runtime
        .repository_mut()
        .inject_once(FaultPoint::AppendBeforeCommit);
    assert!(
        runtime
            .execute(envelope(
                &graph,
                "before-failure",
                Command::EnsurePage {
                    page_id: PageId::new("before").unwrap(),
                    title: "Before".to_owned(),
                },
            ))
            .is_err()
    );
    assert!(runtime.is_dirty_unsaved());
    assert_eq!(runtime.repository().update_count().unwrap(), 0);
    runtime.retry_pending().unwrap();
    assert_eq!(runtime.repository().update_count().unwrap(), 1);

    runtime
        .repository_mut()
        .inject_once(FaultPoint::AppendAfterCommit);
    assert!(
        runtime
            .execute(envelope(
                &graph,
                "after-failure",
                Command::EnsurePage {
                    page_id: PageId::new("after").unwrap(),
                    title: "After".to_owned(),
                },
            ))
            .is_err()
    );
    assert!(runtime.is_dirty_unsaved());
    assert_eq!(runtime.repository().update_count().unwrap(), 2);
    runtime.retry_pending().unwrap();
    assert_eq!(runtime.repository().update_count().unwrap(), 2);
}

#[test]
fn recovery_corrupt_tail_is_quarantined_and_graph_remains_writable() {
    let database = TempDb::new("corrupt-tail");
    let graph = GraphId::new("corrupt-tail").unwrap();
    let (mut runtime, _) = open(database.path(), &graph, 61);
    ensure_page(&mut runtime, &graph);
    let checkpoint = runtime.core().export_snapshot().unwrap();
    runtime
        .repository_mut()
        .install_checkpoint(&checkpoint, 1, "2026-08-03T12:02:00Z")
        .unwrap();
    let checkpoint_hash = runtime.core().fingerprint().unwrap();
    runtime
        .execute(envelope(
            &graph,
            "corrupt-me",
            Command::RenamePage {
                page_id: PageId::new("home").unwrap(),
                title: "This tail will be corrupt".to_owned(),
            },
        ))
        .unwrap();
    runtime.repository_mut().truncate_update(2).unwrap();
    drop(runtime);

    let (mut restored, report) = open(database.path(), &graph, 62);
    assert_eq!(restored.core().fingerprint().unwrap(), checkpoint_hash);
    assert_eq!(report.quarantined_records, vec!["update-2"]);
    let quarantined = restored.repository_mut().quarantined().unwrap();
    assert_eq!(quarantined.len(), 1);
    assert!(!quarantined[0].bytes.is_empty());
    assert_eq!(quarantined[0].reason, "update-checksum-mismatch");
    restored
        .execute(envelope(
            &graph,
            "after-recovery",
            Command::EnsurePage {
                page_id: PageId::new("usable").unwrap(),
                title: "Still usable".to_owned(),
            },
        ))
        .unwrap();
    let repaired_fingerprint = restored.core().fingerprint().unwrap();
    drop(restored);

    let (reopened, second_report) = open(database.path(), &graph, 63);
    assert!(second_report.quarantined_records.is_empty());
    assert_eq!(second_report.replayed_updates, 1);
    assert_eq!(reopened.core().fingerprint().unwrap(), repaired_fingerprint);
}

#[test]
fn recovery_quarantines_a_causally_incomplete_tail() {
    let database = TempDb::new("missing-tail-dependency");
    let graph = GraphId::new("missing-tail-dependency").unwrap();
    let (mut runtime, _) = open(database.path(), &graph, 66);
    let checkpoint = runtime.repository_mut().checkpoints_descending().unwrap()[0]
        .bytes
        .clone();
    let replica_id = runtime.repository_mut().metadata().unwrap().replica_id;
    let mut producer = GraphCore::from_snapshot(graph.clone(), replica_id, &checkpoint).unwrap();
    producer
        .execute(
            envelope(
                &graph,
                "missing-page",
                Command::EnsurePage {
                    page_id: PageId::new("home").unwrap(),
                    title: "Home".to_owned(),
                },
            ),
            "t1",
        )
        .unwrap();
    let dependent = producer
        .execute(
            envelope(
                &graph,
                "dependent-rename",
                Command::RenamePage {
                    page_id: PageId::new("home").unwrap(),
                    title: "Missing dependency".to_owned(),
                },
            ),
            "t2",
        )
        .unwrap()
        .update;
    runtime
        .repository_mut()
        .append_update(&dependent, "2026-08-03T12:02:30Z")
        .unwrap();
    drop(runtime);

    let (mut restored, report) = open(database.path(), &graph, 67);
    assert!(restored.core().summary().unwrap().pages.is_empty());
    assert_eq!(report.quarantined_records, vec!["update-1"]);
    let quarantined = restored.repository_mut().quarantined().unwrap();
    assert_eq!(quarantined.len(), 1);
    assert!(
        quarantined[0]
            .reason
            .contains("missing causal dependencies")
    );
}

#[test]
fn recovery_checkpoint_and_storage_fault_matrix_is_typed() {
    let database = TempDb::new("fault-matrix");
    let graph = GraphId::new("fault-matrix").unwrap();
    let (mut runtime, _) = open(database.path(), &graph, 71);
    ensure_page(&mut runtime, &graph);
    let snapshot = runtime.core().export_snapshot().unwrap();

    runtime
        .repository_mut()
        .inject_once(FaultPoint::CheckpointBeforeCommit);
    assert!(
        runtime
            .repository_mut()
            .install_checkpoint(&snapshot, 1, "before")
            .is_err()
    );
    runtime
        .repository_mut()
        .inject_once(FaultPoint::CheckpointAfterCommit);
    assert!(
        runtime
            .repository_mut()
            .install_checkpoint(&snapshot, 1, "after")
            .is_err()
    );
    assert_eq!(
        runtime.repository_mut().checkpoints_descending().unwrap()[0].local_sequence,
        1
    );

    runtime.repository_mut().inject_once(FaultPoint::Busy);
    assert!(matches!(
        runtime.repository_mut().append_update(b"busy", "now"),
        Err(SqliteRepositoryError::Busy)
    ));
    runtime.repository_mut().inject_once(FaultPoint::DiskFull);
    assert!(matches!(
        runtime.repository_mut().append_update(b"full", "now"),
        Err(SqliteRepositoryError::DiskFull)
    ));
}

#[test]
fn persistence_explicit_delete_removes_only_the_target_graph() {
    let database = TempDb::new("delete");
    let first = GraphId::new("delete-first").unwrap();
    let second = GraphId::new("delete-second").unwrap();
    let (mut first_runtime, _) = open(database.path(), &first, 81);
    ensure_page(&mut first_runtime, &first);
    let (mut second_runtime, _) = open(database.path(), &second, 82);
    ensure_page(&mut second_runtime, &second);
    let (first_repository, _) = first_runtime.close().unwrap();
    first_repository.delete_local().unwrap();
    drop(second_runtime);

    let (restored, report) = open(database.path(), &second, 83);
    assert_eq!(report.replayed_updates, 1);
    assert_eq!(restored.read().unwrap().pages.len(), 1);
}
