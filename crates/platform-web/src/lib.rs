//! Browser Wasm adapter for the graph core.

use domain::{CorePortError, CorePortErrorCode};
use graph_core::{GraphCore, apply_index_changes};
use query::{AuthoredQueryRequest, GraphIndex};
use sync_protocol::{Message, decode, encode};
use wasm_bindgen::prelude::*;

const SYNC_MAX_FRAME_BYTES: usize = 1_048_576;

/// Keeps postcard and the versioned wire header in Rust, so browser clients do
/// not grow an independent protocol implementation that can drift.
#[wasm_bindgen(js_name = encodeSyncMessageJson)]
pub fn encode_sync_message_json(message: &str) -> Result<Vec<u8>, JsValue> {
    let message: Message = serde_json::from_str(message).map_err(js_error)?;
    encode(&message, SYNC_MAX_FRAME_BYTES).map_err(js_error)
}

#[wasm_bindgen(js_name = decodeSyncMessageJson)]
pub fn decode_sync_message_json(frame: &[u8]) -> Result<String, JsValue> {
    let message = decode(frame, SYNC_MAX_FRAME_BYTES).map_err(js_error)?;
    serde_json::to_string(&message).map_err(js_error)
}

#[wasm_bindgen(js_name = emptyVersionVector)]
pub fn empty_version_vector() -> Vec<u8> {
    graph_core::empty_version_vector()
}

#[wasm_bindgen(js_name = encodeGraphArchive)]
pub fn encode_graph_archive(
    snapshot: &[u8],
    source_graph_id: &str,
    archive_id: &str,
    exported_at: &str,
    suggested_name: Option<String>,
) -> Result<Vec<u8>, JsValue> {
    let source_graph_id = domain::GraphId::new(source_graph_id).map_err(|error| {
        js_port_error(port_error(CorePortErrorCode::InvalidArchive, error, false))
    })?;
    graph_archive::encode(
        snapshot,
        graph_archive::ArchiveMetadata {
            archive_id: archive_id.to_owned(),
            source_graph_id,
            document_schema: graph_core::SCHEMA_VERSION,
            exported_at: exported_at.to_owned(),
            suggested_name,
        },
    )
    .map_err(|error| js_port_error(map_archive_error(error)))
}

#[wasm_bindgen(js_name = decodeGraphArchive)]
pub fn decode_graph_archive(bytes: &[u8]) -> Result<WasmDecodedGraphArchive, JsValue> {
    let decoded =
        graph_archive::decode(bytes).map_err(|error| js_port_error(map_archive_error(error)))?;
    Ok(WasmDecodedGraphArchive {
        manifest_json: serde_json::to_string(&decoded.manifest).map_err(|error| {
            js_port_error(port_error(CorePortErrorCode::Internal, error, false))
        })?,
        snapshot: decoded.snapshot,
    })
}

#[wasm_bindgen]
pub struct WasmDecodedGraphArchive {
    manifest_json: String,
    snapshot: Vec<u8>,
}

