-- 07/11/2026 : points et avis de la Carte anonymes (affichés « Ajouté par un·e cycliste »).
-- Plus de prénom enregistré à l'ajout, et colonne `author` vidée pour l'existant. Appliqué via la migration poi_anonymous_author.
create or replace function public.poi_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    new.author := null;
    if not public.is_admin() then
      new.status := 'pending'; new.reviewed_at := null;
      if tg_table_name = 'poi' then new.osm_ref := null; end if;
      if tg_table_name = 'poi_review' then new.reports := 0; end if;
    end if;
  end if;
  return new;
end $$;
update public.poi set author = null where author is not null;
update public.poi_review set author = null where author is not null;
