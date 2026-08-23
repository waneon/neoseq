use crate::{FaultPoint, NativeCorePort, SqliteGraphRepository};
use domain::{
    CORE_PORT_VERSION, CloseGraphRequest, Command, CommandEnvelope, CommandId, CorePortErrorCode,
    ExecuteRequest, GraphId, GraphLocatorDto, OpenGraphRequest, PageId, QueryRequestDto,
    ReadOutlineRequest, ReadRequest, SaveStatusDto, SubscribeRequest,
};
use graph_core::{GraphLocator, LocalGraphRepository, SCHEMA_VERSION};
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
            graph_id: graph.to_owned(),
        },
        peer_id,
    }
}

fn command(graph: &str, id: &str, page: &str) -> Value {
    serde_json::to_value(CommandEnvelope {
        graph_id: GraphId::new(graph).unwrap(),
        command_id: CommandId::new(id).unwrap(),
        command: Command::EnsurePage {
            page_id: PageId::new(page).unwrap(),
            title: page.to_owned(),
        },
    })
    .unwrap()
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
    assert_eq!(opened.summary["schema_version"], 3);
    assert!(opened.capabilities.durable);
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
    assert_eq!(golden["transcript"]["execute"], "saved_locally");

    let read = port
        .read(ReadRequest {
            graph_handle: opened.graph_handle.clone(),
        })
        .unwrap();
    assert_eq!(read.summary["schema_version"], 3);
    assert_eq!(read.summary["pages"].as_array().unwrap().len(), 1);
    assert_eq!(golden["transcript"]["read"], "schema_v3_summary");
    let outline = port
        .read_outline(ReadOutlineRequest {
            graph_handle: opened.graph_handle.clone(),
            owner: json!({ "kind": "page", "id": "home" }),
        })
        .unwrap();
    assert_eq!(outline.outline["owner"]["id"], "home");
    assert_eq!(golden["transcript"]["read_outline"], "outline_snapshot");

    let queried = port
        .query(QueryRequestDto {
            graph_handle: opened.graph_handle.clone(),
            query: json!({
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
    assert_eq!(queried.result["kind"], "select");
    assert_eq!(queried.result["rows"].as_array().unwrap().len(), 1);
    assert_eq!(golden["transcript"]["query"], "select_result");

    let subscribed = port
        .subscribe(SubscribeRequest {
            graph_handle: opened.graph_handle.clone(),
            after_cursor: 0,
        })
        .unwrap();
    assert_eq!(subscribed.events.len(), 2);
    assert!(!subscribed.resync_required);
    assert_eq!(subscribed.events[0]["kind"]["type"], "semantic");
    assert_eq!(subscribed.events[1]["kind"]["type"], "saved_locally");
    assert_eq!(
        golden["transcript"]["subscribe"],
        json!(["semantic", "saved_locally"])
    );

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

    port.inject_fault(&opened.graph_handle, FaultPoint::AppendBeforeCommit)
        .unwrap();
    assert_eq!(
        port.execute(ExecuteRequest {
            graph_handle: opened.graph_handle.clone(),
            command: command("port-native", "dirty", "notes"),
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
    port.inject_fault(&opened.graph_handle, FaultPoint::Busy)
        .unwrap();
    assert_eq!(
        port.execute(ExecuteRequest {
            graph_handle: opened.graph_handle.clone(),
            command: command("port-native", "busy", "busy"),
            timeout_ms: 1_000,
        })
        .unwrap_err()
        .code,
        CorePortErrorCode::StorageBusy
    );
    port.retry_pending(&opened.graph_handle).unwrap();
    port.inject_fault(&opened.graph_handle, FaultPoint::DiskFull)
        .unwrap();
    assert_eq!(
        port.execute(ExecuteRequest {
            graph_handle: opened.graph_handle.clone(),
            command: command("port-native", "full", "full"),
            timeout_ms: 1_000,
        })
        .unwrap_err()
        .code,
        CorePortErrorCode::StorageFull
    );
    port.retry_pending(&opened.graph_handle).unwrap();
    assert!(
        port.close_graph(CloseGraphRequest {
            graph_handle: opened.graph_handle.clone(),
        })
        .unwrap()
        .closed
    );

    let reopened = port.open_graph(open_request("port-native", 93)).unwrap();
    assert_eq!(reopened.summary["pages"].as_array().unwrap().len(), 4);
    assert_eq!(reopened.recovery.checkpoint_sequence, 4);
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
    repository.set_schema_version(4).unwrap();
    drop(repository);
    assert_eq!(
        port.open_graph(open_request("unsupported-native-schema", 112))
            .unwrap_err()
            .code,
        CorePortErrorCode::UnsupportedSchema
    );
}

#[test]
fn core_port_native_migrates_the_schema_v2_tag_fixture_before_opening() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/compatibility/schema-v2-tag-without-outline.json"
    ))
    .unwrap();
    let graph_id = GraphId::new(fixture["graph_id"].as_str().unwrap()).unwrap();
    let snapshot = hex::decode(fixture["snapshot_hex"].as_str().unwrap()).unwrap();
    let database = TempDb::new();
    let mut repository = SqliteGraphRepository::open(
        &database.0,
        GraphLocator::local(graph_id.clone()),
        "2026-08-23T00:00:00Z",
        121,
    )
    .unwrap();
    repository
        .install_compatibility_fixture(2, &snapshot, "2026-08-23T00:00:01Z")
        .unwrap();
    drop(repository);

    let mut port = NativeCorePort::new(&database.0, 4);
    let opened = port
        .open_graph(open_request(graph_id.as_str(), 122))
        .unwrap();
    assert_eq!(opened.summary["schema_version"], SCHEMA_VERSION);
    let outline = port
        .read_outline(ReadOutlineRequest {
            graph_handle: opened.graph_handle.clone(),
            owner: json!({ "kind": "tag", "id": fixture["tag_id"] }),
        })
        .unwrap();
    assert!(outline.outline["blocks"].as_array().unwrap().is_empty());
    port.close_graph(CloseGraphRequest {
        graph_handle: opened.graph_handle,
    })
    .unwrap();

    let mut repository = SqliteGraphRepository::open(
        &database.0,
        GraphLocator::local(graph_id),
        "2026-08-23T00:00:02Z",
        123,
    )
    .unwrap();
    assert_eq!(
        repository.metadata().unwrap().schema_version,
        SCHEMA_VERSION
    );
    assert_eq!(
        repository.checkpoints_descending().unwrap()[0].schema_version,
        SCHEMA_VERSION
    );
}
