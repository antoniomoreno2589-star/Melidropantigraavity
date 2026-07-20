-- ML's real item status is really a (status, sub_status[]) pair — e.g. a
-- "closed" item can be seller-closed or removed by Mercado Libre itself,
-- distinguishable only via sub_status. The Sandbox page only tracked status,
-- so it couldn't tell those apart (needed for the "Eliminada por Mercado
-- Libre" bucket in the ML-style filter bar).
alter table public.test_products
  add column if not exists sub_status jsonb not null default '[]'::jsonb;
