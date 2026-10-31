-- Carte des points utiles (essai du 31/10/2026) : points ajoutés par les cyclistes, avis, photos,
-- « Toujours là ? », signalements et fusion avec les points OpenStreetMap.
-- À appliquer une fois sur le projet plan-my-ride (bsypkdsnhiepvcnhmfsm). Rejouable sans erreur.

-- Clé d'un point dans les avis et les votes : 'p:<uuid>' pour un point Sillage, 'node/123' (ou way/…, relation/…) pour un point OSM.

create table if not exists public.poi (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author text,
  type text not null check (type in ('bivouac','boulangerie','fontaine','epicerie','atelier','abri','cafe','recharge')),
  name text not null check (char_length(name) between 1 and 80),
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  details text check (char_length(details) <= 500),
  hours text check (char_length(hours) <= 200),
  contact text check (char_length(contact) <= 200),
  osm_ref text check (osm_ref ~ '^(node|way|relation)/[0-9]+$'),
  status text not null default 'pending' check (status in ('pending','valid','removed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists poi_latlon on public.poi (lat, lon);
create index if not exists poi_status on public.poi (status, created_at desc);
create index if not exists poi_osm on public.poi (osm_ref) where osm_ref is not null;

create table if not exists public.poi_review (
  id uuid primary key default gen_random_uuid(),
  poi_key text not null check (poi_key ~ '^(p:[0-9a-f-]{36}|(node|way|relation)/[0-9]+)$'),
  poi_name text check (char_length(poi_name) <= 120),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author text,
  rating smallint check (rating between 1 and 5),
  comment text check (char_length(comment) <= 1000),
  photo text check (photo ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'),
  status text not null default 'pending' check (status in ('pending','valid','removed')),
  reports int not null default 0,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  check (rating is not null or comment is not null or photo is not null)
);
create index if not exists poi_review_key on public.poi_review (poi_key, created_at desc);
create index if not exists poi_review_status on public.poi_review (status, created_at desc);

create table if not exists public.poi_check (
  poi_key text not null check (poi_key ~ '^(p:[0-9a-f-]{36}|(node|way|relation)/[0-9]+)$'),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ok boolean not null,
  at timestamptz not null default now(),
  primary key (poi_key, user_id)
);

create table if not exists public.poi_report (
  review_id uuid not null references public.poi_review(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  primary key (review_id, user_id)
);

-- Peut écrire : compte actif avec l'accès Sillage (pas le mode démo, pas en attente, pas bloqué).
create or replace function public.poi_can_write() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users where user_id = auth.uid() and status = 'active' and pmr);
$$;

-- À l'ajout par un cycliste : auteur = son prénom, statut « en validation », compteurs à zéro.
create or replace function public.poi_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    new.author := (select nullif(trim(prenom), '') from public.app_users where user_id = auth.uid());
    if not public.is_admin() then
      new.status := 'pending'; new.reviewed_at := null;
      if tg_table_name = 'poi' then new.osm_ref := null; end if;
      if tg_table_name = 'poi_review' then new.reports := 0; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists poi_bi on public.poi;
create trigger poi_bi before insert on public.poi for each row execute function public.poi_before_insert();
drop trigger if exists poi_review_bi on public.poi_review;
create trigger poi_review_bi before insert on public.poi_review for each row execute function public.poi_before_insert();

-- Un signalement ajoute 1 au compteur de l'avis.
create or replace function public.poi_report_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.poi_review set reports = reports + 1 where id = new.review_id;
  return new;
end $$;
drop trigger if exists poi_report_ai on public.poi_report;
create trigger poi_report_ai after insert on public.poi_report for each row execute function public.poi_report_count();

-- « Toujours là ? » : totaux par point, sans dévoiler qui a voté.
create or replace function public.poi_checks(keys text[])
returns table (poi_key text, ok int, ko int, last_ok timestamptz, mine boolean)
language sql stable security definer set search_path = public as $$
  select c.poi_key,
         count(*) filter (where c.ok)::int,
         count(*) filter (where not c.ok)::int,
         max(c.at) filter (where c.ok),
         coalesce(bool_or(c.ok) filter (where c.user_id = auth.uid()), null)
  from public.poi_check c
  where c.poi_key = any(keys) and auth.uid() is not null
  group by c.poi_key;
$$;

-- Fusion (admin) : le point Sillage reprend les infos choisies, remplace le point OSM et récupère ses avis et ses votes.
create or replace function public.poi_merge(p_id uuid, p_osm text, p_name text, p_hours text, p_contact text, p_details text)
returns void language plpgsql security definer set search_path = public as $$
declare k text := 'p:' || p_id::text;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_osm !~ '^(node|way|relation)/[0-9]+$' then raise exception 'bad osm ref'; end if;
  update public.poi set name = coalesce(nullif(trim(p_name), ''), name), hours = nullif(trim(p_hours), ''),
    contact = nullif(trim(p_contact), ''), details = nullif(trim(p_details), ''),
    osm_ref = p_osm, status = 'valid', reviewed_at = now() where id = p_id;
  update public.poi_review set poi_key = k where poi_key = p_osm;
  delete from public.poi_check o where o.poi_key = p_osm and exists (select 1 from public.poi_check s where s.poi_key = k and s.user_id = o.user_id);
  update public.poi_check set poi_key = k where poi_key = p_osm;
end $$;

-- Annuler une fusion (admin) : le point repasse « en validation » et le point OSM réapparaît
-- (les avis venus du point OSM restent rattachés au point Sillage).
create or replace function public.poi_unmerge(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.poi set osm_ref = null, status = 'pending', reviewed_at = null where id = p_id;
end $$;

alter table public.poi enable row level security;
alter table public.poi_review enable row level security;
alter table public.poi_check enable row level security;
alter table public.poi_report enable row level security;

drop policy if exists poi_read on public.poi;
create policy poi_read on public.poi for select to authenticated using (status <> 'removed' or user_id = auth.uid() or public.is_admin());
drop policy if exists poi_add on public.poi;
create policy poi_add on public.poi for insert to authenticated with check (user_id = auth.uid() and public.poi_can_write());
drop policy if exists poi_admin_upd on public.poi;
create policy poi_admin_upd on public.poi for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists poi_del on public.poi;
create policy poi_del on public.poi for delete to authenticated using (public.is_admin() or (user_id = auth.uid() and status = 'pending'));

drop policy if exists poi_review_read on public.poi_review;
create policy poi_review_read on public.poi_review for select to authenticated using (status <> 'removed' or user_id = auth.uid() or public.is_admin());
drop policy if exists poi_review_add on public.poi_review;
create policy poi_review_add on public.poi_review for insert to authenticated with check (user_id = auth.uid() and public.poi_can_write());
drop policy if exists poi_review_admin_upd on public.poi_review;
create policy poi_review_admin_upd on public.poi_review for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists poi_review_del on public.poi_review;
create policy poi_review_del on public.poi_review for delete to authenticated using (public.is_admin() or user_id = auth.uid());

drop policy if exists poi_check_own on public.poi_check;
create policy poi_check_own on public.poi_check for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists poi_check_add on public.poi_check;
create policy poi_check_add on public.poi_check for insert to authenticated with check (user_id = auth.uid() and public.poi_can_write());
drop policy if exists poi_check_upd on public.poi_check;
create policy poi_check_upd on public.poi_check for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists poi_check_del on public.poi_check;
create policy poi_check_del on public.poi_check for delete to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists poi_report_add on public.poi_report;
create policy poi_report_add on public.poi_report for insert to authenticated with check (user_id = auth.uid() and public.poi_can_write());
drop policy if exists poi_report_read on public.poi_report;
create policy poi_report_read on public.poi_report for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists poi_report_admin_del on public.poi_report;
create policy poi_report_admin_del on public.poi_report for delete to authenticated using (public.is_admin());

revoke all on function public.poi_merge(uuid, text, text, text, text, text) from public, anon;
revoke all on function public.poi_unmerge(uuid) from public, anon;
revoke all on function public.poi_checks(text[]) from public, anon;
grant execute on function public.poi_merge(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.poi_unmerge(uuid) to authenticated;
grant execute on function public.poi_checks(text[]) to authenticated;

-- Photos : espace public en lecture (adresse publique), écriture dans son propre dossier <user_id>/…, JPEG de 3 Mo au plus.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('poi-photos', 'poi-photos', true, 3145728, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg'];

drop policy if exists poi_photos_add on storage.objects;
create policy poi_photos_add on storage.objects for insert to authenticated
  with check (bucket_id = 'poi-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.poi_can_write());
drop policy if exists poi_photos_del on storage.objects;
create policy poi_photos_del on storage.objects for delete to authenticated
  using (bucket_id = 'poi-photos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- Points OpenStreetMap vérifiés par les cyclistes (31/10/2026) : avis validés + « Oui, toujours là » des 12 derniers mois,
-- plus nombreux que les « Non, disparu ». Rectangle lu dans osm_poi (base de départ).
create or replace function public.poi_verified(s double precision, w double precision, n double precision, e double precision)
returns table (poi_key text, ok int, ko int, last_at timestamptz)
language sql stable security definer set search_path = public as $$
  with ev as (
    select r.poi_key, true as ok, r.created_at as at from public.poi_review r
      where r.status = 'valid' and r.poi_key !~ '^p:' and r.created_at > now() - interval '12 months'
    union all
    select c.poi_key, c.ok, c.at from public.poi_check c
      where c.poi_key !~ '^p:' and c.at > now() - interval '12 months'
  ), agg as (
    select ev.poi_key, count(*) filter (where ev.ok)::int ok, count(*) filter (where not ev.ok)::int ko, max(ev.at) filter (where ev.ok) last_at
    from ev group by ev.poi_key
  )
  select a.poi_key, a.ok, a.ko, a.last_at from agg a
  join public.osm_poi o on o.id = a.poi_key
  where auth.uid() is not null and a.ok > a.ko
    and o.lat between s and n and o.lon between w and e;
$$;
revoke all on function public.poi_verified(double precision, double precision, double precision, double precision) from public, anon;
grant execute on function public.poi_verified(double precision, double precision, double precision, double precision) to authenticated;
