use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::sync::Arc;
use thiserror::Error;

const CLIENT_SESSION_SECONDS: i64 = 12 * 60 * 60;
const PERSISTENT_CLIENT_SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;
const ADMIN_SESSION_SECONDS: i64 = 60 * 60;
const PASSWORD_MAX_BYTES: usize = 1_024;
const ACCOUNT_MUTATION_LOCK_ID: i64 = 715_887_125;
const INSERT_ACCOUNT_AUDIT: &str = "INSERT INTO account_audit_event(
        actor_account_id, subject_account_id, action, result_code
     ) VALUES ($1, $2, $3, 'ok')";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionPurpose {
    Client,
    Admin,
}

impl SessionPurpose {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Client => "client",
            Self::Admin => "admin",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "client" => Some(Self::Client),
            "admin" => Some(Self::Admin),
            _ => None,
        }
    }

    fn from_database(value: &str) -> Result<Self, AuthError> {
        Self::parse(value).ok_or(AuthError::Unavailable)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    /// Stable account identity used by memberships and audit records.
    pub id: String,
    pub username: String,
    pub server_role: ServerRole,
    pub purpose: SessionPurpose,
}

impl Principal {
    pub const fn is_admin(&self) -> bool {
        matches!(self.server_role, ServerRole::Admin)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    Active,
    Disabled,
}

impl AccountStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Disabled => "disabled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }

