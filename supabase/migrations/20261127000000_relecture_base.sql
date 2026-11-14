-- =============================================================================
-- Relecture complète de la base (14/11/2026, demande d'Ahmed : « relis tout le code de la base, organise-la, projet propre »).
-- Corrections sans effet sur les données (droits, contrôles, index, vitesse des règles RLS). Rejouable.
-- À exécuter dans Supabase > SQL Editor après 20261126000000_siphon_controle.sql.
-- =============================================================================

-- 1. Fonctions de droits : plus exécutables sans compte (déjà le cas en production depuis novembre, repris ici)
do $$ declare f text; begin
  foreach f in array array['hr_can(text,bigint)', 'hr_can_emp(bigint)', 'is_admin()', 'is_rh()', 'my_agency_ids()', 'my_driver_codes()', 'my_role()',
    'my_vehicle_keys()', 'plan_can_edit(bigint,date)', 'plan_can_read(bigint)', 'plan_driver_in(text,bigint)', 'rh_agency_ids()', 'rh_driver_codes()',
    'rh_scope(bigint)', 'rh_staff_users()', 'wc_can(bigint)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
-- séquences et tables : rien pour anon (le site sans compte ne lit ni n'écrit rien)
do $$ declare r record; begin
  for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' loop
    execute format('revoke all on sequence public.%I from anon', r.relname);
  end loop;
end $$;
revoke all on public.fuel_card_tx from anon;
revoke insert, delete on public.fuel_card_tx from authenticated;   -- l'import passe par import_fuel_card (statut : droit par colonne gardé)
-- les prochaines tables, séquences et fonctions ne naissent plus ouvertes à anon
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

-- 2. Planning : une agence vide n'est jamais « la sienne » (un gestionnaire faisait partir un chauffeur d'une autre agence avec p_agency = null)
create or replace function public.plan_can_edit(p_agency bigint, p_week date default null) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(is_admin(), false) or (p_agency is not null and coalesce(
    my_role() = 'manager' and p_agency = any(my_agency_ids())
    and coalesce((select value from params where key = 'planManagersEdit'), 'oui') <> 'non'
    and (p_week is null or not exists (select 1 from plan_weeks w where w.agency_id = p_agency and w.week = p_week and w.locked)), false))
$$;
create or replace function public.plan_driver_in(p_code text, p_agency bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(is_admin(), false) or (p_agency is not null and coalesce(
    coalesce((select agency_id from driver_roster where driver_code = p_code), (select agency_id from drivers where code = p_code), p_agency) = p_agency, false))
$$;
revoke execute on function public.plan_can_edit(bigint, date) from public, anon;
revoke execute on function public.plan_driver_in(text, bigint) from public, anon;
grant execute on function public.plan_can_edit(bigint, date) to authenticated, service_role;
grant execute on function public.plan_driver_in(text, bigint) to authenticated, service_role;

-- 3. Courses : la marque « course rapide » (sans devis, donc sans validation) n'ouvre plus l'envoi d'un devis
create or replace function public.mission_quick_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(public.my_role(), 'service') = 'manager' then
    if tg_op = 'INSERT' and coalesce(new.data->>'quick', '') = 'true' and new.status not in ('Confirmée', 'En cours') then
      raise exception 'course rapide : créée « Confirmée » ou « En cours » seulement (sinon, préparer un devis)';
    end if;
    if tg_op = 'UPDATE' and coalesce(new.data->>'quick', '') is distinct from coalesce(old.data->>'quick', '') then
      raise exception 'course rapide : marque non modifiable';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists mission_quick_guard on public.missions;
create trigger mission_quick_guard before insert or update on public.missions for each row execute function public.mission_quick_guard();
revoke execute on function public.mission_quick_guard() from public, anon;

-- 4. Pointage du staff : essais de date de naissance comptés un par un (50 essais envoyés en même temps passaient la limite de 5)
create or replace function public.hr_clock_do(p_kind text, p_birth date default null, p_client text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e public.hr_employees; st text; n int;
begin
  select * into e from public.hr_employees where user_id = auth.uid() and (left_on is null or left_on > current_date) and pointage;
  if e.id is null then return jsonb_build_object('ok', false, 'error', 'Pointage non activé pour ce compte'); end if;
  if p_kind not in ('in', 'pause', 'resume', 'out') then return jsonb_build_object('ok', false, 'error', 'Action inconnue'); end if;
  perform pg_advisory_xact_lock(hashtext('hr_clock_do'), e.id::int);   -- un appel à la fois par salarié
  st := public.hr_state(e.id) ->> 'state';
  if p_kind = 'in' then
    -- ouverture de Ludy : date de naissance obligatoire, 5 essais manqués en 15 minutes au plus
    select count(*) into n from public.hr_clock where employee_id = e.id and kind = 'fail' and at > now() - interval '15 minutes';
    if n >= 5 then return jsonb_build_object('ok', false, 'error', 'Trop d''essais : réessayez dans 15 minutes'); end if;
    if e.birth_date is null then return jsonb_build_object('ok', false, 'error', 'Date de naissance absente de la fiche : demandez à l''administrateur de la renseigner'); end if;
    if p_birth is distinct from e.birth_date then
      insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'fail', left(p_client, 80));
      return jsonb_build_object('ok', false, 'error', 'Date de naissance incorrecte');
    end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), case when st = 'off' then 'in' else 'session' end, left(p_client, 80));
  elsif p_kind = 'pause' then
    if st <> 'on' then return jsonb_build_object('ok', false, 'error', 'Pause possible seulement en service'); end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'pause', left(p_client, 80));
  elsif p_kind = 'resume' then
    if st <> 'pause' then return jsonb_build_object('ok', false, 'error', 'Aucune pause en cours'); end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'resume', left(p_client, 80));
  else
    if st = 'off' then return jsonb_build_object('ok', false, 'error', 'Aucune journée en cours'); end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'out', left(p_client, 80));
  end if;
  return jsonb_build_object('ok', true) || public.hr_me();
