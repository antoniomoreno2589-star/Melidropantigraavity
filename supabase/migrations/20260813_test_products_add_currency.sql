-- Amazon marketplace links (Sandbox and elsewhere) hardcoded amazon.com
-- regardless of source — confirmed live a MXN-origin ("Nacional") product's
-- ASIN link still pointed at amazon.com instead of amazon.com.mx. products
-- already tracks this per-item via its currency column; test_products never
-- did, so the Sandbox page had no way to route the link correctly even after
-- fixing the link logic itself.
alter table public.test_products
  add column if not exists currency text not null default 'USD';
