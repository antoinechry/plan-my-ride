-- Écran de connexion v2.0 (07/11/2026) : « e-mail d'abord ». Répond seulement oui / non à une adresse complète,
-- pour envoyer vers « Content de te revoir » (mot de passe ou code) ou « Bienvenue » (création de compte).
-- Les comptes invités du mode démo (app_users.status = 'guest') comptent comme inconnus. Appelée par la page sans session
-- (clé anon) : POST /rest/v1/rpc/auth_email_known { p_email }.
create or replace function public.auth_email_known(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from auth.users u
    left join public.app_users a on a.user_id = u.id
    where lower(u.email) = lower(trim(p_email))
      and u.deleted_at is null
      and coalesce(a.status, '') <> 'guest'
  );
$$;
revoke all on function public.auth_email_known(text) from public;
grant execute on function public.auth_email_known(text) to anon, authenticated;
