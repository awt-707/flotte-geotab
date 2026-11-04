-- =============================================================================
-- Fonctionnement sans Google Sheet, agences, alertes par e-mail, rapports PDF planifiés.
-- - parc : liste des véhicules injectée depuis le site (remplace le Sheet « ETAT PARC »)
-- - chauffeurs ajoutés à la main (en plus de ceux déduits des contrats)
-- - agences : chaque utilisateur ne voit que les véhicules (et leurs trajets, contrats, alertes…) de ses agences ; l'admin voit tout
-- - destinataires des alertes par e-mail, rapports envoyés automatiquement
-- =============================================================================

-- ---------- Agences ----------
create table if not exists public.agencies (
  id bigint generated always as identity primary key,
  name text not null unique, city text, created_at timestamptz not null default now()
);
create table if not exists public.user_agencies (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  agency_id bigint not null references public.agencies(id) on delete cascade,
  primary key (user_id, agency_id)
);
alter table public.vehicles add column if not exists agency_id bigint references public.agencies(id) on delete set null;
alter table public.drivers add column if not exists agency_id bigint references public.agencies(id) on delete set null;
alter table public.drivers add column if not exists source text not null default 'contrats';   -- 'contrats' ou 'manuel'
create index if not exists vehicles_agency on public.vehicles(agency_id);

-- ---------- Parc (liste des véhicules, injectée depuis le site) ----------
create table if not exists public.parc (
  plate text primary key, brand text, model text, vin text, fuel text,
  agency_id bigint references public.agencies(id) on delete set null, note text,
  updated_at timestamptz not null default now()
);

-- ---------- Alertes : envoi par e-mail ----------
alter table public.alerts add column if not exists notified_at timestamptz;
create table if not exists public.alert_recipients (
  id bigint generated always as identity primary key,
  email text not null, name text,
  agency_id bigint references public.agencies(id) on delete cascade,      -- vide = toutes les agences
  min_severity text not null default 'Haute' check (min_severity in ('Critique', 'Haute', 'Moyenne', 'Info')),
  types text,                                                             -- types d'alerte séparés par des virgules ; vide = tous
  active boolean not null default true, created_at timestamptz not null default now()
);

-- ---------- Rapports PDF envoyés automatiquement ----------
create table if not exists public.report_schedules (
  id bigint generated always as identity primary key,
  name text, agency_id bigint references public.agencies(id) on delete cascade,   -- vide = toutes les agences
  frequency text not null check (frequency in ('jour', 'semaine', 'mois')),
  recipients text not null, active boolean not null default true,
  last_period text, last_sent_at timestamptz, last_result text, created_at timestamptz not null default now()
);

-- ---------- Plaque normalisée (même règle que normPlate_ du collecteur) ----------
create or replace function public.norm_plate(s text) returns text language sql immutable as $$
  select regexp_replace(t, '[^0-9]', '', 'g') || regexp_replace(t, '[^A-Z]', '', 'g') from (select regexp_replace(upper(coalesce(s, '')), '[^0-9A-Z]', '', 'g') t) x
$$;

-- Agence d'un véhicule reprise du parc : à la création du véhicule par le collecteur, et quand l'agence change dans le parc
create or replace function public.parc_agency_for(p_key text, p_plate text, p_others text) returns bigint
language sql stable security definer set search_path = public as $$
  select p.agency_id from parc p
   where p.agency_id is not null
     and norm_plate(p.plate) in (select p_key union select norm_plate(p_plate) union select norm_plate(trim(x)) from unnest(regexp_split_to_array(coalesce(p_others, ''), '[,;]')) x)
   order by p.updated_at desc limit 1
$$;
create or replace function public.vehicles_agency_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.agency_id is null then new.agency_id := parc_agency_for(new.key, new.plate, new.other_plates); end if;
  return new;
end $$;
drop trigger if exists vehicles_agency on public.vehicles;
create trigger vehicles_agency before insert or update on public.vehicles for each row execute function public.vehicles_agency_trg();
create or replace function public.parc_agency_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.agency_id is not null then
    update vehicles v set agency_id = new.agency_id
     where v.agency_id is distinct from new.agency_id
       and norm_plate(new.plate) in (select v.key union select norm_plate(v.plate) union select norm_plate(trim(x)) from unnest(regexp_split_to_array(coalesce(v.other_plates, ''), '[,;]')) x);
  end if;
  return new;
end $$;
drop trigger if exists parc_agency on public.parc;
create trigger parc_agency after insert or update of agency_id, plate on public.parc for each row execute function public.parc_agency_trg();

-- ---------- Droits par agence ----------
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from profiles where user_id = auth.uid()), false)
$$;
create or replace function public.my_agency_ids() returns bigint[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(agency_id), '{}') from user_agencies where user_id = auth.uid()
$$;
-- Clés des véhicules visibles par l'utilisateur connecté (admin : tous ; sinon : véhicules de ses agences)
create or replace function public.my_vehicle_keys() returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(key), '{}') from vehicles
   where (select role from profiles where user_id = auth.uid()) in ('manager', 'viewer')
     and agency_id = any(coalesce((select array_agg(agency_id) from user_agencies where user_id = auth.uid()), '{}'))
$$;
-- Chauffeurs visibles : de ses agences, ou ayant un contrat sur un véhicule de ses agences
create or replace function public.my_driver_codes() returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct code), '{}') from (
    select code from drivers where agency_id = any(my_agency_ids())
    union all select client_code from contracts where vehicle_key = any(my_vehicle_keys()) and client_code is not null) x
