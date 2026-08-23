//! Browser Wasm adapter for the graph core.

use graph_core::{GraphChangeSet, GraphCore};
use query::{GraphIndex, QueryRequest};
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
    let source_graph_id = domain::GraphId::new(source_graph_id).map_err(js_error)?;
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
    .map_err(js_error)
}

#[wasm_bindgen(js_name = decodeGraphArchive)]
pub fn decode_graph_archive(bytes: &[u8]) -> Result<WasmDecodedGraphArchive, JsValue> {
    let decoded = graph_archive::decode(bytes).map_err(js_error)?;
    Ok(WasmDecodedGraphArchive {
        manifest_json: serde_json::to_string(&decoded.manifest).map_err(js_error)?,
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

fn apply_index_changes(
    inner: &GraphCore,
    index: &mut GraphIndex,
    changes: &GraphChangeSet,
) -> Result<(), JsValue> {
    match inner.index_delta(changes).map_err(js_error)? {
        Some(delta) => {
            if index.apply_delta(delta).is_err() {
                index
                    .rebuild_from_units(
                        inner.graph_id().clone(),
                        inner.frontier(),
                        inner.index_units().map_err(js_error)?,
                    )
                    .map_err(js_error)?;
            }
        }
        None => {
            index
                .rebuild_from_units(
                    inner.graph_id().clone(),
                    inner.frontier(),
                    inner.index_units().map_err(js_error)?,
                )
                .map_err(js_error)?;
        }
    }
    Ok(())
}

#[wasm_bindgen]
pub struct WasmGraphCore {
    inner: GraphCore,
    index: GraphIndex,
    pending_update: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl WasmGraphCore {
    #[wasm_bindgen(constructor)]
    pub fn new(graph_id: &str, peer_id: u64, now: &str) -> Result<WasmGraphCore, JsValue> {
        let graph_id = domain::GraphId::new(graph_id).map_err(js_error)?;
        let inner = GraphCore::new(graph_id, peer_id, now).map_err(js_error)?;
        let index = GraphIndex::from_units(
            inner.graph_id().clone(),
            inner.frontier(),
            inner.index_units().map_err(js_error)?,
        )
        .map_err(js_error)?;
        Ok(Self {
            inner,
            index,
            pending_update: None,
        })
    }

    #[wasm_bindgen(js_name = fromSnapshot)]
    pub fn from_snapshot(
        graph_id: &str,
        peer_id: u64,
        snapshot: &[u8],
    ) -> Result<WasmGraphCore, JsValue> {
        let graph_id = domain::GraphId::new(graph_id).map_err(js_error)?;
        let inner = GraphCore::from_snapshot(graph_id, peer_id, snapshot).map_err(js_error)?;
        let index = GraphIndex::from_units(
            inner.graph_id().clone(),
            inner.frontier(),
            inner.index_units().map_err(js_error)?,
        )
        .map_err(js_error)?;
        Ok(Self {
            inner,
            index,
            pending_update: None,
        })
    }

    #[wasm_bindgen(js_name = resetLocalHistory)]
    pub fn reset_local_history(&mut self) {
        self.inner.reset_local_history();
    }

    #[wasm_bindgen(js_name = executeJson)]
    pub fn execute_json(&mut self, command: &str, now: &str) -> Result<String, JsValue> {
        if self.pending_update.is_some() {
            return Err(js_error("take the pending update before another command"));
        }
        let envelope = serde_json::from_str(command).map_err(js_error)?;
        let execution = self.inner.execute(envelope, now).map_err(js_error)?;
        apply_index_changes(&self.inner, &mut self.index, &execution.changes)?;
        self.pending_update = Some(execution.update);
        serde_json::to_string(&serde_json::json!({
            "result": execution.result,
            "semantic": execution.semantic,
            "duplicate": execution.duplicate
        }))
        .map_err(js_error)
    }

    #[wasm_bindgen(js_name = takeUpdate)]
    pub fn take_update(&mut self) -> Vec<u8> {
        self.pending_update.take().unwrap_or_default()
    }

    #[wasm_bindgen(js_name = importUpdate)]
    pub fn import_update(&mut self, update: &[u8]) -> Result<(), JsValue> {
        let changes = self
            .inner
            .import_remote_with_changes(update)
            .map_err(js_error)?;
        apply_index_changes(&self.inner, &mut self.index, &changes)?;
        Ok(())
    }

    #[wasm_bindgen(js_name = validateUpdate)]
    pub fn validate_update(&self, update: &[u8]) -> Result<(), JsValue> {
        self.inner.validate_remote(update).map_err(js_error)
    }

    #[wasm_bindgen(js_name = versionVector)]
    pub fn version_vector(&self) -> Vec<u8> {
        self.inner.version_vector()
    }

    #[wasm_bindgen(js_name = exportAll)]
    pub fn export_all(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_all().map_err(js_error)
    }

    #[wasm_bindgen(js_name = exportUpdatesSince)]
    pub fn export_updates_since(&self, version_vector: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner
            .export_updates_since(version_vector)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = queryJson)]
    pub fn query_json(&self, request: &str) -> Result<String, JsValue> {
        if self.pending_update.is_some() {
            return Err(js_error("take the pending update before querying"));
        }
        let request: QueryRequest = serde_json::from_str(request).map_err(js_error)?;
        serde_json::to_string(&self.index.execute(request).map_err(js_error)?).map_err(js_error)
    }

    #[wasm_bindgen(js_name = summaryJson)]
    pub fn summary_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.summary().map_err(js_error)?).map_err(js_error)
    }

    #[wasm_bindgen(js_name = outlineSnapshotJson)]
    pub fn outline_snapshot_json(&self, owner: &str) -> Result<String, JsValue> {
        let owner: domain::OutlineOwner = serde_json::from_str(owner).map_err(js_error)?;
        serde_json::to_string(&self.inner.outline_snapshot(&owner).map_err(js_error)?)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = exportSnapshot)]
    pub fn export_snapshot(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_snapshot().map_err(js_error)
    }

    #[wasm_bindgen(js_name = exportGcCheckpoint)]
    pub fn export_gc_checkpoint(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_gc_checkpoint().map_err(js_error)
    }

    #[wasm_bindgen(js_name = exportCloneSnapshot)]
    pub fn export_clone_snapshot(
        &self,
        target_graph_id: &str,
        target_peer_id: u64,
    ) -> Result<Vec<u8>, JsValue> {
        let target_graph_id = domain::GraphId::new(target_graph_id).map_err(js_error)?;
        self.inner
            .export_clone_snapshot(target_graph_id, target_peer_id)
            .map_err(js_error)
    }
}
