-- Base de départ des points OpenStreetMap pour la carte des points utiles (31/10/2026).
-- osm_poi : points OSM des 8 types de la carte (eau, boulangerie, épicerie, bivouac, abri, café · resto, atelier vélo, recharge),
-- importés carré par carré par la fonction edge osm-import (tâche pg_cron sillage-osm-import), puis rafraîchis chaque semaine.
-- osm_tiles : la grille d'import (France métropolitaine, Corse et bandes frontalières, carrés de 0,5°, découpés en 4 si trop lourds).

create table if not exists public.osm_poi (
  id text primary key,                 -- 'node/123', 'way/456', 'relation/789'
  type text not null,
  name text,
  lat double precision not null,
  lon double precision not null,
  t jsonb not null default '{}'::jsonb, -- étiquettes utiles seulement (horaires, adresse, contact, nature exacte)
  tile text not null,
  updated_at timestamptz not null default now()
);
create index if not exists osm_poi_latlon on public.osm_poi (lat, lon);
create index if not exists osm_poi_tile on public.osm_poi (tile);

create table if not exists public.osm_tiles (
  key text primary key,
  s double precision not null, w double precision not null, n double precision not null, e double precision not null,
  status text not null default 'pending' check (status in ('pending','done','error','split')),
  n_poi int,
  tries int not null default 0,
  picked_at timestamptz,
  done_at timestamptz,
  err text
);

alter table public.osm_poi enable row level security;
alter table public.osm_tiles enable row level security;
drop policy if exists osm_poi_read on public.osm_poi;
create policy osm_poi_read on public.osm_poi for select to anon, authenticated using (true);
drop policy if exists osm_tiles_read on public.osm_tiles;
create policy osm_tiles_read on public.osm_tiles for select to anon, authenticated using (true);

-- Grille : France métropolitaine et frontières (41,0 → 51,5 N ; −5,5 → 10,0 E), carrés de 0,5°.
insert into public.osm_tiles (key, s, w, n, e)
select format('%s:%s', a, o), a * 0.5, o * 0.5, a * 0.5 + 0.5, o * 0.5 + 0.5
from generate_series(82, 102) a, generate_series(-11, 19) o
on conflict (key) do nothing;

-- Prend les prochains carrés à importer : jamais faits, en erreur (5 essais), ou faits il y a plus de 7 jours.
create or replace function public.osm_tile_claim(k int default 1)
returns setof public.osm_tiles language sql security definer set search_path = public as $$
  update public.osm_tiles t set picked_at = now(), tries = t.tries + 1
  where t.key in (
    select key from public.osm_tiles
    where (picked_at is null or picked_at < now() - interval '10 minutes')
      and (status = 'pending' or (status = 'error' and tries < 5) or (status = 'done' and done_at < now() - interval '7 days'))
    order by (status = 'done'), (status = 'error'), key
    limit k for update skip locked)
  returning t.*;
$$;

-- Remplace les points d'un carré.
create or replace function public.osm_tile_store(p_key text, p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare c int;
begin
  delete from public.osm_poi where tile = p_key;
  insert into public.osm_poi (id, type, name, lat, lon, t, tile, updated_at)
  select r->>'id', r->>'type', r->>'name', (r->>'lat')::float8, (r->>'lon')::float8, coalesce(r->'t', '{}'::jsonb), p_key, now()
  from jsonb_array_elements(p_rows) r
  on conflict (id) do update set type = excluded.type, name = excluded.name, lat = excluded.lat, lon = excluded.lon, t = excluded.t, tile = excluded.tile, updated_at = now();
  get diagnostics c = row_count;
  update public.osm_tiles set status = 'done', n_poi = c, done_at = now(), tries = 0, err = null where key = p_key;
  return c;
end $$;

-- Carré trop lourd pour Overpass : coupé en 4.
create or replace function public.osm_tile_split(p_key text)
returns int language plpgsql security definer set search_path = public as $$
declare t public.osm_tiles; ms double precision; mw double precision;
begin
  select * into t from public.osm_tiles where key = p_key;
  if t is null or (t.n - t.s) <= 0.13 then return 0; end if;
  ms := (t.s + t.n) / 2; mw := (t.w + t.e) / 2;
  insert into public.osm_tiles (key, s, w, n, e) values
    (p_key || '.a', t.s, t.w, ms, mw), (p_key || '.b', t.s, mw, ms, t.e),
    (p_key || '.c', ms, t.w, t.n, mw), (p_key || '.d', ms, mw, t.n, t.e)
  on conflict (key) do nothing;
  update public.osm_tiles set status = 'split', err = 'découpé en 4' where key = p_key;
  return 4;
end $$;

revoke all on function public.osm_tile_claim(int) from public, anon, authenticated;
revoke all on function public.osm_tile_store(text, jsonb) from public, anon, authenticated;
revoke all on function public.osm_tile_split(text) from public, anon, authenticated;

-- Import depuis un navigateur (31/10/2026) : les serveurs Overpass refusent les adresses de Supabase.
-- Jeton temporaire dans osm_import_token (6 h), rows envoyées par paquets de 1 500 via rpc/osm_web_put.
create table if not exists public.osm_import_token (token text primary key, expires_at timestamptz not null);
alter table public.osm_import_token enable row level security;

create or replace function public.osm_web_put(p_token text, p_key text, p_rows jsonb, p_first boolean, p_last boolean)
returns int language plpgsql security definer set search_path = public as $$
declare c int;
begin
  if not exists (select 1 from public.osm_import_token where token = p_token and expires_at > now()) then raise exception 'token'; end if;
  if not exists (select 1 from public.osm_tiles where key = p_key) then raise exception 'tile'; end if;
  if jsonb_array_length(p_rows) > 3000 then raise exception 'too many rows'; end if;
  if p_first then delete from public.osm_poi where tile = p_key; end if;
  insert into public.osm_poi (id, type, name, lat, lon, t, tile, updated_at)
  select r->>'id', r->>'type', left(r->>'name', 120), (r->>'lat')::float8, (r->>'lon')::float8, coalesce(r->'t', '{}'::jsonb), p_key, now()
  from jsonb_array_elements(p_rows) r
  where r->>'id' ~ '^(node|way|relation)/[0-9]+$' and r->>'type' in ('bivouac','boulangerie','fontaine','epicerie','atelier','abri','cafe','recharge')
  on conflict (id) do update set type = excluded.type, name = excluded.name, lat = excluded.lat, lon = excluded.lon, t = excluded.t, tile = excluded.tile, updated_at = now();
  if p_last then
    select count(*) into c from public.osm_poi where tile = p_key;
    update public.osm_tiles set status = 'done', n_poi = c, done_at = now(), tries = 0, err = null, picked_at = now() where key = p_key;
  end if;
  return coalesce(c, 0);
end $$;
revoke all on function public.osm_web_put(text, text, jsonb, boolean, boolean) from public;
grant execute on function public.osm_web_put(text, text, jsonb, boolean, boolean) to anon, authenticated;
-- Pour un nouvel import : insert into public.osm_import_token values (encode(gen_random_bytes(24), 'hex'), now() + interval '6 hours');
-- Après l'import : delete from public.osm_import_token;
