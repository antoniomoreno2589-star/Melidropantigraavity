-- Tracks progress of each Amazon→MercadoLibre sync cycle.
-- One row per user per cycle. The updater edge function processes
-- BATCH_SIZE products per invocation and increments next_offset
-- until next_offset >= total_products, then marks the job complete.

CREATE TABLE IF NOT EXISTS sync_jobs (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID        NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'running',   -- running | completed | failed
    total_products  INTEGER   NOT NULL DEFAULT 0,
    processed_count INTEGER   NOT NULL DEFAULT 0,
    updated_count   INTEGER   NOT NULL DEFAULT 0,
    error_count     INTEGER   NOT NULL DEFAULT 0,
    next_offset     INTEGER   NOT NULL DEFAULT 0,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_user_status
    ON sync_jobs (user_id, status);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_started_at
    ON sync_jobs (started_at DESC);