end $$;

-- 5. Connexions : la dernière activité (heure de départ d'un salarié qui n'a pas pointé) est l'heure de la base, jamais celle envoyée par le navigateur ;
--    chacun n'efface plus que ses signaux de plus de 30 jours (ménage de session_ping)
create or replace function public.user_sessions_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then new.last_seen := now(); end if;
  return new;
end $$;
drop trigger if exists user_sessions_guard on public.user_sessions;
create trigger user_sessions_guard before update on public.user_sessions for each row execute function public.user_sessions_guard();
revoke execute on function public.user_sessions_guard() from public, anon;
drop policy if exists own_delete on public.user_sessions;
create policy own_delete on public.user_sessions for delete to authenticated
  using ((select public.is_admin()) or (user_id = (select auth.uid()) and last_seen < now() - interval '30 days'));

-- 6. Sociétés employeuses : un compte RH limité à des agences ne modifie plus celles de tout le groupe
do $$ declare p record; begin
  for p in select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'employers' and cmd <> 'SELECT' loop
    execute format('drop policy %I on public.employers', p.policyname);
  end loop;
end $$;
create policy admin_all on public.employers for all to authenticated
  using ((select public.is_admin()) or ((select public.is_rh()) and cardinality(coalesce((select public.rh_agency_ids()), '{}')) = 0))
  with check ((select public.is_admin()) or ((select public.is_rh()) and cardinality(coalesce((select public.rh_agency_ids()), '{}')) = 0));

-- 7. Stockage « contrats » : le dossier 0 (contrats du staff, copies légalisées) n'est plus lisible par tous les comptes RH ;
--    lecture = administrateur, auteur du dépôt, ou contrat visible dans work_contracts (mêmes droits que la page)
do $$ begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists contrats_select on storage.objects';
    execute $p$create policy contrats_select on storage.objects for select to authenticated using (
      bucket_id = 'contrats' and ((select public.is_admin()) or owner_id = (select auth.uid())::text
        or exists (select 1 from public.work_contracts w where w.pdf_path = objects.name or w.legal_path = objects.name)))$p$;
    execute 'drop policy if exists contrats_delete on storage.objects';
    execute $p$create policy contrats_delete on storage.objects for delete to authenticated using (
      bucket_id = 'contrats' and ((select public.is_admin()) or ((select public.is_rh())
        and exists (select 1 from public.work_contracts w where w.pdf_path = objects.name or w.legal_path = objects.name))))$p$;
  end if;
