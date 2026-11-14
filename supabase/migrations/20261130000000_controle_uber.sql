-- Contrôle des courses Uber (14/11/2026, demande d'Ahmed : chauffeurs qui acceptent une course Uber sans aller chercher le client,
-- l'annulation vient du client donc sans pénalité, pendant qu'ils font des courses en cachette).
-- Export Uber Fleet « Activité des courses » (trip_activity, CSV) importé depuis le site, croisé avec le GPS Geotab :
-- * uber_trips : une ligne par course (demandée, terminée, annulée par le client ou par le chauffeur), clé = UUID Uber ;
--   chk = constat Geotab d'une annulation (distance à la prise en charge à la demande, au plus près, 15 min après, km parcourus) ;
-- * uber_days : par véhicule et par jour, km roulés pendant une course Uber (de la demande à la dépose) et sans course Uber,
--   trajets sans course Uber (début, fin, km, positions).
-- Heures de l'export = UTC (vérifié le 14/11 sur les positions Geotab : dépose à Fès le 12/11 15:05 = arrêt Geotab 15:05 UTC).

create table if not exists public.uber_trips (
  uuid text primary key,
  agency_id bigint references public.agencies(id) on delete set null,
  driver_uuid text,
  driver_name text,
  vehicle_uuid text,
  plate text,
  vehicle_key text,
  service text,
  product text,
  payment text,
  requested_at timestamptz not null,
  dropoff_at timestamptz,
  pickup_addr text,
  drop_addr text,
  km numeric,
  status text not null,
  pu_lat double precision,
  pu_lon double precision,
  pu_prec text,
  chk jsonb,
  chk_at timestamptz,
  imported_at timestamptz not null default now(),
  imported_by uuid
);
create index if not exists uber_trips_veh on public.uber_trips (vehicle_key, requested_at);
create index if not exists uber_trips_drv on public.uber_trips (driver_uuid, requested_at);
create index if not exists uber_trips_at on public.uber_trips (requested_at);

create table if not exists public.uber_days (
  vehicle_key text not null,
  day date not null,
  agency_id bigint references public.agencies(id) on delete set null,
  win_from timestamptz,
  win_to timestamptz,
  km_uber numeric,
  km_off numeric,
  n_gps integer,
  segs jsonb not null default '[]',
  computed_at timestamptz not null default now(),
  computed_by uuid,
  primary key (vehicle_key, day)
);
create index if not exists uber_days_day on public.uber_days (day);

alter table public.uber_trips enable row level security;
alter table public.uber_days enable row level security;
revoke all on public.uber_trips, public.uber_days from anon, authenticated;
grant select on public.uber_trips, public.uber_days to authenticated;
grant update (pu_lat, pu_lon, pu_prec, chk, chk_at) on public.uber_trips to authenticated;
grant insert, update on public.uber_days to authenticated;
grant delete on public.uber_trips, public.uber_days to authenticated;
grant all on public.uber_trips, public.uber_days to service_role;

-- administrateur : tout ; gestionnaire : véhicules et agences de ses agences (lecture seule : rien de visible)
drop policy if exists ub_read on public.uber_trips;
drop policy if exists ub_upd on public.uber_trips;
drop policy if exists ub_del on public.uber_trips;
create policy ub_read on public.uber_trips for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]) or agency_id = any((select public.my_agency_ids())::bigint[]));
create policy ub_upd on public.uber_trips for update to authenticated
  using ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])))
  with check ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));
create policy ub_del on public.uber_trips for delete to authenticated using ((select public.is_admin()));

drop policy if exists ubd_read on public.uber_days;
drop policy if exists ubd_ins on public.uber_days;
drop policy if exists ubd_upd on public.uber_days;
drop policy if exists ubd_del on public.uber_days;
create policy ubd_read on public.uber_days for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]) or agency_id = any((select public.my_agency_ids())::bigint[]));
create policy ubd_ins on public.uber_days for insert to authenticated
  with check ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));
create policy ubd_upd on public.uber_days for update to authenticated
  using ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])))
  with check ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));
create policy ubd_del on public.uber_days for delete to authenticated using ((select public.is_admin()));

