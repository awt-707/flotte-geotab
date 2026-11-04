-- =============================================================================
-- Relecture A → Z du 24/10/2026 : corrections de droits et de règles dans la base. À exécuter dans Supabase > SQL Editor
-- (après 20261112000000_pointage_alerte.sql). Rejouable sans risque.
-- 1. Courses privées : un gestionnaire ne retire plus le besoin de validation (règles minimales recalculées dans la base) ;
--    véhicule ou prix détaillé changés après validation = validation à refaire ; un véhicule jamais réservé deux fois
--    (acompte reçu, confirmée, en cours) sur des périodes qui se chevauchent
-- 2. Planning des chauffeurs : plan_save et plan_replace_driver limités aux véhicules et chauffeurs de l'agence ;
--    absence refusée à un gestionnaire dans une semaine verrouillée
-- 3. Caisse : transactions Uber non modifiables par le site ; « part déjà gardée » d'une course plus modifiable après 24 h
-- 4. Ressources humaines : journée de pointage = depuis la dernière arrivée (plus de journée fusionnée avec la veille) ;
--    sortie future = salarié en poste jusque-là ; compte RH limité à son agence même pour un salarié sans agence ;
--    jamais de compte administrateur rattaché à une fiche par un compte RH ; plus de lecture des véhicules par les RH
--    (le relais en direct lit les véhicules avec le jeton de l'utilisateur) ; contrats du staff hors de portée des gestionnaires
-- =============================================================================

-- ---------- 1. Courses privées ----------
create or replace function public.mission_guard() returns trigger language plpgsql set search_path = public as $$
declare lim numeric;
begin
  if coalesce(public.my_role(), 'service') = 'manager' then
    if tg_op = 'INSERT' and (new.validated_by is not null or new.validated_at is not null) then
      raise exception 'validation réservée à l''administrateur';
    end if;
    if tg_op = 'UPDATE' and (new.validated_by is distinct from old.validated_by or new.validated_at is distinct from old.validated_at) then
      raise exception 'validation réservée à l''administrateur';
    end if;
    -- besoin de validation : jamais retiré par un gestionnaire ; règles connues de la base (24 h / VIP, plus de 3 jours, montant)
    select nullif(data->>'validationAmount', '')::numeric into lim from public.pricing_grid where id = 1;
    new.needs_validation := coalesce(new.needs_validation, false) or (tg_op = 'UPDATE' and coalesce(old.needs_validation, false))
      or coalesce(new.level = '24h / VIP', false) or coalesce((new.end_at - new.start_at) > interval '3 days', false) or coalesce(lim > 0 and new.total_ttc > lim, false);
    -- devis à valider : pas d'envoi ni de confirmation tant que l'administrateur n'a pas validé
    if new.needs_validation and new.validated_at is null and new.status not in ('Demande', 'Annulée', 'Refusée') then
      raise exception 'validation de l''exploitation requise avant « % »', new.status;
    end if;
  end if;
  -- mission modifiée après validation (prix, dates, véhicule, niveau, détail du prix) : la validation tombe, à refaire
  if tg_op = 'UPDATE' and old.validated_at is not null and new.validated_at is not distinct from old.validated_at
     and (new.total_ttc is distinct from old.total_ttc or new.start_at is distinct from old.start_at or new.end_at is distinct from old.end_at
          or new.category is distinct from old.category or new.level is distinct from old.level or new.vehicle_key is distinct from old.vehicle_key
          or (new.data -> 'price' -> 'lines') is distinct from (old.data -> 'price' -> 'lines')) then
    if coalesce(public.my_role(), '') = 'manager' and new.needs_validation and new.status not in ('Demande', 'Annulée', 'Refusée') then
      raise exception 'devis validé par l''exploitation : prix, dates, véhicule et niveau modifiables seulement par l''administrateur';
    end if;
    new.validated_at := null; new.validated_by := null;
  end if;
  return new;
end $$;

-- un véhicule bloqué (acompte reçu, confirmée, en cours) n'est jamais réservé deux fois sur des périodes qui se chevauchent
create or replace function public.mission_booking() returns trigger language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if new.vehicle_key is null or new.start_at is null or new.status not in ('Acompte reçu', 'Confirmée', 'En cours') then return new; end if;
  if tg_op = 'UPDATE' and new.vehicle_key is not distinct from old.vehicle_key and new.start_at is not distinct from old.start_at
     and new.end_at is not distinct from old.end_at and new.status is not distinct from old.status then return new; end if;
  perform pg_advisory_xact_lock(hashtext('mission:' || new.vehicle_key));   -- deux confirmations en même temps : l'une après l'autre
  select m.number, m.status, m.client_name into o from public.missions m
   where m.vehicle_key = new.vehicle_key and m.id is distinct from new.id and m.status in ('Acompte reçu', 'Confirmée', 'En cours')
     and m.start_at < coalesce(new.end_at, new.start_at) and coalesce(m.end_at, m.start_at) > new.start_at
   limit 1;
  if found then raise exception 'véhicule déjà bloqué sur cette période : % (%, %)', coalesce(o.number, '?'), coalesce(o.client_name, ''), o.status; end if;
  return new;
end $$;
drop trigger if exists missions_booking on public.missions;
create trigger missions_booking before insert or update on public.missions for each row execute function public.mission_booking();

-- ---------- 2. Planning des chauffeurs ----------
create or replace function public.plan_save(p_agency bigint, p_from date, p_to date, p_cells jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w date; n_changed integer; n_cells integer; bad text;
begin
  if p_to < p_from or p_to - p_from > 41 then raise exception 'période invalide'; end if;
  for w in select distinct (d - ((extract(isodow from d)::int - 1) * interval '1 day'))::date from generate_series(p_from, p_to, interval '1 day') d loop
    if not plan_can_edit(p_agency, w) then raise exception 'modification du planning non autorisée (droits ou semaine verrouillée)'; end if;
  end loop;
  create temp table _n on commit drop as
    select (c->>'day')::date as day, c->>'shift' as shift, c->>'vehicle_key' as vehicle_key, nullif(c->>'driver_code', '') as driver_code,
           coalesce((c->>'locked')::boolean, false) as locked, nullif(c->>'note', '') as note
      from jsonb_array_elements(coalesce(p_cells, '[]')) c where (c->>'day')::date between p_from and p_to;
  -- cases d'une autre agence (même véhicule, même jour) jamais reprises ; gestionnaire : véhicules de l'agence seulement
  select n.vehicle_key into bad from _n n join driver_plan o using (day, shift, vehicle_key) where o.agency_id is distinct from p_agency limit 1;
  if bad is not null then raise exception 'véhicule % planifié dans une autre agence ce jour-là', bad; end if;
  if not is_admin() then
    select n.vehicle_key into bad from _n n left join vehicles v on v.key = n.vehicle_key where v.agency_id is distinct from p_agency limit 1;
    if bad is not null then raise exception 'véhicule % hors de l''agence', bad; end if;
  end if;
  select count(*) into n_cells from _n;
  select count(*) into n_changed from _n full join (select * from driver_plan where agency_id = p_agency and day between p_from and p_to) o
    using (day, shift, vehicle_key) where _n.driver_code is distinct from o.driver_code;
  delete from driver_plan where agency_id = p_agency and day between p_from and p_to;
  insert into driver_plan (agency_id, day, shift, vehicle_key, driver_code, locked, note, updated_at, updated_by)
  select p_agency, day, shift, vehicle_key, driver_code, locked, note, now(), auth.uid() from _n;
  if n_changed > 0 then insert into plan_log (agency_id, action, detail) values (p_agency, 'modification', p_from || ' → ' || p_to || ' : ' || n_changed || ' case(s) changée(s)' || coalesce(' · ' || p_note, '')); end if;
  return jsonb_build_object('cells', n_cells, 'changed', n_changed);
end $$;
revoke execute on function public.plan_save(bigint, date, date, jsonb, text) from public, anon;
grant execute on function public.plan_save(bigint, date, date, jsonb, text) to authenticated;

-- départ d'un chauffeur : l'ancien et le remplaçant doivent être de l'agence (ou sans agence)
create or replace function public.plan_driver_in(p_code text, p_agency bigint) returns boolean language sql stable security definer set search_path = public as $$
  select is_admin() or (coalesce((select agency_id from driver_roster where driver_code = p_code), (select agency_id from drivers where code = p_code), p_agency) = p_agency)
$$;
do $$ declare src text; begin
  select pg_get_functiondef('public.plan_replace_driver(bigint, text, text, date, text)'::regprocedure) into src;
  if src is not null and position('plan_driver_in' in src) = 0 then
    src := replace(src, 'if not plan_can_edit(p_agency, null) then raise exception ''modification du planning non autorisée''; end if;',
      'if not plan_can_edit(p_agency, null) then raise exception ''modification du planning non autorisée''; end if;
  if not plan_driver_in(p_old, p_agency) or not plan_driver_in(p_new, p_agency) then raise exception ''chauffeur d''''une autre agence''; end if;');
    execute src;
  end if;
end $$;

-- absence posée par un gestionnaire dans une semaine verrouillée : refusée (le planning ne pourrait pas être ajusté)
create or replace function public.plan_absence_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare r public.driver_absences;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  if coalesce(my_role(), '') = 'manager' and exists (select 1 from plan_weeks w where w.agency_id = r.agency_id and w.locked
       and w.week <= r.day_to and w.week + 6 >= r.day_from) then
    raise exception 'semaine verrouillée : absence à poser par l''administrateur';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists driver_absences_lock on public.driver_absences;
create trigger driver_absences_lock before insert or update or delete on public.driver_absences for each row execute function public.plan_absence_guard();

-- ---------- 3. Caisse ----------
revoke update on public.uber_payments from authenticated;   -- import : ajout seulement (doublons ignorés), jamais de modification
do $$ declare src text; begin
  select pg_get_functiondef('public.cash_guard()'::regprocedure) into src;
  if position('''prime_paid'', ''updated_at''' in src) > 0 then
    src := replace(src, '''comment'', ''prime_paid'', ''updated_at''', '''comment'', ''updated_at''');
    execute src;
  end if;
end $$;

-- ---------- 4. Ressources humaines ----------
-- état du pointage : journée ouverte par la dernière arrivée de moins de 18 h ; sinon hors service (nouvelle arrivée)
create or replace function public.hr_state(p_emp bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  with arr as (
    select max(at) as at from public.hr_clock where employee_id = p_emp and kind = 'in' and at > now() - interval '18 hours'),
  last as (
    select c.kind, c.at from public.hr_clock c, arr where c.employee_id = p_emp and c.kind in ('in', 'pause', 'resume', 'out') and arr.at is not null and c.at >= arr.at
    order by c.at desc, c.id desc limit 1)
  select jsonb_build_object(
    'state', case (select kind from last) when 'in' then 'on' when 'resume' then 'on' when 'pause' then 'pause' else 'off' end,
    'since', (select at from last),
    'arrived', case when (select kind from last) in ('in', 'pause', 'resume') then (select at from arr) end)
$$;
revoke all on function public.hr_state(bigint) from public, anon, authenticated;
-- sortie future (préavis) : en poste et au pointage jusqu'à la date de sortie
create or replace function public.hr_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when e.id is null then null else jsonb_build_object('id', e.id, 'name', e.name, 'kind', e.kind, 'pointage', e.pointage) || public.hr_state(e.id) end
  from (select 1) x left join public.hr_employees e on e.user_id = auth.uid() and (e.left_on is null or e.left_on > current_date)
$$;
do $$ declare src text; begin
  select pg_get_functiondef('public.hr_clock_do(text, date, text)'::regprocedure) into src;
  if position('left_on is null and pointage' in src) > 0 then
    src := replace(src, 'left_on is null and pointage', '(left_on is null or left_on > current_date) and pointage');
    execute src;
  end if;
end $$;

-- compte RH : chauffeurs de son périmètre d'après l'agence du chauffeur (une fiche sans agence n'ouvre pas une autre agence) ;
-- connexions du staff seulement, jamais d'un administrateur
create or replace function public.rh_driver_codes() returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(e.driver_code), '{}') from public.hr_employees e left join public.drivers d on d.code = e.driver_code
   where public.is_rh() and e.driver_code is not null and public.rh_scope(e.agency_id) and public.rh_scope(d.agency_id)
$$;
create or replace function public.rh_staff_users() returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(e.user_id), '{}') from public.hr_employees e join public.profiles p on p.user_id = e.user_id
   where public.is_rh() and e.kind = 'staff' and p.role <> 'admin' and public.rh_scope(e.agency_id)
$$;
-- fiche rattachée à un compte Ludy : jamais un administrateur, sauf par un administrateur
create or replace function public.hr_user_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is not null and new.user_id is distinct from (case when tg_op = 'UPDATE' then old.user_id end) and auth.uid() is not null and not is_admin()
     and exists (select 1 from profiles where user_id = new.user_id and role = 'admin') then
    raise exception 'compte administrateur : rattachement réservé à l''administrateur';
  end if;
  return new;
end $$;
drop trigger if exists hr_user_guard on public.hr_employees;
create trigger hr_user_guard before insert or update on public.hr_employees for each row execute function public.hr_user_guard();

-- les RH ne lisent plus la flotte (le relais en direct lit les véhicules avec le jeton de l'utilisateur)
drop policy if exists rh_read on public.vehicles;

-- contrats de travail du staff : jamais lus ni modifiés par un gestionnaire (même rattachés à son agence)
drop policy if exists read_agency on public.work_contracts;
drop policy if exists mgr_insert on public.work_contracts;
drop policy if exists mgr_update on public.work_contracts;
create policy read_agency on public.work_contracts for select to authenticated
  using (public.wc_can(agency_id) and (employee_id is null or public.hr_can_emp(employee_id)));
create policy mgr_insert on public.work_contracts for insert to authenticated
  with check (public.wc_can(agency_id) and (employee_id is null or public.hr_can_emp(employee_id)));
create policy mgr_update on public.work_contracts for update to authenticated
  using (public.wc_can(agency_id) and (employee_id is null or public.hr_can_emp(employee_id)))
  with check (public.wc_can(agency_id) and (employee_id is null or public.hr_can_emp(employee_id)));
