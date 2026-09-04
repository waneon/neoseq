-- Protocol v6 identifies an update by its lowercase SHA-256 checksum. Fold
-- pre-v6 duplicate payloads before replacing their arbitrary transport IDs.
-- Uniqueness is restored after the rewrite so adversarial key swaps cannot
-- collide halfway through a multi-row UPDATE.
ALTER TABLE graph_update
    DROP CONSTRAINT IF EXISTS graph_update_content_identity,
    DROP CONSTRAINT IF EXISTS graph_update_graph_id_message_id_key;
ALTER TABLE graph_update_receipt
    DROP CONSTRAINT IF EXISTS graph_update_receipt_content_identity,
    DROP CONSTRAINT IF EXISTS graph_update_receipt_pkey;

WITH ranked AS (
    SELECT graph_id, cursor, size_bytes,
           ROW_NUMBER() OVER (
               PARTITION BY graph_id, checksum
               ORDER BY cursor
           ) AS occurrence
    FROM graph_update
), removed AS (
    DELETE FROM graph_update AS stored
    USING ranked
    WHERE stored.graph_id = ranked.graph_id
      AND stored.cursor = ranked.cursor
      AND ranked.occurrence > 1
    RETURNING stored.graph_id, stored.size_bytes
), reclaimed AS (
    SELECT graph_id, SUM(size_bytes)::BIGINT AS size_bytes
    FROM removed
    GROUP BY graph_id
)
UPDATE graph AS stored_graph
SET used_bytes = stored_graph.used_bytes - reclaimed.size_bytes
FROM reclaimed
WHERE stored_graph.graph_id = reclaimed.graph_id;

WITH ranked AS (
    SELECT graph_id, message_id,
           ROW_NUMBER() OVER (
               PARTITION BY graph_id, checksum
               ORDER BY cursor, message_id
           ) AS occurrence
    FROM graph_update_receipt
)
DELETE FROM graph_update_receipt AS receipt
USING ranked
WHERE receipt.graph_id = ranked.graph_id
  AND receipt.message_id = ranked.message_id
  AND ranked.occurrence > 1;

-- The same pre-v6 bytes may straddle the compact receipt and live Tail under
-- different IDs. Keep the earliest cursor as their one durable identity. On
-- a tie retain the live Tail, whose payload may still serve a fallback Base.
WITH removed AS (
    DELETE FROM graph_update AS stored
    USING graph_update_receipt AS receipt
    WHERE stored.graph_id = receipt.graph_id
      AND stored.checksum = receipt.checksum
      AND receipt.cursor < stored.cursor
    RETURNING stored.graph_id, stored.size_bytes
), reclaimed AS (
    SELECT graph_id, SUM(size_bytes)::BIGINT AS size_bytes
    FROM removed
    GROUP BY graph_id
)
UPDATE graph AS stored_graph
SET used_bytes = stored_graph.used_bytes - reclaimed.size_bytes
FROM reclaimed
WHERE stored_graph.graph_id = reclaimed.graph_id;

DELETE FROM graph_update_receipt AS receipt
USING graph_update AS stored
WHERE receipt.graph_id = stored.graph_id
  AND receipt.checksum = stored.checksum
  AND stored.cursor <= receipt.cursor;

UPDATE graph_update SET message_id = checksum;
UPDATE graph_update_receipt SET message_id = checksum;

-- Once the transport key is canonical, retaining the same digest in a second
-- column would reintroduce two representations of one identity.
ALTER TABLE graph_update DROP COLUMN checksum;
ALTER TABLE graph_update_receipt DROP COLUMN checksum;

ALTER TABLE graph_update
    ADD CONSTRAINT graph_update_graph_id_message_id_key UNIQUE (graph_id, message_id),
    ADD CONSTRAINT graph_update_content_identity
    CHECK (message_id ~ '^[0-9a-f]{64}$');

ALTER TABLE graph_update_receipt
    ADD CONSTRAINT graph_update_receipt_pkey PRIMARY KEY (graph_id, message_id),
    ADD CONSTRAINT graph_update_receipt_content_identity
    CHECK (message_id ~ '^[0-9a-f]{64}$');
