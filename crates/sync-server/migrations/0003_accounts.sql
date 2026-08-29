CREATE TABLE account (
    account_id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    server_role TEXT NOT NULL DEFAULT 'user' CHECK (server_role IN ('user', 'admin')),
    failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
    login_blocked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (username = LOWER(username))
);

CREATE TABLE account_session (
    session_id_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account(account_id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('client', 'admin')),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX account_session_active
    ON account_session(account_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE account_audit_event (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_account_id TEXT REFERENCES account(account_id) ON DELETE SET NULL,
    subject_account_id TEXT REFERENCES account(account_id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    result_code TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

UPDATE neoseq_schema_version SET version = 3 WHERE singleton = TRUE;
