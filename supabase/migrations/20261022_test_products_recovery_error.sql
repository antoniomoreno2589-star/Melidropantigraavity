-- Why listing-recovery couldn't fill in a transferred Catálogo row (e.g. the
-- original Mercado Libre listing no longer exists). Rows with a value here are
-- skipped by later runs; NULL means not tried yet or recovered.
alter table public.test_products add column if not exists recovery_error text;
