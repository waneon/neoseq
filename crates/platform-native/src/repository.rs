use graph_core::{
    AppendReceipt, CheckpointRecord, GraphLocator, GraphMetadata, GraphRepository,
    LocalGraphRepository, QuarantineRecord, SCHEMA_VERSION, StorageCapabilities, UpdateRecord,
    checksum,
};
use rusqlite::{Connection, ErrorCode, OptionalExtension, Transaction, params};
use std::path::Path;
use thiserror::Error;

pub const SQLITE_SCHEMA_VERSION: i64 = 1;

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultPoint {
    AppendBeforeCommit,
    AppendAfterCommit,
    CheckpointBeforeCommit,
    CheckpointAfterCommit,
    Busy,
    DiskFull,
}

#[derive(Debug, Error)]
pub enum SqliteRepositoryError {
    #[error("SQLite database is busy")]
    Busy,
    #[error("SQLite storage is full")]
    DiskFull,
    #[error("SQLite database is corrupt: {0}")]
    Corrupt(String),
    #[error("graph is not present in local storage")]
    NotFound,
    #[cfg(debug_assertions)]
    #[error("injected failure at {0}")]
    Injected(&'static str),
    #[error("SQLite operation failed: {0}")]
    Sqlite(String),
}

impl From<rusqlite::Error> for SqliteRepositoryError {
    fn from(error: rusqlite::Error) -> Self {
        match sqlite_code(&error) {
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => Self::Busy,
            Some(ErrorCode::DiskFull) => Self::DiskFull,
            Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => {
                Self::Corrupt(error.to_string())
            }
            _ => Self::Sqlite(error.to_string()),
        }
    }
}

fn sqlite_code(error: &rusqlite::Error) -> Option<ErrorCode> {
    match error {
        rusqlite::Error::SqliteFailure(failure, _) => Some(failure.code),
        _ => None,
    }
}

pub struct SqliteGraphRepository {
    connection: Connection,
    locator: GraphLocator,
    #[cfg(debug_assertions)]
    fault: Option<FaultPoint>,
}

impl SqliteGraphRepository {
    pub fn open(
        path: &Path,
        locator: GraphLocator,
        now: &str,
        suggested_replica_id: u64,
    ) -> Result<Self, SqliteRepositoryError> {
        let mut connection = Connection::open(path).map_err(SqliteRepositoryError::from)?;
        connection
            .busy_timeout(std::time::Duration::ZERO)
            .map_err(SqliteRepositoryError::from)?;
        let journal_mode: String = connection
            .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
            .map_err(SqliteRepositoryError::from)?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Err(SqliteRepositoryError::Sqlite(
                "WAL journal mode was not enabled".to_owned(),
            ));
        }
        initialize_schema(&mut connection)?;
        connection
            .execute(
                "INSERT INTO graph_metadata(
                    graph_id, replica_id, history_epoch, schema_version,
                    next_sequence, compacted_through, checkpoint_bytes,
                    tail_bytes, tail_count, created_at, updated_at
                 ) VALUES (?1, ?2, 0, ?3, 1, 0, 0, 0, 0, ?4, ?4)
                 ON CONFLICT(graph_id) DO NOTHING",
                params![
                    locator.graph_id.as_str(),
                    as_i64(suggested_replica_id)?,
                    SCHEMA_VERSION,
                    now
                ],
            )
            .map_err(SqliteRepositoryError::from)?;
        connection
            .execute(
                "UPDATE graph_metadata SET replica_id = ?2
                 WHERE graph_id = ?1 AND replica_id = 0",
                params![locator.graph_id.as_str(), as_i64(suggested_replica_id)?],
            )
            .map_err(SqliteRepositoryError::from)?;
        Ok(Self {
            connection,
            locator,
            #[cfg(debug_assertions)]
            fault: None,
        })
    }

    #[cfg(debug_assertions)]
    pub fn inject_once(&mut self, fault: FaultPoint) {
        self.fault = Some(fault);
    }

    pub fn journal_mode(&self) -> Result<String, SqliteRepositoryError> {
        self.connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(SqliteRepositoryError::from)
    }

    pub fn schema_version(&self) -> Result<i64, SqliteRepositoryError> {
        self.connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(SqliteRepositoryError::from)
    }

    pub fn truncate_update(&mut self, sequence: u64) -> Result<(), SqliteRepositoryError> {
        let bytes: Vec<u8> = self
            .connection
            .query_row(
                "SELECT payload FROM graph_update WHERE graph_id = ?1 AND local_sequence = ?2",
                params![self.locator.graph_id.as_str(), as_i64(sequence)?],
                |row| row.get(0),
            )
            .map_err(SqliteRepositoryError::from)?;
        let truncated = &bytes[..bytes.len().saturating_sub(1)];
        self.connection
            .execute(
                "UPDATE graph_update SET payload = ?3
                 WHERE graph_id = ?1 AND local_sequence = ?2",
                params![self.locator.graph_id.as_str(), as_i64(sequence)?, truncated],
            )
            .map_err(SqliteRepositoryError::from)?;
        Ok(())
    }

    pub fn update_count(&self) -> Result<usize, SqliteRepositoryError> {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM graph_update WHERE graph_id = ?1",
                [self.locator.graph_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value as usize)
            .map_err(SqliteRepositoryError::from)
    }

    pub fn checkpoint_count(&self) -> Result<usize, SqliteRepositoryError> {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM graph_checkpoint WHERE graph_id = ?1",
                [self.locator.graph_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value as usize)
            .map_err(SqliteRepositoryError::from)
    }

    pub fn set_schema_version(&mut self, schema_version: u32) -> Result<(), SqliteRepositoryError> {
        self.connection
            .execute(
                "UPDATE graph_metadata SET schema_version = ?2 WHERE graph_id = ?1",
                params![self.locator.graph_id.as_str(), i64::from(schema_version)],
            )
            .map_err(SqliteRepositoryError::from)?;
        Ok(())
    }

    #[cfg(debug_assertions)]
    fn take_fault(&mut self, expected: FaultPoint) -> bool {
        if self.fault == Some(expected) {
            self.fault = None;
            true
        } else {
            false
        }
    }

    #[cfg(debug_assertions)]
    fn injected_storage_fault(&mut self) -> Result<(), SqliteRepositoryError> {
        if self.take_fault(FaultPoint::Busy) {
            Err(SqliteRepositoryError::Busy)
        } else if self.take_fault(FaultPoint::DiskFull) {
            Err(SqliteRepositoryError::DiskFull)
        } else {
            Ok(())
        }
    }
}

