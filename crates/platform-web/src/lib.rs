//! wasm-bindgen feasibility adapter. It is intentionally smaller than CorePort v1.

use graph_core::GraphCore;
use graph_core::SpikePeer as CoreSpikePeer;
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub fn core_version() -> String {
    graph_core::ping("wasm-spike").core_version
}

#[wasm_bindgen]
pub fn core_port_version() -> u32 {
    graph_core::ping("wasm-spike").contract_version
}

#[wasm_bindgen]
pub fn fixture_hash() -> Result<String, JsValue> {
    graph_core::fixture_hash().map_err(js_error)
}

#[wasm_bindgen]
pub fn fixture_snapshot() -> Result<Vec<u8>, JsValue> {
    graph_core::fixture_snapshot().map_err(js_error)
}

#[wasm_bindgen]
pub fn core_basic_scenario_json() -> Result<String, JsValue> {
    graph_core::scenario::basic_scenario_json().map_err(js_error)
}

#[wasm_bindgen]
pub fn snapshot_hash(bytes: &[u8]) -> Result<String, JsValue> {
    graph_core::snapshot_semantic_hash(bytes).map_err(js_error)
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

#[wasm_bindgen]
pub struct SpikePeer {
    inner: CoreSpikePeer,
}

#[wasm_bindgen]
impl SpikePeer {
    #[wasm_bindgen(constructor)]
    pub fn new(peer_id: u64) -> Result<SpikePeer, JsValue> {
        Ok(Self {
            inner: CoreSpikePeer::new(peer_id).map_err(js_error)?,
        })
    }

    pub fn edit(&self, value: &str) -> Result<(), JsValue> {
        self.inner.edit(value).map_err(js_error)
    }

    pub fn export_all(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_all().map_err(js_error)
    }

    pub fn import(&self, update: &[u8]) -> Result<(), JsValue> {
        self.inner.import(update).map_err(js_error)
    }

    pub fn hash(&self) -> Result<String, JsValue> {
        self.inner.hash().map_err(js_error)
    }
}
