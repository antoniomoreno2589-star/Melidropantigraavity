-- Remove the orders_status_check constraint.
-- Status validation is handled in application code (mapMlStatus) before
-- any row reaches the DB, so the DB-level check is redundant and blocks
-- valid upserts when ML introduces new status values.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
