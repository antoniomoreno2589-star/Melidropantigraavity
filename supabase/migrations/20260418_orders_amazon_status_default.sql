-- Ensure new orders get amazon_status = 'pending' when the sync payload
-- omits the field (so the ON CONFLICT SET clause never touches it and
-- existing 'purchased' marks are preserved across re-syncs).
ALTER TABLE orders ALTER COLUMN amazon_status SET DEFAULT 'pending';
