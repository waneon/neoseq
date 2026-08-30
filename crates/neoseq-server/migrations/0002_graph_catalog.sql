ALTER TABLE graph
    ADD COLUMN display_name TEXT,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE graph SET display_name = graph_id;

ALTER TABLE graph
    ALTER COLUMN display_name SET NOT NULL;

ALTER TABLE graph
    ADD CONSTRAINT graph_display_name_bounds
    CHECK (CHAR_LENGTH(display_name) BETWEEN 1 AND 160);