$$;
-- Lecture : admin = tout ; gestionnaire / lecture seule = lignes des véhicules de ses agences
do $$
declare t text;
begin
  foreach t in array array['trips', 'idles', 'events', 'fuel', 'levels', 'vehicle_days', 'journal', 'alerts', 'live_status', 'contracts'] loop
    execute format('drop policy if exists read_all on public.%I', t);
    execute format('drop policy if exists read_agency on public.%I', t);
    execute format('create policy read_agency on public.%I for select to authenticated using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]))', t);
  end loop;
end $$;
drop policy if exists read_all on public.vehicles;
drop policy if exists read_agency on public.vehicles;
create policy read_agency on public.vehicles for select to authenticated using ((select public.is_admin()) or key = any((select public.my_vehicle_keys())::text[]));
drop policy if exists read_all on public.drivers;
drop policy if exists read_agency on public.drivers;
create policy read_agency on public.drivers for select to authenticated using ((select public.is_admin()) or code = any((select public.my_driver_codes())::text[]));

-- Modifications limitées aux lignes de ses agences
drop policy if exists mgr_update on public.alerts;
create policy mgr_update on public.alerts for update to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));
drop policy if exists mgr_update on public.fuel;
create policy mgr_update on public.fuel for update to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));

-- Chauffeurs : ajout / modification à la main (admin ; gestionnaire pour ses agences)
grant insert on public.drivers to authenticated;
grant update (name, phone, email, status, note, agency_id) on public.drivers to authenticated;
drop policy if exists mgr_update on public.drivers;
drop policy if exists mgr_insert on public.drivers;
drop policy if exists mgr_delete on public.drivers;
create policy mgr_update on public.drivers for update to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and code = any((select public.my_driver_codes())::text[])))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and (agency_id is null or agency_id = any((select public.my_agency_ids())::bigint[]))));
create policy mgr_insert on public.drivers for insert to authenticated
  with check (source = 'manuel' and ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[]))));
grant delete on public.drivers to authenticated;
create policy mgr_delete on public.drivers for delete to authenticated
  using (source = 'manuel' and ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[]))));

-- Véhicules : agence modifiable par l'admin
grant update (tank_l, ref_l100, revenue, active, agency_id) on public.vehicles to authenticated;

-- Contrats : import par fonction (compare et enregistre côté base ; un gestionnaire importe l'extract complet sans voir les autres agences)
drop policy if exists mgr_insert on public.contracts;
drop policy if exists mgr_update on public.contracts;
revoke insert, update on public.contracts from authenticated;
create or replace function public.import_contracts(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_add integer; n_upd integer; n_same integer; m timestamptz;
begin
  if coalesce(my_role(), '') not in ('admin', 'manager') then raise exception 'droits insuffisants'; end if;
  create temp table _c on commit drop as
    select distinct on (r.num) r.* from jsonb_populate_recordset(null::contracts, coalesce(p_rows, '[]')) r where coalesce(r.num, '') <> '' order by r.num;
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
  return jsonb_build_object('added', n_add, 'updated', n_upd, 'same', n_same, 'min_start', m);
end $$;
revoke execute on function public.import_contracts(jsonb) from public, anon;
grant execute on function public.import_contracts(jsonb) to authenticated, service_role;

-- Agences, rattachements, parc, destinataires, rapports : lecture selon l'agence, modification par l'admin
alter table public.agencies enable row level security;
alter table public.user_agencies enable row level security;
alter table public.parc enable row level security;
alter table public.alert_recipients enable row level security;
alter table public.report_schedules enable row level security;
revoke all on public.agencies, public.user_agencies, public.parc, public.alert_recipients, public.report_schedules from anon;
grant select, insert, update, delete on public.agencies, public.user_agencies, public.parc, public.alert_recipients, public.report_schedules to authenticated;
drop policy if exists read_agency on public.agencies;
drop policy if exists admin_all on public.agencies;
create policy read_agency on public.agencies for select to authenticated using ((select public.is_admin()) or id = any((select public.my_agency_ids())::bigint[]));
create policy admin_all on public.agencies for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists read_own on public.user_agencies;
drop policy if exists admin_all on public.user_agencies;
create policy read_own on public.user_agencies for select to authenticated using ((select public.is_admin()) or user_id = auth.uid());
create policy admin_all on public.user_agencies for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists read_agency on public.parc;
drop policy if exists admin_all on public.parc;
create policy read_agency on public.parc for select to authenticated using ((select public.is_admin()) or agency_id = any((select public.my_agency_ids())::bigint[]));
create policy admin_all on public.parc for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists admin_all on public.alert_recipients;
create policy admin_all on public.alert_recipients for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists admin_all on public.report_schedules;
create policy admin_all on public.report_schedules for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Chauffeurs reconstruits depuis les contrats ; les chauffeurs ajoutés à la main sont conservés (nom, téléphone, e-mail saisis prioritaires)
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
  return jsonb_build_object('new', news, 'dupes', dupes);
end $$;
revoke execute on function public.refresh_drivers() from public, anon, authenticated;
grant execute on function public.refresh_drivers() to service_role;
revoke execute on function public.parc_agency_for(text, text, text) from public, anon, authenticated;

-- Alertes à envoyer par e-mail (collecteur) : marquées une fois envoyées
create or replace function public.mark_notified(p_ids text[]) returns integer language sql set search_path = public as $$
  with u as (update alerts set notified_at = now() where id = any(p_ids) and notified_at is null returning 1) select count(*)::int from u
$$;
revoke execute on function public.mark_notified(text[]) from public, anon, authenticated;
grant execute on function public.mark_notified(text[]) to service_role;

-- Temps réel : le site est prévenu des nouvelles alertes (Supabase Realtime, filtré par les droits de lecture)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.alerts'; exception when others then null; end;
  end if;
end $$;

-- Paramètre de l'ancien rapport quotidien du Sheet remplacé par les rapports planifiés (Réglages > Rapports)
delete from public.params where key = 'emails';
