-- =============================================================================
-- Nouveaux chauffeurs détectés depuis les contrats et enregistrés tout de suite ; caisse séparée par agence (22/10/2026, demandes d'Ahmed).
-- À exécuter dans Supabase > SQL Editor (après 20261104000000_caisse_classeur.sql). Rejouable sans risque.
-- - import des contrats (site) : fiches des chauffeurs créées / mises à jour dans la même opération (avant : au passage suivant
--   du collecteur), nouveaux chauffeurs renvoyés au site
-- - chauffeur sans agence : agence du véhicule de son dernier contrat (les gestionnaires de l'agence le voient tout de suite)
-- - compte Uber relié tout seul (même téléphone, sinon même nom) pour la Caisse
-- Caisse séparée par agence (même jour, demande d'Ahmed : « chaque agence avec son propre suivi ») :
-- - chaque mouvement, transaction Uber et chauffeur Uber appartient à une agence (celle choisie dans la Caisse ; à défaut celle du
--   chauffeur, ou la seule agence) ; un gestionnaire ne voit et ne saisit que ceux de ses agences ; soldes et calculs par agence
-- - classeur de sauvegarde par agence (agencies.cash_sheet_id) ; l'agence existante reprend le classeur déjà préparé
-- =============================================================================
create or replace function public.name_key(t text) returns text language sql immutable as $$
  select coalesce(string_agg(w, ' ' order by w), '') from (select norm_name(x) w from regexp_split_to_table(coalesce(t, ''), '\s+') x) y where w <> ''
$$;

create or replace function public.refresh_drivers()
returns jsonb language plpgsql set search_path = public as $$
declare news jsonb; dupes jsonb;
begin
  create temp table _d on commit drop as
  with c as (select client_code code, trim(coalesce(name, '')) nm, start_at, phone, email, num from contracts
              where coalesce(client_code, '') <> '' and start_at is not null),
  agg as (select code, count(*)::int n, min(start_at) first_c, max(start_at) last_c from c group by code),
  lst as (select distinct on (code) code, nm, phone, email from c order by code, start_at desc, num desc),
  oth as (select c.code, string_agg(distinct c.nm, ' / ' order by c.nm) others from c join lst using (code) where c.nm <> '' and c.nm <> lst.nm group by c.code)
  select a.code, l.nm as name, coalesce(o.others, '') other_names, regexp_replace(coalesce(l.phone, ''), '^''', '') phone, coalesce(l.email, '') email,
         a.first_c, a.last_c, a.n, d.code is null as is_new,
         case when d.code is null then 'NOUVEAU' when d.status = 'NOUVEAU' and d.detected_at < now() - interval '7 days' then 'ACTIF' else coalesce(nullif(d.status, ''), 'ACTIF') end status,
         coalesce(d.detected_at, now()) detected_at, coalesce(d.note, '') note
    from agg a join lst l using (code) left join oth o using (code) left join drivers d on d.code = a.code;
  update _d set note = case when note = '' then '' else note || ' | ' end || 'Doublon possible : ' || g.codes
    from (select norm_name(name) k, string_agg(code, ', ' order by code) codes from _d group by 1 having count(*) > 1) g
   where norm_name(_d.name) = g.k and position('Doublon' in _d.note) = 0;
  select coalesce(jsonb_agg(name || ' (' || code || ')' order by name), '[]') into news from _d where is_new;
  select coalesce(jsonb_agg(codes), '[]') into dupes from (select string_agg(code, ' = ' order by code) codes from _d group by norm_name(name) having count(*) > 1) x;
  delete from drivers where code not in (select code from _d) and source <> 'manuel';
  insert into drivers (code, name, other_names, phone, email, first_contract, last_contract, n_contracts, status, detected_at, note)
  select code, name, other_names, phone, email, first_c, last_c, n, status, detected_at, note from _d
  on conflict (code) do update set
    name = case when drivers.source = 'manuel' and coalesce(drivers.name, '') <> '' then drivers.name else excluded.name end,
    other_names = excluded.other_names,
    phone = case when drivers.source = 'manuel' and coalesce(drivers.phone, '') <> '' then drivers.phone else excluded.phone end,
    email = case when drivers.source = 'manuel' and coalesce(drivers.email, '') <> '' then drivers.email else excluded.email end,
    first_contract = excluded.first_contract, last_contract = excluded.last_contract, n_contracts = excluded.n_contracts,
    status = excluded.status, note = excluded.note;
  -- agence d'un chauffeur qui n'en a pas : celle du véhicule de son dernier contrat (un chauffeur rattaché n'est jamais déplacé)
  update drivers d set agency_id = v.agency_id
    from (select distinct on (c.client_code) c.client_code, ve.agency_id from contracts c join vehicles ve on ve.key = c.vehicle_key
           where coalesce(c.client_code, '') <> '' and ve.agency_id is not null order by c.client_code, c.start_at desc nulls last, c.num desc) v
   where d.code = v.client_code and d.agency_id is null;
  -- compte Uber : même téléphone (9 derniers chiffres), sinon même nom (mots dans n'importe quel ordre) ; seulement un candidat unique,
  -- jamais un compte déjà relié à un autre chauffeur, jamais un chauffeur déjà relié
  if to_regclass('public.uber_drivers') is not null then
    with dp as (select code, right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9) p, name_key(name) k from drivers where uber_uuid is null),
    up as (select uuid, right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9) p, name_key(name) k from uber_drivers u
            where not exists (select 1 from drivers x where x.uber_uuid = u.uuid)),
    byp as (select dp.code, min(up.uuid) uuid, count(*) n from dp join up on length(dp.p) = 9 and dp.p = up.p group by dp.code),
    byn as (select dp.code, min(up.uuid) uuid, count(*) n from dp join up on dp.k <> '' and dp.k = up.k group by dp.code),
    cand as (select dp.code, coalesce((select b.uuid from byp b where b.code = dp.code and b.n = 1), (select b.uuid from byn b where b.code = dp.code and b.n = 1)) uuid from dp),
    uniq as (select code, uuid from cand where uuid is not null and uuid in (select uuid from cand where uuid is not null group by uuid having count(*) = 1))
    update drivers d set uber_uuid = uniq.uuid from uniq where d.code = uniq.code and d.uber_uuid is null;
  end if;
  return jsonb_build_object('new', news, 'dupes', dupes);
end $$;
revoke execute on function public.refresh_drivers() from public, anon, authenticated;
grant execute on function public.refresh_drivers() to service_role;

create or replace function public.import_contracts(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rd jsonb := '{}'; n_add integer; n_upd integer; n_same integer; n_skip integer := 0; m timestamptz; adm boolean := is_admin(); keys text[] := my_vehicle_keys();
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
  -- nouveaux chauffeurs enregistrés tout de suite (fiche, agence, compte Uber), sans attendre le passage du collecteur
  if n_add + n_upd > 0 then rd := refresh_drivers(); end if;
  return jsonb_build_object('added', n_add, 'updated', n_upd, 'same', n_same, 'min_start', m, 'skipped', n_skip, 'new_drivers', coalesce(rd->'new', '[]'));
end $$;
revoke execute on function public.import_contracts(jsonb) from public, anon;
grant execute on function public.import_contracts(jsonb) to authenticated, service_role;

-- chauffeurs déjà enregistrés : agence et compte Uber complétés maintenant
select public.refresh_drivers();

-- ---------- Caisse par agence ----------
alter table public.uber_payments add column if not exists agency_id bigint references public.agencies(id) on delete set null;
alter table public.uber_drivers add column if not exists agency_id bigint references public.agencies(id) on delete set null;
alter table public.agencies add column if not exists cash_sheet_id text;
create index if not exists cash_moves_agency on public.cash_moves(agency_id, day);
create index if not exists uber_payments_agency on public.uber_payments(agency_id, at);

-- agence d'une ligne sans agence : celle du chauffeur, sinon la seule agence ; obligatoire dès qu'il y a plusieurs agences
create or replace function public.cash_agency_trg() returns trigger language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if new.agency_id is null then
    if tg_table_name = 'cash_moves' then
      select agency_id into new.agency_id from drivers where (code = new.driver_code or (new.uber_uuid is not null and uber_uuid = new.uber_uuid)) and agency_id is not null limit 1;
    elsif tg_table_name = 'uber_payments' then
      select agency_id into new.agency_id from drivers where uber_uuid = new.driver_uuid and agency_id is not null limit 1;
    else
      select agency_id into new.agency_id from drivers where uber_uuid = new.uuid and agency_id is not null limit 1;
    end if;
  end if;
  if new.agency_id is null then
    select count(*) into n from agencies;
    if n = 1 then select id into new.agency_id from agencies; elsif n > 1 then raise exception 'agence obligatoire : choisir l''agence de la caisse'; end if;
  end if;
  return new;
end $$;
drop trigger if exists cash_moves_agency on public.cash_moves;
create trigger cash_moves_agency before insert on public.cash_moves for each row execute function public.cash_agency_trg();
drop trigger if exists uber_payments_agency on public.uber_payments;
create trigger uber_payments_agency before insert on public.uber_payments for each row execute function public.cash_agency_trg();
drop trigger if exists uber_drivers_agency on public.uber_drivers;
create trigger uber_drivers_agency before insert on public.uber_drivers for each row execute function public.cash_agency_trg();

-- lignes déjà saisies sans agence : agence du chauffeur, sinon la seule agence
update public.cash_moves m set agency_id = coalesce((select d.agency_id from drivers d where d.code = m.driver_code and d.agency_id is not null limit 1),
  (select min(id) from agencies having count(*) = 1)) where m.agency_id is null;
update public.uber_payments p set agency_id = coalesce((select d.agency_id from drivers d where d.uber_uuid = p.driver_uuid and d.agency_id is not null limit 1),
  (select min(id) from agencies having count(*) = 1)) where p.agency_id is null;
update public.uber_drivers u set agency_id = coalesce((select d.agency_id from drivers d where d.uber_uuid = u.uuid and d.agency_id is not null limit 1),
  (select min(id) from agencies having count(*) = 1)) where u.agency_id is null;
update public.agencies set cash_sheet_id = (select nullif(value, '') from params where key = 'cashSheetId')
 where cash_sheet_id is null and (select count(*) from agencies) = 1;

-- un gestionnaire ne voit et ne saisit que la caisse de ses agences (plus de lignes « sans agence » visibles par tous)
drop policy if exists read_mgr on public.cash_moves;
drop policy if exists mgr_insert on public.cash_moves;
drop policy if exists mgr_update on public.cash_moves;
create policy read_mgr on public.cash_moves for select to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[])));
create policy mgr_insert on public.cash_moves for insert to authenticated
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[])));
create policy mgr_update on public.cash_moves for update to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[])))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[])));
do $$
declare t text;
begin
  foreach t in array array['uber_payments', 'uber_drivers'] loop
    execute format('drop policy if exists mgr_all on public.%I', t);
    execute format('drop policy if exists mgr_ins on public.%I', t);
    execute format('drop policy if exists mgr_upd on public.%I', t);
    execute format('create policy mgr_all on public.%I for select to authenticated using ((select public.is_admin()) or (public.my_role() = ''manager'' and agency_id = any((select public.my_agency_ids())::bigint[])))', t);
    execute format('create policy mgr_ins on public.%I for insert to authenticated with check ((select public.is_admin()) or (public.my_role() = ''manager'' and agency_id = any((select public.my_agency_ids())::bigint[])))', t);
    execute format('create policy mgr_upd on public.%I for update to authenticated using ((select public.is_admin()) or (public.my_role() = ''manager'' and agency_id = any((select public.my_agency_ids())::bigint[]))) with check ((select public.is_admin()) or (public.my_role() = ''manager'' and agency_id = any((select public.my_agency_ids())::bigint[])))', t);
  end loop;
end $$;
grant update (cash_sheet_id) on public.agencies to authenticated;
