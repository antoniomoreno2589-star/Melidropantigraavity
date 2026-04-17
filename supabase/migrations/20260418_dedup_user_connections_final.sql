-- Final deduplication of user_connections.
-- The previous migration may have failed because it relied on an 'id' column
-- which may not exist. This version uses ctid (always available in Postgres)
-- and window functions to keep the row with the most recent credentials.
--
-- Ranking priority: row that has meli_credentials first, then most recent updated_at.

WITH ranked AS (
    SELECT ctid,
           ROW_NUMBER() OVER (
               PARTITION BY user_id
               ORDER BY
                   (meli_credentials IS NOT NULL) DESC,
                   (meli_test_user   IS NOT NULL) DESC,
                   updated_at DESC NULLS LAST,
                   ctid DESC
           ) AS rn
    FROM user_connections
)
DELETE FROM user_connections
WHERE ctid IN (SELECT ctid FROM ranked WHERE rn > 1);

-- Re-apply unique constraint (safe now that duplicates are gone)
ALTER TABLE user_connections DROP CONSTRAINT IF EXISTS user_connections_user_id_key;
ALTER TABLE user_connections ADD CONSTRAINT user_connections_user_id_key UNIQUE (user_id);
