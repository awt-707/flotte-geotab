-- Retours des véhicules : arrivée à l'agence notifiée sur Ludy et sur le téléphone Android (16/11/2026, demande d'Ahmed).
-- watch_poll (téléphone, secret du téléphone) renvoie aussi les retours en cours que l'utilisateur a le droit de voir : chauffeur prévenu,
-- retour pas encore fait, avec la position de l'agence. Le relais geotab-live (?mode=watch) et le collecteur notent l'arrivée
-- (return_calls.arrived_at) quand le véhicule est à moins du rayon de l'agence ; le téléphone notifie l'arrivée.
-- Même corps que 20261129000000_alertes_telephone.sql, plus « returns » et le paramètre returnRadiusM.

create index if not exists return_calls_arrived on public.return_calls (arrived_at) where done_at is null and cancelled_at is null;

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
    'params', coalesce((select jsonb_object_agg(key, value) from params where key in ('pauseShiftMin', 'pauseRemindMin', 'pauseMoveM', 'trackArriveM', 'returnRadiusM')), '{}'),
    'pauses', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'vehicle_key', p.vehicle_key, 'plate', p.plate, 'driver_name', p.driver_name,
        'driver_phone', p.driver_phone, 'started_at', p.started_at, 'planned_min', p.planned_min, 'start_lat', p.start_lat, 'start_lon', p.start_lon,
        'moved_at', p.moved_at, 'moved_m', p.moved_m, 'moved_note', p.moved_note) order by p.started_at)
      from driver_pauses p where p.ended_at is null and p.started_at > now() - interval '24 hours'
        and (v_admin or p.vehicle_key = any(v_keys) or p.agency_id = any(v_ag))), '[]'),
    'tracks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'mission_id', t.mission_id, 'vehicle_key', t.vehicle_key, 'plate', t.plate,
        'driver_name', t.driver_name, 'started_at', t.started_at, 'dest_label', t.dest_label, 'dest_lat', t.dest_lat, 'dest_lon', t.dest_lon,
        'arrived_at', t.arrived_at) order by t.started_at)
      from mission_tracks t where t.ended_at is null and t.started_at > now() - interval '48 hours'
        and (v_admin or t.vehicle_key = any(v_keys) or t.agency_id = any(v_ag))), '[]'),
    'returns', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'contract_num', r.contract_num, 'vehicle_key', r.vehicle_key,
        'plate', coalesce(v.plate, r.vehicle_key), 'driver_name', r.driver_name, 'slot_at', r.slot_at, 'sent_at', r.sent_at, 'arrived_at', r.arrived_at,
        'agency', a.name, 'lat', a.lat, 'lng', a.lng, 'radius_m', a.return_radius_m) order by r.slot_at nulls last, r.sent_at)
      from return_calls r left join vehicles v on v.key = r.vehicle_key left join agencies a on a.id = r.agency_id
      where r.sent_at is not null and r.done_at is null and r.cancelled_at is null and r.created_at > now() - interval '24 hours'
        and (v_admin or r.vehicle_key = any(v_keys))), '[]'));
end $$;
revoke execute on function public.watch_poll(text) from public;
grant execute on function public.watch_poll(text) to anon, authenticated, service_role;
