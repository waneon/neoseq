use crate::{CoreError, GraphCore, SCHEMA_VERSION};
use domain::GraphId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphLocator {
    pub graph_id: GraphId,
}

impl GraphLocator {
    pub fn local(graph_id: GraphId) -> Self {
        Self { graph_id }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphMetadata {
    pub locator: GraphLocator,
    pub replica_id: u64,
    pub history_epoch: u64,
    pub schema_version: u32,
    pub next_sequence: u64,
    pub compacted_through: u64,
    pub checkpoint_bytes: u64,
    pub tail_bytes: u64,
    pub tail_count: u64,
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
    /// Atomically installs a recovery checkpoint, advances the logical
    /// compacted sequence, and retains exactly one fallback generation.
    fn install_checkpoint(
        &mut self,
        checkpoint: &[u8],
        local_sequence: u64,
        created_at: &str,
    ) -> Result<String, Self::Error>;
    fn quarantine(&mut self, record: &QuarantineRecord) -> Result<(), Self::Error>;
    /// Atomically publishes the last valid state and moves the corrupt Tail
    /// suffix out of the active recovery log without reusing its sequences.
    fn repair_corrupt_tail(
        &mut self,
        checkpoint: &[u8],
        valid_through: u64,
        records: &[QuarantineRecord],
        created_at: &str,
    ) -> Result<String, Self::Error>;
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
    now: &str,
) -> Result<(GraphCore, RecoveryReport), RecoveryError> {
    let metadata = repository.metadata().map_err(repository_error)?;
    let peer_id = metadata.replica_id;
    if metadata.schema_version != SCHEMA_VERSION {
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
        let reason = if checkpoint.schema_version != SCHEMA_VERSION {
            Some(format!(
                "unsupported-checkpoint-schema:{}",
                checkpoint.schema_version
            ))
        } else if !valid_checksum(&checkpoint.checksum, &checkpoint.bytes) {
            Some("checkpoint-checksum-mismatch".to_owned())
        } else {
            match GraphCore::from_recovery_snapshot(graph_id.clone(), peer_id, &checkpoint.bytes) {
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
    let mut valid_through = checkpoint_sequence;
    let mut corrupt_tail = Vec::new();
    for update in repository
        .updates_after(checkpoint_sequence)
        .map_err(repository_error)?
    {
        let reason = if tail_is_corrupt {
            Some("after-corrupt-tail".to_owned())
        } else if !valid_checksum(&update.checksum, &update.bytes) {
            tail_is_corrupt = true;
            Some("update-checksum-mismatch".to_owned())
        } else if let Err(error) = core.import_recovery_update(&update.bytes) {
            tail_is_corrupt = true;
            Some(format!("invalid-update:{error}"))
        } else {
            replayed += 1;
            valid_through = update.local_sequence;
            None
        };
        if let Some(reason) = reason {
            let export_handle = format!("update-{}", update.local_sequence);
            corrupt_tail.push(QuarantineRecord {
                export_handle: export_handle.clone(),
                record_kind: "update".to_owned(),
                local_sequence: update.local_sequence,
                checksum: update.checksum,
                reason,
                bytes: update.bytes,
                created_at: now.to_owned(),
            });
            quarantined.push(export_handle);
        }
    }

    core.finish_recovery()?;

    if !corrupt_tail.is_empty() {
        let checkpoint = core.export_gc_checkpoint()?;
        repository
            .repair_corrupt_tail(&checkpoint, valid_through, &corrupt_tail, now)
            .map_err(repository_error)?;
    }

    // Recovery is a hard session-local undo boundary. Tail updates may carry
    // this replica's peer ID, but they were already durable before this runtime
    // opened and have no ephemeral HistoryEntry in the new process.
    core.reset_local_history();

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistence_checksum_is_deterministic() {
        assert_eq!(checksum(b"neoseq"), checksum(b"neoseq"));
        assert!(!valid_checksum(&checksum(b"other"), b"neoseq"));
    }
}
