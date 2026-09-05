use crate::{FaultPoint, NativeCorePort, SqliteGraphRepository};
use domain::{
    CORE_PORT_VERSION, CloseGraphRequest, Command, CommandEnvelope, CommandId, CorePortErrorCode,
    ExecuteRequest, GraphChanges, GraphId, GraphLocatorDto, OpenGraphRequest, OutlineOwner, PageId,
    QueryRequestDto, ReadOutlineRequest, ReadRequest, SaveStatusDto, SubscribeRequest,
};
use graph_core::{GraphLocator, SCHEMA_VERSION};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_DATABASE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

struct TempDb(PathBuf);

impl TempDb {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "neoseq-step3-core-port-{}-{}.sqlite",
            std::process::id(),
            TEMP_DATABASE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )))
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-shm", "-wal"] {
            let _ = std::fs::remove_file(format!("{}{}", self.0.display(), suffix));
        }
    }
}

fn open_request(graph: &str, peer_id: u64) -> OpenGraphRequest {
    OpenGraphRequest {
        contract_version: CORE_PORT_VERSION,
        locator: GraphLocatorDto {
            repository_id: "local".to_owned(),
            graph_id: graph.to_owned(),
        },
        peer_id,
    }
}

fn command(graph: &str, id: &str, page: &str) -> CommandEnvelope {
    CommandEnvelope {
        graph_id: GraphId::new(graph).unwrap(),
        command_id: CommandId::new(id).unwrap(),
        command: Command::EnsurePage {
            page_id: PageId::new(page).unwrap(),
            title: page.to_owned(),
        },
    }
}

