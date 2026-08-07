use crate::{CoreError, GraphCore, SCHEMA_VERSION};
use domain::GraphId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphLocation {
    Local,
    Remote { remote_graph_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphLocator {
    pub graph_id: GraphId,
    pub location: GraphLocation,
}

impl GraphLocator {
    pub fn local(graph_id: GraphId) -> Self {
        Self {
            graph_id,
            location: GraphLocation::Local,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphMetadata {
    pub locator: GraphLocator,
    pub schema_version: u32,
    pub next_sequence: u64,
    pub compacted_through: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateRecord {
    pub local_sequence: u64,
    pub checksum: String,
    pub bytes: Vec<u8>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointRecord {
    pub local_sequence: u64,
    pub schema_version: u32,
    pub checksum: String,
    pub bytes: Vec<u8>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuarantineRecord {
    pub export_handle: String,
    pub record_kind: String,
    pub local_sequence: u64,
    pub checksum: String,
    pub reason: String,
    pub bytes: Vec<u8>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageCapabilities {
    pub durable: bool,
    pub persisted: Option<bool>,
    pub quota_bytes: Option<u64>,
    pub usage_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendReceipt {
    pub local_sequence: u64,
    pub checksum: String,
}

pub trait GraphRepository {
    type Error: std::error::Error + Send + Sync + 'static;

    fn append_update(
        &mut self,
        update: &[u8],
        created_at: &str,
    ) -> Result<AppendReceipt, Self::Error>;
}

pub trait LocalGraphRepository: GraphRepository {
    fn metadata(&mut self) -> Result<GraphMetadata, Self::Error>;
    fn checkpoints_descending(&mut self) -> Result<Vec<CheckpointRecord>, Self::Error>;
    fn updates_after(&mut self, local_sequence: u64) -> Result<Vec<UpdateRecord>, Self::Error>;
    fn save_checkpoint(
        &mut self,
        checkpoint: &[u8],
        local_sequence: u64,
        created_at: &str,
    ) -> Result<String, Self::Error>;
    fn mark_compacted(&mut self, through_sequence: u64) -> Result<(), Self::Error>;
    fn load_index_cache(&mut self, key: &str) -> Result<Option<Vec<u8>>, Self::Error>;
    fn store_index_cache(&mut self, key: &str, value: &[u8]) -> Result<(), Self::Error>;
    fn set_schema_version(&mut self, schema_version: u32) -> Result<(), Self::Error>;
    fn quarantine(&mut self, record: &QuarantineRecord) -> Result<(), Self::Error>;
    fn quarantined(&mut self) -> Result<Vec<QuarantineRecord>, Self::Error>;
    fn delete_local(self) -> Result<(), Self::Error>;
    fn capabilities(&self) -> StorageCapabilities;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryReport {
    pub checkpoint_sequence: u64,
    pub replayed_updates: usize,
    pub quarantined_records: Vec<String>,
}

#[derive(Debug, Error)]
pub enum RecoveryError {
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error("repository operation failed: {0}")]
    Repository(String),
    #[error("stored graph has checkpoints but none are valid")]
    NoValidCheckpoint,
}

pub fn checksum(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn valid_checksum(expected: &str, bytes: &[u8]) -> bool {
    checksum(bytes) == expected
}

pub fn recover_graph<R: LocalGraphRepository>(
    repository: &mut R,
    graph_id: GraphId,
    peer_id: u64,
    now: &str,
) -> Result<(GraphCore, RecoveryReport), RecoveryError> {
    let metadata = repository.metadata().map_err(repository_error)?;
    if !matches!(metadata.schema_version, 3 | SCHEMA_VERSION) {
        return Err(RecoveryError::Core(CoreError::UnsupportedSchema(
            i64::from(metadata.schema_version),
        )));
    }
    let mut selected = None;
    let mut quarantined = Vec::new();

    let checkpoints = repository
        .checkpoints_descending()
        .map_err(repository_error)?;
    let had_checkpoints = !checkpoints.is_empty();
    for checkpoint in checkpoints {
        let reason = if !matches!(checkpoint.schema_version, 3 | SCHEMA_VERSION) {
            Some(format!(
                "unsupported-checkpoint-schema:{}",
                checkpoint.schema_version
            ))
        } else if !valid_checksum(&checkpoint.checksum, &checkpoint.bytes) {
            Some("checkpoint-checksum-mismatch".to_owned())
        } else {
            match GraphCore::from_snapshot(graph_id.clone(), peer_id, &checkpoint.bytes) {
                Ok(core) => {
                    selected = Some((core, checkpoint.local_sequence));
                    None
                }
                Err(error) => Some(format!("invalid-checkpoint:{error}")),
            }
        };
        if selected.is_some() {
            break;
        }
        if let Some(reason) = reason {
            let export_handle = format!("checkpoint-{}", checkpoint.local_sequence);
            repository
                .quarantine(&QuarantineRecord {
                    export_handle: export_handle.clone(),
                    record_kind: "checkpoint".to_owned(),
                    local_sequence: checkpoint.local_sequence,
                    checksum: checkpoint.checksum,
                    reason,
                    bytes: checkpoint.bytes,
                    created_at: now.to_owned(),
                })
                .map_err(repository_error)?;
            quarantined.push(export_handle);
        }
    }

    if selected.is_none() && had_checkpoints {
        return Err(RecoveryError::NoValidCheckpoint);
    }
    let (mut core, checkpoint_sequence) = match selected {
        Some(value) => value,
        None => (GraphCore::new(graph_id, peer_id, now)?, 0),
    };
    let mut replayed = 0;
    let mut tail_is_corrupt = false;
    for update in repository
        .updates_after(checkpoint_sequence)
        .map_err(repository_error)?
    {
        let reason = if tail_is_corrupt {
            Some("after-corrupt-tail".to_owned())
        } else if !valid_checksum(&update.checksum, &update.bytes) {
            tail_is_corrupt = true;
            Some("update-checksum-mismatch".to_owned())
        } else if let Err(error) = core.import_remote(&update.bytes) {
            tail_is_corrupt = true;
            Some(format!("invalid-update:{error}"))
        } else {
            replayed += 1;
            None
        };
        if let Some(reason) = reason {
            let export_handle = format!("update-{}", update.local_sequence);
            repository
                .quarantine(&QuarantineRecord {
                    export_handle: export_handle.clone(),
                    record_kind: "update".to_owned(),
                    local_sequence: update.local_sequence,
                    checksum: update.checksum,
                    reason,
                    bytes: update.bytes,
                    created_at: now.to_owned(),
                })
                .map_err(repository_error)?;
            quarantined.push(export_handle);
        }
    }

    if metadata.schema_version == 3 {
        let sequence = metadata.next_sequence.saturating_sub(1);
        repository
            .save_checkpoint(&core.export_snapshot()?, sequence, now)
            .map_err(repository_error)?;
        repository
            .set_schema_version(SCHEMA_VERSION)
            .map_err(repository_error)?;
    }

    Ok((
        core,
        RecoveryReport {
            checkpoint_sequence,
            replayed_updates: replayed,
            quarantined_records: quarantined,
        },
    ))
}

fn repository_error(error: impl std::fmt::Display) -> RecoveryError {
    RecoveryError::Repository(error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckpointPolicy {
    pub update_count: usize,
    pub update_bytes: usize,
    pub idle_ticks: u64,
}

impl Default for CheckpointPolicy {
    fn default() -> Self {
        Self {
            update_count: 128,
            update_bytes: 4 * 1024 * 1024,
            idle_ticks: 30,
        }
    }
}

#[derive(Debug, Default)]
pub struct CheckpointTracker {
    updates: usize,
    bytes: usize,
    last_write_tick: u64,
}

impl CheckpointTracker {
    pub fn record_update(&mut self, bytes: usize, tick: u64) {
        self.updates += 1;
        self.bytes += bytes;
        self.last_write_tick = tick;
    }

    pub fn should_checkpoint(&self, policy: CheckpointPolicy, current_tick: u64) -> bool {
        self.updates >= policy.update_count
            || self.bytes >= policy.update_bytes
            || (self.updates > 0
                && current_tick.saturating_sub(self.last_write_tick) >= policy.idle_ticks)
    }

    pub fn checkpointed(&mut self) {
        self.updates = 0;
        self.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistence_checksum_and_checkpoint_policy_are_deterministic() {
        assert_eq!(checksum(b"neoseq"), checksum(b"neoseq"));
        assert!(!valid_checksum(&checksum(b"other"), b"neoseq"));
        let mut tracker = CheckpointTracker::default();
        tracker.record_update(7, 10);
        assert!(tracker.should_checkpoint(
            CheckpointPolicy {
                update_count: 2,
                update_bytes: 8,
                idle_ticks: 5,
            },
            15
        ));
    }
}
