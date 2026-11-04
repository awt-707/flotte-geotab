-- =============================================================================
-- Relecture du 17/10/2026. À exécuter une fois dans Supabase > SQL Editor (après 20261022000000_vitesse.sql). Rejouable sans risque.
-- 1. Import de contrats : un gestionnaire ne peut plus importer un contrat sans véhicule ; téléphone, e-mail, plaque, modèle, origine
--    et commentaire corrigés dans l'extract sont maintenant enregistrés (ils étaient ignorés si le reste n'avait pas changé).
-- 2. Changement de plaque : les alertes gardent leur statut, leur commentaire et ne sont pas renvoyées par e-mail.
-- 3. Index pour « Chauffeurs en ce moment » (événements par contrat).
-- =============================================================================

create or replace function public.import_contracts(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_add integer; n_upd integer; n_same integer; n_skip integer := 0; m timestamptz; adm boolean := is_admin(); keys text[] := my_vehicle_keys();
begin
  if coalesce(my_role(), '') not in ('admin', 'manager') then raise exception 'droits insuffisants'; end if;
  create temp table _c on commit drop as
    select distinct on (r.num) r.* from jsonb_populate_recordset(null::contracts, coalesce(p_rows, '[]')) r where coalesce(r.num, '') <> '' order by r.num;
  if not adm then
    select count(*) into n_skip from _c c left join contracts o on o.num = c.num
     where not (coalesce(c.vehicle_key, '') = any(keys)) or (o.num is not null and not (coalesce(o.vehicle_key, '') = any(keys)));
    delete from _c c using (select c2.num from _c c2 left join contracts o on o.num = c2.num
      where not (coalesce(c2.vehicle_key, '') = any(keys)) or (o.num is not null and not (coalesce(o.vehicle_key, '') = any(keys)))) x where c.num = x.num;
  end if;
  create temp table _s on commit drop as
    select c.*, o.num is not null as known, o.start_at as old_start, o.imported_at as old_imported,
      (o.num is not null and o.client_code is not distinct from c.client_code and o.name is not distinct from c.name and o.vehicle_key is not distinct from c.vehicle_key
        and o.start_at is not distinct from c.start_at and o.end_at is not distinct from c.end_at and coalesce(o.status, '') = coalesce(c.status, '')
        and o.plate is not distinct from c.plate and o.model is not distinct from c.model and o.origin is not distinct from c.origin
        and o.phone is not distinct from c.phone and o.email is not distinct from c.email and o.comment is not distinct from c.comment) as same
      from _c c left join contracts o on o.num = c.num;
  select count(*) filter (where not known), count(*) filter (where known and not same), count(*) filter (where same),
         least(min(start_at) filter (where not same), min(old_start) filter (where known and not same))
    into n_add, n_upd, n_same, m from _s;
  insert into contracts (num, client_code, name, plate, vehicle_key, model, start_at, end_at, status, origin, phone, email, comment, imported_at, updated_at)
  select num, client_code, name, plate, vehicle_key, model, start_at, end_at, status, origin, phone, email, comment, coalesce(old_imported, now()), now() from _s where not same
  on conflict (num) do update set client_code = excluded.client_code, name = excluded.name, plate = excluded.plate, vehicle_key = excluded.vehicle_key,
    model = excluded.model, start_at = excluded.start_at, end_at = excluded.end_at, status = excluded.status, origin = excluded.origin, phone = excluded.phone,
    email = excluded.email, comment = excluded.comment, imported_at = excluded.imported_at, updated_at = excluded.updated_at;
  return jsonb_build_object('added', n_add, 'updated', n_upd, 'same', n_same, 'min_start', m, 'skipped', n_skip);
end $$;
revoke execute on function public.import_contracts(jsonb) from public, anon;
grant execute on function public.import_contracts(jsonb) to authenticated, service_role;

create or replace function public.rekey_vehicle(p_alias text, p_canon text)
returns date language plpgsql set search_path = public as $$
declare t text; d date; m date; pre text := p_alias || '|'; np integer := length(p_alias) + 2;
begin
  if p_alias = p_canon or coalesce(p_alias, '') = '' or coalesce(p_canon, '') = '' then return null; end if;
  foreach t in array array['trips', 'idles', 'events', 'fuel', 'levels', 'engine_stops'] loop
    execute format('select min(vday) from %I where vehicle_key = $1', t) into d using p_alias;
    if d is not null and (m is null or d < m) then m := d; end if;
    -- identifiant déjà présent sous la clé historique : doublon
    execute format('delete from %I a where a.vehicle_key = $1 and left(a.id, length($3)) = $3 and exists (select 1 from %I b where b.id = $2 || ''|'' || substr(a.id, $4))', t, t)
      using p_alias, p_canon, pre, np;
    execute format('update %I set vehicle_key = $2, id = case when left(id, length($3)) = $3 then $2 || ''|'' || substr(id, $4) else id end where vehicle_key = $1', t)
      using p_alias, p_canon, pre, np;
  end loop;
  update idles set trip_id = p_canon || '|' || substr(trip_id, np) where left(trip_id, length(pre)) = pre;
  update engine_stops set trip_id = p_canon || '|' || substr(trip_id, np) where left(trip_id, length(pre)) = pre;
  delete from vehicle_days a where a.vehicle_key = p_alias and exists (select 1 from vehicle_days b where b.id = p_canon || '|' || substr(a.id, np));
  update vehicle_days set vehicle_key = p_canon, id = p_canon || '|' || substr(id, np) where vehicle_key = p_alias;
  update contracts set vehicle_key = p_canon where vehicle_key = p_alias;
  update journal set vehicle_key = p_canon where vehicle_key = p_alias;
  -- alertes : identifiants qui contiennent la clé (VIT|clé|…, MOT|jour|clé…) renommés, statut, commentaire et envoi conservés
  -- (sinon le recalcul les recréait « À traiter » et les renvoyait par e-mail)
  delete from alerts a where a.vehicle_key = p_alias and position('|' || p_alias in a.id) > 0
    and exists (select 1 from alerts b where b.id = left(replace(a.id || '|', '|' || p_alias || '|', '|' || p_canon || '|'), -1));
  update alerts set vehicle_key = p_canon, id = left(replace(id || '|', '|' || p_alias || '|', '|' || p_canon || '|'), -1) where vehicle_key = p_alias;
  delete from live_status where vehicle_key = p_alias;
  return m;
end $$;

create index if not exists events_contract on public.events(contract_num);
