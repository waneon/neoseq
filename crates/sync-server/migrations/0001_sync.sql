CREATE TABLE neoseq_schema_version (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    version INTEGER NOT NULL CHECK (version > 0)
);
INSERT INTO neoseq_schema_version(singleton, version) VALUES (TRUE, 1);

CREATE TABLE graph (
    graph_id TEXT PRIMARY KEY,
    owner_principal_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'read_only')),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    byte_quota BIGINT NOT NULL CHECK (byte_quota > 0),
    used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    membership_version BIGINT NOT NULL DEFAULT 1 CHECK (membership_version > 0),
    checkpoint_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE graph_membership (
    graph_id TEXT NOT NULL REFERENCES graph(graph_id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    version BIGINT NOT NULL CHECK (version > 0),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (graph_id, principal_id)
);

CREATE TABLE graph_update (
    cursor BIGINT GENERATED ALWAYS AS IDENTITY,
    graph_id TEXT NOT NULL REFERENCES graph(graph_id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
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

CREATE TABLE graph_audit_event (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    graph_id TEXT REFERENCES graph(graph_id) ON DELETE SET NULL,
    principal_id TEXT,
    action TEXT NOT NULL,
    result_code TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
