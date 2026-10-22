-- The Sandbox page (api.testProducts.list) reads every test product of the
-- account, 1,000 rows per request. Confirmed live that for an account with
-- 27,214 rows each request took over 8 s and failed on the API's statement
-- timeout (500 — the page never loaded):
--  * whether a row has a payload was read as publish_payload->>'category_id',
--    which unpacks every row's whole payload (pictures, attributes,
--    description) on every request;
--  * pages were read by offset, so each one sorted all of the account's rows
--    and re-read every row before it.

-- The same fact as a plain column. Existing rows read the stored default
-- without rewriting the table; only the few without a payload are updated.
set local lock_timeout = '5s';
alter table public.test_products add column if not exists has_payload boolean not null default true;
update public.test_products set has_payload = false where publish_payload is null and has_payload;
alter table public.test_products alter column has_payload set default false;

create or replace function public.test_products_set_has_payload()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.has_payload := new.publish_payload is not null;
  return new;
end $$;

drop trigger if exists test_products_has_payload on public.test_products;
create trigger test_products_has_payload
  before insert or update of publish_payload on public.test_products
  for each row execute function public.test_products_set_has_payload();

-- The list now pages by id within the account (each request starts after the
-- last id it got), so a request reads only its own rows.
create index if not exists test_products_user_id_idx on public.test_products (user_id, id);
