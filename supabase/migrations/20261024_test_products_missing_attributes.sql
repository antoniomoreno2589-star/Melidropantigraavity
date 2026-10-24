-- Required attributes the last publish couldn't fill from Amazon or the
-- title (services/attributeRepair), with what a form needs to ask for each:
-- name, type, units, the category's values. The Sandbox page lists them for
-- the seller to complete by hand; cleared once a publish needs nothing more.
alter table public.test_products add column if not exists missing_attributes jsonb;
