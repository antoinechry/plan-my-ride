-- Connexion avec Google, Apple et code par e-mail (04/11/2026)
-- 1. handle_new_user : un compte créé par Google ou Apple (adresse vérifiée par le fournisseur) est actif tout de suite,
--    en compte gratuit comme un compte confirmé par e-mail ; prénom repris du fournisseur quand il le donne.
-- 2. auth_welcome(p_code) : appelée par la page après une connexion Google / Apple / code par e-mail :
--    - compte encore « pending » (adresse pas confirmée) : l'adresse est prouvée, le compte s'ouvre ;
--    - lien testeur gardé dans le navigateur (?invite=) : appliqué à un compte créé depuis moins d'un jour ;
--    - prénom vide : celui envoyé par la page (Apple ne le donne qu'à la première connexion, à l'app), sinon celui du fournisseur.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_code text := nullif(new.raw_user_meta_data->>'invite', '');
  v_ok boolean := false;
  v_social boolean := coalesce(new.raw_app_meta_data->>'provider', '') in ('google', 'apple') and new.email_confirmed_at is not null;
  v_name text := left(nullif(trim(coalesce(new.raw_user_meta_data->>'prenom', new.raw_user_meta_data->>'given_name',
                  split_part(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''), ' ', 1))), ''), 40);
begin
  if v_code is not null then
    update public.tester_links t set uses = t.uses + 1, last_used = now() where t.code = v_code and t.active;
    v_ok := found;
  end if;
  insert into public.app_users (user_id, email, prenom, invite, status, pmr, validated_at, plan)
  values (new.id, new.email, v_name, v_code,
          case when v_ok or v_social then 'active' else 'pending' end, v_ok or v_social,
          case when v_ok or v_social then now() end,
          case when v_ok then 'full' else 'free' end)
  on conflict (user_id) do nothing;
  return new;
end $function$;

create or replace function public.auth_welcome(p_code text default null, p_name text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_uid uuid := auth.uid();
  r public.app_users%rowtype;
  v_social boolean;
  v_otp boolean;
  v_name text;
  v_code text := nullif(left(trim(coalesce(p_code, '')), 40), '');
  v_inv boolean := false;
begin
  if v_uid is null then return null; end if;
  select * into r from public.app_users where user_id = v_uid for update;
  if not found or r.status in ('guest', 'blocked') then return jsonb_build_object('status', r.status); end if;
  v_social := exists (select 1 from auth.identities i where i.user_id = v_uid and i.provider in ('google', 'apple'));
  v_otp := coalesce(jsonb_path_exists(auth.jwt()->'amr', '$[*] ? (@.method == "otp" || @.method == "magiclink")'), false);
  if r.status = 'pending' and (v_social or v_otp) then
    update public.app_users set status = 'active', pmr = true, validated_at = coalesce(validated_at, now()) where user_id = v_uid;
    delete from public.email_confirm where user_id = v_uid;
  end if;
  v_name := left(nullif(trim(coalesce(p_name, '')), ''), 40);
  if r.prenom is null and v_social and v_name is null then
    select left(nullif(trim(coalesce(i.identity_data->>'given_name', split_part(coalesce(i.identity_data->>'full_name', i.identity_data->>'name', ''), ' ', 1))), ''), 40)
      into v_name from auth.identities i where i.user_id = v_uid and i.provider in ('google', 'apple') order by i.created_at limit 1;
  end if;
  if r.prenom is null and v_name is not null then update public.app_users set prenom = v_name where user_id = v_uid; end if;
  if v_code is not null and r.invite is null and r.created_at > now() - interval '1 day' then
    update public.tester_links t set uses = t.uses + 1, last_used = now() where t.code = v_code and t.active;
    v_inv := found;
    if v_inv then
      update public.app_users set invite = v_code, plan = 'full', status = 'active', pmr = true, validated_at = coalesce(validated_at, now()) where user_id = v_uid;
    end if;
  end if;
  select * into r from public.app_users where user_id = v_uid;
  return jsonb_build_object('status', r.status, 'plan', r.plan, 'invite', v_inv);
end $function$;

revoke all on function public.auth_welcome(text, text) from public, anon;
grant execute on function public.auth_welcome(text, text) to authenticated;
