//! Disposable Step 1 relay protocol. This is not the production sync protocol.

use serde::{Deserialize, Serialize};

pub const SPIKE_PROTOCOL_VERSION: u16 = 0;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SpikeMessage {
    Hello { peer: String },
    Update { peer: String, payload: Vec<u8> },
    Ack { received: usize },
}
