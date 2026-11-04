-- =============================================================================
-- FLOTTE GEOTAB — base de données Supabase
-- À coller une seule fois dans Supabase : SQL Editor > New query > Run.
-- Le collecteur (Google Apps Script) écrit avec la clé service_role ; le site lit
-- avec la clé publique (anon) + la connexion de chaque utilisateur.
-- =============================================================================

-- ---------- Profils et rôles (admin / manager / viewer ; pending = compte créé, en attente de validation par l'admin) ----------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text, name text,
  role text not null default 'pending' check (role in ('admin', 'manager', 'viewer', 'pending')),
  created_at timestamptz not null default now()
);
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'manager', 'viewer', 'pending'));
alter table public.profiles alter column role set default 'pending';
-- Chaque nouveau compte reçoit un profil ; le tout premier compte est administrateur, les suivants attendent sa validation
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(user_id, email, role)
  values (new.id, new.email, case when exists (select 1 from public.profiles) then 'pending' else 'admin' end)
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid()
$$;

-- ---------- Référentiels ----------
create table if not exists public.vehicles (
  key text primary key, plate text not null, brand text, model text, fuel text, vin text,
  geotab_id text, geotab_name text, tank_l double precision, ref_l100 double precision, revenue double precision,
  active text default 'OUI', last_sync timestamptz, other_plates text
);
create table if not exists public.plate_changes (
  id bigserial primary key, old_plate text, new_plate text, changed_on date, vehicle text, status text, note text,
  created_at timestamptz not null default now()
);
create table if not exists public.drivers (
  code text primary key, name text, other_names text, phone text, email text, first_contract timestamptz,
  last_contract timestamptz, n_contracts integer, status text, detected_at timestamptz, note text
);
create table if not exists public.contracts (
  num text primary key, client_code text, name text, plate text, vehicle_key text, model text,
  start_at timestamptz, end_at timestamptz, status text, origin text, phone text, email text, comment text,
  imported_at timestamptz, updated_at timestamptz
);
create index if not exists contracts_vehicle_start on public.contracts(vehicle_key, start_at);
create index if not exists contracts_start on public.contracts(start_at desc);
create table if not exists public.rules (
  id text primary key, name text, weight double precision default 0, category text, n_events integer, note text
);
create table if not exists public.params (
  key text primary key, label text, value text, note text, sort integer
);

-- ---------- Données Geotab calculées ----------
-- vday = véhicule-jour auquel appartient la ligne (jour de début du cycle contact) ; final = journée finalisée (définitive)
create table if not exists public.trips (
  id text primary key, vehicle_key text not null, plate text, day date, start_at timestamptz, end_at timestamptz,
  km double precision, drive_min double precision, still_min double precision, evoff_min double precision, idle_min double precision,
  idle_source text, long_idle_min double precision, n_long_idle integer, vmax double precision, vavg double precision,
  vmax_gps double precision, lim_at_vmax double precision, lim_source text, worst_over double precision,
  speed_at_worst double precision, lim_at_worst double precision, worst_time text, fuel_l double precision, fuel_source text,
  ecu_l double precision, idle_fuel_l double precision, idle_fuel_source text, lat double precision, lon double precision,
  driver_code text, driver_name text, contract_num text, vday date not null, final boolean not null default false
);
create index if not exists trips_vday on public.trips(vehicle_key, vday);
create index if not exists trips_day on public.trips(day);
create index if not exists trips_start on public.trips(start_at);
create index if not exists trips_driver on public.trips(driver_code, day);

create table if not exists public.idles (
  id text primary key, vehicle_key text not null, plate text, trip_id text, day date, start_at timestamptz, end_at timestamptz,
  stop_min double precision, engine_min double precision, engine_check text, liters double precision, liters_source text,
  lat double precision, lon double precision, driver_code text, driver_name text, contract_num text,
  vday date not null, final boolean not null default false
);
create index if not exists idles_vday on public.idles(vehicle_key, vday);
create index if not exists idles_day on public.idles(day);

