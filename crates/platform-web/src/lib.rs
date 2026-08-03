//! wasm-bindgen feasibility adapter. It is intentionally smaller than CorePort v1.

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
