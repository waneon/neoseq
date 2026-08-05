//! Browser Wasm adapter for the graph core.

use graph_core::GraphCore;
use query::{GraphIndex, QueryRequest};
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
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
        let index = GraphIndex::new_at(&inner.snapshot().map_err(js_error)?, inner.frontier())
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
        let index = GraphIndex::new_at(&inner.snapshot().map_err(js_error)?, inner.frontier())
            .map_err(js_error)?;
        Ok(Self {
            inner,
            index,
            pending_update: None,
        })
    }

    #[wasm_bindgen(js_name = executeJson)]
    pub fn execute_json(&mut self, command: &str, now: &str) -> Result<String, JsValue> {
        if self.pending_update.is_some() {
            return Err(js_error("take the pending update before another command"));
        }
        let envelope = serde_json::from_str(command).map_err(js_error)?;
        let execution = self.inner.execute(envelope, now).map_err(js_error)?;
        self.index
            .refresh_at(
                &self.inner.snapshot().map_err(js_error)?,
                self.inner.frontier(),
            )
            .map_err(js_error)?;
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
        self.inner.import_remote(update).map_err(js_error)?;
        self.index
            .refresh_at(
                &self.inner.snapshot().map_err(js_error)?,
                self.inner.frontier(),
            )
            .map_err(js_error)?;
        Ok(())
    }

    #[wasm_bindgen(js_name = queryJson)]
    pub fn query_json(&self, request: &str) -> Result<String, JsValue> {
        if self.pending_update.is_some() {
            return Err(js_error("take the pending update before querying"));
        }
        let request: QueryRequest = serde_json::from_str(request).map_err(js_error)?;
        serde_json::to_string(&self.index.execute(request).map_err(js_error)?).map_err(js_error)
    }

    #[wasm_bindgen(js_name = snapshotJson)]
    pub fn snapshot_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.snapshot().map_err(js_error)?).map_err(js_error)
    }

    #[wasm_bindgen(js_name = summaryJson)]
    pub fn summary_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.summary().map_err(js_error)?).map_err(js_error)
    }

    #[wasm_bindgen(js_name = pageSnapshotJson)]
    pub fn page_snapshot_json(&self, page_id: &str) -> Result<String, JsValue> {
        let page_id = domain::PageId::new(page_id).map_err(js_error)?;
        serde_json::to_string(&self.inner.page_snapshot(&page_id).map_err(js_error)?)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = exportSnapshot)]
    pub fn export_snapshot(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_snapshot().map_err(js_error)
    }

    pub fn fingerprint(&self) -> Result<String, JsValue> {
        self.inner.fingerprint().map_err(js_error)
    }
}
