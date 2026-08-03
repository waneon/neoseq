use graph_core::{
    AppendReceipt, CheckpointRecord, GraphLocation, GraphLocator, GraphMetadata, GraphRepository,
    LocalGraphRepository, QuarantineRecord, StorageCapabilities, UpdateRecord, checksum,
};
use rusqlite::{Connection, ErrorCode, OptionalExtension, Transaction, params};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const SQLITE_SCHEMA_VERSION: i64 = 1;

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
    #[error("remote graph locators are not available in local-only mode")]
    RemoteUnavailable,
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
    path: PathBuf,
    locator: GraphLocator,
    fault: Option<FaultPoint>,
}

impl SqliteGraphRepository {
    pub fn open(
        path: &Path,
        locator: GraphLocator,
        now: &str,
    ) -> Result<Self, SqliteRepositoryError> {
        if !matches!(locator.location, GraphLocation::Local) {
            return Err(SqliteRepositoryError::RemoteUnavailable);
        }
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
        migrate(&mut connection)?;
        let location = serde_json::to_string(&locator.location)
            .map_err(|error| SqliteRepositoryError::Sqlite(error.to_string()))?;
        connection
            .execute(
                "INSERT INTO graph_metadata(
                    graph_id, location, schema_version, next_sequence,
                    compacted_through, created_at, updated_at
                 ) VALUES (?1, ?2, 1, 1, 0, ?3, ?3)
                 ON CONFLICT(graph_id) DO NOTHING",
                params![locator.graph_id.as_str(), location, now],
            )
            .map_err(SqliteRepositoryError::from)?;
        Ok(Self {
            connection,
            path: path.to_owned(),
            locator,
            fault: None,
        })
    }

    pub fn inject_once(&mut self, fault: FaultPoint) {
        self.fault = Some(fault);
    }

    pub fn path(&self) -> &Path {
        &self.path
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

    pub fn set_schema_version(&mut self, schema_version: u32) -> Result<(), SqliteRepositoryError> {
        self.connection
            .execute(
                "UPDATE graph_metadata SET schema_version = ?2 WHERE graph_id = ?1",
                params![self.locator.graph_id.as_str(), i64::from(schema_version)],
            )
            .map_err(SqliteRepositoryError::from)?;
        Ok(())
    }

    fn take_fault(&mut self, expected: FaultPoint) -> bool {
        if self.fault == Some(expected) {
            self.fault = None;
            true
        } else {
            false
        }
    }

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
        self.injected_storage_fault()?;
        if self.take_fault(FaultPoint::AppendBeforeCommit) {
            return Err(SqliteRepositoryError::Injected("append-before-commit"));
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
                "INSERT INTO graph_outbox(graph_id, local_sequence, ready)
                 VALUES (?1, ?2, 1)",
                params![graph_id, as_i64(sequence)?],
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction
            .execute(
                "UPDATE graph_metadata
                 SET next_sequence = ?2, updated_at = ?3 WHERE graph_id = ?1",
                params![graph_id, as_i64(sequence + 1)?, created_at],
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction.commit().map_err(SqliteRepositoryError::from)?;
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
                "SELECT location, schema_version, next_sequence, compacted_through,
                        created_at, updated_at
                 FROM graph_metadata WHERE graph_id = ?1",
                [self.locator.graph_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(SqliteRepositoryError::from)?
            .ok_or(SqliteRepositoryError::NotFound)?;
        let location = serde_json::from_str(&row.0)
            .map_err(|error| SqliteRepositoryError::Corrupt(error.to_string()))?;
        Ok(GraphMetadata {
            locator: GraphLocator {
                graph_id: self.locator.graph_id.clone(),
                location,
            },
            schema_version: as_u32(row.1)?,
            next_sequence: as_u64(row.2)?,
            compacted_through: as_u64(row.3)?,
            created_at: row.4,
            updated_at: row.5,
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

    fn save_checkpoint(
        &mut self,
        checkpoint: &[u8],
        local_sequence: u64,
        created_at: &str,
    ) -> Result<String, Self::Error> {
        self.injected_storage_fault()?;
        if self.take_fault(FaultPoint::CheckpointBeforeCommit) {
            return Err(SqliteRepositoryError::Injected("checkpoint-before-commit"));
        }
        let digest = checksum(checkpoint);
        let transaction = self
            .connection
            .transaction()
            .map_err(SqliteRepositoryError::from)?;
        transaction
            .execute(
                "INSERT INTO graph_checkpoint(
                    graph_id, local_sequence, schema_version, checksum, payload, created_at
                 ) VALUES (?1, ?2, 1, ?3, ?4, ?5)
                 ON CONFLICT(graph_id, local_sequence) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    checksum = excluded.checksum,
                    payload = excluded.payload,
                    created_at = excluded.created_at",
                params![
                    self.locator.graph_id.as_str(),
                    as_i64(local_sequence)?,
                    digest,
                    checkpoint,
                    created_at
                ],
            )
            .map_err(SqliteRepositoryError::from)?;
        transaction.commit().map_err(SqliteRepositoryError::from)?;
        if self.take_fault(FaultPoint::CheckpointAfterCommit) {
            return Err(SqliteRepositoryError::Injected("checkpoint-after-commit"));
        }
        Ok(digest)
    }

    fn mark_compacted(&mut self, through_sequence: u64) -> Result<(), Self::Error> {
        self.connection
            .execute(
                "UPDATE graph_metadata SET compacted_through = MAX(compacted_through, ?2)
                 WHERE graph_id = ?1",
                params![self.locator.graph_id.as_str(), as_i64(through_sequence)?],
            )
            .map_err(SqliteRepositoryError::from)?;
        Ok(())
    }

    fn load_index_cache(&mut self, key: &str) -> Result<Option<Vec<u8>>, Self::Error> {
        self.connection
            .query_row(
                "SELECT payload FROM graph_index_cache WHERE graph_id = ?1 AND cache_key = ?2",
                params![self.locator.graph_id.as_str(), key],
                |row| row.get(0),
            )
            .optional()
            .map_err(SqliteRepositoryError::from)
    }

    fn store_index_cache(&mut self, key: &str, value: &[u8]) -> Result<(), Self::Error> {
        self.connection
            .execute(
                "INSERT INTO graph_index_cache(graph_id, cache_key, payload)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(graph_id, cache_key) DO UPDATE SET payload = excluded.payload",
                params![self.locator.graph_id.as_str(), key, value],
            )
            .map_err(SqliteRepositoryError::from)?;
        Ok(())
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
            "graph_outbox",
            "graph_index_cache",
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

fn migrate(connection: &mut Connection) -> Result<(), SqliteRepositoryError> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(SqliteRepositoryError::from)?;
    if version > SQLITE_SCHEMA_VERSION {
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
                    location TEXT NOT NULL,
                    schema_version INTEGER NOT NULL,
                    next_sequence INTEGER NOT NULL,
                    compacted_through INTEGER NOT NULL,
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
                 CREATE TABLE graph_outbox (
                    graph_id TEXT NOT NULL,
                    local_sequence INTEGER NOT NULL,
                    ready INTEGER NOT NULL,
                    acknowledged_at TEXT,
                    PRIMARY KEY(graph_id, local_sequence),
                    FOREIGN KEY(graph_id, local_sequence)
                      REFERENCES graph_update(graph_id, local_sequence)
                 );
                 CREATE TABLE graph_index_cache (
                    graph_id TEXT NOT NULL,
                    cache_key TEXT NOT NULL,
                    payload BLOB NOT NULL,
                    PRIMARY KEY(graph_id, cache_key)
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