#[wasm_bindgen]
impl WasmDecodedGraphArchive {
    #[wasm_bindgen(js_name = manifestJson)]
    pub fn manifest_json(&self) -> String {
        self.manifest_json.clone()
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.snapshot.clone()
    }
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

fn js_port_error(error: CorePortError) -> JsValue {
    JsValue::from_str(&serialize_port_error(&error))
}

fn serialize_port_error(error: &CorePortError) -> String {
    serde_json::to_string(error)
        .expect("CorePortError contains only infallibly serializable values")
}

fn port_error(
    code: CorePortErrorCode,
    error: impl std::fmt::Display,
    retryable: bool,
) -> CorePortError {
    CorePortError {
        code,
        message: error.to_string(),
        retryable,
    }
}

fn map_archive_error(error: graph_archive::ArchiveError) -> CorePortError {
    let code = match &error {
        graph_archive::ArchiveError::ArchiveTooLarge
        | graph_archive::ArchiveError::ManifestTooLarge
        | graph_archive::ArchiveError::SnapshotTooLarge => CorePortErrorCode::ArchiveTooLarge,
        graph_archive::ArchiveError::UnsupportedVersion => CorePortErrorCode::UnsupportedArchive,
        graph_archive::ArchiveError::ChecksumMismatch => CorePortErrorCode::ArchiveChecksumMismatch,
        graph_archive::ArchiveError::InvalidEntries
        | graph_archive::ArchiveError::UnsupportedCompression
        | graph_archive::ArchiveError::InvalidManifest(_)
        | graph_archive::ArchiveError::Zip(_)
        | graph_archive::ArchiveError::Io(_) => CorePortErrorCode::InvalidArchive,
    };
    port_error(code, error, false)
}

fn map_query_error(error: query::QueryError) -> CorePortError {
    let code = match &error {
        query::QueryError::SourceBudget
        | query::QueryError::BindingBudget
        | query::QueryError::AlgebraBudget
        | query::QueryError::RowBudget
        | query::QueryError::ResultBudget => CorePortErrorCode::QueryBudgetExceeded,
        query::QueryError::Index(_) => CorePortErrorCode::Internal,
        query::QueryError::UnsupportedLanguage(_)
        | query::QueryError::Syntax(_)
        | query::QueryError::InvalidPlan(_)
        | query::QueryError::Disallowed(_)
        | query::QueryError::InvalidTerm(_)
        | query::QueryError::Evaluation(_) => CorePortErrorCode::InvalidQuery,
    };
    port_error(code, error, false)
}

fn map_core_error(error: graph_core::CoreError) -> CorePortError {
    let code = match &error {
        graph_core::CoreError::WrongGraph { .. } => CorePortErrorCode::WrongGraph,
        graph_core::CoreError::UnsupportedSchema(_) => CorePortErrorCode::UnsupportedSchema,
        graph_core::CoreError::PageNameConflict { .. } => CorePortErrorCode::PageNameConflict,
        graph_core::CoreError::TagNameConflict { .. } => CorePortErrorCode::TagNameConflict,
        graph_core::CoreError::FirstSiblingIndent => CorePortErrorCode::FirstSiblingIndent,
        graph_core::CoreError::RootBlockOutdent => CorePortErrorCode::RootBlockOutdent,
        _ => CorePortErrorCode::InvalidRequest,
    };
    port_error(code, error, false)
}

fn map_runtime_error(error: graph_core::RuntimeError) -> CorePortError {
    match error {
        graph_core::RuntimeError::Core(error) => map_core_error(error),
        graph_core::RuntimeError::Query(error) => map_query_error(error),
        graph_core::RuntimeError::DirtyUnsaved { kind, message } => {
            let (code, retryable) = match kind {
                graph_core::StorageErrorKind::Full => (CorePortErrorCode::StorageFull, true),
                graph_core::StorageErrorKind::Corrupt | graph_core::StorageErrorKind::NotFound => {
                    (CorePortErrorCode::DirtyUnsaved, false)
                }
                graph_core::StorageErrorKind::Busy
                | graph_core::StorageErrorKind::Unavailable
                | graph_core::StorageErrorKind::Other => (CorePortErrorCode::DirtyUnsaved, true),
            };
            port_error(code, message, retryable)
        }
        graph_core::RuntimeError::ZeroEventCapacity => port_error(
            CorePortErrorCode::InvalidRequest,
            "event capacity must be positive",
            false,
        ),
    }
}

fn js_core_error(error: graph_core::CoreError) -> JsValue {
    js_port_error(map_core_error(error))
}

fn js_invalid_request(error: impl std::fmt::Display) -> JsValue {
    js_port_error(port_error(CorePortErrorCode::InvalidRequest, error, false))
}

fn js_invalid_query(error: impl std::fmt::Display) -> JsValue {
    js_port_error(port_error(CorePortErrorCode::InvalidQuery, error, false))
}

fn js_internal_error(error: impl std::fmt::Display) -> JsValue {
    js_port_error(port_error(CorePortErrorCode::Internal, error, false))
}

fn js_dirty_unsaved(message: &'static str) -> JsValue {
    js_port_error(port_error(CorePortErrorCode::DirtyUnsaved, message, true))
}

#[wasm_bindgen]
pub struct WasmGraphCore {
    inner: GraphCore,
    /// `None` is the complete stale/cold representation. Derived index work
    /// can therefore fail without changing authoritative mutation semantics.
    index: Option<GraphIndex>,
    pending_update: Option<Vec<u8>>,
    #[cfg(test)]
    fail_next_index_update: bool,
}

impl WasmGraphCore {
    fn advance_index(&mut self, changes: &graph_core::GraphChangeSet) {
        let Some(mut index) = self.index.take() else {
            return;
        };
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_index_update) {
            return;
        }
        if apply_index_changes(&self.inner, &mut index, changes).is_ok() {
            self.index = Some(index);
        }
    }

