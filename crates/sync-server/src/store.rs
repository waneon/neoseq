use async_trait::async_trait;
use graph_core::checksum;
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgPoolOptions};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use sync_protocol::GraphStatus;
use thiserror::Error;

pub const DATABASE_SCHEMA_VERSION: i32 = 1;

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
    pub principal_id: String,
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
    pub principal_id: String,
    pub role: GraphRole,
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredUpdate {
    pub cursor: u64,
    pub message_id: String,
    pub principal_id: String,
    pub checksum: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCheckpoint {
    pub included_cursor: u64,
    pub snapshot: Vec<u8>,
    pub version_vector: Vec<u8>,
    pub checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphLoad {
    pub graph_id: String,
    pub owner_principal_id: String,
    pub status: GraphStatus,
    pub schema_version: u32,
    pub byte_quota: u64,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphBackup {
    pub graph: GraphLoad,
    pub memberships: Vec<(String, GraphRole, u64, bool)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommitOutcome {
    pub cursor: u64,
    pub inserted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultPoint {
    BeforeCommit,
    AfterCommit,
}

#[derive(Debug, Error)]
pub enum StoreError {
    /// Used for missing graphs as well as missing/revoked memberships so callers
    /// cannot use error shape to discover graph existence.
    #[error("graph access denied")]
    AccessDenied,
    #[error("membership is read-only")]
    ReadOnly,
    #[error("graph byte quota exceeded")]
    QuotaExceeded,
    #[error("message id was already committed with different bytes")]
    MessageConflict,
    #[error("database schema {found} is newer than supported schema {supported}")]
    SchemaTooNew { found: i32, supported: i32 },
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

    async fn authorize(&self, graph_id: &str, principal_id: &str)
    -> Result<Membership, StoreError>;

    async fn load_graph(&self, graph_id: &str) -> Result<GraphLoad, StoreError>;

    async fn commit_update(
        &self,
        graph_id: &str,
        principal_id: &str,
        message_id: &str,
        bytes: &[u8],
    ) -> Result<CommitOutcome, StoreError>;
}

#[async_trait]
pub trait GraphAdmin: GraphStore {
    async fn create_remote_graph(
        &self,
        graph_id: &str,
        owner_principal_id: &str,
        schema_version: u32,
        byte_quota: u64,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<(), StoreError>;

    async fn list_graphs(&self, principal_id: &str) -> Result<Vec<GraphListing>, StoreError>;

    async fn list_memberships(&self, graph_id: &str) -> Result<Vec<MembershipListing>, StoreError>;

    async fn grant_membership(
        &self,
        graph_id: &str,
        principal_id: &str,
        role: GraphRole,
    ) -> Result<u64, StoreError>;

    async fn revoke_membership(
        &self,
        graph_id: &str,
        principal_id: &str,
    ) -> Result<u64, StoreError>;
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
        migrate(&pool).await?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn create_graph(
        &self,
        graph_id: &str,
        owner_principal_id: &str,
        schema_version: u32,
        byte_quota: u64,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<(), StoreError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO graph(
                graph_id, owner_principal_id, schema_version, byte_quota, used_bytes
             ) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(graph_id)
        .bind(owner_principal_id)
        .bind(i32::try_from(schema_version).map_err(|_| StoreError::Corrupt("schema overflow"))?)
        .bind(as_i64(byte_quota)?)
        .bind(as_i64(snapshot.len() as u64)?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO graph_membership(graph_id, principal_id, role, version)
             VALUES ($1, $2, 'owner', 1)",
        )
        .bind(graph_id)
        .bind(owner_principal_id)
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
            owner_principal_id,
            "graph.create",
            "ok",
        )
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn grant(
        &self,
        graph_id: &str,
        principal_id: &str,
        role: GraphRole,
    ) -> Result<u64, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let version = bump_membership_version(&mut transaction, graph_id).await?;
        sqlx::query(
            "INSERT INTO graph_membership(graph_id, principal_id, role, version, revoked_at)
             VALUES ($1, $2, $3, $4, NULL)
             ON CONFLICT(graph_id, principal_id) DO UPDATE
             SET role = EXCLUDED.role, version = EXCLUDED.version, revoked_at = NULL",
        )
        .bind(graph_id)
        .bind(principal_id)
        .bind(role.as_str())
        .bind(as_i64(version)?)
        .execute(&mut *transaction)
        .await?;
        audit(
            &mut transaction,
            graph_id,
            principal_id,
            "membership.grant",
            "ok",
        )
        .await?;
        transaction.commit().await?;
        Ok(version)
    }

    pub async fn revoke(&self, graph_id: &str, principal_id: &str) -> Result<u64, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let version = bump_membership_version(&mut transaction, graph_id).await?;
        let affected = sqlx::query(
            "UPDATE graph_membership
             SET revoked_at = NOW(), version = $3
             WHERE graph_id = $1 AND principal_id = $2 AND revoked_at IS NULL",
        )
        .bind(graph_id)
        .bind(principal_id)
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
            principal_id,
            "membership.revoke",
            "ok",
        )
        .await?;
        transaction.commit().await?;
        Ok(version)
    }

    pub async fn backup_graph(&self, graph_id: &str) -> Result<GraphBackup, StoreError> {
        let graph = self.load_graph(graph_id).await?;
        let rows = sqlx::query(
            "SELECT principal_id, role, version, revoked_at IS NOT NULL AS revoked
             FROM graph_membership WHERE graph_id = $1 ORDER BY principal_id",
        )
        .bind(graph_id)
        .fetch_all(&self.pool)
        .await?;
        let mut memberships = Vec::with_capacity(rows.len());
        for row in rows {
            memberships.push((
                row.try_get("principal_id")?,
                GraphRole::parse(row.try_get("role")?)?,
                as_u64(row.try_get("version")?)?,
                row.try_get("revoked")?,
            ));
        }
        Ok(GraphBackup { graph, memberships })
    }

    /// Restores a logical test backup into an empty graph slot. Production
    /// backups remain PostgreSQL-native; this path makes restore correctness a
    /// deterministic integration-test contract.
    pub async fn restore_graph(&self, backup: &GraphBackup) -> Result<(), StoreError> {
        let graph = &backup.graph;
        let used_bytes = graph.checkpoint.snapshot.len() as u64
            + graph
                .updates
                .iter()
                .map(|update| update.bytes.len() as u64)
                .sum::<u64>();
        let membership_version = backup
            .memberships
            .iter()
            .map(|entry| entry.2)
            .max()
            .unwrap_or(1);
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO graph(
                graph_id, owner_principal_id, status, schema_version, byte_quota,
                used_bytes, membership_version
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&graph.graph_id)
        .bind(&graph.owner_principal_id)
        .bind(match graph.status {
            GraphStatus::Active => "active",
            GraphStatus::ReadOnly => "read_only",
        })
        .bind(
            i32::try_from(graph.schema_version)
                .map_err(|_| StoreError::Corrupt("schema overflow"))?,
        )
        .bind(as_i64(graph.byte_quota)?)
        .bind(as_i64(used_bytes)?)
        .bind(as_i64(membership_version)?)
        .execute(&mut *transaction)
        .await?;
        let checkpoint_id: i64 = sqlx::query_scalar(
            "INSERT INTO graph_checkpoint(
                graph_id, included_cursor, snapshot, version_vector, checksum, size_bytes
             ) VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING checkpoint_id",
        )
        .bind(&graph.graph_id)
        .bind(as_i64(graph.checkpoint.included_cursor)?)
        .bind(&graph.checkpoint.snapshot)
        .bind(&graph.checkpoint.version_vector)
        .bind(&graph.checkpoint.checksum)
        .bind(as_i64(graph.checkpoint.snapshot.len() as u64)?)
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query("UPDATE graph SET checkpoint_id = $2 WHERE graph_id = $1")
            .bind(&graph.graph_id)
            .bind(checkpoint_id)
            .execute(&mut *transaction)
            .await?;
        for (principal, role, version, revoked) in &backup.memberships {
            sqlx::query(
                "INSERT INTO graph_membership(
                    graph_id, principal_id, role, version, revoked_at
                 ) VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN NOW() ELSE NULL END)",
            )
            .bind(&graph.graph_id)
            .bind(principal)
            .bind(role.as_str())
            .bind(as_i64(*version)?)
            .bind(*revoked)
            .execute(&mut *transaction)
            .await?;
        }
        for update in &graph.updates {
            sqlx::query(
                "INSERT INTO graph_update(
                    cursor, graph_id, message_id, principal_id, checksum, payload, size_bytes
                 ) OVERRIDING SYSTEM VALUE
                 VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(as_i64(update.cursor)?)
            .bind(&graph.graph_id)
            .bind(&update.message_id)
            .bind(&update.principal_id)
            .bind(&update.checksum)
            .bind(&update.bytes)
            .bind(as_i64(update.bytes.len() as u64)?)
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query(
            "SELECT setval(
                pg_get_serial_sequence('graph_update', 'cursor'),
                GREATEST(COALESCE((SELECT MAX(cursor) FROM graph_update), 1), 1),
                EXISTS(SELECT 1 FROM graph_update)
             )",
        )
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }
}

