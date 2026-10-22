-- Used by listing-recovery: stores the Mercado Libre descriptions it fetched
-- for transferred Catálogo rows, inside the database, so the edge function
-- doesn't have to round-trip each full publish_payload (confirmed live that
-- doing so hit the edge runtime's compute limit). An empty text marks a
-- listing that has no description, so it isn't asked for again.
create or replace function public.apply_recovered_descriptions(p_user uuid, p_items jsonb)
returns int language sql security definer set search_path = public as $$
  with input as (
    select (e->>'id')::uuid as id, coalesce(e->>'text', '') as txt from jsonb_array_elements(p_items) e),
  upd as (
    update test_products t
    set source_description = i.txt,
        publish_payload = case when i.txt <> ''
          then jsonb_set(t.publish_payload, '{description}', jsonb_build_object('plain_text', i.txt))
          else t.publish_payload end
    from input i
    where t.id = i.id and t.user_id = p_user and t.publish_payload is not null
    returning 1)
  select count(*)::int from upd
$$;

-- Writes any user's rows, so only the service role may run it.
revoke execute on function public.apply_recovered_descriptions(uuid, jsonb) from public, anon, authenticated;
