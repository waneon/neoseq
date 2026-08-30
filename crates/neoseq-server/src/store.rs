use async_trait::async_trait;
use graph_core::checksum;
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgPoolOptions};
use thiserror::Error;

const DATABASE_MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_initial.sql")];
pub const DATABASE_SCHEMA_VERSION: i32 = DATABASE_MIGRATIONS.len() as i32;
const MAX_RETAINED_RECEIPTS: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphStatus {
    Active,
    ReadOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphRole {
    Owner,
    Editor,
    Viewer,
}

impl GraphRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Editor => "editor",
            Self::Viewer => "viewer",
        }
    }

    fn parse(value: &str) -> Result<Self, StoreError> {
        match value {
            "owner" => Ok(Self::Owner),
            "editor" => Ok(Self::Editor),
            "viewer" => Ok(Self::Viewer),
            _ => Err(StoreError::Corrupt("invalid membership role")),
        }
    }

    pub const fn can_write(self) -> bool {
        matches!(self, Self::Owner | Self::Editor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Membership {
    pub role: GraphRole,
    pub version: u64,
    pub schema_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphListing {
    pub graph_id: String,
    pub role: GraphRole,
    pub status: GraphStatus,
    pub membership_version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MembershipListing {
    pub account_id: String,
    pub role: GraphRole,
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredUpdate {
    pub cursor: u64,
    pub message_id: String,
    pub checksum: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCheckpoint {
    pub history_epoch: u64,
    pub included_cursor: u64,
    pub snapshot: Vec<u8>,
    pub version_vector: Vec<u8>,
    pub checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphLoad {
    pub schema_version: u32,
    pub history_epoch: u64,
    pub checkpoint: StoredCheckpoint,
    pub updates: Vec<StoredUpdate>,
}

impl GraphLoad {
    pub fn latest_cursor(&self) -> u64 {
        self.updates
            .last()
            .map_or(self.checkpoint.included_cursor, |update| update.cursor)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommitOutcome {
    pub cursor: u64,
    pub inserted: bool,
}

#[derive(Debug, Error)]
pub enum StoreError {
    /// Used for missing graphs as well as missing/revoked memberships so callers
    /// cannot use error shape to discover graph existence.
    #[error("graph access denied")]
    AccessDenied,
    #[error("membership is read-only")]
    ReadOnly,
    #[error("owner membership is established only when a graph is created")]
    InvalidMembershipRole,
    #[error("graph byte quota exceeded")]
    QuotaExceeded,
    #[error("message id was already committed with different bytes")]
    MessageConflict,
    #[error("history epoch changed while checkpoint was being installed")]
    StaleHistory,
    #[error("database schema {found} does not match required schema {required}")]
    SchemaMismatch { found: i32, required: i32 },
    #[error("durable graph data is corrupt: {0}")]
    Corrupt(&'static str),
    #[error("storage is unavailable: {0}")]
    Unavailable(&'static str),
    #[error("database operation failed: {0}")]
    Database(String),
}

impl From<sqlx::Error> for StoreError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error.to_string())
    }
}

#[async_trait]
pub trait GraphStore: Send + Sync + 'static {
    async fn ready(&self) -> Result<(), StoreError>;

    async fn authorize(&self, graph_id: &str, account_id: &str) -> Result<Membership, StoreError>;

    async fn load_graph(&self, graph_id: &str) -> Result<GraphLoad, StoreError>;

    async fn commit_update(
        &self,
        graph_id: &str,
        account_id: &str,
        message_id: &str,
        bytes: &[u8],
    ) -> Result<CommitOutcome, StoreError>;

    async fn install_checkpoint(
        &self,
        graph_id: &str,
        expected_epoch: u64,
        included_cursor: u64,
        schema_version: u32,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<u64, StoreError>;
}

#[async_trait]
pub trait GraphAdmin: GraphStore {
    async fn create_graph(
        &self,
        graph_id: &str,
        owner_account_id: &str,
        schema_version: u32,
        byte_quota: u64,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<(), StoreError>;

    async fn list_graphs(&self, account_id: &str) -> Result<Vec<GraphListing>, StoreError>;

    async fn list_memberships(&self, graph_id: &str) -> Result<Vec<MembershipListing>, StoreError>;

    async fn grant_membership(
        &self,
        graph_id: &str,
        account_id: &str,
        role: GraphRole,
    ) -> Result<u64, StoreError>;

    async fn revoke_membership(&self, graph_id: &str, account_id: &str) -> Result<u64, StoreError>;
}

#[derive(Clone)]
pub struct PgStore {
    pool: PgPool,
}

impl PgStore {
    pub async fn connect(database_url: &str, max_connections: u32) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(database_url)
            .await?;
        Self::from_pool(pool).await
    }

    pub async fn from_pool(pool: PgPool) -> Result<Self, StoreError> {
        initialize_schema(&pool).await?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    async fn insert_graph(
        &self,
        graph_id: &str,
        owner_account_id: &str,
        schema_version: u32,
        byte_quota: u64,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<(), StoreError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO graph(graph_id, schema_version, byte_quota, used_bytes)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(graph_id)
        .bind(i32::try_from(schema_version).map_err(|_| StoreError::Corrupt("schema overflow"))?)
        .bind(as_i64(byte_quota)?)
        .bind(as_i64(snapshot.len() as u64)?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO graph_membership(graph_id, account_id, role, version)
             VALUES ($1, $2, 'owner', 1)",
        )
        .bind(graph_id)
        .bind(owner_account_id)
        .execute(&mut *transaction)
        .await?;
        let checkpoint_id: i64 = sqlx::query_scalar(
            "INSERT INTO graph_checkpoint(
                graph_id, included_cursor, snapshot, version_vector, checksum, size_bytes
             ) VALUES ($1, 0, $2, $3, $4, $5)
             RETURNING checkpoint_id",
        )
        .bind(graph_id)
        .bind(snapshot)
        .bind(version_vector)
        .bind(checksum(snapshot))
        .bind(as_i64(snapshot.len() as u64)?)
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query("UPDATE graph SET checkpoint_id = $2 WHERE graph_id = $1")
            .bind(graph_id)
            .bind(checkpoint_id)
            .execute(&mut *transaction)
            .await?;
        audit(
            &mut transaction,
            graph_id,
            owner_account_id,
            "graph.create",
            "ok",
        )
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    async fn upsert_membership(
        &self,
        graph_id: &str,
        account_id: &str,
        role: GraphRole,
    ) -> Result<u64, StoreError> {
        if role == GraphRole::Owner {
            return Err(StoreError::InvalidMembershipRole);
        }
        let mut transaction = self.pool.begin().await?;
        let version = bump_membership_version(&mut transaction, graph_id).await?;
        sqlx::query(
            "INSERT INTO graph_membership(graph_id, account_id, role, version, revoked_at)
             VALUES ($1, $2, $3, $4, NULL)
             ON CONFLICT(graph_id, account_id) DO UPDATE
             SET role = EXCLUDED.role, version = EXCLUDED.version, revoked_at = NULL",
        )
        .bind(graph_id)
        .bind(account_id)
        .bind(role.as_str())
        .bind(as_i64(version)?)
        .execute(&mut *transaction)
        .await?;
        audit(
            &mut transaction,
            graph_id,
            account_id,
            "membership.grant",
            "ok",
        )
        .await?;
        transaction.commit().await?;
        Ok(version)
    }

    async fn revoke_membership_row(
        &self,
        graph_id: &str,
        account_id: &str,
    ) -> Result<u64, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let version = bump_membership_version(&mut transaction, graph_id).await?;
        let affected = sqlx::query(
            "UPDATE graph_membership
             SET revoked_at = NOW(), version = $3
             WHERE graph_id = $1 AND account_id = $2 AND revoked_at IS NULL",
        )
        .bind(graph_id)
        .bind(account_id)
        .bind(as_i64(version)?)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        if affected == 0 {
            return Err(StoreError::AccessDenied);
        }
        audit(
            &mut transaction,
            graph_id,
            account_id,
            "membership.revoke",
            "ok",
        )
        .await?;
        transaction.commit().await?;
        Ok(version)
    }
}

async fn initialize_schema(pool: &PgPool) -> Result<(), StoreError> {
    let mut transaction = pool.begin().await?;
    // Serializes initialization and forward migrations across stateless instances.
    sqlx::query("SELECT pg_advisory_xact_lock(715887124)")
        .execute(&mut *transaction)
        .await?;
    let table: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('public.neoseq_schema_version')::text")
            .fetch_one(&mut *transaction)
            .await?;
    let found = if table.is_some() {
        sqlx::query_scalar("SELECT version FROM neoseq_schema_version WHERE singleton = TRUE")
            .fetch_one(&mut *transaction)
            .await?
    } else {
        sqlx::query(
            "CREATE TABLE neoseq_schema_version (
                singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
                version INTEGER NOT NULL CHECK (version >= 0)
             )",
        )
        .execute(&mut *transaction)
        .await?;
        sqlx::query("INSERT INTO neoseq_schema_version(singleton, version) VALUES (TRUE, 0)")
            .execute(&mut *transaction)
            .await?;
        0
    };
    if !(0..=DATABASE_SCHEMA_VERSION).contains(&found) {
        return Err(StoreError::SchemaMismatch {
            found,
            required: DATABASE_SCHEMA_VERSION,
        });
    }
    for (index, migration) in DATABASE_MIGRATIONS.iter().enumerate().skip(found as usize) {
        sqlx::raw_sql(migration).execute(&mut *transaction).await?;
        sqlx::query("UPDATE neoseq_schema_version SET version = $1 WHERE singleton = TRUE")
            .bind((index + 1) as i32)
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn bump_membership_version(
    transaction: &mut Transaction<'_, Postgres>,
    graph_id: &str,
) -> Result<u64, StoreError> {
    let version: i64 = sqlx::query_scalar(
        "UPDATE graph SET membership_version = membership_version + 1
         WHERE graph_id = $1 RETURNING membership_version",
    )
    .bind(graph_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StoreError::AccessDenied)?;
    as_u64(version)
}

async fn audit(
    transaction: &mut Transaction<'_, Postgres>,
    graph_id: &str,
    account_id: &str,
    action: &str,
    result: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO graph_audit_event(graph_id, account_id, action, result_code)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(graph_id)
    .bind(account_id)
    .bind(action)
    .bind(result)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

#[async_trait]
impl GraphStore for PgStore {
    async fn ready(&self) -> Result<(), StoreError> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    async fn authorize(&self, graph_id: &str, account_id: &str) -> Result<Membership, StoreError> {
        let row = sqlx::query(
            "SELECT m.role, m.version, g.schema_version
             FROM graph_membership m
             JOIN graph g ON g.graph_id = m.graph_id
             WHERE m.graph_id = $1 AND m.account_id = $2 AND m.revoked_at IS NULL",
        )
        .bind(graph_id)
        .bind(account_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::AccessDenied)?;
        Ok(Membership {
            role: GraphRole::parse(row.try_get("role")?)?,
            version: as_u64(row.try_get("version")?)?,
            schema_version: as_u32(row.try_get("schema_version")?)?,
        })
    }

    async fn load_graph(&self, graph_id: &str) -> Result<GraphLoad, StoreError> {
        let row = sqlx::query(
            "SELECT g.schema_version, g.history_epoch, c.history_epoch AS checkpoint_epoch,
                    c.included_cursor, c.snapshot, c.version_vector, c.checksum
             FROM graph g
             JOIN graph_checkpoint c ON c.checkpoint_id = g.checkpoint_id
             WHERE g.graph_id = $1",
        )
        .bind(graph_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::AccessDenied)?;
        let snapshot: Vec<u8> = row.try_get("snapshot")?;
        let snapshot_checksum: String = row.try_get("checksum")?;
        if checksum(&snapshot) != snapshot_checksum {
            return Err(StoreError::Corrupt("checkpoint checksum mismatch"));
        }
        let included_cursor = as_u64(row.try_get("included_cursor")?)?;
        let history_epoch = as_u64(row.try_get("history_epoch")?)?;
        if as_u64(row.try_get("checkpoint_epoch")?)? != history_epoch {
            return Err(StoreError::Corrupt("checkpoint history epoch mismatch"));
        }
        let update_rows = sqlx::query(
            "SELECT cursor, message_id, checksum, payload
             FROM graph_update
             WHERE graph_id = $1 AND cursor > $2 ORDER BY cursor",
        )
        .bind(graph_id)
        .bind(as_i64(included_cursor)?)
        .fetch_all(&self.pool)
        .await?;
        let mut updates = Vec::with_capacity(update_rows.len());
        for update in update_rows {
            let bytes: Vec<u8> = update.try_get("payload")?;
            let expected: String = update.try_get("checksum")?;
            if checksum(&bytes) != expected {
                return Err(StoreError::Corrupt("update checksum mismatch"));
            }
            updates.push(StoredUpdate {
                cursor: as_u64(update.try_get("cursor")?)?,
                message_id: update.try_get("message_id")?,
                checksum: expected,
                bytes,
            });
        }
        Ok(GraphLoad {
            schema_version: as_u32(row.try_get("schema_version")?)?,
            history_epoch,
            checkpoint: StoredCheckpoint {
                history_epoch,
                included_cursor,
                snapshot,
                version_vector: row.try_get("version_vector")?,
                checksum: snapshot_checksum,
            },
            updates,
        })
    }

    async fn commit_update(
        &self,
        graph_id: &str,
        account_id: &str,
        message_id: &str,
        bytes: &[u8],
    ) -> Result<CommitOutcome, StoreError> {
        let mut transaction = self.pool.begin().await?;
        // Authorization and graph quota are checked under the same graph lock as
        // the durable insert, closing the revoke/check-of-use race.
        let row = sqlx::query(
            "SELECT m.role, g.status, g.byte_quota, g.used_bytes
             FROM graph g
             JOIN graph_membership m ON m.graph_id = g.graph_id
             WHERE g.graph_id = $1 AND m.account_id = $2 AND m.revoked_at IS NULL
             FOR UPDATE OF g",
        )
        .bind(graph_id)
        .bind(account_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::AccessDenied)?;
        let role = GraphRole::parse(row.try_get("role")?)?;
        if !role.can_write() || parse_status(row.try_get("status")?)? == GraphStatus::ReadOnly {
            return Err(StoreError::ReadOnly);
        }
        let digest = checksum(bytes);
        if let Some(row) = sqlx::query(
            "SELECT cursor, checksum FROM graph_update
             WHERE graph_id = $1 AND message_id = $2
             UNION ALL
             SELECT cursor, checksum FROM graph_update_receipt
             WHERE graph_id = $1 AND message_id = $2
             LIMIT 1",
        )
        .bind(graph_id)
        .bind(message_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            if row.try_get::<String, _>("checksum")? != digest {
                return Err(StoreError::MessageConflict);
            }
            transaction.commit().await?;
            return Ok(CommitOutcome {
                cursor: as_u64(row.try_get("cursor")?)?,
                inserted: false,
            });
        }
        let quota = as_u64(row.try_get("byte_quota")?)?;
        let used = as_u64(row.try_get("used_bytes")?)?;
        let next_used = used
            .checked_add(bytes.len() as u64)
            .ok_or(StoreError::QuotaExceeded)?;
        if next_used > quota {
            return Err(StoreError::QuotaExceeded);
        }
        let cursor: i64 = sqlx::query_scalar(
            "INSERT INTO graph_update(
                graph_id, message_id, account_id, checksum, payload, size_bytes
             ) VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING cursor",
        )
        .bind(graph_id)
        .bind(message_id)
        .bind(account_id)
        .bind(&digest)
        .bind(bytes)
        .bind(as_i64(bytes.len() as u64)?)
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query("UPDATE graph SET used_bytes = $2 WHERE graph_id = $1")
            .bind(graph_id)
            .bind(as_i64(next_used)?)
            .execute(&mut *transaction)
            .await?;
        audit(
            &mut transaction,
            graph_id,
            account_id,
            "update.commit",
            "ok",
        )
        .await?;
        transaction.commit().await?;
        Ok(CommitOutcome {
            cursor: as_u64(cursor)?,
            inserted: true,
        })
    }

    async fn install_checkpoint(
        &self,
        graph_id: &str,
        expected_epoch: u64,
        included_cursor: u64,
        schema_version: u32,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<u64, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT history_epoch, byte_quota, checkpoint_id FROM graph
             WHERE graph_id = $1 FOR UPDATE",
        )
        .bind(graph_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::AccessDenied)?;
        if as_u64(row.try_get("history_epoch")?)? != expected_epoch {
            return Err(StoreError::StaleHistory);
        }
        let next_epoch = expected_epoch
            .checked_add(1)
            .ok_or(StoreError::Corrupt("history epoch overflow"))?;
        let prior_checkpoint_id: i64 = row.try_get("checkpoint_id")?;
        let prior = sqlx::query(
            "SELECT included_cursor, size_bytes FROM graph_checkpoint
             WHERE graph_id = $1 AND checkpoint_id = $2",
        )
        .bind(graph_id)
        .bind(prior_checkpoint_id)
        .fetch_one(&mut *transaction)
        .await?;
        let prior_cursor = as_u64(prior.try_get("included_cursor")?)?;
        if included_cursor < prior_cursor {
            return Err(StoreError::StaleHistory);
        }
        let prior_checkpoint_bytes = as_u64(prior.try_get("size_bytes")?)?;
        let tail_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(size_bytes), 0)::BIGINT FROM graph_update
             WHERE graph_id = $1 AND cursor > $2",
        )
        .bind(graph_id)
        .bind(as_i64(prior_cursor)?)
        .fetch_one(&mut *transaction)
        .await?;
        let used_bytes = (snapshot.len() as u64)
            .checked_add(prior_checkpoint_bytes)
            .ok_or(StoreError::QuotaExceeded)?
            .checked_add(as_u64(tail_bytes)?)
            .ok_or(StoreError::QuotaExceeded)?;
        if used_bytes > as_u64(row.try_get("byte_quota")?)? {
            return Err(StoreError::QuotaExceeded);
        }
        let checkpoint_id: i64 = sqlx::query_scalar(
            "INSERT INTO graph_checkpoint(
                graph_id, history_epoch, included_cursor, snapshot,
                version_vector, checksum, size_bytes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING checkpoint_id",
        )
        .bind(graph_id)
        .bind(as_i64(next_epoch)?)
        .bind(as_i64(included_cursor)?)
        .bind(snapshot)
        .bind(version_vector)
        .bind(checksum(snapshot))
        .bind(as_i64(snapshot.len() as u64)?)
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO graph_update_receipt(
                graph_id, message_id, checksum, cursor, received_at
             ) SELECT graph_id, message_id, checksum, cursor, received_at
               FROM graph_update WHERE graph_id = $1 AND cursor <= $2
             ON CONFLICT(graph_id, message_id) DO NOTHING",
        )
        .bind(graph_id)
        .bind(as_i64(included_cursor)?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "DELETE FROM graph_update_receipt
             WHERE graph_id = $1 AND message_id NOT IN (
                 SELECT message_id FROM graph_update_receipt
                 WHERE graph_id = $1 ORDER BY cursor DESC LIMIT $2
             )",
        )
        .bind(graph_id)
        .bind(as_i64(MAX_RETAINED_RECEIPTS as u64)?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("DELETE FROM graph_update WHERE graph_id = $1 AND cursor <= $2")
            .bind(graph_id)
            .bind(as_i64(prior_cursor)?)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "UPDATE graph SET checkpoint_id = $2, history_epoch = $3,
                              schema_version = $4, used_bytes = $5
             WHERE graph_id = $1",
        )
        .bind(graph_id)
        .bind(checkpoint_id)
        .bind(as_i64(next_epoch)?)
        .bind(i32::try_from(schema_version).map_err(|_| StoreError::Corrupt("schema overflow"))?)
        .bind(as_i64(used_bytes)?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "DELETE FROM graph_checkpoint
             WHERE graph_id = $1 AND checkpoint_id NOT IN ($2, $3)",
        )
        .bind(graph_id)
        .bind(checkpoint_id)
        .bind(prior_checkpoint_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(next_epoch)
    }
}

#[async_trait]
impl GraphAdmin for PgStore {
    async fn create_graph(
        &self,
        graph_id: &str,
        owner_account_id: &str,
        schema_version: u32,
        byte_quota: u64,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<(), StoreError> {
        self.insert_graph(
            graph_id,
            owner_account_id,
            schema_version,
            byte_quota,
            snapshot,
            version_vector,
        )
        .await
    }

    async fn list_graphs(&self, account_id: &str) -> Result<Vec<GraphListing>, StoreError> {
        let rows = sqlx::query(
            "SELECT g.graph_id, m.role, g.status, g.membership_version
             FROM graph g
             JOIN graph_membership m ON m.graph_id = g.graph_id
             WHERE m.account_id = $1 AND m.revoked_at IS NULL
             ORDER BY g.created_at, g.graph_id",
        )
        .bind(account_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(GraphListing {
                    graph_id: row.try_get("graph_id")?,
                    role: GraphRole::parse(row.try_get("role")?)?,
                    status: parse_status(row.try_get("status")?)?,
                    membership_version: as_u64(row.try_get("membership_version")?)?,
                })
            })
            .collect()
    }

    async fn list_memberships(&self, graph_id: &str) -> Result<Vec<MembershipListing>, StoreError> {
        let rows = sqlx::query(
            "SELECT account_id, role, version
             FROM graph_membership
             WHERE graph_id = $1 AND revoked_at IS NULL
             ORDER BY account_id",
        )
        .bind(graph_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(MembershipListing {
                    account_id: row.try_get("account_id")?,
                    role: GraphRole::parse(row.try_get("role")?)?,
                    version: as_u64(row.try_get("version")?)?,
                })
            })
            .collect()
    }

    async fn grant_membership(
        &self,
        graph_id: &str,
        account_id: &str,
        role: GraphRole,
    ) -> Result<u64, StoreError> {
        self.upsert_membership(graph_id, account_id, role).await
    }

    async fn revoke_membership(&self, graph_id: &str, account_id: &str) -> Result<u64, StoreError> {
        self.revoke_membership_row(graph_id, account_id).await
    }
}

fn parse_status(value: &str) -> Result<GraphStatus, StoreError> {
    match value {
        "active" => Ok(GraphStatus::Active),
        "read_only" => Ok(GraphStatus::ReadOnly),
        _ => Err(StoreError::Corrupt("invalid graph status")),
    }
}

fn as_u64(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| StoreError::Corrupt("negative database integer"))
}

fn as_u32(value: i32) -> Result<u32, StoreError> {
    u32::try_from(value).map_err(|_| StoreError::Corrupt("negative database integer"))
}

fn as_i64(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| StoreError::Corrupt("database integer overflow"))
}