async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
    let mut transaction = pool.begin().await?;
    // Serializes first-start migration across otherwise stateless instances.
    sqlx::query("SELECT pg_advisory_xact_lock(715887124)")
        .execute(&mut *transaction)
        .await?;
    let table: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('public.neoseq_schema_version')::text")
            .fetch_one(&mut *transaction)
            .await?;
    if table.is_some() {
        let found: i32 =
            sqlx::query_scalar("SELECT version FROM neoseq_schema_version WHERE singleton = TRUE")
                .fetch_one(&mut *transaction)
                .await?;
        if found > DATABASE_SCHEMA_VERSION {
            return Err(StoreError::SchemaTooNew {
                found,
                supported: DATABASE_SCHEMA_VERSION,
            });
        }
    } else {
        sqlx::raw_sql(include_str!("../migrations/0001_sync.sql"))
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
    principal_id: &str,
    action: &str,
    result: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO graph_audit_event(graph_id, principal_id, action, result_code)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(graph_id)
    .bind(principal_id)
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

    async fn authorize(
        &self,
        graph_id: &str,
        principal_id: &str,
    ) -> Result<Membership, StoreError> {
        let row = sqlx::query(
            "SELECT m.role, m.version, g.schema_version
             FROM graph_membership m
             JOIN graph g ON g.graph_id = m.graph_id
             WHERE m.graph_id = $1 AND m.principal_id = $2 AND m.revoked_at IS NULL",
        )
        .bind(graph_id)
        .bind(principal_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::AccessDenied)?;
        Ok(Membership {
            principal_id: principal_id.to_owned(),
            role: GraphRole::parse(row.try_get("role")?)?,
            version: as_u64(row.try_get("version")?)?,
            schema_version: as_u32(row.try_get("schema_version")?)?,
        })
    }

    async fn load_graph(&self, graph_id: &str) -> Result<GraphLoad, StoreError> {
        let row = sqlx::query(
            "SELECT g.owner_principal_id, g.status, g.schema_version, g.byte_quota,
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
        let update_rows = sqlx::query(
            "SELECT cursor, message_id, principal_id, checksum, payload
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
                principal_id: update.try_get("principal_id")?,
                checksum: expected,
                bytes,
            });
        }
        Ok(GraphLoad {
            graph_id: graph_id.to_owned(),
            owner_principal_id: row.try_get("owner_principal_id")?,
            status: parse_status(row.try_get("status")?)?,
            schema_version: as_u32(row.try_get("schema_version")?)?,
            byte_quota: as_u64(row.try_get("byte_quota")?)?,
            checkpoint: StoredCheckpoint {
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
        principal_id: &str,
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
             WHERE g.graph_id = $1 AND m.principal_id = $2 AND m.revoked_at IS NULL
             FOR UPDATE OF g",
        )
        .bind(graph_id)
        .bind(principal_id)
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
             WHERE graph_id = $1 AND message_id = $2",
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
                graph_id, message_id, principal_id, checksum, payload, size_bytes
             ) VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING cursor",
        )
        .bind(graph_id)
        .bind(message_id)
        .bind(principal_id)
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
            principal_id,
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
}