impl GraphRepository for SqliteGraphRepository {
    type Error = SqliteRepositoryError;

    fn append_update(
        &mut self,
        update: &[u8],
        created_at: &str,
    ) -> Result<AppendReceipt, Self::Error> {
        #[cfg(debug_assertions)]
        {
            self.injected_storage_fault()?;
            if self.take_fault(FaultPoint::AppendBeforeCommit) {
                return Err(SqliteRepositoryError::Injected("append-before-commit"));
            }
        }
        let digest = checksum(update);
        if let Some(sequence) = existing_sequence(&self.connection, &self.locator, &digest)? {
            return Ok(AppendReceipt {
                local_sequence: sequence,
                checksum: digest,
            });
        }
        let graph_id = self.locator.graph_id.to_string();
        let transaction = self
            .connection
            .transaction()
            .map_err(SqliteRepositoryError::from)?;
        let sequence = next_sequence(&transaction, &graph_id)?;
        transaction
            .execute(
                "INSERT INTO graph_update(
                    graph_id, local_sequence, checksum, payload, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![graph_id, as_i64(sequence)?, digest, update, created_at],
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction
            .execute(
                "UPDATE graph_metadata
                 SET next_sequence = ?2, tail_bytes = tail_bytes + ?3,
                     tail_count = tail_count + 1, updated_at = ?4
                 WHERE graph_id = ?1",
                params![
                    graph_id,
                    as_i64(sequence + 1)?,
                    as_i64(update.len() as u64)?,
                    created_at
                ],
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction.commit().map_err(SqliteRepositoryError::from)?;
        #[cfg(debug_assertions)]
        if self.take_fault(FaultPoint::AppendAfterCommit) {
            return Err(SqliteRepositoryError::Injected("append-after-commit"));
        }
        Ok(AppendReceipt {
            local_sequence: sequence,
            checksum: digest,
        })
    }
}

impl LocalGraphRepository for SqliteGraphRepository {
    fn metadata(&mut self) -> Result<GraphMetadata, Self::Error> {
        let row = self
            .connection
            .query_row(
                "SELECT replica_id, history_epoch, schema_version, next_sequence,
                        compacted_through, checkpoint_bytes, tail_bytes,
                        tail_count, created_at, updated_at
                 FROM graph_metadata WHERE graph_id = ?1",
                [self.locator.graph_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()
            .map_err(SqliteRepositoryError::from)?
            .ok_or(SqliteRepositoryError::NotFound)?;
        Ok(GraphMetadata {
            locator: GraphLocator {
                graph_id: self.locator.graph_id.clone(),
            },
            replica_id: as_u64(row.0)?,
            history_epoch: as_u64(row.1)?,
            schema_version: as_u32(row.2)?,
            next_sequence: as_u64(row.3)?,
            compacted_through: as_u64(row.4)?,
            checkpoint_bytes: as_u64(row.5)?,
            tail_bytes: as_u64(row.6)?,
            tail_count: as_u64(row.7)?,
            created_at: row.8,
            updated_at: row.9,
        })
    }

    fn checkpoints_descending(&mut self) -> Result<Vec<CheckpointRecord>, Self::Error> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT local_sequence, schema_version, checksum, payload, created_at
                 FROM graph_checkpoint WHERE graph_id = ?1 ORDER BY local_sequence DESC",
            )
            .map_err(SqliteRepositoryError::from)?;
        let rows = statement
            .query_map([self.locator.graph_id.as_str()], |row| {
                Ok(CheckpointRecord {
                    local_sequence: row.get::<_, i64>(0)? as u64,
                    schema_version: row.get::<_, i64>(1)? as u32,
                    checksum: row.get(2)?,
                    bytes: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(SqliteRepositoryError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(SqliteRepositoryError::from)
    }

    fn updates_after(&mut self, local_sequence: u64) -> Result<Vec<UpdateRecord>, Self::Error> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT local_sequence, checksum, payload, created_at
                 FROM graph_update
                 WHERE graph_id = ?1 AND local_sequence > ?2
                 ORDER BY local_sequence",
            )
            .map_err(SqliteRepositoryError::from)?;
        let rows = statement
            .query_map(
                params![self.locator.graph_id.as_str(), as_i64(local_sequence)?],
                |row| {
                    Ok(UpdateRecord {
                        local_sequence: row.get::<_, i64>(0)? as u64,
                        checksum: row.get(1)?,
                        bytes: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                },
            )
            .map_err(SqliteRepositoryError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(SqliteRepositoryError::from)
    }

    fn install_checkpoint(
        &mut self,
        checkpoint: &[u8],
        local_sequence: u64,
        created_at: &str,
    ) -> Result<String, Self::Error> {
        #[cfg(debug_assertions)]
        {
            self.injected_storage_fault()?;
            if self.take_fault(FaultPoint::CheckpointBeforeCommit) {
                return Err(SqliteRepositoryError::Injected("checkpoint-before-commit"));
            }
        }
        let digest = checksum(checkpoint);
        let transaction = self
            .connection
            .transaction()
            .map_err(SqliteRepositoryError::from)?;
        let sequence = as_i64(local_sequence)?;
        let (compacted_through, next_sequence): (i64, i64) = transaction
            .query_row(
                "SELECT compacted_through, next_sequence FROM graph_metadata
                 WHERE graph_id = ?1",
                [self.locator.graph_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(SqliteRepositoryError::from)?;
        if sequence < compacted_through || sequence >= next_sequence {
            return Err(SqliteRepositoryError::Corrupt(
                "checkpoint sequence is outside the durable frontier".to_owned(),
            ));
        }
        transaction
            .execute(
                "INSERT INTO graph_checkpoint(
                    graph_id, local_sequence, schema_version, checksum, payload, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(graph_id, local_sequence) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    checksum = excluded.checksum,
                    payload = excluded.payload,
                    created_at = excluded.created_at",
                params![
                    self.locator.graph_id.as_str(),
                    sequence,
                    SCHEMA_VERSION,
                    digest,
                    checkpoint,
                    created_at
                ],
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction
            .execute(
                "DELETE FROM graph_checkpoint
                 WHERE graph_id = ?1 AND local_sequence NOT IN (
                     SELECT local_sequence FROM graph_checkpoint
                     WHERE graph_id = ?1 ORDER BY local_sequence DESC LIMIT 2
                 )",
                [self.locator.graph_id.as_str()],
            )
            .map_err(SqliteRepositoryError::from)?;
        let reclaim_through: Option<i64> = transaction
            .query_row(
                "SELECT MIN(local_sequence) FROM graph_checkpoint WHERE graph_id = ?1",
                [self.locator.graph_id.as_str()],
                |row| row.get(0),
            )
            .map_err(SqliteRepositoryError::from)?;
        if let Some(reclaim_through) = reclaim_through {
            transaction
                .execute(
                    "DELETE FROM graph_update
                     WHERE graph_id = ?1 AND local_sequence <= ?2",
                    params![self.locator.graph_id.as_str(), reclaim_through],
                )
                .map_err(SqliteRepositoryError::from)?;
        }
        let (tail_bytes, tail_count): (i64, i64) = transaction
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(payload)), 0), COUNT(*)
                 FROM graph_update WHERE graph_id = ?1",
                [self.locator.graph_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(SqliteRepositoryError::from)?;
        let checkpoint_bytes: i64 = transaction
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(payload)), 0)
                 FROM graph_checkpoint WHERE graph_id = ?1",
                [self.locator.graph_id.as_str()],
                |row| row.get(0),
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction
            .execute(
                "UPDATE graph_metadata
                 SET schema_version = ?2, compacted_through = MAX(compacted_through, ?3),
                     checkpoint_bytes = ?4, tail_bytes = ?5, tail_count = ?6,
                     updated_at = ?7
                 WHERE graph_id = ?1",
                params![
                    self.locator.graph_id.as_str(),
                    SCHEMA_VERSION,
                    as_i64(local_sequence)?,
                    checkpoint_bytes,
                    tail_bytes,
                    tail_count,
                    created_at
                ],
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction.commit().map_err(SqliteRepositoryError::from)?;
        #[cfg(debug_assertions)]
        if self.take_fault(FaultPoint::CheckpointAfterCommit) {
            return Err(SqliteRepositoryError::Injected("checkpoint-after-commit"));
        }
        Ok(digest)
    }

    fn quarantine(&mut self, record: &QuarantineRecord) -> Result<(), Self::Error> {
        self.connection
            .execute(
                "INSERT INTO graph_quarantine(
                    graph_id, export_handle, record_kind, local_sequence,
                    checksum, reason, payload, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(graph_id, export_handle) DO UPDATE SET
                    reason = excluded.reason, payload = excluded.payload",
                params![
                    self.locator.graph_id.as_str(),
                    record.export_handle,
                    record.record_kind,
                    as_i64(record.local_sequence)?,
                    record.checksum,
                    record.reason,
                    record.bytes,
                    record.created_at
                ],
            )
            .map_err(SqliteRepositoryError::from)?;
        Ok(())
    }

    fn repair_corrupt_tail(
        &mut self,
        checkpoint: &[u8],
        valid_through: u64,
        records: &[QuarantineRecord],
        created_at: &str,
    ) -> Result<String, Self::Error> {
        let digest = checksum(checkpoint);
        let transaction = self
            .connection
            .transaction()
            .map_err(SqliteRepositoryError::from)?;
        for record in records {
            transaction
                .execute(
                    "INSERT INTO graph_quarantine(
                        graph_id, export_handle, record_kind, local_sequence,
                        checksum, reason, payload, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(graph_id, export_handle) DO UPDATE SET
                        reason = excluded.reason, payload = excluded.payload",
                    params![
                        self.locator.graph_id.as_str(),
                        record.export_handle,
                        record.record_kind,
                        as_i64(record.local_sequence)?,
                        record.checksum,
                        record.reason,
                        record.bytes,
                        record.created_at
                    ],
                )
                .map_err(SqliteRepositoryError::from)?;
        }
        transaction
            .execute(
                "INSERT INTO graph_checkpoint(
                    graph_id, local_sequence, schema_version, checksum, payload, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(graph_id, local_sequence) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    checksum = excluded.checksum,
                    payload = excluded.payload,
                    created_at = excluded.created_at",
                params![
                    self.locator.graph_id.as_str(),
                    as_i64(valid_through)?,
                    SCHEMA_VERSION,
                    digest,
                    checkpoint,
                    created_at
                ],
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction
            .execute(
                "DELETE FROM graph_update
                 WHERE graph_id = ?1 AND local_sequence > ?2",
                params![self.locator.graph_id.as_str(), as_i64(valid_through)?],
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction
            .execute(
                "DELETE FROM graph_checkpoint
                 WHERE graph_id = ?1 AND local_sequence NOT IN (
                     SELECT local_sequence FROM graph_checkpoint
                     WHERE graph_id = ?1 ORDER BY local_sequence DESC LIMIT 2
                 )",
                [self.locator.graph_id.as_str()],
            )
            .map_err(SqliteRepositoryError::from)?;
        let (checkpoint_bytes, tail_bytes, tail_count): (i64, i64, i64) = transaction
            .query_row(
                "SELECT
                    (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM graph_checkpoint WHERE graph_id = ?1),
                    (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM graph_update WHERE graph_id = ?1),
                    (SELECT COUNT(*) FROM graph_update WHERE graph_id = ?1)",
                [self.locator.graph_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction
            .execute(
                "UPDATE graph_metadata
                 SET schema_version = ?2, compacted_through = ?3,
                     checkpoint_bytes = ?4, tail_bytes = ?5, tail_count = ?6,
                     updated_at = ?7
                 WHERE graph_id = ?1",
                params![
                    self.locator.graph_id.as_str(),
                    SCHEMA_VERSION,
                    as_i64(valid_through)?,
                    checkpoint_bytes,
                    tail_bytes,
                    tail_count,
                    created_at
                ],
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction.commit().map_err(SqliteRepositoryError::from)?;
        Ok(digest)
    }

    fn quarantined(&mut self) -> Result<Vec<QuarantineRecord>, Self::Error> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT export_handle, record_kind, local_sequence, checksum,
                        reason, payload, created_at
                 FROM graph_quarantine WHERE graph_id = ?1 ORDER BY export_handle",
            )
            .map_err(SqliteRepositoryError::from)?;
        let rows = statement
            .query_map([self.locator.graph_id.as_str()], |row| {
                Ok(QuarantineRecord {
                    export_handle: row.get(0)?,
                    record_kind: row.get(1)?,
                    local_sequence: row.get::<_, i64>(2)? as u64,
                    checksum: row.get(3)?,
                    reason: row.get(4)?,
                    bytes: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(SqliteRepositoryError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(SqliteRepositoryError::from)
    }

    fn delete_local(mut self) -> Result<(), Self::Error> {
        let transaction = self
            .connection
            .transaction()
            .map_err(SqliteRepositoryError::from)?;
        for table in [
            "graph_quarantine",
            "graph_checkpoint",
            "graph_update",
            "graph_metadata",
        ] {
            transaction
                .execute(
                    &format!("DELETE FROM {table} WHERE graph_id = ?1"),
                    [self.locator.graph_id.as_str()],
                )
                .map_err(SqliteRepositoryError::from)?;
        }
        transaction.commit().map_err(SqliteRepositoryError::from)
    }

    fn capabilities(&self) -> StorageCapabilities {
        StorageCapabilities {
            durable: true,
            persisted: Some(true),
            quota_bytes: None,
            usage_bytes: None,
        }
    }
}

fn initialize_schema(connection: &mut Connection) -> Result<(), SqliteRepositoryError> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(SqliteRepositoryError::from)?;
    if version != 0 && version != SQLITE_SCHEMA_VERSION {
        return Err(SqliteRepositoryError::Corrupt(format!(
            "unsupported SQLite schema version {version}"
        )));
    }
    if version == 0 {
        let transaction = connection
            .transaction()
            .map_err(SqliteRepositoryError::from)?;
        transaction
            .execute_batch(
                "CREATE TABLE graph_metadata (
                    graph_id TEXT PRIMARY KEY,
                    replica_id INTEGER NOT NULL,
                    history_epoch INTEGER NOT NULL DEFAULT 0,
                    schema_version INTEGER NOT NULL,
                    next_sequence INTEGER NOT NULL,
                    compacted_through INTEGER NOT NULL,
                    checkpoint_bytes INTEGER NOT NULL DEFAULT 0,
                    tail_bytes INTEGER NOT NULL DEFAULT 0,
                    tail_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 CREATE TABLE graph_update (
                    graph_id TEXT NOT NULL,
                    local_sequence INTEGER NOT NULL,
                    checksum TEXT NOT NULL,
                    payload BLOB NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(graph_id, local_sequence),
                    UNIQUE(graph_id, checksum),
                    FOREIGN KEY(graph_id) REFERENCES graph_metadata(graph_id)
                 );
                 CREATE TABLE graph_checkpoint (
                    graph_id TEXT NOT NULL,
                    local_sequence INTEGER NOT NULL,
                    schema_version INTEGER NOT NULL,
                    checksum TEXT NOT NULL,
                    payload BLOB NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(graph_id, local_sequence),
                    FOREIGN KEY(graph_id) REFERENCES graph_metadata(graph_id)
                 );
                 CREATE TABLE graph_quarantine (
                    graph_id TEXT NOT NULL,
                    export_handle TEXT NOT NULL,
                    record_kind TEXT NOT NULL,
                    local_sequence INTEGER NOT NULL,
                    checksum TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    payload BLOB NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(graph_id, export_handle)
                 );",
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction
            .pragma_update(None, "user_version", SQLITE_SCHEMA_VERSION)
            .map_err(SqliteRepositoryError::from)?;
        transaction.commit().map_err(SqliteRepositoryError::from)?;
    }
    Ok(())
}

fn existing_sequence(
    connection: &Connection,
    locator: &GraphLocator,
    digest: &str,
) -> Result<Option<u64>, SqliteRepositoryError> {
    connection
        .query_row(
            "SELECT local_sequence FROM graph_update WHERE graph_id = ?1 AND checksum = ?2",
            params![locator.graph_id.as_str(), digest],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map(|value| value.map(|sequence| sequence as u64))
        .map_err(SqliteRepositoryError::from)
}

fn next_sequence(
    transaction: &Transaction<'_>,
    graph_id: &str,
) -> Result<u64, SqliteRepositoryError> {
    transaction
        .query_row(
            "SELECT next_sequence FROM graph_metadata WHERE graph_id = ?1",
            [graph_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(SqliteRepositoryError::from)
        .and_then(as_u64)
}

fn as_i64(value: u64) -> Result<i64, SqliteRepositoryError> {
    i64::try_from(value)
        .map_err(|_| SqliteRepositoryError::Corrupt("sequence exceeds SQLite range".to_owned()))
}

fn as_u64(value: i64) -> Result<u64, SqliteRepositoryError> {
    u64::try_from(value)
        .map_err(|_| SqliteRepositoryError::Corrupt("negative local sequence".to_owned()))
}

fn as_u32(value: i64) -> Result<u32, SqliteRepositoryError> {
    u32::try_from(value)
        .map_err(|_| SqliteRepositoryError::Corrupt("invalid schema version".to_owned()))
}
