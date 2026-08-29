CREATE TABLE neoseq_schema_version (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    version INTEGER NOT NULL CHECK (version > 0)
);
INSERT INTO neoseq_schema_version(singleton, version) VALUES (TRUE, 1);

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

CREATE TABLE graph (
    graph_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'read_only')),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    byte_quota BIGINT NOT NULL CHECK (byte_quota > 0),
    used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    membership_version BIGINT NOT NULL DEFAULT 1 CHECK (membership_version > 0),
    history_epoch BIGINT NOT NULL DEFAULT 0 CHECK (history_epoch >= 0),
    checkpoint_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE graph_membership (
    graph_id TEXT NOT NULL REFERENCES graph(graph_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES account(account_id),
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    version BIGINT NOT NULL CHECK (version > 0),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (graph_id, account_id)
);

CREATE TABLE graph_update (
    cursor BIGINT GENERATED ALWAYS AS IDENTITY,
    graph_id TEXT NOT NULL REFERENCES graph(graph_id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(account_id),
    checksum TEXT NOT NULL,
    payload BYTEA NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (graph_id, cursor),
    UNIQUE (graph_id, message_id)
);
CREATE INDEX graph_update_tail ON graph_update(graph_id, cursor);

CREATE TABLE graph_checkpoint (
    checkpoint_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    graph_id TEXT NOT NULL REFERENCES graph(graph_id) ON DELETE CASCADE,
    history_epoch BIGINT NOT NULL DEFAULT 0 CHECK (history_epoch >= 0),
    included_cursor BIGINT NOT NULL CHECK (included_cursor >= 0),
    snapshot BYTEA NOT NULL,
    version_vector BYTEA NOT NULL,
    checksum TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (graph_id, checkpoint_id)
);
ALTER TABLE graph ADD CONSTRAINT graph_checkpoint_pointer
    FOREIGN KEY (graph_id, checkpoint_id)
    REFERENCES graph_checkpoint(graph_id, checkpoint_id);

CREATE TABLE graph_update_receipt (
    graph_id TEXT NOT NULL REFERENCES graph(graph_id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    checksum TEXT NOT NULL,
    cursor BIGINT NOT NULL CHECK (cursor >= 0),
    received_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (graph_id, message_id)
);

CREATE TABLE graph_audit_event (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    graph_id TEXT REFERENCES graph(graph_id) ON DELETE SET NULL,
    account_id TEXT REFERENCES account(account_id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    result_code TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