    fn index(&mut self) -> Result<&GraphIndex, graph_core::RuntimeError> {
        if self.index.is_none() {
            self.index = Some(GraphIndex::from_units(
                self.inner.graph_id().clone(),
                self.inner.frontier(),
                self.inner.index_units()?,
            )?);
        }
        Ok(self
            .index
            .as_ref()
            .expect("query index initialized immediately above"))
    }
}

#[wasm_bindgen]
impl WasmGraphCore {
    #[wasm_bindgen(constructor)]
    pub fn new(graph_id: &str, peer_id: u64, now: &str) -> Result<WasmGraphCore, JsValue> {
        let graph_id = domain::GraphId::new(graph_id).map_err(js_invalid_request)?;
        let inner = GraphCore::new(graph_id, peer_id, now).map_err(js_core_error)?;
        Ok(Self {
            inner,
            index: None,
            pending_update: None,
            #[cfg(test)]
            fail_next_index_update: false,
        })
    }

    #[wasm_bindgen(js_name = fromSnapshot)]
    pub fn from_snapshot(
        graph_id: &str,
        peer_id: u64,
        snapshot: &[u8],
    ) -> Result<WasmGraphCore, JsValue> {
        let graph_id = domain::GraphId::new(graph_id).map_err(js_invalid_request)?;
        let inner = GraphCore::from_snapshot(graph_id, peer_id, snapshot).map_err(js_core_error)?;
        Ok(Self {
            inner,
            index: None,
            pending_update: None,
            #[cfg(test)]
            fail_next_index_update: false,
        })
    }

    #[wasm_bindgen(js_name = fromRecoverySnapshot)]
    pub fn from_recovery_snapshot(
        graph_id: &str,
        peer_id: u64,
        snapshot: &[u8],
    ) -> Result<WasmGraphCore, JsValue> {
        let graph_id = domain::GraphId::new(graph_id).map_err(js_invalid_request)?;
        let inner = GraphCore::from_recovery_snapshot(graph_id, peer_id, snapshot)
            .map_err(js_core_error)?;
        Ok(Self {
            inner,
            index: None,
            pending_update: None,
            #[cfg(test)]
            fail_next_index_update: false,
        })
    }

    #[wasm_bindgen(js_name = importRecoveryUpdate)]
    pub fn import_recovery_update(&mut self, update: &[u8]) -> Result<(), JsValue> {
        self.inner
            .import_recovery_update(update)
            .map_err(js_core_error)
    }

    #[wasm_bindgen(js_name = stageRecoveryUpdate)]
    pub fn stage_recovery_update(&mut self, update: &[u8]) -> Result<(), JsValue> {
        self.inner
            .stage_recovery_update(update)
            .map_err(js_core_error)
    }

    #[wasm_bindgen(js_name = finishRecovery)]
    pub fn finish_recovery(&mut self) -> Result<(), JsValue> {
        self.inner.finish_recovery().map_err(js_core_error)?;
        self.index = None;
        Ok(())
    }

    #[wasm_bindgen(js_name = resetLocalHistory)]
    pub fn reset_local_history(&mut self) {
        self.inner.reset_local_history();
    }

    #[wasm_bindgen(js_name = executeJson)]
    pub fn execute_json(&mut self, command: &str, now: &str) -> Result<String, JsValue> {
        if self.pending_update.is_some() {
            return Err(js_dirty_unsaved(
                "take the pending update before another command",
            ));
        }
        let envelope = serde_json::from_str(command).map_err(js_invalid_request)?;
        let mut execution = self.inner.execute(envelope, now).map_err(js_core_error)?;
        if !execution.update.is_empty() {
            // The document is authoritative and has already changed. Publish
            // its exact durable unit before updating any disposable index.
            self.pending_update = Some(std::mem::take(&mut execution.update));
        }
        self.advance_index(&execution.changes);
        let changes = self.inner.publication(&execution);
        serde_json::to_string(&serde_json::json!({
            "result": execution.result,
            "changes": changes,
            "semantic": execution.semantic
        }))
        .map_err(js_internal_error)
    }

    #[wasm_bindgen(js_name = takeUpdate)]
    pub fn take_update(&mut self) -> Vec<u8> {
        self.pending_update.take().unwrap_or_default()
    }

