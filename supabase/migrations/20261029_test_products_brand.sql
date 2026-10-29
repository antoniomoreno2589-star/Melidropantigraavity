-- The Sandbox page searches by brand like Publicaciones does (products.brand),
-- but a test product's brand is inside its publish_payload, which the list
-- leaves out (see api.testProducts.list). Kept as a column instead, from the
-- payload's BRAND/MARCA attribute: the brand that would be published.
alter table public.test_products add column if not exists brand text;

create or replace function public.ml_payload_brand(p_payload jsonb)
returns text language sql immutable set search_path = '' as $$
  select nullif(btrim(a->>'value_name'), '')
  from jsonb_array_elements(case when jsonb_typeof(p_payload->'attributes') = 'array'
                                 then p_payload->'attributes' else '[]'::jsonb end) a
  where a->>'id' in ('BRAND', 'MARCA')
  limit 1
$$;

create or replace function public.test_products_set_brand()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.brand := public.ml_payload_brand(new.publish_payload);
  return new;
end $$;

create or replace trigger test_products_brand
  before insert or update of publish_payload on public.test_products
  for each row execute function public.test_products_set_brand();

-- Existing rows. On this project it ran in chunks of the id range first (all
-- at once reads every payload in one go), so here it finds nothing left to do.
update public.test_products
set brand = public.ml_payload_brand(publish_payload)
where brand is null and publish_payload is not null
  and public.ml_payload_brand(publish_payload) is not null;
