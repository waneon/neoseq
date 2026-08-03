//! Browser Wasm adapter for the graph core.

use graph_core::GraphCore;
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub struct WasmGraphCore {
    inner: GraphCore,
    pending_update: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl WasmGraphCore {
    #[wasm_bindgen(constructor)]
    pub fn new(graph_id: &str, peer_id: u64, now: &str) -> Result<WasmGraphCore, JsValue> {
        let graph_id = domain::GraphId::new(graph_id).map_err(js_error)?;
        Ok(Self {
            inner: GraphCore::new(graph_id, peer_id, now).map_err(js_error)?,
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
        Ok(Self {
            inner: GraphCore::from_snapshot(graph_id, peer_id, snapshot).map_err(js_error)?,
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
        self.inner.import_remote(update).map_err(js_error)
    }

    #[wasm_bindgen(js_name = snapshotJson)]
    pub fn snapshot_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.snapshot().map_err(js_error)?).map_err(js_error)
    }

    #[wasm_bindgen(js_name = exportSnapshot)]
    pub fn export_snapshot(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_snapshot().map_err(js_error)
    }

    pub fn fingerprint(&self) -> Result<String, JsValue> {
        self.inner.fingerprint().map_err(js_error)
    }
}