    fn from_database(value: &str) -> Result<Self, AuthError> {
        Self::parse(value).ok_or(AuthError::Unavailable)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerRole {
    User,
    Admin,
}

impl ServerRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Admin => "admin",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Self::User),
            "admin" => Some(Self::Admin),
            _ => None,
        }
    }

    fn from_database(value: &str) -> Result<Self, AuthError> {
        Self::parse(value).ok_or(AuthError::Unavailable)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountView {
    pub account_id: String,
    pub username: String,
    pub status: AccountStatus,
    pub server_role: ServerRole,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginSession {
    pub access_token: String,
    pub account: AccountView,
    pub purpose: SessionPurpose,
    /// Unix timestamp in seconds. This is an absolute lifetime, not a sliding
    /// promise that could keep a stolen credential alive indefinitely.
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AccountPatch {
    pub status: Option<AccountStatus>,
    pub server_role: Option<ServerRole>,
}

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("authentication credentials are invalid")]
    Invalid,
    #[error("the account operation is forbidden")]
    Forbidden,
    #[error("the account already exists")]
    Conflict,
    #[error("account input is invalid: {0}")]
    InvalidInput(&'static str),
    #[error("the last active administrator cannot be disabled or demoted")]
    LastAdmin,
    #[error("the identity store is unavailable")]
    Unavailable,
}

impl From<sqlx::Error> for AuthError {
    fn from(_: sqlx::Error) -> Self {
        Self::Unavailable
    }
}

#[async_trait]
pub trait IdentityService: Send + Sync + 'static {
    /// Resolves a bounded, revocable transport credential into a stable account.
    /// Verification remains asynchronous so revocation and account status are
    /// authoritative for long-lived WebSocket sessions.
    async fn verify(&self, token: &str) -> Result<Principal, AuthError>;
    async fn login(
        &self,
        username: &str,
        password: &str,
        purpose: SessionPurpose,
        persistent: bool,
    ) -> Result<LoginSession, AuthError>;
    async fn logout(&self, token: &str) -> Result<(), AuthError>;
    async fn change_password(
        &self,
        principal: &Principal,
        current_password: &str,
        new_password: &str,
    ) -> Result<(), AuthError>;
    async fn list_accounts(&self, actor: &Principal) -> Result<Vec<AccountView>, AuthError>;
    async fn create_account(
        &self,
        actor: &Principal,
        username: &str,
        password: &str,
        role: ServerRole,
    ) -> Result<AccountView, AuthError>;
    async fn update_account(
        &self,
        actor: &Principal,
        account_id: &str,
        patch: AccountPatch,
    ) -> Result<AccountView, AuthError>;
    async fn reset_password(
        &self,
        actor: &Principal,
        account_id: &str,
        password: &str,
    ) -> Result<(), AuthError>;
    async fn revoke_sessions(&self, actor: &Principal, account_id: &str) -> Result<(), AuthError>;
    async fn resolve_username(&self, username: &str) -> Result<String, AuthError>;
    async fn username_for(&self, account_id: &str) -> Result<Option<String>, AuthError>;
}

/// PostgreSQL-backed account and opaque-session authority.
#[derive(Clone)]
pub struct PgIdentity {
    pool: PgPool,
    dummy_password_hash: Arc<str>,
}

impl PgIdentity {
    pub fn new(pool: PgPool) -> Result<Self, AuthError> {
        Ok(Self {
            pool,
            dummy_password_hash: Arc::from(hash_password_blocking(
                "this password deliberately never authenticates",
            )?),
        })
    }

    /// Creates the first active administrator, or leaves an initialized identity
    /// store untouched. The check inside the advisory lock remains authoritative;
    /// the early check avoids validating and hashing a retained bootstrap secret on
    /// every normal server restart.
    pub async fn bootstrap_admin_if_absent(
        &self,
        username: &str,
        password: &str,
    ) -> Result<Option<AccountView>, AuthError> {
        if self.has_active_admin().await? {
            return Ok(None);
        }

        let username = normalize_username(username)?;
        validate_password(password)?;
        let password_hash = hash_password(password).await?;
        let account_id = random_value("acct_", 18)?;
        let mut transaction = self.pool.begin().await?;
        lock_account_mutations(&mut transaction).await?;
        let existing: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM account WHERE status = 'active' AND server_role = 'admin'",
        )
        .fetch_one(&mut *transaction)
        .await?;
        if existing != 0 {
            return Ok(None);
        }
        sqlx::query(
            "INSERT INTO account(account_id, username, password_hash, server_role)
             VALUES ($1, $2, $3, 'admin')",
        )
        .bind(&account_id)
        .bind(username)
        .bind(password_hash)
        .execute(&mut *transaction)
        .await?;
        audit_in_transaction(
            &mut transaction,
            None,
            Some(&account_id),
            "account.bootstrap",
        )
        .await?;
        let account = account_in_transaction(&mut transaction, &account_id).await?;
        transaction.commit().await?;
        Ok(Some(account))
    }

    /// Reports whether routine account administration is already bootstrapped.
    pub async fn has_active_admin(&self) -> Result<bool, AuthError> {
        sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM account WHERE status = 'active' AND server_role = 'admin'
             )",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(Into::into)
    }

    async fn insert_account(
        &self,
        actor: &Principal,
        username: &str,
        password: &str,
        role: ServerRole,
    ) -> Result<AccountView, AuthError> {
        let username = normalize_username(username)?;
        validate_password(password)?;
        let password_hash = hash_password(password).await?;
        let account_id = random_value("acct_", 18)?;
        // Argon2 is deliberately completed before acquiring a connection and
        // the account-mutation lock. Authorization is still rechecked inside
        // the transaction before any state changes.
        let mut transaction = self.pool.begin().await?;
        lock_account_mutations(&mut transaction).await?;
        require_admin(&mut transaction, actor).await?;
        let result = sqlx::query(
            "INSERT INTO account(account_id, username, password_hash, server_role)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(&account_id)
        .bind(&username)
        .bind(password_hash)
        .bind(role.as_str())
        .execute(&mut *transaction)
        .await;
        if let Err(error) = result {
            if error
                .as_database_error()
                .and_then(|error| error.code())
                .as_deref()
                == Some("23505")
            {
                return Err(AuthError::Conflict);
            }
            return Err(AuthError::Unavailable);
        }
        audit_in_transaction(
            &mut transaction,
            Some(&actor.id),
            Some(&account_id),
            "account.create",
        )
        .await?;
        let account = account_in_transaction(&mut transaction, &account_id).await?;
        transaction.commit().await?;
        Ok(account)
    }

    async fn audit(
        &self,
        actor: Option<&str>,
        subject: Option<&str>,
        action: &str,
    ) -> Result<(), AuthError> {
        sqlx::query(INSERT_ACCOUNT_AUDIT)
            .bind(actor)
            .bind(subject)
            .bind(action)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

async fn lock_account_mutations(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<(), AuthError> {
    // Account administration is rare. Serializing it keeps an actor's
    // transaction-local authorization stable against concurrent demotion and
    // shares the same last-admin boundary as bootstrap and role changes.
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(ACCOUNT_MUTATION_LOCK_ID)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

async fn require_admin(
    transaction: &mut Transaction<'_, Postgres>,
    actor: &Principal,
) -> Result<(), AuthError> {
    if !actor.is_admin() || actor.purpose != SessionPurpose::Admin {
        return Err(AuthError::Forbidden);
    }
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM account
            WHERE account_id = $1 AND status = 'active' AND server_role = 'admin'
         )",
    )
    .bind(&actor.id)
    .fetch_one(&mut **transaction)
    .await?;
    if allowed {
        Ok(())
    } else {
        Err(AuthError::Forbidden)
    }
}

async fn account_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<AccountView, AuthError> {
    let row = sqlx::query(
        "SELECT account_id, username, status, server_role, created_at::TEXT AS created_at
         FROM account WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(AuthError::InvalidInput("unknown account"))?;
    account_view(&row)
}

async fn revoke_account_sessions(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<(), AuthError> {
    sqlx::query(
        "UPDATE account_session SET revoked_at = NOW()
         WHERE account_id = $1 AND revoked_at IS NULL",
    )
    .bind(account_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn audit_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    actor: Option<&str>,
    subject: Option<&str>,
    action: &str,
) -> Result<(), AuthError> {
    sqlx::query(INSERT_ACCOUNT_AUDIT)
        .bind(actor)
        .bind(subject)
        .bind(action)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

#[async_trait]
impl IdentityService for PgIdentity {
    async fn verify(&self, token: &str) -> Result<Principal, AuthError> {
        let digest = token_digest(token);
        let row = sqlx::query(
            "SELECT a.account_id, a.username, a.server_role, s.purpose
             FROM account_session s
             JOIN account a ON a.account_id = s.account_id
             WHERE s.session_id_hash = $1
               AND s.revoked_at IS NULL
               AND s.expires_at > NOW()
               AND a.status = 'active'",
        )
        .bind(digest)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(AuthError::Invalid)?;
        Ok(Principal {
            id: row.try_get("account_id")?,
            username: row.try_get("username")?,
            server_role: ServerRole::from_database(row.try_get("server_role")?)?,
            purpose: SessionPurpose::from_database(row.try_get("purpose")?)?,
        })
    }
    async fn login(
        &self,
        username: &str,
        password: &str,
        purpose: SessionPurpose,
        persistent: bool,
    ) -> Result<LoginSession, AuthError> {
        let username = normalize_username(username)?;
        let row = sqlx::query(
            "SELECT account_id, username, password_hash, status, server_role,
                    COALESCE(login_blocked_until > NOW(), FALSE) AS blocked,
                    created_at::TEXT AS created_at
             FROM account WHERE username = $1",
        )
        .bind(&username)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            // An unknown username costs exactly one verification, so the
            // response time does not say whether the account exists.
            verify_password(password.to_owned(), self.dummy_password_hash.to_string()).await?;
            return Err(AuthError::Invalid);
        };
        let account_id: String = row.try_get("account_id")?;
        let blocked: bool = row.try_get("blocked")?;
        let status = AccountStatus::from_database(row.try_get("status")?)?;
        let role = ServerRole::from_database(row.try_get("server_role")?)?;
        // A locked or disabled account is refused before the hash is checked:
        // the lockout exists to stop paying for guesses against it.
        if blocked || status != AccountStatus::Active {
            return Err(AuthError::Invalid);
        }
        let password_hash: String = row.try_get("password_hash")?;
        let password_valid = verify_password(password.to_owned(), password_hash).await?;
        if !password_valid {
            sqlx::query(
                "UPDATE account SET
                    failed_login_attempts = CASE
                        WHEN login_blocked_until IS NOT NULL AND login_blocked_until <= NOW()
                            THEN 1
                        ELSE failed_login_attempts + 1
                    END,
                    login_blocked_until = CASE
                        WHEN (CASE
                            WHEN login_blocked_until IS NOT NULL AND login_blocked_until <= NOW()
                                THEN 1
                            ELSE failed_login_attempts + 1
                        END) >= 5 THEN NOW() + INTERVAL '30 seconds'
                        ELSE NULL
                    END,
                    updated_at = NOW()
                 WHERE account_id = $1",
            )
            .bind(&account_id)
            .execute(&self.pool)
            .await?;
            return Err(AuthError::Invalid);
        }
        if purpose == SessionPurpose::Admin && role != ServerRole::Admin {
            return Err(AuthError::Invalid);
        }
        sqlx::query(
            "UPDATE account SET failed_login_attempts = 0,
                                login_blocked_until = NULL,
                                updated_at = NOW()
             WHERE account_id = $1",
        )
        .bind(&account_id)
        .execute(&self.pool)
        .await?;
        let token = random_value("ns_", 32)?;
        let ttl = match (purpose, persistent) {
            (SessionPurpose::Client, true) => PERSISTENT_CLIENT_SESSION_SECONDS,
            (SessionPurpose::Client, false) => CLIENT_SESSION_SECONDS,
            (SessionPurpose::Admin, _) => ADMIN_SESSION_SECONDS,
        };
        let expires_at: i64 = sqlx::query_scalar(
            "INSERT INTO account_session(session_id_hash, account_id, purpose, expires_at)
             VALUES ($1, $2, $3, NOW() + make_interval(secs => $4::DOUBLE PRECISION))
             RETURNING EXTRACT(EPOCH FROM expires_at)::BIGINT",
        )
        .bind(token_digest(&token))
        .bind(&account_id)
        .bind(purpose.as_str())
        .bind(ttl as f64)
        .fetch_one(&self.pool)
        .await?;
        self.audit(Some(&account_id), Some(&account_id), "session.login")
            .await?;
        Ok(LoginSession {
            access_token: token,
            account: AccountView {
                account_id,
                username: row.try_get("username")?,
                status,
                server_role: role,
                created_at: row.try_get("created_at")?,
            },
            purpose,
            expires_at,
        })
    }

    async fn logout(&self, token: &str) -> Result<(), AuthError> {
        sqlx::query(
            "UPDATE account_session SET revoked_at = NOW()
             WHERE session_id_hash = $1 AND revoked_at IS NULL",
        )
        .bind(token_digest(token))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn change_password(
        &self,
        principal: &Principal,
        current_password: &str,
        new_password: &str,
    ) -> Result<(), AuthError> {
        validate_password(new_password)?;
        let password_hash: String = sqlx::query_scalar(
            "SELECT password_hash FROM account
             WHERE account_id = $1 AND status = 'active'",
        )
        .bind(&principal.id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(AuthError::Invalid)?;
        if !verify_password(current_password.to_owned(), password_hash.clone()).await? {
            return Err(AuthError::Invalid);
        }
        let next_hash = hash_password(new_password).await?;
        let mut transaction = self.pool.begin().await?;
        // Password verification is deliberately outside the transaction. The
        // old hash and active status make this update the authoritative
        // transaction-local recheck, so a concurrent reset cannot be lost.
        let updated = sqlx::query(
            "UPDATE account SET password_hash = $2, updated_at = NOW()
             WHERE account_id = $1 AND status = 'active' AND password_hash = $3",
        )
        .bind(&principal.id)
        .bind(next_hash)
        .bind(password_hash)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        if updated == 0 {
            return Err(AuthError::Invalid);
        }
        revoke_account_sessions(&mut transaction, &principal.id).await?;
        audit_in_transaction(
            &mut transaction,
            Some(&principal.id),
            Some(&principal.id),
            "account.password.change",
        )
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    async fn list_accounts(&self, actor: &Principal) -> Result<Vec<AccountView>, AuthError> {
        let mut transaction = self.pool.begin().await?;
        require_admin(&mut transaction, actor).await?;
        let rows = sqlx::query(
            "SELECT account_id, username, status, server_role, created_at::TEXT AS created_at
             FROM account ORDER BY username, account_id",
        )
        .fetch_all(&mut *transaction)
        .await?;
        let accounts = rows.iter().map(account_view).collect::<Result<_, _>>()?;
        transaction.commit().await?;
        Ok(accounts)
    }

    async fn create_account(
        &self,
        actor: &Principal,
        username: &str,
        password: &str,
        role: ServerRole,
    ) -> Result<AccountView, AuthError> {
        self.insert_account(actor, username, password, role).await
    }

    async fn update_account(
        &self,
        actor: &Principal,
        account_id: &str,
        patch: AccountPatch,
    ) -> Result<AccountView, AuthError> {
        let mut transaction = self.pool.begin().await?;
        lock_account_mutations(&mut transaction).await?;
        require_admin(&mut transaction, actor).await?;
        if patch.status.is_none() && patch.server_role.is_none() {
            return Err(AuthError::InvalidInput("no account fields were supplied"));
        }
        // Global account authority changes are rare and serialized so two
        // administrators cannot concurrently demote the final active pair.
        let current =
            sqlx::query("SELECT status, server_role FROM account WHERE account_id = $1 FOR UPDATE")
                .bind(account_id)
                .fetch_optional(&mut *transaction)
                .await?
                .ok_or(AuthError::InvalidInput("unknown account"))?;
        let current_status = AccountStatus::from_database(current.try_get("status")?)?;
        let current_role = ServerRole::from_database(current.try_get("server_role")?)?;
        let next_status = patch.status.unwrap_or(current_status);
        let next_role = patch.server_role.unwrap_or(current_role);
        if current_status == AccountStatus::Active
            && current_role == ServerRole::Admin
            && (next_status != AccountStatus::Active || next_role != ServerRole::Admin)
        {
            let other_admins: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM account
                 WHERE account_id <> $1 AND status = 'active' AND server_role = 'admin'",
            )
            .bind(account_id)
            .fetch_one(&mut *transaction)
            .await?;
            if other_admins == 0 {
                return Err(AuthError::LastAdmin);
            }
        }
        sqlx::query(
            "UPDATE account SET status = $2, server_role = $3, updated_at = NOW()
             WHERE account_id = $1",
        )
        .bind(account_id)
        .bind(next_status.as_str())
        .bind(next_role.as_str())
        .execute(&mut *transaction)
        .await?;
        revoke_account_sessions(&mut transaction, account_id).await?;
        audit_in_transaction(
            &mut transaction,
            Some(&actor.id),
            Some(account_id),
            "account.update",
        )
        .await?;
        let account = account_in_transaction(&mut transaction, account_id).await?;
        transaction.commit().await?;
        Ok(account)
    }

    async fn reset_password(
        &self,
        actor: &Principal,
        account_id: &str,
        password: &str,
    ) -> Result<(), AuthError> {
        validate_password(password)?;
        let password_hash = hash_password(password).await?;
        let mut transaction = self.pool.begin().await?;
        lock_account_mutations(&mut transaction).await?;
        require_admin(&mut transaction, actor).await?;
        let updated = sqlx::query(
            "UPDATE account SET password_hash = $2,
                                failed_login_attempts = 0,
                                login_blocked_until = NULL,
                                updated_at = NOW()
             WHERE account_id = $1",
        )
        .bind(account_id)
        .bind(password_hash)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        if updated == 0 {
            return Err(AuthError::InvalidInput("unknown account"));
        }
        revoke_account_sessions(&mut transaction, account_id).await?;
        audit_in_transaction(
            &mut transaction,
            Some(&actor.id),
            Some(account_id),
            "account.password.reset",
        )
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    async fn revoke_sessions(&self, actor: &Principal, account_id: &str) -> Result<(), AuthError> {
        let mut transaction = self.pool.begin().await?;
        lock_account_mutations(&mut transaction).await?;
        require_admin(&mut transaction, actor).await?;
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account WHERE account_id = $1)")
                .bind(account_id)
                .fetch_one(&mut *transaction)
                .await?;
        if !exists {
            return Err(AuthError::InvalidInput("unknown account"));
        }
        revoke_account_sessions(&mut transaction, account_id).await?;
        audit_in_transaction(
            &mut transaction,
            Some(&actor.id),
            Some(account_id),
            "account.sessions.revoke",
        )
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    async fn resolve_username(&self, username: &str) -> Result<String, AuthError> {
        let username = normalize_username(username)?;
        let account = sqlx::query_scalar(
            "SELECT account_id FROM account WHERE username = $1 AND status = 'active'",
        )
        .bind(&username)
        .fetch_optional(&self.pool)
        .await?;
        match account {
            Some(account_id) => Ok(account_id),
            None => Err(AuthError::InvalidInput("unknown or disabled account")),
        }
    }

    async fn username_for(&self, account_id: &str) -> Result<Option<String>, AuthError> {
        Ok(
            sqlx::query_scalar("SELECT username FROM account WHERE account_id = $1")
                .bind(account_id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }
}

fn account_view(row: &sqlx::postgres::PgRow) -> Result<AccountView, AuthError> {
    Ok(AccountView {
        account_id: row.try_get("account_id")?,
        username: row.try_get("username")?,
        status: AccountStatus::from_database(row.try_get("status")?)?,
        server_role: ServerRole::from_database(row.try_get("server_role")?)?,
        created_at: row.try_get("created_at")?,
    })
}

fn normalize_username(value: &str) -> Result<String, AuthError> {
    let value = value.trim().to_ascii_lowercase();
    let mut characters = value.chars();
    if !(3..=64).contains(&value.len())
        || !characters
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        || characters.any(|character| {
            !(character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-'))
        })
    {
        return Err(AuthError::InvalidInput(
            "username must be 3-64 lowercase ASCII letters, digits, '.', '_' or '-'",
        ));
    }
    Ok(value)
}

fn validate_password(value: &str) -> Result<(), AuthError> {
    if value.len() > PASSWORD_MAX_BYTES {
        Err(AuthError::InvalidInput(
            "password must be at most 1024 bytes",
        ))
    } else {
        Ok(())
    }
}

async fn hash_password(value: &str) -> Result<String, AuthError> {
    let value = value.to_owned();
    tokio::task::spawn_blocking(move || hash_password_blocking(&value))
        .await
        .map_err(|_| AuthError::Unavailable)?
}

fn hash_password_blocking(value: &str) -> Result<String, AuthError> {
    let mut salt = [0_u8; 16];
    getrandom::fill(&mut salt).map_err(|_| AuthError::Unavailable)?;
    let salt = SaltString::encode_b64(&salt).map_err(|_| AuthError::Unavailable)?;
    Argon2::default()
        .hash_password(value.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| AuthError::Unavailable)
}

async fn verify_password(value: String, encoded: String) -> Result<bool, AuthError> {
    tokio::task::spawn_blocking(move || {
        let hash = PasswordHash::new(&encoded).map_err(|_| AuthError::Unavailable)?;
        Ok(Argon2::default()
            .verify_password(value.as_bytes(), &hash)
            .is_ok())
    })
    .await
    .map_err(|_| AuthError::Unavailable)?
}

fn random_value(prefix: &str, bytes: usize) -> Result<String, AuthError> {
    let mut random = vec![0_u8; bytes];
    getrandom::fill(&mut random).map_err(|_| AuthError::Unavailable)?;
    Ok(format!("{prefix}{}", URL_SAFE_NO_PAD.encode(random)))
}

fn token_digest(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_are_small_unambiguous_identifiers() {
        assert_eq!(normalize_username(" Alice-1 ").unwrap(), "alice-1");
        assert!(normalize_username("한글").is_err());
        assert!(normalize_username("1alice").is_err());
    }

    #[test]
    fn passwords_have_no_minimum_length_but_remain_bounded() {
        assert!(validate_password("").is_ok());
        assert!(validate_password("x").is_ok());
        assert!(validate_password(&"x".repeat(PASSWORD_MAX_BYTES)).is_ok());
        assert!(validate_password(&"x".repeat(PASSWORD_MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn identity_enums_share_database_and_json_names() {
        assert_eq!(
            SessionPurpose::parse("client"),
            Some(SessionPurpose::Client)
        );
        assert_eq!(
            AccountStatus::parse("disabled"),
            Some(AccountStatus::Disabled)
        );
        assert_eq!(ServerRole::parse("admin"), Some(ServerRole::Admin));
        assert_eq!(
            serde_json::to_string(&SessionPurpose::Admin).unwrap(),
            "\"admin\""
        );
        assert_eq!(
            serde_json::to_string(&AccountStatus::Active).unwrap(),
            "\"active\""
        );
        assert_eq!(
            serde_json::to_string(&ServerRole::User).unwrap(),
            "\"user\""
        );
        assert!(matches!(
            ServerRole::from_database("superuser"),
            Err(AuthError::Unavailable)
        ));

        let principal = Principal {
            id: "account".into(),
            username: "admin".into(),
            server_role: ServerRole::Admin,
            purpose: SessionPurpose::Admin,
        };
        assert!(principal.is_admin());
    }
}
