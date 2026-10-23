-- Helpers over ml_category_cache for cleaning the listings transferred to a
-- new account (see services/attributeRepair.ts for the publish-time side).

-- Text compared without case, accents or extra spaces.
create or replace function public.ml_text_key(t text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select regexp_replace(translate(lower(trim(coalesce(t, ''))), 'áéíóúàèìòùäëïöüâêîôûñç', 'aeiouaeiouaeiouaeiounc'), '\s+', ' ', 'g')
$$;

-- One row per category attribute, with its name as ml_text_key gives it.
-- An attribute whose value equals its own name ("Color: Color", "Material
-- de la botella: Material de la botella") is filler: confirmed live in 73% of
-- the transferred listings. Internal only (no RLS on materialized views).
create materialized view if not exists public.ml_category_attributes as
  select c.category_id, e->>'id' as attribute_id, e->>'name' as name, public.ml_text_key(e->>'name') as name_key,
         coalesce((e->'tags') ? 'required' or (e->'tags') ? 'new_required', false) as required
  from public.ml_category_cache c, jsonb_array_elements(c.attributes) e;
create unique index if not exists ml_category_attributes_pk on public.ml_category_attributes (category_id, attribute_id);
revoke all on public.ml_category_attributes from anon, authenticated;

-- A listing title fitted to its category's max_title_length without losing
-- what it says. Confirmed live: the transferred titles (Mercado Libre's own,
-- up to ~85 characters) had been cut at character 60 — 5,466 of them in the
-- middle of a word ("… Aislante Térmico Bla") — and 375 in categories that
-- allow 100-200 characters didn't need cutting at all. ML had also appended
-- filler to them: attribute names given as values ("… Rosa Neón Color Nombre
-- Del Diseño"). So: drop that filler from the end, then, only if still too
-- long, cut after the last whole word. Nothing is reworded.
-- p_fillers: attribute names in ml_text_key form (ml_category_attributes.name_key).
create or replace function public.ml_fit_title(p_title text, p_fillers text[], p_limit int)
returns text language plpgsql immutable set search_path = '' as $$
declare
  t text := trim(regexp_replace(regexp_replace(coalesce(p_title, ''), '[<>|\\]', '', 'g'), '\s+', ' ', 'g'));
  lim int := coalesce(p_limit, 60);
  -- Plus generic filler that also turns up on its own at the end. Longest
  -- first, so "Nombre del diseño" goes whole instead of leaving "Nombre Del".
  keys text[] := array(select k from unnest(coalesce(p_fillers, '{}'::text[]) || array['color', 'diseno', 'nombre del diseno']) k
                       where k <> '' order by length(k) desc);
  tk text; k text; changed boolean := true; touched boolean := false;
begin
  -- Filler Mercado Libre appended to its generated titles: an attribute's own
  -- name ("… Color Nombre Del Diseño"), dropped from the end.
  tk := public.ml_text_key(t);
  while changed loop
    changed := false;
    foreach k in array keys loop
      if length(tk) > length(k) + 1 and right(tk, length(k) + 1) = ' ' || k then
        t := rtrim(left(t, length(t) - length(k) - 1));
        tk := public.ml_text_key(t);
        changed := true; touched := true;
      end if;
    end loop;
  end loop;
  -- The last word repeated by the value ML appended ("… Color Blanco Blanco").
  -- Words only, and only at the end: a repeat elsewhere can be meant ("2 2").
  if t ~* '(\m[[:alpha:]]\S*)(\s+\1)+$' then
    t := regexp_replace(t, '(\m[[:alpha:]]\S*)(\s+\1)+$', '\1', 'i');
    touched := true;
  end if;
  -- Over the category's limit: cut after the last whole word, never inside one.
  if length(t) > lim then
    t := regexp_replace(left(t, lim + 1), '\s+\S*$', '');
    if length(t) > lim then t := left(t, lim); end if;
    touched := true;
  end if;
  -- After a change, nothing left dangling at the end ("… Con", "… De", "… /").
  if touched then
    t := regexp_replace(t, '(\s+(de|del|con|para|por|en|sin|y|la|las|el|los|al|que))+$', '', 'i');
    t := regexp_replace(t, '[\s,;:/+&-]+$', '');
  end if;
  return t;
end $$;