#[async_trait]
impl GraphAdmin for PgStore {
    async fn create_remote_graph(
        &self,
        graph_id: &str,
        owner_principal_id: &str,
        schema_version: u32,
        byte_quota: u64,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<(), StoreError> {
        self.create_graph(
            graph_id,
            owner_principal_id,
            schema_version,
            byte_quota,
            snapshot,
            version_vector,
        )
        .await
    }

    async fn list_graphs(&self, principal_id: &str) -> Result<Vec<GraphListing>, StoreError> {
        let rows = sqlx::query(
            "SELECT g.graph_id, m.role, g.status, g.membership_version
             FROM graph g
             JOIN graph_membership m ON m.graph_id = g.graph_id
             WHERE m.principal_id = $1 AND m.revoked_at IS NULL
             ORDER BY g.created_at, g.graph_id",
        )
        .bind(principal_id)
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
            "SELECT principal_id, role, version
             FROM graph_membership
             WHERE graph_id = $1 AND revoked_at IS NULL
             ORDER BY principal_id",
        )
        .bind(graph_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(MembershipListing {
                    principal_id: row.try_get("principal_id")?,
                    role: GraphRole::parse(row.try_get("role")?)?,
                    version: as_u64(row.try_get("version")?)?,
                })
            })
            .collect()
    }

    async fn grant_membership(
        &self,
        graph_id: &str,
        principal_id: &str,
        role: GraphRole,
    ) -> Result<u64, StoreError> {
        self.grant(graph_id, principal_id, role).await
    }

    async fn revoke_membership(
        &self,
        graph_id: &str,
        principal_id: &str,
    ) -> Result<u64, StoreError> {
        self.revoke(graph_id, principal_id).await
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

#[derive(Clone, Default)]
pub struct MemoryStore {
    inner: Arc<Mutex<MemoryState>>,
}

#[derive(Default)]
struct MemoryState {
    graphs: HashMap<String, MemoryGraph>,
    next_cursor: u64,
    fault: Option<FaultPoint>,
    available: bool,
}

struct MemoryGraph {
    owner_principal_id: String,
    status: GraphStatus,
    schema_version: u32,
    byte_quota: u64,
    used_bytes: u64,
    checkpoint: StoredCheckpoint,
    updates: Vec<StoredUpdate>,
    memberships: HashMap<String, MemoryMembership>,
    membership_version: u64,
}

struct MemoryMembership {
    role: GraphRole,
    version: u64,
    revoked: bool,
}

impl MemoryStore {
    pub fn new() -> Self {
        let store = Self::default();
        store.inner.lock().expect("memory store mutex").available = true;
        store
    }

    pub fn seed_graph(
        &self,
        graph_id: &str,
        owner_principal_id: &str,
        schema_version: u32,
        byte_quota: u64,
        snapshot: Vec<u8>,
        version_vector: Vec<u8>,
    ) {
        let mut memberships = HashMap::new();
        memberships.insert(
            owner_principal_id.to_owned(),
            MemoryMembership {
                role: GraphRole::Owner,
                version: 1,
                revoked: false,
            },
        );
        self.inner
            .lock()
            .expect("memory store mutex")
            .graphs
            .insert(
                graph_id.to_owned(),
                MemoryGraph {
                    owner_principal_id: owner_principal_id.to_owned(),
                    status: GraphStatus::Active,
                    schema_version,
                    byte_quota,
                    used_bytes: snapshot.len() as u64,
                    checkpoint: StoredCheckpoint {
                        included_cursor: 0,
                        checksum: checksum(&snapshot),
                        snapshot,
                        version_vector,
                    },
                    updates: Vec::new(),
                    memberships,
                    membership_version: 1,
                },
            );
    }

    pub fn grant(&self, graph_id: &str, principal_id: &str, role: GraphRole) {
        let mut state = self.inner.lock().expect("memory store mutex");
        let graph = state.graphs.get_mut(graph_id).expect("seeded graph");
        graph.membership_version += 1;
        graph.memberships.insert(
            principal_id.to_owned(),
            MemoryMembership {
                role,
                version: graph.membership_version,
                revoked: false,
            },
        );
    }

    pub fn revoke(&self, graph_id: &str, principal_id: &str) {
        let mut state = self.inner.lock().expect("memory store mutex");
        let graph = state.graphs.get_mut(graph_id).expect("seeded graph");
        graph.membership_version += 1;
        let membership = graph
            .memberships
            .get_mut(principal_id)
            .expect("granted principal");
        membership.version = graph.membership_version;
        membership.revoked = true;
    }

    pub fn inject_once(&self, point: FaultPoint) {
        self.inner.lock().expect("memory store mutex").fault = Some(point);
    }

    pub fn set_available(&self, available: bool) {
        self.inner.lock().expect("memory store mutex").available = available;
    }

    pub fn backup_graph(&self, graph_id: &str) -> Result<GraphBackup, StoreError> {
        let state = self.inner.lock().expect("memory store mutex");
        let graph = state.graphs.get(graph_id).ok_or(StoreError::AccessDenied)?;
        Ok(GraphBackup {
            graph: memory_load(graph_id, graph),
            memberships: graph
                .memberships
                .iter()
                .map(|(principal, membership)| {
                    (
                        principal.clone(),
                        membership.role,
                        membership.version,
                        membership.revoked,
                    )
                })
                .collect(),
        })
    }

    pub fn restore_graph(&self, backup: GraphBackup) -> Result<(), StoreError> {
        let graph_id = backup.graph.graph_id.clone();
        let used_bytes = backup.graph.checkpoint.snapshot.len() as u64
            + backup
                .graph
                .updates
                .iter()
                .map(|update| update.bytes.len() as u64)
                .sum::<u64>();
        let membership_version = backup
            .memberships
            .iter()
            .map(|entry| entry.2)
            .max()
            .unwrap_or(1);
        let memberships = backup
            .memberships
            .into_iter()
            .map(|(principal, role, version, revoked)| {
                (
                    principal,
                    MemoryMembership {
                        role,
                        version,
                        revoked,
                    },
                )
            })
            .collect();
        self.inner
            .lock()
            .expect("memory store mutex")
            .graphs
            .insert(
                graph_id,
                MemoryGraph {
                    owner_principal_id: backup.graph.owner_principal_id,
                    status: backup.graph.status,
                    schema_version: backup.graph.schema_version,
                    byte_quota: backup.graph.byte_quota,
                    used_bytes,
                    checkpoint: backup.graph.checkpoint,
                    updates: backup.graph.updates,
                    memberships,
                    membership_version,
                },
            );
        Ok(())
    }

    pub fn update_count(&self, graph_id: &str) -> usize {
        self.inner
            .lock()
            .expect("memory store mutex")
            .graphs
            .get(graph_id)
            .map_or(0, |graph| graph.updates.len())
    }
}

fn memory_load(graph_id: &str, graph: &MemoryGraph) -> GraphLoad {
    GraphLoad {
        graph_id: graph_id.to_owned(),
        owner_principal_id: graph.owner_principal_id.clone(),
        status: graph.status,
        schema_version: graph.schema_version,
        byte_quota: graph.byte_quota,
        checkpoint: graph.checkpoint.clone(),
        updates: graph.updates.clone(),
    }
}

#[async_trait]
impl GraphStore for MemoryStore {
    async fn ready(&self) -> Result<(), StoreError> {
        if self.inner.lock().expect("memory store mutex").available {
            Ok(())
        } else {
            Err(StoreError::Unavailable("injected outage"))
        }
    }

    async fn authorize(
        &self,
        graph_id: &str,
        principal_id: &str,
    ) -> Result<Membership, StoreError> {
        let state = self.inner.lock().expect("memory store mutex");
        if !state.available {
            return Err(StoreError::Unavailable("injected outage"));
        }
        let graph = state.graphs.get(graph_id).ok_or(StoreError::AccessDenied)?;
        let member = graph
            .memberships
            .get(principal_id)
            .filter(|member| !member.revoked)
            .ok_or(StoreError::AccessDenied)?;
        Ok(Membership {
            principal_id: principal_id.to_owned(),
            role: member.role,
            version: member.version,
            schema_version: graph.schema_version,
        })
    }

    async fn load_graph(&self, graph_id: &str) -> Result<GraphLoad, StoreError> {
        let state = self.inner.lock().expect("memory store mutex");
        if !state.available {
            return Err(StoreError::Unavailable("injected outage"));
        }
        state
            .graphs
            .get(graph_id)
            .map(|graph| memory_load(graph_id, graph))
            .ok_or(StoreError::AccessDenied)
    }

    async fn commit_update(
        &self,
        graph_id: &str,
        principal_id: &str,
        message_id: &str,
        bytes: &[u8],
    ) -> Result<CommitOutcome, StoreError> {
        let mut state = self.inner.lock().expect("memory store mutex");
        if !state.available {
            return Err(StoreError::Unavailable("injected outage"));
        }
        let fault = state.fault.take();
        if fault == Some(FaultPoint::BeforeCommit) {
            return Err(StoreError::Unavailable("injected before commit"));
        }
        let next_cursor = state.next_cursor + 1;
        let graph = state
            .graphs
            .get_mut(graph_id)
            .ok_or(StoreError::AccessDenied)?;
        let member = graph
            .memberships
            .get(principal_id)
            .filter(|member| !member.revoked)
            .ok_or(StoreError::AccessDenied)?;
        if !member.role.can_write() || graph.status == GraphStatus::ReadOnly {
            return Err(StoreError::ReadOnly);
        }
        if let Some(update) = graph
            .updates
            .iter()
            .find(|update| update.message_id == message_id)
        {
            if update.checksum != checksum(bytes) {
                return Err(StoreError::MessageConflict);
            }
            return Ok(CommitOutcome {
                cursor: update.cursor,
                inserted: false,
            });
        }
        let next_used = graph
            .used_bytes
            .checked_add(bytes.len() as u64)
            .ok_or(StoreError::QuotaExceeded)?;
        if next_used > graph.byte_quota {
            return Err(StoreError::QuotaExceeded);
        }
        graph.updates.push(StoredUpdate {
            cursor: next_cursor,
            message_id: message_id.to_owned(),
            principal_id: principal_id.to_owned(),
            checksum: checksum(bytes),
            bytes: bytes.to_vec(),
        });
        graph.used_bytes = next_used;
        state.next_cursor = next_cursor;
        if fault == Some(FaultPoint::AfterCommit) {
            return Err(StoreError::Unavailable("injected after commit"));
        }
        Ok(CommitOutcome {
            cursor: next_cursor,
            inserted: true,
        })
    }
}

#[async_trait]
impl GraphAdmin for MemoryStore {
    async fn create_remote_graph(
        &self,
        graph_id: &str,
        owner_principal_id: &str,
        schema_version: u32,
        byte_quota: u64,
        snapshot: &[u8],
        version_vector: &[u8],
    ) -> Result<(), StoreError> {
        let mut state = self.inner.lock().expect("memory store mutex");
        if state.graphs.contains_key(graph_id) {
            return Err(StoreError::Database("graph already exists".into()));
        }
        let mut memberships = HashMap::new();
        memberships.insert(
            owner_principal_id.to_owned(),
            MemoryMembership {
                role: GraphRole::Owner,
                version: 1,
                revoked: false,
            },
        );
        state.graphs.insert(
            graph_id.to_owned(),
            MemoryGraph {
                owner_principal_id: owner_principal_id.to_owned(),
                status: GraphStatus::Active,
                schema_version,
                byte_quota,
                used_bytes: snapshot.len() as u64,
                checkpoint: StoredCheckpoint {
                    included_cursor: 0,
                    snapshot: snapshot.to_vec(),
                    version_vector: version_vector.to_vec(),
                    checksum: checksum(snapshot),
                },
                updates: Vec::new(),
                memberships,
                membership_version: 1,
            },
        );
        Ok(())
    }

    async fn list_graphs(&self, principal_id: &str) -> Result<Vec<GraphListing>, StoreError> {
        let state = self.inner.lock().expect("memory store mutex");
        let mut graphs = state
            .graphs
            .iter()
            .filter_map(|(graph_id, graph)| {
                let member = graph.memberships.get(principal_id)?;
                (!member.revoked).then_some(GraphListing {
                    graph_id: graph_id.clone(),
                    role: member.role,
                    status: graph.status,
                    membership_version: graph.membership_version,
                })
            })
            .collect::<Vec<_>>();
        graphs.sort_by(|left, right| left.graph_id.cmp(&right.graph_id));
        Ok(graphs)
    }

    async fn list_memberships(&self, graph_id: &str) -> Result<Vec<MembershipListing>, StoreError> {
        let state = self.inner.lock().expect("memory store mutex");
        let graph = state.graphs.get(graph_id).ok_or(StoreError::AccessDenied)?;
        let mut memberships = graph
            .memberships
            .iter()
            .filter_map(|(principal_id, membership)| {
                (!membership.revoked).then_some(MembershipListing {
                    principal_id: principal_id.clone(),
                    role: membership.role,
                    version: membership.version,
                })
            })
            .collect::<Vec<_>>();
        memberships.sort_by(|left, right| left.principal_id.cmp(&right.principal_id));
        Ok(memberships)
    }

    async fn grant_membership(
        &self,
        graph_id: &str,
        principal_id: &str,
        role: GraphRole,
    ) -> Result<u64, StoreError> {
        self.grant(graph_id, principal_id, role);
        self.authorize(graph_id, principal_id)
            .await
            .map(|membership| membership.version)
    }

    async fn revoke_membership(
        &self,
        graph_id: &str,
        principal_id: &str,
    ) -> Result<u64, StoreError> {
        self.revoke(graph_id, principal_id);
        let state = self.inner.lock().expect("memory store mutex");
        state
            .graphs
            .get(graph_id)
            .and_then(|graph| graph.memberships.get(principal_id))
            .map(|membership| membership.version)
            .ok_or(StoreError::AccessDenied)
    }
}