#[test]
fn core_port_native_contract_suite_matches_current_golden() {
    let golden: Value =
        serde_json::from_str(include_str!("../../../fixtures/core-port/current.json")).unwrap();
    let schema: Value =
        serde_json::from_str(include_str!("../../../contracts/core-port.json")).unwrap();
    assert_eq!(golden["contract_version"], schema["contractVersion"]);
    assert_eq!(golden["operations"], schema["operations"]);
    assert_eq!(golden["error_codes"], schema["errorCodes"]);
    assert_eq!(golden["domain_payloads"], schema["domainPayloads"]);

    let database = TempDb::new();
    let mut port = NativeCorePort::new(&database.0, 8);
    let missing = port
        .read(ReadRequest {
            graph_handle: "missing".to_owned(),
        })
        .unwrap_err();
    assert_eq!(missing.code, CorePortErrorCode::GraphNotOpen);

    let mut unsupported = open_request("port-native", 91);
    unsupported.contract_version += 1;
    assert_eq!(
        port.open_graph(unsupported).unwrap_err().code,
        CorePortErrorCode::UnsupportedContract
    );

    let opened = port.open_graph(open_request("port-native", 91)).unwrap();
    assert_eq!(opened.summary.schema_version, SCHEMA_VERSION);
    assert!(
        opened
            .capabilities
            .as_ref()
            .is_some_and(|value| value.durable)
    );
    assert_eq!(golden["transcript"]["open"], "summary_available");
    assert_eq!(
        port.open_graph(open_request("port-native", 92))
            .unwrap_err()
            .code,
        CorePortErrorCode::GraphAlreadyOpen
    );

    let executed = port
        .execute(ExecuteRequest {
            graph_handle: opened.graph_handle.clone(),
            command: command("port-native", "command-1", "home"),
            timeout_ms: 1_000,
        })
        .unwrap();
    let SaveStatusDto::SavedLocally {
        local_sequence,
        checksum,
    } = executed.save_status
    else {
        panic!("expected saved status");
    };
    assert_eq!(local_sequence, 1);
    assert_eq!(checksum.len(), 64);
    assert_eq!(
        executed.result.created_page,
        Some(PageId::new("home").unwrap())
    );
    assert_eq!(golden["transcript"]["execute"], "saved_locally");

    let read = port
        .read(ReadRequest {
            graph_handle: opened.graph_handle.clone(),
        })
        .unwrap();
    assert_eq!(read.summary.schema_version, SCHEMA_VERSION);
    assert_eq!(read.summary.pages.len(), 1);
    assert_eq!(golden["transcript"]["read"], "schema_v7_summary");
    let outline = port
        .read_outline(ReadOutlineRequest {
            graph_handle: opened.graph_handle.clone(),
            owner: OutlineOwner::Page {
                id: PageId::new("home").unwrap(),
            },
        })
        .unwrap();
    assert_eq!(
        outline.outline.owner,
        OutlineOwner::Page {
            id: PageId::new("home").unwrap(),
        }
    );
    assert_eq!(golden["transcript"]["read_outline"], "outline_snapshot");

    let queried = port
        .query(QueryRequestDto {
            graph_handle: opened.graph_handle.clone(),
            query: json!({
                "kind": "built",
                "plan": {
                    "version": domain::QUERY_PLAN_VERSION,
                    "grain": "entity",
                    "subject": "page",
                    "where": {
                        "id": "root",
                        "kind": "group",
                        "match": "all",
                        "children": []
                    },
                    "columns": [{ "id": "text", "source": { "kind": "content" } }],
                    "limit": 100
                },
                "today": "2026-08-03"
            }),
        })
        .unwrap();
    assert_eq!(queried.result["kind"], "built");
    assert_eq!(queried.result["grain"], "entity");
    assert_eq!(queried.result["columns"][0]["id"], "text");
    assert_eq!(
        queried.result["rows"][0]["subject"],
        json!({"kind": "page", "id": "home"})
    );
    assert_eq!(queried.result["rows"].as_array().unwrap().len(), 1);
    assert_eq!(golden["transcript"]["query"], "built_entity_result");
    assert_eq!(golden["transcript"]["query_request"], "built_plan");

    let raw = port
        .query(QueryRequestDto {
            graph_handle: opened.graph_handle.clone(),
            query: json!({
                "kind": "raw_sparql",
                "language": "sparql-1.1/neoseq-v1",
                "source": "PREFIX neo: <urn:neoseq:vocab:v1:> SELECT ?page WHERE { ?page a neo:Page }",
                "bindings": {},
                "budget": {
                    "max_source_bytes": 65536,
                    "max_algebra_operators": 512,
                    "max_bindings": 64,
                    "max_rows": 1000
                }
            }),
        })
        .unwrap();
    assert_eq!(raw.result["kind"], "select");
    assert_eq!(raw.result["rows"].as_array().unwrap().len(), 1);

    let subscribed = port
        .subscribe(SubscribeRequest {
            graph_handle: opened.graph_handle.clone(),
            after_cursor: 0,
        })
        .unwrap();
    assert_eq!(subscribed.events.len(), 2);
    assert!(!subscribed.resync_required);
    assert!(matches!(
        &subscribed.events[0].kind,
        graph_core::GraphEventKind::Semantic {
            name: graph_core::SemanticEvent::PageEnsured,
            ..
        }
    ));
    assert!(matches!(
        &subscribed.events[1].kind,
        graph_core::GraphEventKind::SavedLocally { .. }
    ));
    assert_eq!(
        golden["transcript"]["subscribe"],
        json!(["semantic", "saved_locally"])
    );

    let later = port
        .execute(ExecuteRequest {
            graph_handle: opened.graph_handle.clone(),
            command: command("port-native", "command-2", "later"),
            timeout_ms: 1_000,
        })
        .unwrap();
    assert!(matches!(
        later.save_status,
        SaveStatusDto::SavedLocally {
            local_sequence: 2,
            ..
        }
    ));
    let duplicate = port
        .execute(ExecuteRequest {
            graph_handle: opened.graph_handle.clone(),
            command: command("port-native", "command-1", "home"),
            timeout_ms: 1_000,
        })
        .unwrap();
    assert_eq!(duplicate.save_status, SaveStatusDto::Unchanged);
    assert_eq!(duplicate.result, executed.result);
    let no_op = port
        .execute(ExecuteRequest {
            graph_handle: opened.graph_handle.clone(),
            command: command("port-native", "no-op", "home"),
            timeout_ms: 1_000,
        })
        .unwrap();
    assert_eq!(no_op.save_status, SaveStatusDto::Unchanged);

    assert_eq!(
        port.execute(ExecuteRequest {
            graph_handle: opened.graph_handle.clone(),
            command: command("port-native", "timeout", "timeout"),
            timeout_ms: 0,
        })
        .unwrap_err()
        .code,
        CorePortErrorCode::CommandTimeout
    );

    for (fault, command_id, page_id, code) in [
        (
            FaultPoint::AppendBeforeCommit,
            "dirty",
            "notes",
            CorePortErrorCode::DirtyUnsaved,
        ),
        (
            FaultPoint::Busy,
            "busy",
            "busy",
            CorePortErrorCode::DirtyUnsaved,
        ),
        (
            FaultPoint::DiskFull,
            "full",
            "full",
            CorePortErrorCode::StorageFull,
        ),
    ] {
        let before = port
            .subscribe(SubscribeRequest {
                graph_handle: opened.graph_handle.clone(),
                after_cursor: 0,
            })
            .unwrap()
            .next_cursor;
        port.inject_fault(&opened.graph_handle, fault).unwrap();
        let applied = port
            .execute(ExecuteRequest {
                graph_handle: opened.graph_handle.clone(),
                command: command("port-native", command_id, page_id),
                timeout_ms: 1_000,
            })
            .unwrap();
        assert!(
            matches!(&applied.save_status, SaveStatusDto::Unsaved { error } if error.code == code)
        );
        assert_eq!(
            applied.result.created_page,
            Some(PageId::new(page_id).unwrap())
        );
        assert_eq!(
            applied.changes,
            GraphChanges::Refresh {
                outlines: Some(vec![OutlineOwner::Page {
                    id: PageId::new(page_id).unwrap()
                }]),
                blocks: vec![],
            }
        );
        let summary = port
            .read(ReadRequest {
                graph_handle: opened.graph_handle.clone(),
            })
            .unwrap()
            .summary;
        assert!(summary.pages.iter().any(|page| page.id.as_str() == page_id));
        assert!(
            port.subscribe(SubscribeRequest {
                graph_handle: opened.graph_handle.clone(),
                after_cursor: before,
            })
            .unwrap()
            .events
            .is_empty()
        );
        assert_eq!(
            port.execute(ExecuteRequest {
                graph_handle: opened.graph_handle.clone(),
                command: command("port-native", &format!("blocked-{command_id}"), "blocked"),
                timeout_ms: 1_000,
            })
            .unwrap_err()
            .code,
            CorePortErrorCode::DirtyUnsaved
        );
        assert_eq!(
            port.close_graph(CloseGraphRequest {
                graph_handle: opened.graph_handle.clone(),
            })
            .unwrap_err()
            .code,
            CorePortErrorCode::DirtyUnsaved
        );
        port.retry_pending(&opened.graph_handle).unwrap();
        let saved = port
            .subscribe(SubscribeRequest {
                graph_handle: opened.graph_handle.clone(),
                after_cursor: before,
            })
            .unwrap();
        assert_eq!(saved.events.len(), 2);
        port.retry_pending(&opened.graph_handle).unwrap();
        assert!(
            port.subscribe(SubscribeRequest {
                graph_handle: opened.graph_handle.clone(),
                after_cursor: saved.next_cursor,
            })
            .unwrap()
            .events
            .is_empty()
        );
    }

    // A compaction probe happens only after the append is durable. Failure to
    // read its maintenance metadata must not reject the acknowledged command.
    port.inject_fault(&opened.graph_handle, FaultPoint::MetadataRead)
        .unwrap();
    let maintenance_read_failed = port
        .execute(ExecuteRequest {
            graph_handle: opened.graph_handle.clone(),
            command: command("port-native", "metadata-read", "metadata-read"),
            timeout_ms: 1_000,
        })
        .unwrap();
    assert!(matches!(
        maintenance_read_failed.save_status,
        SaveStatusDto::SavedLocally {
            local_sequence: 6,
            ..
        }
    ));

    assert!(
        port.close_graph(CloseGraphRequest {
            graph_handle: opened.graph_handle.clone(),
        })
        .unwrap()
        .closed
    );

    let reopened = port.open_graph(open_request("port-native", 93)).unwrap();
    assert_eq!(reopened.summary.pages.len(), 6);
    assert_eq!(reopened.recovery.checkpoint_sequence, 6);
    port.close_graph(CloseGraphRequest {
        graph_handle: reopened.graph_handle,
    })
    .unwrap();
}

