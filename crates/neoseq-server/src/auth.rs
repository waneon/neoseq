use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::sync::Arc;
use thiserror::Error;

const CLIENT_SESSION_SECONDS: i64 = 12 * 60 * 60;
const PERSISTENT_CLIENT_SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;
const ADMIN_SESSION_SECONDS: i64 = 60 * 60;
const PASSWORD_MAX_BYTES: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionPurpose {
    Client,
    Admin,
}

impl SessionPurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Client => "client",
            Self::Admin => "admin",
        }
    }

    fn parse(value: &str) -> Result<Self, AuthError> {
        match value {
            "client" => Ok(Self::Client),
            "admin" => Ok(Self::Admin),
            _ => Err(AuthError::Invalid),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    /// Stable account identity used by memberships and audit records.
    pub id: String,
    pub username: String,
    pub is_admin: bool,
    pub purpose: SessionPurpose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    Active,
    Disabled,
}

impl AccountStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Disabled => "disabled",
        }
    }

    fn parse(value: &str) -> Result<Self, AuthError> {
        match value {
            "active" => Ok(Self::Active),
            "disabled" => Ok(Self::Disabled),
            _ => Err(AuthError::Unavailable),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerRole {
    User,
    Admin,
}

impl ServerRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Admin => "admin",
        }
    }

    fn parse(value: &str) -> Result<Self, AuthError> {
        match value {
            "user" => Ok(Self::User),
            "admin" => Ok(Self::Admin),
            _ => Err(AuthError::Unavailable),
        }
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
        sqlx::query("SELECT pg_advisory_xact_lock(715887125)")
            .execute(&mut *transaction)
            .await?;
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
        transaction.commit().await?;
        self.audit(None, Some(&account_id), "account.bootstrap")
            .await?;
        self.account(&account_id).await.map(Some)
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
        actor: Option<&Principal>,
        username: &str,
        password: &str,
        role: ServerRole,
    ) -> Result<AccountView, AuthError> {
        let username = normalize_username(username)?;
        validate_password(password)?;
        let password_hash = hash_password(password).await?;
        let account_id = random_value("acct_", 18)?;
        let result = sqlx::query(
            "INSERT INTO account(account_id, username, password_hash, server_role)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(&account_id)
        .bind(&username)
        .bind(password_hash)
        .bind(role.as_str())
        .execute(&self.pool)
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
        self.audit(
            actor.map(|actor| actor.id.as_str()),
            Some(&account_id),
            "account.create",
        )
        .await?;
        self.account(&account_id).await
    }

    async fn account(&self, account_id: &str) -> Result<AccountView, AuthError> {
        let row = sqlx::query(
            "SELECT account_id, username, status, server_role, created_at::TEXT AS created_at
             FROM account WHERE account_id = $1",
        )
        .bind(account_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(AuthError::InvalidInput("unknown account"))?;
        account_view(&row)
    }

    async fn require_admin(&self, actor: &Principal) -> Result<(), AuthError> {
        if !actor.is_admin || actor.purpose != SessionPurpose::Admin {
            return Err(AuthError::Forbidden);
        }
        let allowed: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM account
                WHERE account_id = $1 AND status = 'active' AND server_role = 'admin'
             )",
        )
        .bind(&actor.id)
        .fetch_one(&self.pool)
        .await?;
        if allowed {
            Ok(())
        } else {
            Err(AuthError::Forbidden)
        }
    }

    async fn audit(
        &self,
        actor: Option<&str>,
        subject: Option<&str>,
        action: &str,
    ) -> Result<(), AuthError> {
        sqlx::query(
            "INSERT INTO account_audit_event(
                actor_account_id, subject_account_id, action, result_code
             ) VALUES ($1, $2, $3, 'ok')",
        )
        .bind(actor)
        .bind(subject)
        .bind(action)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
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
            is_admin: row.try_get::<String, _>("server_role")? == "admin",
            purpose: SessionPurpose::parse(row.try_get("purpose")?)?,
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
        let password_hash = row
            .as_ref()
            .and_then(|row| row.try_get::<String, _>("password_hash").ok())
            .unwrap_or_else(|| self.dummy_password_hash.to_string());
        let password_valid = verify_password(password.to_owned(), password_hash).await?;
        let Some(row) = row else {
            return Err(AuthError::Invalid);
        };
        let account_id: String = row.try_get("account_id")?;
        let blocked: bool = row.try_get("blocked")?;
        let status = AccountStatus::parse(row.try_get("status")?)?;
        let role = ServerRole::parse(row.try_get("server_role")?)?;
        if blocked || status != AccountStatus::Active {
            return Err(AuthError::Invalid);
        }
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
        if !verify_password(current_password.to_owned(), password_hash).await? {
            return Err(AuthError::Invalid);
        }
        let next_hash = hash_password(new_password).await?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "UPDATE account SET password_hash = $2, updated_at = NOW()
             WHERE account_id = $1",
        )
        .bind(&principal.id)
        .bind(next_hash)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE account_session SET revoked_at = NOW()
             WHERE account_id = $1 AND revoked_at IS NULL",
        )
        .bind(&principal.id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        self.audit(
            Some(&principal.id),
            Some(&principal.id),
            "account.password.change",
        )
        .await
    }

    async fn list_accounts(&self, actor: &Principal) -> Result<Vec<AccountView>, AuthError> {
        self.require_admin(actor).await?;
        let rows = sqlx::query(
            "SELECT account_id, username, status, server_role, created_at::TEXT AS created_at
             FROM account ORDER BY username, account_id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(account_view).collect()
    }

    async fn create_account(
        &self,
        actor: &Principal,
        username: &str,
        password: &str,
        role: ServerRole,
    ) -> Result<AccountView, AuthError> {
        self.require_admin(actor).await?;
        self.insert_account(Some(actor), username, password, role)
            .await
    }

    async fn update_account(
        &self,
        actor: &Principal,
        account_id: &str,
        patch: AccountPatch,
    ) -> Result<AccountView, AuthError> {
        self.require_admin(actor).await?;
        if patch.status.is_none() && patch.server_role.is_none() {
            return Err(AuthError::InvalidInput("no account fields were supplied"));
        }
        let mut transaction = self.pool.begin().await?;
        // Global account authority changes are rare and serialized so two
        // administrators cannot concurrently demote the final active pair.
        sqlx::query("SELECT pg_advisory_xact_lock(715887125)")
            .execute(&mut *transaction)
            .await?;
        let current =
            sqlx::query("SELECT status, server_role FROM account WHERE account_id = $1 FOR UPDATE")
                .bind(account_id)
                .fetch_optional(&mut *transaction)
                .await?
                .ok_or(AuthError::InvalidInput("unknown account"))?;
        let current_status = AccountStatus::parse(current.try_get("status")?)?;
        let current_role = ServerRole::parse(current.try_get("server_role")?)?;
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
        sqlx::query(
            "UPDATE account_session SET revoked_at = NOW()
             WHERE account_id = $1 AND revoked_at IS NULL",
        )
        .bind(account_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        self.audit(Some(&actor.id), Some(account_id), "account.update")
            .await?;
        self.account(account_id).await
    }

    async fn reset_password(
        &self,
        actor: &Principal,
        account_id: &str,
        password: &str,
    ) -> Result<(), AuthError> {
        self.require_admin(actor).await?;
        validate_password(password)?;
        let password_hash = hash_password(password).await?;
        let mut transaction = self.pool.begin().await?;
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
        sqlx::query(
            "UPDATE account_session SET revoked_at = NOW()
             WHERE account_id = $1 AND revoked_at IS NULL",
        )
        .bind(account_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        self.audit(Some(&actor.id), Some(account_id), "account.password.reset")
            .await
    }

    async fn revoke_sessions(&self, actor: &Principal, account_id: &str) -> Result<(), AuthError> {
        self.require_admin(actor).await?;
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account WHERE account_id = $1)")
                .bind(account_id)
                .fetch_one(&self.pool)
                .await?;
        if !exists {
            return Err(AuthError::InvalidInput("unknown account"));
        }
        sqlx::query(
            "UPDATE account_session SET revoked_at = NOW()
             WHERE account_id = $1 AND revoked_at IS NULL",
        )
        .bind(account_id)
        .execute(&self.pool)
        .await?;
        self.audit(Some(&actor.id), Some(account_id), "account.sessions.revoke")
            .await
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
        status: AccountStatus::parse(row.try_get("status")?)?,
        server_role: ServerRole::parse(row.try_get("server_role")?)?,
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
}
