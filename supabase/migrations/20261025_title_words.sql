-- Words seen whole (anywhere but last) in an account's listing titles. A
-- title whose last word never appears whole but starts one that does ends
-- in a cut-off fragment ("… 170 Kg 31 Esca", "… Control De Temperatu"):
-- confirmed live on 457 of the transferred titles, cut at 60 characters by an
-- importer. Filled in chunks of the catalog; derived data, safe to rebuild.
create unlogged table if not exists public.title_words (w text collate "C" primary key);
alter table public.title_words enable row level security;
