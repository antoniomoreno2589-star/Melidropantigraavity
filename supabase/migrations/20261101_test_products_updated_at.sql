-- test_products.updated_at only ever held the creation time: nothing set it
-- on a change, so the Sandbox's "Actualización" date filter matched the
-- creation date for every product (confirmed live: max(updated_at) equal to
-- max(created_at), weeks after products were tested, repaired and published).

-- The one past change that kept a date of its own: publishing for real.
-- Before the trigger below, which would stamp now() over it.
update public.test_products
set updated_at = published_to_real_at
where published_to_real_at > updated_at;

-- From now on every change to a row stamps it: a test or real publish, a
-- repaired payload or title, data filled in by hand, a status sync, a
-- re-import (the importer upserts by ASIN).
create or replace function public.test_products_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace trigger test_products_touch_updated_at
  before update on public.test_products
  for each row execute function public.test_products_touch_updated_at();
