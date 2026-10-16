-- =============================================================================
-- Sécurité des droits par agence (relecture du 16/10/2026). À exécuter une fois dans Supabase > SQL Editor.
-- Rejouable sans risque. Ne change rien pour l'administrateur.
-- =============================================================================

-- 1. Un compte remis « en attente » ne voit plus rien, même s'il reste rattaché à une agence
create or replace function public.my_agency_ids() returns bigint[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(agency_id), '{}') from user_agencies
   where user_id = auth.uid() and (select role from profiles where user_id = auth.uid()) in ('manager', 'viewer')
$$;

-- 2. Import de contrats par un gestionnaire : uniquement les contrats des véhicules de ses agences
--    (ni créer, ni modifier un contrat d'une autre agence ; un contrat existant d'une autre agence n'est pas déplacé)
create or replace function public.import_contracts(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_add integer; n_upd integer; n_same integer; n_skip integer := 0; m timestamptz; adm boolean := is_admin(); keys text[] := my_vehicle_keys();
begin
  if coalesce(my_role(), '') not in ('admin', 'manager') then raise exception 'droits insuffisants'; end if;
  create temp table _c on commit drop as
    select distinct on (r.num) r.* from jsonb_populate_recordset(null::contracts, coalesce(p_rows, '[]')) r where coalesce(r.num, '') <> '' order by r.num;
  if not adm then
    select count(*) into n_skip from _c c left join contracts o on o.num = c.num
     where not (c.vehicle_key = any(keys)) or (o.num is not null and not (coalesce(o.vehicle_key, '') = any(keys)));
    delete from _c c using (select c2.num from _c c2 left join contracts o on o.num = c2.num
      where not (c2.vehicle_key = any(keys)) or (o.num is not null and not (coalesce(o.vehicle_key, '') = any(keys)))) x where c.num = x.num;
  end if;
  create temp table _s on commit drop as
    select c.*, o.num is not null as known, o.start_at as old_start, o.imported_at as old_imported,
      (o.num is not null and o.client_code is not distinct from c.client_code and o.name is not distinct from c.name and o.vehicle_key is not distinct from c.vehicle_key
        and o.start_at is not distinct from c.start_at and o.end_at is not distinct from c.end_at and coalesce(o.status, '') = coalesce(c.status, '')) as same
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

-- 3. Changements de plaque : lus et modifiés seulement pour les véhicules de ses agences (admin : tous)
drop policy if exists read_all on public.plate_changes;
drop policy if exists read_agency on public.plate_changes;
drop policy if exists mgr_all on public.plate_changes;
create policy read_agency on public.plate_changes for select to authenticated using ((select public.is_admin())
  or norm_plate(old_plate) = any((select public.my_vehicle_keys())::text[]) or norm_plate(new_plate) = any((select public.my_vehicle_keys())::text[]));
create policy mgr_all on public.plate_changes for all to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and (norm_plate(old_plate) = any((select public.my_vehicle_keys())::text[]) or norm_plate(new_plate) = any((select public.my_vehicle_keys())::text[]))))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and (norm_plate(old_plate) = any((select public.my_vehicle_keys())::text[]) or norm_plate(new_plate) = any((select public.my_vehicle_keys())::text[]))));

-- 4. Chauffeurs : un gestionnaire modifie ceux de ses agences (ou sans agence, vus sur ses véhicules), sans pouvoir retirer un chauffeur d'une agence
drop policy if exists mgr_update on public.drivers;
create policy mgr_update on public.drivers for update to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and (agency_id = any((select public.my_agency_ids())::bigint[])
    or (agency_id is null and code = any((select public.my_driver_codes())::text[])))))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[]))
    or (public.my_role() = 'manager' and agency_id is null and code = any((select public.my_driver_codes())::text[])));

-- un chauffeur rattaché à une agence n'en est pas retiré (ni déplacé ailleurs) par un gestionnaire
create or replace function public.drivers_guard_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_admin() and old.agency_id is not null and new.agency_id is distinct from old.agency_id
     and not (coalesce(new.agency_id, -1) = any(my_agency_ids())) then
    raise exception 'chauffeur rattaché à une agence : seul l''administrateur peut le retirer';
  end if;
  if auth.uid() is not null and not is_admin() and old.agency_id is not null and new.agency_id is null then
    raise exception 'chauffeur rattaché à une agence : seul l''administrateur peut le retirer';
  end if;
  return new;
end $$;
drop trigger if exists drivers_guard on public.drivers;
create trigger drivers_guard before update on public.drivers for each row execute function public.drivers_guard_trg();

-- 5. Agence d'un véhicule : reprise du parc seulement à la création ; retirée quand le parc la retire ou que la ligne du parc est supprimée
create or replace function public.vehicles_agency_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.agency_id is null then new.agency_id := parc_agency_for(new.key, new.plate, new.other_plates); end if;
  return new;
end $$;
create or replace function public.parc_agency_trg() returns trigger language plpgsql security definer set search_path = public as $$
declare pl text; ag bigint;
begin
  if tg_op = 'DELETE' then pl := old.plate; ag := null; else pl := new.plate; ag := new.agency_id; end if;
  update vehicles v set agency_id = ag
   where v.agency_id is distinct from ag
     and norm_plate(pl) in (select v.key union select norm_plate(v.plate) union select norm_plate(trim(x)) from unnest(regexp_split_to_array(coalesce(v.other_plates, ''), '[,;]')) x);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists parc_agency on public.parc;
create trigger parc_agency after insert or update of agency_id, plate or delete on public.parc for each row execute function public.parc_agency_trg();

-- 6. Journal technique et liste des comptes : administrateur seulement (chacun garde son propre profil) ;
--    demandes au collecteur : lues par admin / gestionnaire, et un gestionnaire ne dépose que les demandes de son travail
drop policy if exists read_all on public.logs;
drop policy if exists read_admin on public.logs;
create policy read_admin on public.logs for select to authenticated using ((select public.is_admin()));
drop policy if exists read_all on public.profiles;
drop policy if exists read_admin on public.profiles;
create policy read_admin on public.profiles for select to authenticated using ((select public.is_admin()));
drop policy if exists read_all on public.jobs;
drop policy if exists read_mgr on public.jobs;
create policy read_mgr on public.jobs for select to authenticated using (public.my_role() in ('admin', 'manager'));
drop policy if exists mgr_insert on public.jobs;
create policy mgr_insert on public.jobs for insert to authenticated
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and kind in ('sync_now', 'recompute', 'after_inject', 'apply_plates')));

-- 7. Classement : événements par chauffeur ET par véhicule (le site filtre par agence) ; mêmes droits de lecture que la table events
drop function if exists public.driver_rule_counts(date, date);
create or replace function public.driver_rule_counts(p_from date, p_to date)
returns table (driver_code text, rule_id text, vehicle_key text, n integer) language sql stable set search_path = public as $$
  with cd as (select contract_num, min(day) d from journal where contract_num is not null and contract_num <> '' group by 1)
  select e.driver_code, e.rule_id, e.vehicle_key, count(*)::int
    from events e join rules r on r.id = e.rule_id and r.weight > 0
    left join cd on cd.contract_num = e.contract_num
   where e.day between p_from - 2 and p_to + 1 and coalesce(e.driver_code, '') not in ('', 'HORS_CONTRAT')
     and coalesce(cd.d, e.day) between p_from and p_to
   group by 1, 2, 3
$$;
revoke execute on function public.driver_rule_counts(date, date) from public, anon;
grant execute on function public.driver_rule_counts(date, date) to authenticated, service_role;
