//! Disposable Loro feasibility surface for Step 1.

use domain::{PingRequest, PingResponse};
use loro::{ExportMode, LoroDoc, LoroEncodeError, LoroError, ToJson};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const FIXTURE_PEER_ID: u64 = 1;

#[derive(Debug, Error)]
pub enum SpikeError {
    #[error("Loro operation failed: {0}")]
    Loro(#[from] LoroError),
    #[error("Loro export failed: {0}")]
    Encode(#[from] LoroEncodeError),
    #[error("fixture JSON encoding failed: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn ping(client_version: impl Into<String>) -> PingResponse {
    domain::ping(PingRequest {
        client_version: client_version.into(),
    })
}

pub fn fixture_document() -> Result<LoroDoc, SpikeError> {
    let doc = LoroDoc::new();
    doc.set_peer_id(FIXTURE_PEER_ID)?;

    doc.get_text("markdown")
        .insert(0, "# NeoSeq\n\nlocal-first spike")?;

    let properties = doc.get_map("properties");
    properties.insert("page.title", "Step 1")?;
    properties.insert("task.status", "todo")?;
    properties.insert("task.deadline", "2026-08-02")?;

    let outline = doc.get_tree("outline");
    outline.enable_fractional_index(0);
    let root = outline.create(None)?;
    outline
        .get_meta(root)?
        .insert("block.page", "page-step-1")?;
    let child = outline.create(root)?;
    outline.get_meta(child)?.insert("depth", 1_i64)?;

    doc.commit();
    Ok(doc)
}

pub fn fixture_snapshot() -> Result<Vec<u8>, SpikeError> {
    Ok(fixture_document()?.export(ExportMode::Snapshot)?)
}

pub fn semantic_json(doc: &LoroDoc) -> Result<String, SpikeError> {
    let value = doc.get_deep_value().to_json_value();
    Ok(serde_json::to_string(&value)?)
}

pub fn semantic_hash(doc: &LoroDoc) -> Result<String, SpikeError> {
    let digest = Sha256::digest(semantic_json(doc)?.as_bytes());
    Ok(hex::encode(digest))
}

pub fn fixture_hash() -> Result<String, SpikeError> {
    semantic_hash(&fixture_document()?)
}

pub fn restore_snapshot(snapshot: &[u8]) -> Result<LoroDoc, SpikeError> {
    Ok(LoroDoc::from_snapshot(snapshot)?)
}

pub struct SpikePeer {
    doc: LoroDoc,
}

impl SpikePeer {
    pub fn new(peer_id: u64) -> Result<Self, SpikeError> {
        let doc = restore_snapshot(&fixture_snapshot()?)?;
        doc.set_peer_id(peer_id)?;
        Ok(Self { doc })
    }

    pub fn edit(&self, value: &str) -> Result<(), SpikeError> {
        let text = self.doc.get_text("sync");
        text.insert(text.len_unicode(), value)?;
        self.doc.commit();
        Ok(())
    }

    pub fn export_all(&self) -> Result<Vec<u8>, SpikeError> {
        Ok(self.doc.export(ExportMode::all_updates())?)
    }

    pub fn import(&self, update: &[u8]) -> Result<(), SpikeError> {
        self.doc.import(update)?;
        Ok(())
    }

    pub fn hash(&self) -> Result<String, SpikeError> {
        semantic_hash(&self.doc)
    }

    pub fn json(&self) -> Result<String, SpikeError> {
        semantic_json(&self.doc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_round_trip_preserves_semantics() {
        let doc = fixture_document().unwrap();
        let restored = restore_snapshot(&doc.export(ExportMode::Snapshot).unwrap()).unwrap();
        assert_eq!(
            semantic_json(&doc).unwrap(),
            semantic_json(&restored).unwrap()
        );
    }

    #[test]
    fn duplicate_and_reordered_updates_converge() {
        let left = SpikePeer::new(2).unwrap();
        let right = SpikePeer::new(3).unwrap();

        left.edit("left-1|").unwrap();
        let left_first = left.export_all().unwrap();
        left.edit("left-2|").unwrap();
        let left_second = left.export_all().unwrap();

        right.edit("right-1|").unwrap();
        let right_update = right.export_all().unwrap();

        right.import(&left_second).unwrap();
        right.import(&left_first).unwrap();
        right.import(&left_second).unwrap();
        left.import(&right_update).unwrap();
        left.import(&right_update).unwrap();

        assert_eq!(left.json().unwrap(), right.json().unwrap());
    }
}