end $$;

-- 8. Index pour les lectures du site et du collecteur (alertes par véhicule, e-mails en attente, journal, manifestes, connexions RH…)
create index if not exists alerts_vehicle_day on public.alerts (vehicle_key, day);
create index if not exists alerts_driver_day on public.alerts (driver_code, day);
create index if not exists alerts_to_notify on public.alerts (id) where notified_at is null;
create index if not exists journal_vehicle_day on public.journal (vehicle_key, day);
create index if not exists journal_contract on public.journal (contract_num);
create index if not exists manifests_file on public.manifests (file_path);
create index if not exists manifests_vehicle on public.manifests (vehicle_key);
create index if not exists idles_start on public.idles (start_at);
create index if not exists engine_stops_start on public.engine_stops (start_at);
create index if not exists contracts_client on public.contracts (client_code);
create index if not exists driver_absences_driver on public.driver_absences (driver_code);
create index if not exists cash_files_agency on public.cash_files (agency_id);
create index if not exists work_contracts_employee on public.work_contracts (employee_id);

-- 9. Règles RLS : fonctions de droits évaluées une fois par requête, plus une fois par ligne (mesuré : caisse 30 000 lignes, 200 ms → 8 ms).
--    Même résultat : ces fonctions ne dépendent pas de la ligne. Seulement les tables de Ludy (le module de bureau n'est pas touché).
do $$
declare p record; q text; c text; fx constant text := '(?<!SELECT )(public\.)?(is_admin|my_role|my_agency_ids|my_vehicle_keys|my_driver_codes|is_rh|rh_agency_ids|rh_staff_users|rh_driver_codes)\(\)';
  ludy constant text[] := array['params', 'rules', 'jobs', 'logs', 'releases', 'usage_daily', 'geotab_session', 'integration_secrets',
    'profiles', 'agencies', 'user_agencies', 'user_sessions', 'manager_shifts', 'alert_recipients', 'report_schedules',
    'vehicles', 'parc', 'plate_changes', 'vehicle_days', 'trips', 'idles', 'engine_stops', 'events', 'fuel', 'levels', 'alerts', 'journal', 'live_status', 'fuel_card_tx',
    'drivers', 'contracts', 'missions', 'pricing_grid', 'manifests', 'manifest_config',
    'cash_moves', 'cash_log', 'uber_payments', 'uber_drivers', 'bolt_sessions', 'cash_sheets', 'cash_files',
    'driver_roster', 'driver_plan', 'driver_absences', 'plan_weeks', 'plan_log',
    'hr_employees', 'hr_events', 'hr_clock', 'hr_documents', 'employers', 'work_contracts'];
begin
  for p in select tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' and tablename = any(ludy) loop
    q := regexp_replace(regexp_replace(p.qual, fx, '(select public.\2())', 'g'), '(?<!SELECT )auth\.uid\(\)', '(select auth.uid())', 'g');
    c := regexp_replace(regexp_replace(p.with_check, fx, '(select public.\2())', 'g'), '(?<!SELECT )auth\.uid\(\)', '(select auth.uid())', 'g');
    if q is distinct from p.qual then execute format('alter policy %I on public.%I using (%s)', p.policyname, p.tablename, q); end if;
    if c is distinct from p.with_check then execute format('alter policy %I on public.%I with check (%s)', p.policyname, p.tablename, c); end if;
  end loop;
end $$;

-- 10. Statistiques à jour (la table des trajets était estimée à 457 lignes pour 19 625 : mauvais plans de lecture quand la base est chargée)
analyze;
notify pgrst, 'reload schema';