    #[wasm_bindgen(js_name = importUpdate)]
    pub fn import_update(&mut self, update: &[u8]) -> Result<String, JsValue> {
        if self.pending_update.is_some() {
            return Err(js_dirty_unsaved("take the pending update before importing"));
        }
        let (changes, publication) = self
            .inner
            .import_remote_with_publication(update)
            .map_err(js_core_error)?;
        // Inbound bytes are durable before this API is called. An index error
        // invalidates only the disposable projection, not the accepted import.
        self.advance_index(&changes);
        serde_json::to_string(&publication).map_err(js_internal_error)
    }

    #[wasm_bindgen(js_name = validateUpdate)]
    pub fn validate_update(&self, update: &[u8]) -> Result<(), JsValue> {
        self.inner.validate_remote(update).map_err(js_core_error)
    }

    #[wasm_bindgen(js_name = versionVector)]
    pub fn version_vector(&self) -> Vec<u8> {
        self.inner.version_vector()
    }

    #[wasm_bindgen(js_name = exportAll)]
    pub fn export_all(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_all().map_err(js_core_error)
    }

    #[wasm_bindgen(js_name = exportUpdatesSince)]
    pub fn export_updates_since(&self, version_vector: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner
            .export_updates_since(version_vector)
            .map_err(js_core_error)
    }

    #[wasm_bindgen(js_name = queryJson)]
    pub fn query_json(&mut self, request: &str) -> Result<String, JsValue> {
        if self.pending_update.is_some() {
            return Err(js_dirty_unsaved("take the pending update before querying"));
        }
        let request: AuthoredQueryRequest =
            serde_json::from_str(request).map_err(js_invalid_query)?;
        let index = self
            .index()
            .map_err(|error| js_port_error(map_runtime_error(error)))?;
        let result = index
            .execute_authored(request)
            .map_err(|error| js_port_error(map_query_error(error)))?;
        serde_json::to_string(&result).map_err(js_internal_error)
    }

    #[wasm_bindgen(js_name = queryIndexReady)]
    pub fn query_index_ready(&self) -> bool {
        self.index.is_some()
    }

