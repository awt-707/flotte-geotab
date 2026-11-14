-- =============================================================================
-- Suivi des pauses chauffeurs et des courses privées (14/11/2026, demande d'Ahmed).
-- driver_pauses : pause déclenchée par le gestionnaire (2 h par chauffeur et par shift, réglable : pauseShiftMin), fin = compte à rebours,
--   véhicule qui bouge pendant la pause noté (moved_*). mission_tracks : suivi d'une course privée de la prise en charge à l'arrivée.
-- Droits : administrateur ; gestionnaire = véhicules de ses agences ; lecture seule = lecture. Heure de début = heure de la base.
-- À exécuter dans Supabase > SQL Editor après 20261127000000_relecture_base.sql. Rejouable.
-- =============================================================================
create table if not exists public.driver_pauses (
  id bigint generated always as identity primary key,
  agency_id bigint references public.agencies(id) on delete set null,
  vehicle_key text not null,
  plate text,
  driver_code text,
  driver_name text,
  driver_phone text,
  contract_num text,
  shift_day date not null,                -- jour du shift (une nuit appartient au jour où elle commence)
  shift text not null check (shift in ('Jour', 'Nuit')),
  started_at timestamptz not null default now(),
  planned_min integer not null check (planned_min between 1 and 480),
  ended_at timestamptz,
  end_reason text,                        -- Terminée par le gestionnaire, Fin du compte à rebours, Annulée
  start_lat double precision,
  start_lon double precision,
  moved_at timestamptz,
  moved_m integer,
  moved_note text,
  note text,
  created_by uuid default auth.uid(),
  ended_by uuid
);
create unique index if not exists driver_pauses_one_open on public.driver_pauses (vehicle_key) where ended_at is null;
create index if not exists driver_pauses_shift on public.driver_pauses (shift_day, shift);
create index if not exists driver_pauses_agency on public.driver_pauses (agency_id, started_at desc);
create index if not exists driver_pauses_driver on public.driver_pauses (driver_code, shift_day);

create table if not exists public.mission_tracks (
  id bigint generated always as identity primary key,
  mission_id bigint not null references public.missions(id) on delete cascade,
  agency_id bigint references public.agencies(id) on delete set null,
  vehicle_key text not null,
  plate text,
  driver_name text,
  driver_phone text,
  started_at timestamptz not null default now(),
  dest_label text,
  dest_lat double precision,
  dest_lon double precision,
  arrived_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  points jsonb not null default '[]'::jsonb,   -- positions GPS Geotab relevées pendant le suivi [[iso, lat, lon], …]
  created_by uuid default auth.uid(),
  ended_by uuid
);
create unique index if not exists mission_tracks_one_open on public.mission_tracks (mission_id) where ended_at is null;
create index if not exists mission_tracks_started on public.mission_tracks (agency_id, started_at desc);
create index if not exists mission_tracks_mission on public.mission_tracks (mission_id);

-- heure de début = heure de la base, auteur = utilisateur connecté ; une fin jamais avant le début ni dans le futur
create or replace function public.suivi_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then new.started_at := now(); new.created_by := auth.uid(); end if;
    if new.ended_at is not null and (tg_op = 'INSERT' or old.ended_at is null) then
      new.ended_at := least(greatest(new.ended_at, new.started_at), now()); new.ended_by := auth.uid();
    end if;
    if tg_op = 'UPDATE' and old.ended_at is not null and new.ended_at is distinct from old.ended_at then
      raise exception 'suivi déjà terminé';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists driver_pauses_guard on public.driver_pauses;
create trigger driver_pauses_guard before insert or update on public.driver_pauses for each row execute function public.suivi_guard();
drop trigger if exists mission_tracks_guard on public.mission_tracks;
create trigger mission_tracks_guard before insert or update on public.mission_tracks for each row execute function public.suivi_guard();
revoke execute on function public.suivi_guard() from public, anon;

alter table public.driver_pauses enable row level security;
alter table public.mission_tracks enable row level security;
revoke all on public.driver_pauses, public.mission_tracks from anon, authenticated;
grant select on public.driver_pauses, public.mission_tracks to authenticated;
grant insert (agency_id, vehicle_key, plate, driver_code, driver_name, driver_phone, contract_num, shift_day, shift, planned_min, start_lat, start_lon, note)
  on public.driver_pauses to authenticated;
grant update (planned_min, ended_at, end_reason, moved_at, moved_m, moved_note, note) on public.driver_pauses to authenticated;
grant insert (mission_id, agency_id, vehicle_key, plate, driver_name, driver_phone, dest_label, dest_lat, dest_lon, points) on public.mission_tracks to authenticated;
grant update (dest_label, dest_lat, dest_lon, arrived_at, ended_at, end_reason, points) on public.mission_tracks to authenticated;
grant delete on public.driver_pauses, public.mission_tracks to authenticated;
grant all on public.driver_pauses, public.mission_tracks to service_role;

drop policy if exists sv_read on public.driver_pauses;
drop policy if exists sv_ins on public.driver_pauses;
drop policy if exists sv_upd on public.driver_pauses;
drop policy if exists sv_del on public.driver_pauses;
create policy sv_read on public.driver_pauses for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]) or agency_id = any((select public.my_agency_ids())::bigint[]));
create policy sv_ins on public.driver_pauses for insert to authenticated
  with check ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));
create policy sv_upd on public.driver_pauses for update to authenticated
  using ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])))
  with check ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));
create policy sv_del on public.driver_pauses for delete to authenticated using ((select public.is_admin()));

drop policy if exists sv_read on public.mission_tracks;
drop policy if exists sv_ins on public.mission_tracks;
drop policy if exists sv_upd on public.mission_tracks;
drop policy if exists sv_del on public.mission_tracks;
create policy sv_read on public.mission_tracks for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]) or agency_id = any((select public.my_agency_ids())::bigint[]));
create policy sv_ins on public.mission_tracks for insert to authenticated
  with check ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])
    and exists (select 1 from public.missions m where m.id = mission_id)));   -- course visible par lui (règles de missions)
create policy sv_upd on public.mission_tracks for update to authenticated
  using ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])))
  with check ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));
create policy sv_del on public.mission_tracks for delete to authenticated using ((select public.is_admin()));

-- réglages (Réglages > Pauses et suivi des courses) : durée de pause par shift, rappel, déplacement, arrivée
insert into public.params (key, label, value, note, sort) values
  ('pauseShiftMin', 'Pause par chauffeur et par shift (min)', '120', 'Temps de pause autorisé par shift ; le compte à rebours d''une pause ne va pas au-delà de ce qui reste.', 120),
  ('pauseRemindMin', 'Rappel pendant une pause (min)', '30', 'Rappel à l''écran toutes les n minutes de pause.', 121),
  ('pauseMoveM', 'Alerte véhicule en pause qui bouge (m)', '300', 'Alerte quand le véhicule en pause est à plus de n mètres de sa place (ou en route à 10 km/h et plus), d''après le GPS Geotab.', 122),
  ('trackArriveM', 'Course suivie : arrivée à moins de (m)', '300', 'Alerte « course arrivée » quand le véhicule est à moins de n mètres de la destination.', 123)
  on conflict (key) do nothing;
notify pgrst, 'reload schema';