create table if not exists public.events (
  id text primary key, vehicle_key text not null, plate text, day date, start_at timestamptz, end_at timestamptz,
  dur_s double precision, km double precision, rule_id text, rule_name text, driver_code text, driver_name text, contract_num text,
  vday date not null, final boolean not null default false
);
create index if not exists events_vday on public.events(vehicle_key, vday);
create index if not exists events_day on public.events(day);
create index if not exists events_driver on public.events(driver_code, day);

create table if not exists public.fuel (
  id text primary key, vehicle_key text not null, plate text, day date, type text, stop_start timestamptz, stop_end timestamptz,
  stop_min double precision, engine text, lvl_before double precision, lvl_after double precision, delta_pct double precision,
  liters_gauge double precision, liters_geotab double precision, source text, lat double precision, lon double precision,
  driver_code text, driver_name text, contract_num text, next_driver text, status text,
  vday date not null, final boolean not null default false
);
create index if not exists fuel_vday on public.fuel(vehicle_key, vday);
create index if not exists fuel_day on public.fuel(day);

create table if not exists public.levels (
  id text primary key, vehicle_key text not null, at timestamptz, pct double precision,
  vday date not null, final boolean not null default false
);
create index if not exists levels_vday on public.levels(vehicle_key, vday);
create index if not exists levels_at on public.levels(vehicle_key, at);

create table if not exists public.vehicle_days (
  id text primary key, vehicle_key text not null, day date not null, synced_at timestamptz, n_trips integer, n_events integer,
  n_levels integer, fuel_counter text, speed_limits text
);
create index if not exists vehicle_days_day on public.vehicle_days(day);

-- ---------- Tableaux calculés ----------
create table if not exists public.journal (
  id text primary key, day date, plate text, vehicle_key text, model text, driver_code text, driver_name text, contract_num text,
  contract_start timestamptz, contract_end timestamptz, contract_h double precision, n_trips integer, km double precision,
  drive_h double precision, idle_h double precision, idle_source text, long_idle_h double precision, n_long_idle integer,
  fuel_l double precision, fuel_km double precision, l100 double precision, fuel_source text, idle_fuel_l double precision,
  idle_fuel_source text, fuel_cost double precision, idle_cost double precision, vmax double precision, lim_at_vmax double precision,
  worst_over double precision, n_events integer, danger_pts double precision, score double precision, n_fills integer,
  fill_l double precision, n_siphon integer, siphon_l double precision, km_off_contract double precision
);
create index if not exists journal_day on public.journal(day desc);
create index if not exists journal_driver on public.journal(driver_code, day);

create table if not exists public.alerts (
  id text primary key, day date, time text, plate text, vehicle_key text, driver_code text, driver_name text, type text,
  severity text, detail text, value text, status text not null default 'À traiter', comment text default ''
);
create index if not exists alerts_day on public.alerts(day desc);

create table if not exists public.live_status (
  vehicle_key text primary key, plate text, model text, state text, speed double precision, since_min double precision,
  last_pos_at timestamptz, lat double precision, lon double precision, ign_on boolean, driver_name text, contract_num text,
  km_today double precision, drive_min_today double precision, idle_min_today double precision, fuel_l_today double precision,
  alerts_today integer, updated_at timestamptz
);

-- ---------- Journal technique et demandes du site au collecteur ----------
create table if not exists public.logs (
  id bigserial primary key, at timestamptz not null default now(), action text, detail text, dur_s double precision
);
create index if not exists logs_at on public.logs(at desc);
create table if not exists public.jobs (
  id bigserial primary key, kind text not null, arg text, created_by uuid default auth.uid(), created_at timestamptz not null default now(),
  done_at timestamptz, result text
);

