-- Brands and ASINs a user must never publish: the importer drops them before
-- spending on AI, and meliService refuses to publish them on any path. Unlike
-- the "Filtro Global" (words searched in titles), brands here are matched
-- exactly against the product's brand, after normalizing it the same way
-- blocklist_brand_key does (services/publishBlocklist.ts mirrors it).
create table if not exists public.publish_blocklist (
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('brand', 'asin')),
  value      text not null,                -- blocklist_brand_key(brand), or the upper-case ASIN
  display    text,                         -- the brand as written, for the Settings list
  source     text not null default 'manual', -- 'single_seller_scan' | 'ml_forbidden' | 'manual'
  note       text,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, value)
);

alter table public.publish_blocklist enable row level security;
drop policy if exists "Users can view own blocklist" on public.publish_blocklist;
create policy "Users can view own blocklist" on public.publish_blocklist
  for select using (auth.uid() = user_id);
drop policy if exists "Users can add to own blocklist" on public.publish_blocklist;
create policy "Users can add to own blocklist" on public.publish_blocklist
  for insert with check (auth.uid() = user_id);
drop policy if exists "Users can remove from own blocklist" on public.publish_blocklist;
create policy "Users can remove from own blocklist" on public.publish_blocklist
  for delete using (auth.uid() = user_id);

-- Lowercase, common accents removed, "&" read as "and", anything that isn't a
-- letter or digit turned into a single space. "Melissa & Doug" and
-- "MELISSA AND DOUG" both become "melissa and doug"; "..." becomes NULL.
create or replace function public.blocklist_brand_key(b text) returns text
language sql immutable set search_path = '' as $$
  select nullif(trim(regexp_replace(
    replace(lower(translate(coalesce(b, ''),
      'ÁÀÄÂÃÅáàäâãåÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔÕóòöôõÚÙÜÛúùüûÑñÇç',
      'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc')), '&', ' and '),
    '[^a-z0-9]+', ' ', 'g')), '')
$$;

-- Placeholders sellers use when a product has no real brand. Blocking one of
-- these would block every unbranded product, so such ASINs are blocked one by
-- one instead.
create or replace function public.blocklist_is_generic_brand(k text) returns boolean
language sql immutable set search_path = '' as $$
  select k is null or k in (
    'generic', 'generico', 'generica', 'genericos', 'genericas', 'marca generica',
    'sin marca', 'unbranded', 'no brand', 'n a', 'na', 'none', 'oem', 'unknown',
    'sin especificar', 'no especificada', 'no especificado', 'no aplica',
    'otros', 'otro', 'otra', 'varios', 'brand', 'marca', 'desconocida', 'desconocido')
$$;