    #[wasm_bindgen(js_name = summaryJson)]
    pub fn summary_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.summary().map_err(js_core_error)?)
            .map_err(js_internal_error)
    }

    #[wasm_bindgen(js_name = outlineSnapshotJson)]
    pub fn outline_snapshot_json(&self, owner: &str) -> Result<String, JsValue> {
        let owner: domain::OutlineOwner =
            serde_json::from_str(owner).map_err(js_invalid_request)?;
        serde_json::to_string(&self.inner.outline_snapshot(&owner).map_err(js_core_error)?)
            .map_err(js_internal_error)
    }

    #[wasm_bindgen(js_name = exportSnapshot)]
    pub fn export_snapshot(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_snapshot().map_err(js_core_error)
    }

    #[wasm_bindgen(js_name = exportGcCheckpoint)]
    pub fn export_gc_checkpoint(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_gc_checkpoint().map_err(js_core_error)
    }

    #[wasm_bindgen(js_name = exportCloneSnapshot)]
    pub fn export_clone_snapshot(
        &self,
        target_graph_id: &str,
        target_peer_id: u64,
    ) -> Result<Vec<u8>, JsValue> {
        let target_graph_id = domain::GraphId::new(target_graph_id).map_err(js_invalid_request)?;
        self.inner
            .export_clone_snapshot(target_graph_id, target_peer_id)
            .map_err(js_core_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{Command, CommandEnvelope, CommandId, GraphId, PageId};

    fn assert_error_code(error: CorePortError, code: CorePortErrorCode) {
        assert_eq!(error.code, code);
        assert!(!error.retryable);
        let decoded: CorePortError = serde_json::from_str(&serialize_port_error(&error)).unwrap();
        assert_eq!(decoded, error);
    }

    fn ensure_page(graph_id: &str, command_id: &str, page_id: &str, title: &str) -> String {
        serde_json::to_string(&CommandEnvelope {
            graph_id: GraphId::new(graph_id).unwrap(),
            command_id: CommandId::new(command_id).unwrap(),
            command: Command::EnsurePage {
                page_id: PageId::new(page_id).unwrap(),
                title: title.to_owned(),
            },
        })
        .unwrap()
    }

    #[test]
    fn local_update_is_pending_before_a_failed_index_advance() {
        let mut core = WasmGraphCore::new("wasm-index-local", 1, "initial").unwrap();
        core.index().unwrap();
        core.fail_next_index_update = true;

        assert!(
            core.execute_json(
                &ensure_page("wasm-index-local", "command", "page", "Page"),
                "now"
            )
            .is_ok()
        );
        assert!(
            core.pending_update
                .as_ref()
                .is_some_and(|bytes| !bytes.is_empty())
        );
        assert!(core.index.is_none());

        assert!(!core.take_update().is_empty());
        assert!(core.pending_update.is_none());
        core.index().unwrap();
        assert!(core.index.is_some());
    }

    #[test]
    fn durable_remote_import_survives_a_failed_index_advance() {
        let mut receiver = WasmGraphCore::new("wasm-index-remote", 1, "initial").unwrap();
        let snapshot = receiver.export_snapshot().unwrap();
        let mut sender = WasmGraphCore::from_snapshot("wasm-index-remote", 2, &snapshot).unwrap();
        sender
            .execute_json(
                &ensure_page("wasm-index-remote", "command", "page", "Page"),
                "now",
            )
            .unwrap();
        let update = sender.take_update();
        receiver.index().unwrap();
        receiver.fail_next_index_update = true;

        assert!(receiver.import_update(&update).is_ok());
        assert!(receiver.pending_update.is_none());
        assert!(receiver.index.is_none());
        assert!(
            receiver
                .inner
                .snapshot()
                .unwrap()
                .pages
                .iter()
                .any(|page| page.title == "Page")
        );

        receiver.index().unwrap();
        assert!(receiver.index.is_some());
    }

    #[test]
    fn query_failures_use_core_port_error_codes() {
        assert_error_code(
            map_query_error(query::QueryError::SourceBudget),
            CorePortErrorCode::QueryBudgetExceeded,
        );
        assert_error_code(
            map_query_error(query::QueryError::Syntax("bad query".to_owned())),
            CorePortErrorCode::InvalidQuery,
        );
        assert_error_code(
            map_query_error(query::QueryError::Index("broken index".to_owned())),
            CorePortErrorCode::Internal,
        );

        let encoded = serialize_port_error(&map_query_error(query::QueryError::RowBudget));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),
            serde_json::json!({
                "code": "query_budget_exceeded",
                "message": "query output exceeds the configured row budget",
                "retryable": false
            })
        );
    }

    #[test]
    fn archive_failures_use_core_port_error_codes() {
        assert_error_code(
            map_archive_error(graph_archive::ArchiveError::SnapshotTooLarge),
            CorePortErrorCode::ArchiveTooLarge,
        );
        assert_error_code(
            map_archive_error(graph_archive::ArchiveError::ChecksumMismatch),
            CorePortErrorCode::ArchiveChecksumMismatch,
        );
        assert_error_code(
            map_archive_error(graph_archive::ArchiveError::UnsupportedVersion),
            CorePortErrorCode::UnsupportedArchive,
        );
        assert_error_code(
            map_archive_error(graph_archive::ArchiveError::InvalidEntries),
            CorePortErrorCode::InvalidArchive,
        );
        assert_error_code(
            map_archive_error(graph_archive::ArchiveError::UnsupportedCompression),
            CorePortErrorCode::InvalidArchive,
        );
    }

    #[test]
    fn graph_core_failures_preserve_cross_platform_codes() {
        assert_error_code(
            map_core_error(graph_core::CoreError::WrongGraph {
                expected: GraphId::new("expected").unwrap(),
                actual: GraphId::new("actual").unwrap(),
            }),
            CorePortErrorCode::WrongGraph,
        );
        assert_error_code(
            map_core_error(graph_core::CoreError::UnsupportedSchema(99)),
            CorePortErrorCode::UnsupportedSchema,
        );
        assert_error_code(
            map_core_error(graph_core::CoreError::PageNotFound(
                PageId::new("missing").unwrap(),
            )),
            CorePortErrorCode::InvalidRequest,
        );
        assert_error_code(
            map_core_error(graph_core::CoreError::PageNameConflict {
                name: "Same".to_owned(),
                existing: PageId::new("page").unwrap(),
            }),
            CorePortErrorCode::PageNameConflict,
        );
        assert_error_code(
            map_core_error(graph_core::CoreError::TagNameConflict {
                name: "Same".to_owned(),
                existing: domain::TagId::new("tag").unwrap(),
            }),
            CorePortErrorCode::TagNameConflict,
        );
        assert_error_code(
            map_core_error(graph_core::CoreError::FirstSiblingIndent),
            CorePortErrorCode::FirstSiblingIndent,
        );
        assert_error_code(
            map_core_error(graph_core::CoreError::RootBlockOutdent),
            CorePortErrorCode::RootBlockOutdent,
        );
    }
}
