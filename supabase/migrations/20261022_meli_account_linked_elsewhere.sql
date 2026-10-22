-- True when another Melidrop user already has this Mercado Libre account
-- connected. ProfilePage asks before linking it: Mercado Libre connects
-- whichever ML account is signed in on the browser, so on a shared computer
-- a new user would otherwise silently get someone else's account. Answers
-- yes/no only; nothing about the other user leaves the database.
create or replace function public.meli_account_linked_elsewhere(p_meli_user_id text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_connections
    where user_id <> auth.uid() and meli_credentials->>'id' = p_meli_user_id)
$$;

revoke execute on function public.meli_account_linked_elsewhere(text) from public, anon;
grant execute on function public.meli_account_linked_elsewhere(text) to authenticated;