#[test]
fn core_port_native_subscription_overflow_is_stable() {
    let database = TempDb::new();
    let mut port = NativeCorePort::new(&database.0, 2);
    let opened = port.open_graph(open_request("port-overflow", 101)).unwrap();
    for number in 0..2 {
        port.execute(ExecuteRequest {
            graph_handle: opened.graph_handle.clone(),
            command: command(
                "port-overflow",
                &format!("command-{number}"),
                &format!("page-{number}"),
            ),
            timeout_ms: 1_000,
        })
        .unwrap();
    }
    let response = port
        .subscribe(SubscribeRequest {
            graph_handle: opened.graph_handle,
            after_cursor: 0,
        })
        .unwrap();
    assert!(response.resync_required);
    assert!(response.events.is_empty());
}

#[test]
fn core_port_native_unsupported_schema_has_stable_code() {
    let database = TempDb::new();
    let graph = GraphId::new("unsupported-native-schema").unwrap();
    let mut port = NativeCorePort::new(&database.0, 4);
    let opened = port.open_graph(open_request(graph.as_str(), 111)).unwrap();
    port.close_graph(CloseGraphRequest {
        graph_handle: opened.graph_handle,
    })
    .unwrap();
    let mut repository = SqliteGraphRepository::open(
        &database.0,
        GraphLocator::local(graph),
        "2026-08-03T14:00:00Z",
        112,
    )
    .unwrap();
    repository.set_schema_version(SCHEMA_VERSION + 1).unwrap();
    drop(repository);
    assert_eq!(
        port.open_graph(open_request("unsupported-native-schema", 112))
            .unwrap_err()
            .code,
        CorePortErrorCode::UnsupportedSchema
    );
}