-- Import de l'export (réimport : statut, dépose, distance mis à jour ; constat Geotab gardé sauf si la course a changé)
-- Véhicule = plaque de l'export comparée aux plaques et clés de Ludy (chiffres seulement) ; agence = celle du véhicule.
-- Gestionnaire : seulement les courses des véhicules de ses agences (les autres sont comptées « ignorées »).
create or replace function public.import_uber_trips(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare adm boolean := is_admin(); keys text[] := my_vehicle_keys(); n_add integer; n_upd integer; n_same integer; n_skip integer; n_noveh integer;
begin
  if coalesce(my_role(), '') not in ('admin', 'manager') then raise exception 'droits insuffisants' using errcode = '42501'; end if;
  create temp table _u on commit drop as
    select distinct on (r.uuid) r.uuid, r.driver_uuid, r.driver_name, r.vehicle_uuid, r.plate, r.service, r.product, r.payment, r.requested_at, r.dropoff_at,
           r.pickup_addr, r.drop_addr, r.km, r.status,
           (select v.key from vehicles v where nullif(regexp_replace(coalesce(r.plate, ''), '\D', '', 'g'), '') in (regexp_replace(coalesce(v.plate, ''), '\D', '', 'g'), regexp_replace(v.key, '\D', '', 'g'))
             order by (v.key like 'myclicar:%'), v.key limit 1) as vehicle_key
      from jsonb_to_recordset(coalesce(p_rows, '[]')) as r(uuid text, driver_uuid text, driver_name text, vehicle_uuid text, plate text, service text, product text,
        payment text, requested_at timestamptz, dropoff_at timestamptz, pickup_addr text, drop_addr text, km numeric, status text)
     where coalesce(r.uuid, '') <> '' and r.requested_at is not null and coalesce(r.status, '') <> ''
     order by r.uuid;
  select count(*) filter (where vehicle_key is null) into n_noveh from _u;
  select count(*) into n_skip from _u where not adm and not (coalesce(vehicle_key, '') = any(keys));
  if not adm then delete from _u where not (coalesce(vehicle_key, '') = any(keys)); end if;
  create temp table _v on commit drop as
    select u.*, (select agency_id from vehicles where key = u.vehicle_key) as agency_id, o.uuid is not null as known,
      (o.uuid is not null and o.status = u.status and o.dropoff_at is not distinct from u.dropoff_at and o.km is not distinct from u.km
        and o.vehicle_key is not distinct from u.vehicle_key and o.pickup_addr is not distinct from u.pickup_addr) as same
      from _u u left join uber_trips o on o.uuid = u.uuid;
  select count(*) filter (where not known), count(*) filter (where known and not same), count(*) filter (where same) into n_add, n_upd, n_same from _v;
  insert into uber_trips (uuid, agency_id, driver_uuid, driver_name, vehicle_uuid, plate, vehicle_key, service, product, payment, requested_at, dropoff_at,
                          pickup_addr, drop_addr, km, status, imported_at, imported_by)
  select uuid, agency_id, driver_uuid, driver_name, vehicle_uuid, plate, vehicle_key, service, product, payment, requested_at, dropoff_at,
         pickup_addr, drop_addr, km, status, now(), auth.uid() from _v where not same
  on conflict (uuid) do update set agency_id = excluded.agency_id, driver_uuid = excluded.driver_uuid, driver_name = excluded.driver_name,
    vehicle_uuid = excluded.vehicle_uuid, plate = excluded.plate, vehicle_key = excluded.vehicle_key, service = excluded.service, product = excluded.product,
    payment = excluded.payment, requested_at = excluded.requested_at, dropoff_at = excluded.dropoff_at, drop_addr = excluded.drop_addr, km = excluded.km,
    status = excluded.status, imported_at = excluded.imported_at, imported_by = excluded.imported_by,
    pickup_addr = excluded.pickup_addr,
    pu_lat = case when uber_trips.pickup_addr is distinct from excluded.pickup_addr then null else uber_trips.pu_lat end,
    pu_lon = case when uber_trips.pickup_addr is distinct from excluded.pickup_addr then null else uber_trips.pu_lon end,
    pu_prec = case when uber_trips.pickup_addr is distinct from excluded.pickup_addr then null else uber_trips.pu_prec end,
    chk = null, chk_at = null;
  -- journées des véhicules touchés à recalculer (courses changées)
  delete from uber_days d using (select distinct vehicle_key, (requested_at at time zone 'UTC')::date as day from _v where not same and vehicle_key is not null) x
   where d.vehicle_key = x.vehicle_key and d.day between x.day - 1 and x.day + 1;
  return jsonb_build_object('added', n_add, 'updated', n_upd, 'same', n_same, 'skipped', n_skip, 'no_vehicle', n_noveh);
end $$;
revoke execute on function public.import_uber_trips(jsonb) from public, anon;
grant execute on function public.import_uber_trips(jsonb) to authenticated, service_role;
