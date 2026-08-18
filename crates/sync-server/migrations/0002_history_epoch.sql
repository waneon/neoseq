ALTER TABLE graph
    ADD COLUMN history_epoch BIGINT NOT NULL DEFAULT 0 CHECK (history_epoch >= 0);

ALTER TABLE graph_checkpoint
    ADD COLUMN history_epoch BIGINT NOT NULL DEFAULT 0 CHECK (history_epoch >= 0);

CREATE TABLE graph_update_receipt (
    graph_id TEXT NOT NULL REFERENCES graph(graph_id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    checksum TEXT NOT NULL,
    cursor BIGINT NOT NULL CHECK (cursor >= 0),
    received_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (graph_id, message_id)
);

UPDATE neoseq_schema_version SET version = 2 WHERE singleton = TRUE;
