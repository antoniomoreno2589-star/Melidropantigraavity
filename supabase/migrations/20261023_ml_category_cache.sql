-- Mercado Libre's category definitions, cached: each attribute's name, type,
-- tags, units and closed-list values, plus settings.max_title_length (the
-- limit for title and family_name, which varies by category). Filled by the
-- category-cache edge function. Public ML data, so any signed-in user may
-- read it; only the service role writes.
create table if not exists public.ml_category_cache (
  category_id      text primary key,
  max_title_length int,
  attributes       jsonb not null,
  fetched_at       timestamptz not null default now()
);

alter table public.ml_category_cache enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ml_category_cache'
                 and policyname = 'Category definitions are readable') then
    create policy "Category definitions are readable" on public.ml_category_cache
      for select to authenticated using (true);
  end if;
end $$;
