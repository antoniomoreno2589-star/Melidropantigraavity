-- Hands one user's listings to another Melidrop account (the owner passing his
-- catalog to a relative who now sells on her own Mercado Libre account),
-- leaving out everything on the owner's publish_blocklist. Everything lands in
-- the recipient's Sandbox (test_products), unpublished, for her to publish.

-- Catálogo rows have no category, attributes or pictures saved (those only
-- ever lived on the Mercado Libre listing), so a copied Catálogo row keeps the
-- old listing's id and description here until they're recovered from ML.
alter table public.test_products add column if not exists source_meli_id text;
alter table public.test_products add column if not exists source_description text;

create or replace function public.transfer_listings(p_from uuid, p_to uuid, p_include_catalog boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_blocklist int;
  v_sandbox int;
  v_catalog int := 0;
  v_sandbox_blocked int;
  v_catalog_blocked int := 0;
begin
  if p_from = p_to then raise exception 'origin and recipient are the same account'; end if;
  if not exists (select 1 from auth.users where id = p_to) then raise exception 'recipient account % does not exist', p_to; end if;

  -- Her blocklist starts as a copy of his, so her importer and publishing
  -- refuse the same brands and ASINs from day one.
  insert into publish_blocklist (user_id, kind, value, display, source, note)
  select p_to, kind, value, display, source, note from publish_blocklist where user_id = p_from
  on conflict do nothing;
  get diagnostics v_blocklist = row_count;

  -- Every ASIN of his that is blocked by ASIN, or whose brand (as saved in
  -- the Catálogo or in a Sandbox payload) is a blocked brand.
  create temp table _blocked on commit drop as
  with brands as (
    select upper(trim(coalesce(nullif(p.asin, ''), p.sku))) as asin, blocklist_brand_key(p.brand) as k
    from products p where p.user_id = p_from and p.brand is not null
    union all
    select upper(trim(t.asin)), blocklist_brand_key(a->>'value_name')
    from test_products t
    cross join lateral jsonb_array_elements(case when jsonb_typeof(t.publish_payload->'attributes') = 'array' then t.publish_payload->'attributes' else '[]'::jsonb end) a
    where t.user_id = p_from and a->>'id' in ('BRAND', 'MARCA'))
  select value as asin from publish_blocklist where user_id = p_from and kind = 'asin'
  union
  select b.asin from brands b join publish_blocklist l on l.user_id = p_from and l.kind = 'brand' and l.value = b.k;

  -- Sandbox rows carry the complete payload (title, category, attributes,
  -- pictures, price): ready for "Publicar Real" on her account.
  select count(*) into v_sandbox_blocked from test_products t
  where t.user_id = p_from and t.publish_payload is not null and upper(trim(t.asin)) in (select asin from _blocked);

  insert into test_products (user_id, title, asin, sku, price_mxn, cost_usd, stock_provider, stock_meli, status,
                             image_url, category, is_published_to_real, meli_id, publish_payload, sub_status, currency)
  select p_to, t.title, upper(trim(t.asin)), t.sku, t.price_mxn, t.cost_usd, t.stock_provider, 0, 'active',
         t.image_url, t.category, false, null, t.publish_payload, '[]'::jsonb, t.currency
  from test_products t
  where t.user_id = p_from and t.publish_payload is not null and t.asin is not null
    and upper(trim(t.asin)) not in (select asin from _blocked)
  on conflict (user_id, asin) do nothing;
  get diagnostics v_sandbox = row_count;

  -- Catálogo rows (one per ASIN; the active, most recently updated listing
  -- wins) go in after the Sandbox ones, so a complete payload is never
  -- displaced. They stay unpublishable until their data is recovered.
  if p_include_catalog then
    select count(distinct upper(trim(coalesce(nullif(p.asin, ''), p.sku)))) into v_catalog_blocked from products p
    where p.user_id = p_from and upper(trim(coalesce(nullif(p.asin, ''), p.sku))) in (select asin from _blocked);

    insert into test_products (user_id, title, asin, sku, price_mxn, cost_usd, stock_provider, stock_meli, status,
                               image_url, is_published_to_real, publish_payload, sub_status, currency,
                               source_meli_id, source_description)
    select distinct on (c.nasin) p_to, coalesce(c.title, c.nasin), c.nasin, c.nasin, c.price_mxn, c.cost_usd, 0, 0, 'active',
           c.image_url, false, null, '[]'::jsonb, coalesce(c.currency, 'MXN'), c.meli_id, c.description_text
    from (select p.*, upper(trim(coalesce(nullif(p.asin, ''), p.sku))) as nasin from products p where p.user_id = p_from) c
    where c.nasin ~ '^[A-Z0-9]{10}$' and c.nasin not in (select asin from _blocked)
    order by c.nasin, (c.status = 'active') desc, c.last_updated desc nulls last
    on conflict (user_id, asin) do nothing;
    get diagnostics v_catalog = row_count;
  end if;

  return jsonb_build_object(
    'blocklist_copied', v_blocklist,
    'sandbox_copied', v_sandbox, 'sandbox_blocked', v_sandbox_blocked,
    'catalog_copied', v_catalog, 'catalog_blocked', v_catalog_blocked);
end;
$$;

-- Writes into another user's rows, so only the service role may run it.
revoke execute on function public.transfer_listings(uuid, uuid, boolean) from public, anon, authenticated;
