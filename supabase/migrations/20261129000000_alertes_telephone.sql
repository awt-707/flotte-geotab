-- Alertes des pauses sur le téléphone, même écran éteint (14/11/2026, demande d'Ahmed : « celle qui fonctionne en arrière-plan »).
-- L'application Android 1.3 garde un service au premier plan qui interroge la base toutes les 30 s, sans la session du site
-- (qui expire quand l'application dort) : chaque téléphone reçoit à l'activation un secret (watch_register, utilisateur connecté),
-- seule son empreinte SHA-256 est gardée. watch_poll(secret), appelable avec la clé publique, renvoie les pauses et les suivis de courses
-- ouverts que cet utilisateur a le droit de voir (mêmes règles que driver_pauses / mission_tracks : administrateur = tout,
-- sinon véhicules et agences de ses agences). Rien d'autre n'est lisible avec ce secret.
-- Le relais geotab-live (?mode=watch, clé service) contrôle aussi avec les positions Geotab les véhicules en pause qui bougent et
-- les courses arrivées, pour les téléphones dont un utilisateur suit une pause ou une course.

create table if not exists public.watch_devices (
  id bigserial primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  secret_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  last_seen timestamptz
);
create index if not exists watch_devices_user on public.watch_devices (user_id);
alter table public.watch_devices enable row level security;
revoke all on public.watch_devices from anon, authenticated;
grant select (id, label, created_at, last_seen) on public.watch_devices to authenticated;
grant all on public.watch_devices to service_role;
grant usage, select on sequence public.watch_devices_id_seq to service_role;
drop policy if exists wd_read on public.watch_devices;
create policy wd_read on public.watch_devices for select to authenticated using (user_id = (select auth.uid()));

-- Nouveau téléphone : secret renvoyé une seule fois (5 téléphones au plus par utilisateur, les plus anciens retirés)
create or replace function public.watch_register(p_label text) returns text language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_secret text;
begin
  if v_uid is null or coalesce((select role from profiles where user_id = v_uid), '') not in ('admin', 'manager', 'viewer') then
    raise exception 'Compte non autorisé' using errcode = '42501';
  end if;
  v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into watch_devices (user_id, secret_hash, label) values (v_uid, encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), left(coalesce(p_label, ''), 80));
  delete from watch_devices where user_id = v_uid and id not in (select id from watch_devices where user_id = v_uid order by id desc limit 5);
  return v_secret;
end $$;

-- Téléphone retiré (surveillance arrêtée, déconnexion)
create or replace function public.watch_unregister(p_secret text) returns void language sql security definer set search_path = public as $$
  delete from watch_devices where secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex')
$$;

-- Pauses et suivis ouverts visibles par l'utilisateur du téléphone
create or replace function public.watch_poll(p_secret text) returns jsonb language plpgsql security definer set search_path = public as $$
declare d watch_devices; v_role text; v_ag bigint[]; v_keys text[]; v_admin boolean;
begin
  select * into d from watch_devices where secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex');
  if d.id is null then raise exception 'watch_unknown' using errcode = '28000'; end if;
  v_role := coalesce((select role from profiles where user_id = d.user_id), '');
  if v_role not in ('admin', 'manager', 'viewer') then raise exception 'watch_unknown' using errcode = '28000'; end if;
  v_admin := v_role = 'admin';
  v_ag := coalesce((select array_agg(agency_id) from user_agencies where user_id = d.user_id), '{}');
  v_keys := coalesce((select array_agg(key) from vehicles where agency_id = any(v_ag)), '{}');
  if d.last_seen is null or d.last_seen < now() - interval '1 minute' then update watch_devices set last_seen = now() where id = d.id; end if;
  return jsonb_build_object(
    'now', now(),
    'user_id', d.user_id,
    'params', coalesce((select jsonb_object_agg(key, value) from params where key in ('pauseShiftMin', 'pauseRemindMin', 'pauseMoveM', 'trackArriveM')), '{}'),
    'pauses', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'vehicle_key', p.vehicle_key, 'plate', p.plate, 'driver_name', p.driver_name,
        'driver_phone', p.driver_phone, 'started_at', p.started_at, 'planned_min', p.planned_min, 'start_lat', p.start_lat, 'start_lon', p.start_lon,
        'moved_at', p.moved_at, 'moved_m', p.moved_m, 'moved_note', p.moved_note) order by p.started_at)
      from driver_pauses p where p.ended_at is null and p.started_at > now() - interval '24 hours'
        and (v_admin or p.vehicle_key = any(v_keys) or p.agency_id = any(v_ag))), '[]'),
    'tracks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'mission_id', t.mission_id, 'vehicle_key', t.vehicle_key, 'plate', t.plate,
        'driver_name', t.driver_name, 'started_at', t.started_at, 'dest_label', t.dest_label, 'dest_lat', t.dest_lat, 'dest_lon', t.dest_lon,
        'arrived_at', t.arrived_at) order by t.started_at)
      from mission_tracks t where t.ended_at is null and t.started_at > now() - interval '48 hours'
        and (v_admin or t.vehicle_key = any(v_keys) or t.agency_id = any(v_ag))), '[]'));
end $$;

revoke execute on function public.watch_register(text), public.watch_unregister(text), public.watch_poll(text) from public;
grant execute on function public.watch_register(text) to authenticated;
grant execute on function public.watch_unregister(text), public.watch_poll(text) to anon, authenticated, service_role;