-- =============================================================================
-- Droits : tout utilisateur validé (admin, manager, viewer) lit ; seuls admin / manager modifient ce qui est prévu.
-- Un compte non validé (pending) ne voit que son propre profil.
-- Le collecteur utilise la clé service_role (pas concerné par ces règles).
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array['profiles','vehicles','plate_changes','drivers','contracts','rules','params','trips','idles','events','fuel',
    'levels','vehicle_days','journal','alerts','live_status','logs','jobs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('revoke select on public.%I from anon', t);
    execute format('drop policy if exists read_all on public.%I', t);
    execute format('create policy read_all on public.%I for select to authenticated using ((select public.my_role()) in (''admin'', ''manager'', ''viewer''))', t);
  end loop;
end $$;

-- Profils : chacun voit le sien, les comptes validés voient la liste, seul l'admin change les rôles
drop policy if exists read_own on public.profiles;
create policy read_own on public.profiles for select to authenticated using (user_id = auth.uid());
grant update (role, name) on public.profiles to authenticated;
drop policy if exists admin_update on public.profiles;
create policy admin_update on public.profiles for update to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- Alertes : statut et commentaire
grant update (status, comment) on public.alerts to authenticated;
drop policy if exists mgr_update on public.alerts;
create policy mgr_update on public.alerts for update to authenticated using (public.my_role() in ('admin', 'manager')) with check (public.my_role() in ('admin', 'manager'));

-- Carburant : statut (faux positif / vérifié)
grant update (status) on public.fuel to authenticated;
drop policy if exists mgr_update on public.fuel;
create policy mgr_update on public.fuel for update to authenticated using (public.my_role() in ('admin', 'manager')) with check (public.my_role() in ('admin', 'manager'));

-- Contrats : import depuis le site
grant insert, update on public.contracts to authenticated;
drop policy if exists mgr_insert on public.contracts;
drop policy if exists mgr_update on public.contracts;
create policy mgr_insert on public.contracts for insert to authenticated with check (public.my_role() in ('admin', 'manager'));
create policy mgr_update on public.contracts for update to authenticated using (public.my_role() in ('admin', 'manager')) with check (public.my_role() in ('admin', 'manager'));

-- Changements de plaque
grant insert, update, delete on public.plate_changes to authenticated;
grant usage, select on sequence public.plate_changes_id_seq to authenticated;
drop policy if exists mgr_all on public.plate_changes;
create policy mgr_all on public.plate_changes for all to authenticated using (public.my_role() in ('admin', 'manager')) with check (public.my_role() in ('admin', 'manager'));

-- Chauffeurs : statut et note
grant update (status, note) on public.drivers to authenticated;
drop policy if exists mgr_update on public.drivers;
create policy mgr_update on public.drivers for update to authenticated using (public.my_role() in ('admin', 'manager')) with check (public.my_role() in ('admin', 'manager'));

-- Véhicules (réglages), règles (poids), paramètres : admin
grant update (tank_l, ref_l100, revenue, active) on public.vehicles to authenticated;
drop policy if exists admin_update on public.vehicles;
create policy admin_update on public.vehicles for update to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
grant update (weight) on public.rules to authenticated;
drop policy if exists admin_update on public.rules;
create policy admin_update on public.rules for update to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
grant update (value) on public.params to authenticated;
drop policy if exists admin_update on public.params;
create policy admin_update on public.params for update to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- Demandes au collecteur (recalcul après import de contrats, plaques, mise à jour immédiate)
grant insert on public.jobs to authenticated;
grant usage, select on sequence public.jobs_id_seq to authenticated;
drop policy if exists mgr_insert on public.jobs;
create policy mgr_insert on public.jobs for insert to authenticated with check (public.my_role() in ('admin', 'manager'));

-- Temps réel : le site est prévenu des changements de position / statut (Supabase Realtime)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.live_status'; exception when others then null; end;
  end if;
end $$;

-- =============================================================================
-- Fonctions du collecteur (clé service_role uniquement)
-- =============================================================================
-- Lignes de données (trajets, ralentis, événements, carburant, jauge).
-- p_keys : véhicule-jours finalisés ('clé|aaaa-mm-jj') dont toutes les lignes sont remplacées.
-- p_final = false (temps réel) : une ligne déjà finalisée n'est jamais écrasée, une journée déjà finalisée n'est pas modifiée.
-- Le statut saisi sur une ligne carburant (Faux positif, Vérifié…) est conservé.
create or replace function public.put_rows(p_table text, p_keys text[], p_rows jsonb, p_final boolean)
returns integer language plpgsql set search_path = public as $$
declare n integer := 0; st jsonb := '{}';
begin
  if p_table not in ('trips', 'idles', 'events', 'fuel', 'levels') then raise exception 'table %', p_table; end if;
  p_rows := coalesce(p_rows, '[]'::jsonb); p_keys := coalesce(p_keys, '{}');
  if p_table = 'fuel' then
    select coalesce(jsonb_object_agg(id, status), '{}') into st from fuel
     where coalesce(status, '') <> '' and ((vehicle_key || '|' || vday::text) = any(p_keys)
       or id in (select x->>'id' from jsonb_array_elements(p_rows) x));
  end if;
  if p_final then
    execute format('delete from %I where (vehicle_key || ''|'' || vday::text) = any($1) or id in (select x->>''id'' from jsonb_array_elements($2) x)', p_table)
      using p_keys, p_rows;
    execute format('insert into %I select distinct on (id) * from jsonb_populate_recordset(null::%I, $1) on conflict (id) do nothing', p_table, p_table)
      using p_rows;
  else
    execute format('delete from %I where final = false and id in (select x->>''id'' from jsonb_array_elements($1) x)', p_table) using p_rows;
    execute format('insert into %I select distinct on (r.id) r.* from jsonb_populate_recordset(null::%I, $1) r
      where not exists (select 1 from vehicle_days d where d.id = r.vehicle_key || ''|'' || r.vday::text) on conflict (id) do nothing', p_table, p_table)
      using p_rows;
  end if;
  get diagnostics n = row_count;
  if p_table = 'fuel' and st <> '{}' then update fuel set status = st->>id where st ? id; end if;
  return n;
end $$;

-- Finalisation d'un lot de véhicule-jours : toutes les tables en une seule transaction
create or replace function public.finalize_vdays(p_keys text[], p_trips jsonb, p_idles jsonb, p_events jsonb, p_fuel jsonb, p_levels jsonb, p_sync jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare r jsonb := '{}';
begin
  r := r || jsonb_build_object('trips', put_rows('trips', p_keys, p_trips, true));
  r := r || jsonb_build_object('idles', put_rows('idles', p_keys, p_idles, true));
  r := r || jsonb_build_object('events', put_rows('events', p_keys, p_events, true));
  r := r || jsonb_build_object('fuel', put_rows('fuel', p_keys, p_fuel, true));
  r := r || jsonb_build_object('levels', put_rows('levels', p_keys, p_levels, true));
  insert into vehicle_days select distinct on (id) * from jsonb_populate_recordset(null::vehicle_days, coalesce(p_sync, '[]'))
    on conflict (id) do update set vehicle_key = excluded.vehicle_key, day = excluded.day, synced_at = excluded.synced_at, n_trips = excluded.n_trips,
      n_events = excluded.n_events, n_levels = excluded.n_levels, fuel_counter = excluded.fuel_counter, speed_limits = excluded.speed_limits;
  update vehicles set last_sync = now() where key in (select split_part(k, '|', 1) from unnest(p_keys) k);
  return r;
end $$;

-- Journal (une ligne par journée de travail) : remplacement à partir de p_cut
create or replace function public.replace_journal(p_cut date, p_rows jsonb)
returns integer language plpgsql set search_path = public as $$
declare n integer;
begin
  p_rows := coalesce(p_rows, '[]');
  delete from journal where day >= p_cut or id in (select x->>'id' from jsonb_array_elements(p_rows) x);
  insert into journal select distinct on (id) * from jsonb_populate_recordset(null::journal, p_rows);
  get diagnostics n = row_count; return n;
end $$;

-- Alertes à partir de p_cut : statut et commentaire saisis conservés, alertes disparues retirées
create or replace function public.replace_alerts(p_cut date, p_rows jsonb)
returns integer language plpgsql set search_path = public as $$
declare n integer;
begin
  p_rows := coalesce(p_rows, '[]');
  delete from alerts where day >= p_cut and id not in (select x->>'id' from jsonb_array_elements(p_rows) x);
  insert into alerts (id, day, time, plate, vehicle_key, driver_code, driver_name, type, severity, detail, value, status, comment)
  select distinct on (id) id, day, time, plate, vehicle_key, driver_code, driver_name, type, severity, detail, value, 'À traiter', ''
    from jsonb_populate_recordset(null::alerts, p_rows)
  on conflict (id) do update set day = excluded.day, time = excluded.time, plate = excluded.plate, vehicle_key = excluded.vehicle_key,
    driver_code = excluded.driver_code, driver_name = excluded.driver_name, type = excluded.type, severity = excluded.severity,
    detail = excluded.detail, value = excluded.value;
  get diagnostics n = row_count; return n;
end $$;

-- Nom normalisé (doublons de chauffeurs) : minuscules sans accents, lettres seulement
create or replace function public.norm_name(t text) returns text language sql immutable as $$
  select regexp_replace(lower(translate(coalesce(t, ''), 'ÀÂÄÁÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇÑàâäáãéèêëíìîïóòôöõúùûüçñ', 'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn')), '[^a-z]', '', 'g')
$$;

-- Chauffeurs reconstruits depuis les contrats ; retourne les nouveaux et les doublons de nom possibles
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
  -- Doublons possibles : même nom normalisé, codes différents
  update _d set note = case when note = '' then '' else note || ' | ' end || 'Doublon possible : ' || g.codes
    from (select norm_name(name) k, string_agg(code, ', ' order by code) codes from _d group by 1 having count(*) > 1) g
   where norm_name(_d.name) = g.k and position('Doublon' in _d.note) = 0;
  select coalesce(jsonb_agg(name || ' (' || code || ')' order by name), '[]') into news from _d where is_new;
  select coalesce(jsonb_agg(codes), '[]') into dupes from (select string_agg(code, ' = ' order by code) codes from _d group by norm_name(name) having count(*) > 1) x;
  delete from drivers where code not in (select code from _d);
  insert into drivers (code, name, other_names, phone, email, first_contract, last_contract, n_contracts, status, detected_at, note)
  select code, name, other_names, phone, email, first_c, last_c, n, status, detected_at, note from _d
  on conflict (code) do update set name = excluded.name, other_names = excluded.other_names, phone = excluded.phone, email = excluded.email,
    first_contract = excluded.first_contract, last_contract = excluded.last_contract, n_contracts = excluded.n_contracts,
    status = excluded.status, note = excluded.note;
  return jsonb_build_object('new', news, 'dupes', dupes);
end $$;

-- Clés véhicule présentes dans les données et les contrats, avec leur historique (choix de la clé principale d'un véhicule)
create or replace function public.key_stats()
returns table (vehicle_key text, n_days integer, n_contracts integer, in_data boolean)
language sql stable set search_path = public as $$
  with k as (
    select vehicle_key, count(*)::int nd, 0 nc, true d from vehicle_days group by 1
    union all select vehicle_key, 0, count(*)::int, false from contracts where vehicle_key is not null group by 1
    union all select distinct vehicle_key, 0, 0, true from trips
    union all select distinct vehicle_key, 0, 0, true from events
    union all select distinct vehicle_key, 0, 0, true from fuel
    union all select distinct vehicle_key, 0, 0, true from levels
    union all select distinct vehicle_key, 0, 0, true from idles)
  select vehicle_key, sum(nd)::int, sum(nc)::int, bool_or(d) from k group by 1
$$;

-- Premier contrat connu par clé véhicule (pour ne pas mettre en cause un chauffeur avant le début de l'historique)
create or replace function public.contract_first()
returns table (vehicle_key text, first_start timestamptz) language sql stable set search_path = public as $$
  select vehicle_key, min(start_at) from contracts where vehicle_key is not null and start_at is not null group by 1
$$;

-- Plaque devenue « autre plaque » d'un véhicule : toutes ses lignes passent sous la clé historique (doublons retirés)
create or replace function public.rekey_vehicle(p_alias text, p_canon text)
returns date language plpgsql set search_path = public as $$
declare t text; d date; m date; pre text := p_alias || '|'; np integer := length(p_alias) + 2;
begin
  if p_alias = p_canon or coalesce(p_alias, '') = '' or coalesce(p_canon, '') = '' then return null; end if;
  foreach t in array array['trips', 'idles', 'events', 'fuel', 'levels'] loop
    execute format('select min(vday) from %I where vehicle_key = $1', t) into d using p_alias;
    if d is not null and (m is null or d < m) then m := d; end if;
    -- identifiant déjà présent sous la clé historique : doublon
    execute format('delete from %I a where a.vehicle_key = $1 and left(a.id, length($3)) = $3 and exists (select 1 from %I b where b.id = $2 || ''|'' || substr(a.id, $4))', t, t)
      using p_alias, p_canon, pre, np;
    execute format('update %I set vehicle_key = $2, id = case when left(id, length($3)) = $3 then $2 || ''|'' || substr(id, $4) else id end where vehicle_key = $1', t)
      using p_alias, p_canon, pre, np;
  end loop;
  update idles set trip_id = p_canon || '|' || substr(trip_id, np) where left(trip_id, length(pre)) = pre;
  delete from vehicle_days a where a.vehicle_key = p_alias and exists (select 1 from vehicle_days b where b.id = p_canon || '|' || substr(a.id, np));
  update vehicle_days set vehicle_key = p_canon, id = p_canon || '|' || substr(id, np) where vehicle_key = p_alias;
  update contracts set vehicle_key = p_canon where vehicle_key = p_alias;
  update journal set vehicle_key = p_canon where vehicle_key = p_alias;
  update alerts set vehicle_key = p_canon where vehicle_key = p_alias;
  delete from live_status where vehicle_key = p_alias;
  return m;
end $$;

-- Lignes plus anciennes que p_before retirées d'une table (archivage : copiées dans Drive par le collecteur avant)
create or replace function public.purge_before(p_table text, p_before date)
returns integer language plpgsql set search_path = public as $$
declare n integer;
begin
  if p_table in ('trips', 'idles', 'events', 'fuel', 'levels') then execute format('delete from %I where vday < $1', p_table) using p_before;
  elsif p_table in ('vehicle_days', 'journal', 'alerts') then execute format('delete from %I where day < $1', p_table) using p_before;
  elsif p_table = 'logs' then delete from logs where at < p_before;
  elsif p_table = 'jobs' then delete from jobs where done_at is not null and created_at < p_before;
  else raise exception 'table %', p_table; end if;
  get diagnostics n = row_count; return n;
end $$;

-- Taille de la base (suivi du quota gratuit de 500 Mo)
create or replace function public.db_size() returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('total_mb', round(pg_database_size(current_database()) / 1048576.0, 1),
    'tables', (select jsonb_object_agg(relname, round(pg_total_relation_size(c.oid) / 1048576.0, 2)) from pg_class c
                join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'))
$$;

-- Ces fonctions ne sont appelables qu'avec la clé service_role (collecteur)
do $$
declare f text;
begin
  foreach f in array array['put_rows(text,text[],jsonb,boolean)', 'finalize_vdays(text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)',
    'replace_journal(date,jsonb)', 'replace_alerts(date,jsonb)', 'refresh_drivers()', 'key_stats()', 'contract_first()',
    'rekey_vehicle(text,text)', 'purge_before(text,date)', 'db_size()'] loop
    execute 'revoke execute on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- =============================================================================
-- Fonctions de lecture du site (utilisateurs validés, mêmes droits de lecture que les tables)
-- =============================================================================
-- Événements de conduite comptés par chauffeur et par règle (journée de travail = jour du contrat)
create or replace function public.driver_rule_counts(p_from date, p_to date)
returns table (driver_code text, rule_id text, n integer) language sql stable set search_path = public as $$
  with cd as (select contract_num, min(day) d from journal where contract_num is not null and contract_num <> '' group by 1)
  select e.driver_code, e.rule_id, count(*)::int
    from events e join rules r on r.id = e.rule_id and r.weight > 0
    left join cd on cd.contract_num = e.contract_num
   where e.day between p_from - 2 and p_to + 1 and coalesce(e.driver_code, '') not in ('', 'HORS_CONTRAT')
     and coalesce(cd.d, e.day) between p_from and p_to
   group by 1, 2
$$;
-- Alertes comptées par véhicule, type et gravité
create or replace function public.alert_counts(p_from date, p_to date)
returns table (vehicle_key text, type text, severity text, status text, n integer) language sql stable set search_path = public as $$
  select vehicle_key, type, severity, status, count(*)::int from alerts where day between p_from and p_to group by 1, 2, 3, 4
$$;
do $$
declare f text;
begin
  foreach f in array array['driver_rule_counts(date,date)', 'alert_counts(date,date)'] loop
    execute 'revoke execute on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated, service_role';
  end loop;
end $$;
