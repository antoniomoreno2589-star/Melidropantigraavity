-- Sandbox's date filter could only filter by created_at/updated_at — neither
-- reliably answers "when was this actually published for real", since
-- updated_at gets touched by any later change (a sync, a manual edit), not
-- just the original real-publish moment.
alter table public.test_products
  add column if not exists published_to_real_at timestamptz;
