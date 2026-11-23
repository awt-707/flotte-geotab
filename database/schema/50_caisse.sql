-- =============================================================================
-- Caisse : encaissements, dépenses, Uber, Bolt, justificatifs (structure)
-- Journal unique des mouvements (cash_moves, garde cash_guard, historique cash_log), exports Uber et Bolt,
-- fiches d'encaissement et justificatifs déposés (cash_sheets, cash_files),
-- contrôle des courses Uber (export « Activité des courses » croisé avec le GPS Geotab : uber_trips, uber_days).
-- Tables : bolt_sessions, cash_files, cash_log, cash_moves, cash_sheets, uber_catalog, uber_days, uber_drivers, uber_live, uber_live_log, uber_live_readers, uber_payments, uber_perf, uber_suspects, uber_trips
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.cash_agency_trg() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare n integer;
begin
  if new.agency_id is null then
    if tg_table_name = 'cash_moves' then
      select agency_id into new.agency_id from drivers where (code = new.driver_code or (new.uber_uuid is not null and uber_uuid = new.uber_uuid)) and agency_id is not null limit 1;
    elsif tg_table_name = 'uber_payments' then
      select agency_id into new.agency_id from drivers where uber_uuid = new.driver_uuid and agency_id is not null limit 1;
    elsif tg_table_name = 'bolt_sessions' then
      select agency_id into new.agency_id from vehicles where key = new.vehicle_key and agency_id is not null limit 1;
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

CREATE FUNCTION public.cash_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare a jsonb; b jsonb;
begin
  new.updated_at := now(); new.updated_by := auth.uid();
  -- bonus : statut changé = sortie de caisse mise à jour (« Payé » en espèces = sortie ; « A payer » ou payé par banque = hors caisse)
  if tg_op = 'UPDATE' and new.kind = 'bonus' and new.status is distinct from old.status and new.status in ('Payé', 'A payer') then
    new.flow := case when new.status = 'A payer' or new.source = 'Banque' then 'virement' else 'out' end;
  end if;
  if coalesce(public.my_role(), 'service') = 'manager' then
    if tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now(); new.cancelled_at := null; return new; end if;
    if not (old.created_by = auth.uid() and old.created_at > now() - interval '24 hours') then
      a := to_jsonb(old) - array['justif', 'status', 'signed', 'comment', 'promo_status', 'updated_at', 'updated_by', 'flow'];
      b := to_jsonb(new) - array['justif', 'status', 'signed', 'comment', 'promo_status', 'updated_at', 'updated_by', 'flow'];
      if new.flow is distinct from old.flow and not (new.kind = 'bonus' and new.status is distinct from old.status) then
        raise exception 'saisie de plus de 24 h ou d''un autre gestionnaire : seuls le justificatif, le statut, la signature et le commentaire se modifient (correction par l''administrateur)';
      end if;
      if a is distinct from b then
        raise exception 'saisie de plus de 24 h ou d''un autre gestionnaire : seuls le justificatif, le statut, la signature et le commentaire se modifient (correction par l''administrateur)';
      end if;
    end if;
    if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'auteur et date de saisie non modifiables';
    end if;
  end if;
  return new;
end $$;

CREATE FUNCTION public.cash_log_trg() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into cash_log (move_id, by, op, old, new) values (coalesce(new.id, old.id), auth.uid(), lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end, case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  return coalesce(new, old);
end $$;

CREATE FUNCTION public.import_uber_trips(p_rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

CREATE FUNCTION public.ma_offset_min(p_at timestamp with time zone, p_rules jsonb) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select coalesce((select (e->>1)::int from jsonb_array_elements(case when jsonb_typeof(p_rules) = 'array' then p_rules else '[]'::jsonb end) e
     where jsonb_typeof(e) = 'array' and (e->>0)::bigint <= (extract(epoch from p_at) * 1000)::bigint order by (e->>0)::bigint desc limit 1), 60)
$$;

CREATE FUNCTION public.uber_catalog_push(p_items jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_role text := coalesce((select role from profiles where user_id = auth.uid()), ''); it jsonb; n integer := 0;
begin
  if auth.uid() is null or v_role not in ('admin', 'manager', 'viewer') then raise exception 'Envoi refusé'; end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 200 then raise exception 'Envoi invalide'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce(it->>'k', '') = '' then continue; end if;
    if (select count(*) from uber_catalog) >= 3000 and not exists (select 1 from uber_catalog where k = left(it->>'k', 300)) then continue; end if;
    insert into uber_catalog (k, url, op, method, n, first_at, last_at, size, req, res, by_user, updated_at)
      values (left(it->>'k', 300), left(it->>'url', 300), left(it->>'op', 100), left(it->>'m', 10),
        least(coalesce((it->>'n')::numeric, 0), 1e9)::integer,
        to_timestamp(least(greatest(coalesce((it->>'first')::numeric, 0), 0), 4e12) / 1000), to_timestamp(least(greatest(coalesce((it->>'at')::numeric, 0), 0), 4e12) / 1000),
        least(coalesce((it->>'size')::numeric, 0), 1e9)::integer, left(it->>'req', 4000), left(it->>'res', 6000), auth.uid(), now())
      on conflict (k) do update set n = greatest(uber_catalog.n, excluded.n), last_at = greatest(uber_catalog.last_at, excluded.last_at), size = excluded.size,
        req = coalesce(nullif(excluded.req, ''), uber_catalog.req), res = coalesce(nullif(excluded.res, ''), uber_catalog.res), by_user = excluded.by_user, updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

CREATE FUNCTION public.uber_demand(p_from timestamp with time zone, p_to timestamp with time zone, p_agency bigint DEFAULT NULL::bigint) RETURNS TABLE(dow integer, hour integer, done integer, rider_cancel integer, driver_cancel integer, other integer, km double precision)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with rules as (select coalesce((select value::jsonb from params where key = 'tzRules' and value ~ '^\s*\['), '[]'::jsonb) r),
  t as (select u.status, u.km, u.requested_at + make_interval(mins => ma_offset_min(u.requested_at, (select r from rules))) lt
          from uber_trips u where u.requested_at >= p_from and u.requested_at < p_to and (p_agency is null or u.agency_id = p_agency))
  select extract(isodow from lt)::int, extract(hour from lt)::int,
         count(*) filter (where lower(status) = 'completed')::int, count(*) filter (where lower(status) = 'rider_cancelled')::int,
         count(*) filter (where lower(status) = 'driver_cancelled')::int, count(*) filter (where lower(status) not in ('completed', 'rider_cancelled', 'driver_cancelled'))::int,
         sum(km) filter (where lower(status) = 'completed')::double precision
    from t group by 1, 2
$$;

CREATE FUNCTION public.uber_live_push(p_rows jsonb, p_device text DEFAULT ''::text, p_url text DEFAULT ''::text, p_diag text DEFAULT ''::text, p_full boolean DEFAULT false) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare v_role text := coalesce((select role from profiles where user_id = auth.uid()), ''); r jsonb; k text; v_key text; v_ag bigint; n integer := 0;
  o uber_live; g record; v_full boolean := coalesce(p_full, false); v_lat double precision; v_lng double precision; v_did text;
begin
  if auth.uid() is null or v_role not in ('admin', 'manager', 'viewer') then raise exception 'Envoi refusé'; end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 500 then raise exception 'Relevé invalide'; end if;
  -- garde-fou (20/11/2026, fausses déconnexions en masse : liste filtrée par la page d'Uber Fleet prise pour la liste entière) : une
  -- « liste complète » qui contient moins de la moitié des chauffeurs lus en ligne dans les 3 dernières minutes (4 au moins) est traitée
  -- comme partielle ; une vraie vague de déconnexions est enregistrée 3 min plus tard, à l'heure de la dernière lecture de chacun.
  if v_full and jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) * 2 < (select count(*) from uber_live u where u.complete and u.status <> 'offline' and u.observed_at > now() - interval '3 minutes')
     and (select count(*) from uber_live u where u.complete and u.status <> 'offline' and u.observed_at > now() - interval '3 minutes') >= 4 then
    v_full := false;
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    k := norm_plate(r->>'plate');
    if length(k) < 4 or coalesce(r->>'status', '') not in ('available', 'to_pickup', 'on_trip', 'offline', 'unknown') then continue; end if;
    select v.key, v.agency_id into v_key, v_ag from vehicles v where norm_plate(v.plate) = k or norm_plate(v.key) = k limit 1;
    -- position GPS donnée par Uber Fleet avec l'état (carte en temps réel) ; chauffeur Uber (identifiant)
    v_lat := case when jsonb_typeof(r->'lat') = 'number' and (r->>'lat')::double precision between -90 and 90 and (r->>'lat')::double precision <> 0 then (r->>'lat')::double precision end;
    v_lng := case when v_lat is not null and jsonb_typeof(r->'lng') = 'number' and (r->>'lng')::double precision between -180 and 180 and (r->>'lng')::double precision <> 0 then (r->>'lng')::double precision end;
    if v_lng is null then v_lat := null; end if;
    v_did := case when lower(coalesce(r->>'driver', '')) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then lower(r->>'driver') end;
    -- historique : nouvel état (ou plaque revue après plus de 5 min) = période fermée, nouvelle période ouverte ;
    -- « gone » (pas affiché pendant l'absence) seulement si la plaque était lue dans une liste complète
    select * into o from uber_live where plate_key = k;
    if o.plate_key is null or o.status <> r->>'status' or o.observed_at < now() - interval '5 minutes' then
      update uber_live_log set ended_at = case when o.observed_at < now() - interval '5 minutes' then o.observed_at else now() end where plate_key = k and ended_at is null;
      if o.plate_key is not null and o.complete and v_full and o.observed_at < now() - interval '5 minutes' then
        insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at, ended_at)
          values (k, o.plate, v_key, v_ag, o.driver_name, 'gone', o.observed_at, now());
      end if;
      insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at, driver_id, lat0, lng0, lat1, lng1)
        values (k, left(r->>'plate', 30), v_key, v_ag, coalesce(nullif(left(r->>'name', 80), ''), o.driver_name), r->>'status', now(), v_did, v_lat, v_lng, v_lat, v_lng);
    elsif v_lat is not null then
      -- période en cours : dernière position (fin de la période) ; première position si elle manquait
      update uber_live_log set lat1 = v_lat, lng1 = v_lng, lat0 = coalesce(lat0, v_lat), lng0 = coalesce(lng0, v_lng), driver_id = coalesce(driver_id, v_did)
       where plate_key = k and ended_at is null;
    end if;
    insert into uber_live (plate_key, plate, vehicle_key, agency_id, driver_name, status, raw, observed_at, status_since, reader, complete, photo_url, perf)
      values (k, left(r->>'plate', 30), v_key, v_ag, nullif(left(r->>'name', 80), ''), r->>'status', left(r->>'raw', 60), now(), now(), auth.uid(), v_full,
        case when coalesce(r->>'photo', '') ~ '^https://[a-z0-9-]+\.cloudfront\.net/' then left(r->>'photo', 1500) end,
        case when jsonb_typeof(r->'perf') = 'object' then (select jsonb_object_agg(e.key, e.value) from jsonb_each(r->'perf') e
          where e.key in ('e', 'cash', 'h', 't', 'a', 'c', 'first', 'last', 'at') and jsonb_typeof(e.value) = 'number') end)
      on conflict (plate_key) do update set plate = excluded.plate, vehicle_key = excluded.vehicle_key, agency_id = excluded.agency_id,
        driver_name = coalesce(excluded.driver_name, uber_live.driver_name), status = excluded.status, raw = excluded.raw, observed_at = excluded.observed_at, reader = excluded.reader,
        complete = excluded.complete, photo_url = coalesce(excluded.photo_url, uber_live.photo_url), perf = coalesce(excluded.perf, uber_live.perf),
        status_since = case when uber_live.status = excluded.status and uber_live.observed_at > now() - interval '5 minutes' then uber_live.status_since else now() end;
    n := n + 1;
  end loop;
  -- liste complète : plaques lues dans une liste complète et plus affichées depuis 2 min = période fermée, « gone » ouverte (déconnecté)
  if v_full then
    for g in select * from uber_live u where u.complete and u.status <> 'offline' and u.observed_at < now() - interval '2 minutes' and u.observed_at > now() - interval '1 day'
        and exists (select 1 from uber_live_log l where l.plate_key = u.plate_key and l.ended_at is null and l.status <> 'gone') loop
      update uber_live_log set ended_at = g.observed_at where plate_key = g.plate_key and ended_at is null;
      insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at)
        values (g.plate_key, g.plate, g.vehicle_key, g.agency_id, g.driver_name, 'gone', g.observed_at);
    end loop;
  end if;
  insert into uber_live_readers (user_id, device, at, rows, url, diag, complete) values (auth.uid(), left(coalesce(p_device, ''), 80), now(), n, left(p_url, 200), left(p_diag, 20000), v_full)
    on conflict (user_id, device) do update set at = now(), rows = excluded.rows, url = excluded.url, diag = excluded.diag, complete = excluded.complete;
  delete from uber_live where observed_at < now() - interval '3 days';
  if random() < 0.01 then delete from uber_live_log where started_at < now() - interval '180 days'; end if;
  return n;
end $_$;

CREATE FUNCTION public.uber_perf_push(p_period text, p_from timestamp with time zone, p_items jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare v_role text := coalesce((select role from profiles where user_id = auth.uid()), ''); it jsonb; k text; d text; v_key text; v_ag bigint; v_plate text; n integer := 0;
  v_ckey text; v_cag bigint; v_cplate text;
begin
  if auth.uid() is null or v_role not in ('admin', 'manager', 'viewer') then raise exception 'Envoi refusé'; end if;
  if coalesce(p_period, '') !~ '^(shift|cmp):\d{4}-\d{2}-\d{2}:(Jour|Nuit)$' and coalesce(p_period, '') !~ '^(ctr|ctrj1):[A-Za-z0-9_.-]{1,40}$' then raise exception 'Période invalide'; end if;
  -- contrat : véhicule et agence du contrat Ludy (droits de lecture par agence), début du contrat
  if p_period ~ '^(ctr|ctrj1):' then
    select c.vehicle_key, v.agency_id, c.plate into v_ckey, v_cag, v_cplate from contracts c left join vehicles v on v.key = c.vehicle_key where c.num = split_part(p_period, ':', 2);
    if v_ckey is null then raise exception 'Contrat inconnu'; end if;
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 200 then raise exception 'Envoi invalide'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    d := lower(coalesce(it->>'d', ''));
    if d !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then continue; end if;
    -- véhicule de Ludy : plaque lue dans Uber Fleet (chiffres puis lettres) ; plaque écrite sans lettres = seul véhicule aux mêmes chiffres
    v_plate := nullif(left(it->>'p', 30), ''); k := norm_plate(v_plate); v_key := null; v_ag := null;
    if length(k) >= 4 then
      select v.key, v.agency_id into v_key, v_ag from vehicles v where norm_plate(v.plate) = k or norm_plate(v.key) = k limit 1;
      if v_key is null and k ~ '^\d{5,6}$' and (select count(*) from vehicles v where regexp_replace(v.plate, '\D', '', 'g') = k) = 1 then
        select v.key, v.agency_id, v.plate into v_key, v_ag, v_plate from vehicles v where regexp_replace(v.plate, '\D', '', 'g') = k;
      end if;
    end if;
    if v_ckey is not null then v_key := v_ckey; v_ag := v_cag; v_plate := coalesce(v_cplate, v_plate); end if;
    -- un contrat = un seul compte Uber : la ligne d'un autre compte pour ce contrat est remplacée
    if v_ckey is not null then delete from uber_perf where period = p_period and driver_id <> d
      and coalesce((data->>'to')::numeric, 0) <= coalesce((it->>'to')::numeric, 0); end if;
    insert into uber_perf (driver_id, period, period_from, driver_name, plate, vehicle_key, agency_id, data, updated_at)
      values (d, p_period, p_from, nullif(left(it->>'n', 80), ''), v_plate, v_key, v_ag,
        coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(it) e
          where e.key in ('e', 'cash', 'h', 't', 'a', 'c', 'hot', 'hto', 'hav', 'first', 'last', 'to', 'f') and jsonb_typeof(e.value) = 'number'), '{}'::jsonb), now())
      on conflict (driver_id, period) do update set period_from = excluded.period_from, driver_name = coalesce(excluded.driver_name, uber_perf.driver_name),
        plate = coalesce(excluded.plate, uber_perf.plate), vehicle_key = coalesce(excluded.vehicle_key, uber_perf.vehicle_key),
        agency_id = coalesce(excluded.agency_id, uber_perf.agency_id), data = excluded.data, updated_at = now()
      -- jamais en arrière : un lecteur en retard (liste figée, deux ordinateurs) n'écrase pas une période lue plus loin
      where coalesce((excluded.data->>'to')::numeric, 0) >= coalesce((uber_perf.data->>'to')::numeric, 0);
    n := n + 1;
  end loop;
  if random() < 0.02 then delete from uber_perf where updated_at < now() - interval '62 days'; end if;
  return n;
end $_$;

CREATE FUNCTION public.uber_suspect_set(p_id bigint, p_status text, p_comment text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare s uber_suspects;
begin
  if coalesce(public.my_role(), '') not in ('admin', 'manager') then raise exception 'Accès refusé'; end if;
  if p_status not in ('À vérifier', 'Justifié', 'Confirmé') then raise exception 'Statut inconnu'; end if;
  select * into s from uber_suspects where id = p_id;
  if s.id is null then raise exception 'Cas inconnu'; end if;
  if not public.is_admin() and not (s.vehicle_key = any((select public.my_vehicle_keys())::text[]) or s.agency_id = any((select public.my_agency_ids())::bigint[])) then raise exception 'Accès refusé'; end if;
  update uber_suspects set status = p_status, comment = left(p_comment, 500), checked_by = auth.uid(), checked_at = now(), updated_at = now() where id = p_id;
end $$;

CREATE FUNCTION public.uber_suspect_trg() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare p uber_live_log; v_min integer; v_win integer;
begin
  if new.status not in ('available', 'offline', 'gone') then return null; end if;
  select * into p from uber_live_log l where l.plate_key = new.plate_key and l.status = 'to_pickup' and l.id <> new.id and l.ended_at is not null
    and l.ended_at between new.started_at - interval '3 minutes' and new.started_at + interval '1 second' order by l.ended_at desc, l.id desc limit 1;
  if p.id is null then return null; end if;
  if p.ended_at - p.started_at < interval '10 seconds' then return null; end if;   -- clignotement de l'écran
  if new.status = 'gone' and (select count(distinct plate_key) from uber_live_log g where g.status = 'gone'
      and g.started_at between new.started_at - interval '30 seconds' and new.started_at + interval '30 seconds') >= 3 then return null; end if;
  v_min := coalesce((select value::integer from params where key = 'suspectMinS' and value ~ '^[0-9]+$'), 60);
  v_win := coalesce((select value::integer from params where key = 'suspectWinMin' and value ~ '^[0-9]+$'), 20);
  insert into uber_suspects (log_id, plate_key, plate, vehicle_key, agency_id, driver_id, driver_name, route_from, route_to, lat, lng, next_status, next_at, level, win_until)
    values (p.id, p.plate_key, coalesce(new.plate, p.plate), coalesce(new.vehicle_key, p.vehicle_key), coalesce(new.agency_id, p.agency_id), coalesce(p.driver_id, new.driver_id),
      coalesce(new.driver_name, p.driver_name), p.started_at, p.ended_at, p.lat1, p.lng1, new.status, new.started_at,
      case when p.ended_at - p.started_at >= make_interval(secs => v_min) then 'Suspect' else 'Info' end, new.started_at + make_interval(mins => v_win))
    on conflict (log_id) do nothing;
  return null;
end $_$;

CREATE FUNCTION public.uber_zones(p_from timestamp with time zone, p_to timestamp with time zone, p_agency bigint DEFAULT NULL::bigint, p_cell numeric DEFAULT 0.005) RETURNS TABLE(kind text, cy integer, cx integer, dow integer, hour integer, n integer, v double precision)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with rules as (select coalesce((select value::jsonb from params where key = 'tzRules' and value ~ '^\s*\['), '[]'::jsonb) r),
  cell as (select greatest(least(coalesce(p_cell, 0.005), 0.05), 0.001)::double precision c),
  l as (
    select u.*, lead(u.status) over w as nst, lead(u.started_at) over w as nat, lag(u.status) over w as pst
      from uber_live_log u
     where u.started_at >= p_from - interval '6 hours' and u.started_at < p_to and (p_agency is null or u.agency_id = p_agency)
    window w as (partition by u.plate_key order by u.started_at)
  ),
  ev as (
    -- prise en charge : début d'une période « Course en cours » (après un autre état), valeur = durée de la course en minutes
    select 'pickup'::text k, l.lat0 la, l.lng0 lo, l.started_at t,
           case when l.ended_at is not null and l.nst is distinct from 'gone' then extract(epoch from l.ended_at - l.started_at) / 60 end val
      from l where l.status = 'on_trip' and l.pst is distinct from 'on_trip' and l.lat0 is not null
    union all
    -- dépose : fin d'une période « Course en cours » suivie d'un autre état lu (pas une perte de lecture)
    select 'dropoff', l.lat1, l.lng1, l.ended_at, null from l where l.status = 'on_trip' and l.ended_at is not null and l.nst in ('available', 'to_pickup', 'offline') and l.lat1 is not null
    union all
    -- attente : « Disponible » terminé par une demande dans les 2 min, valeur = minutes d'attente (lieu = début de l'attente)
    select 'wait', l.lat0, l.lng0, l.started_at, extract(epoch from l.ended_at - l.started_at) / 60
      from l where l.status = 'available' and l.ended_at is not null and l.nst in ('to_pickup', 'on_trip') and l.nat - l.ended_at < interval '2 minutes' and l.lat0 is not null
    union all
    -- disponible sans demande : « Disponible » terminé par une déconnexion (valeur = minutes)
    select 'idle', l.lat0, l.lng0, l.started_at, extract(epoch from l.ended_at - l.started_at) / 60
      from l where l.status = 'available' and l.ended_at is not null and l.nst in ('offline', 'gone') and l.lat0 is not null
    union all
    -- approche : « En route vers le client » suivi de « Course en cours », valeur = km à vol d'oiseau (lieu = où la demande est reçue)
    select 'approach', l.lat0, l.lng0, l.started_at,
           2 * 6371 * asin(sqrt(power(sin(radians(l.lat1 - l.lat0) / 2), 2) + cos(radians(l.lat0)) * cos(radians(l.lat1)) * power(sin(radians(l.lng1 - l.lng0) / 2), 2)))
      from l where l.status = 'to_pickup' and l.nst = 'on_trip' and l.lat0 is not null and l.lat1 is not null
  ),
  loc as (select ev.*, ev.t + make_interval(mins => ma_offset_min(ev.t, (select r from rules))) lt from ev where ev.t >= p_from and ev.t < p_to)
  select loc.k, floor(loc.la / (select c from cell))::int, floor(loc.lo / (select c from cell))::int, extract(isodow from loc.lt)::int, extract(hour from loc.lt)::int,
         count(*)::int, sum(loc.val)::double precision
    from loc group by 1, 2, 3, 4, 5
$$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.bolt_sessions (
    key text NOT NULL,
    at timestamp with time zone NOT NULL,
    driver_name text,
    vehicle text,
    plate text,
    vehicle_key text,
    minutes numeric(10,2),
    online_min numeric(10,2),
    pause_min numeric(10,2),
    span text,
    trips integer DEFAULT 0 NOT NULL,
    done integer DEFAULT 0 NOT NULL,
    cancel_pax integer DEFAULT 0 NOT NULL,
    cancel_drv integer DEFAULT 0 NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    cash numeric(12,2) DEFAULT 0 NOT NULL,
    terminal numeric(12,2) DEFAULT 0 NOT NULL,
    app numeric(12,2) DEFAULT 0 NOT NULL,
    business numeric(12,2) DEFAULT 0 NOT NULL,
    raw jsonb,
    agency_id bigint,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    imported_by uuid DEFAULT auth.uid()
);

CREATE TABLE public.cash_files (
    id bigint NOT NULL,
    agency_id bigint,
    kind text NOT NULL,
    move_id bigint,
    dep_ref text,
    day date,
    category text,
    title text,
    path text NOT NULL,
    file_name text,
    drive_id text,
    drive_error text,
    drive_at timestamp with time zone,
    created_by uuid DEFAULT auth.uid(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_files_check CHECK ((((kind = 'justif'::text) AND (move_id IS NOT NULL)) OR ((kind = 'depot'::text) AND (dep_ref IS NOT NULL)))),
    CONSTRAINT cash_files_kind_check CHECK ((kind = ANY (ARRAY['justif'::text, 'depot'::text])))
);

CREATE SEQUENCE public.cash_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cash_files_id_seq OWNED BY public.cash_files.id;

CREATE TABLE public.cash_log (
    id bigint NOT NULL,
    move_id bigint,
    at timestamp with time zone DEFAULT now() NOT NULL,
    by uuid,
    op text,
    old jsonb,
    new jsonb
);

CREATE SEQUENCE public.cash_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cash_log_id_seq OWNED BY public.cash_log.id;

CREATE TABLE public.cash_moves (
    id bigint NOT NULL,
    caisse text NOT NULL,
    kind text NOT NULL,
    flow text NOT NULL,
    amount numeric(12,2) NOT NULL,
    day date NOT NULL,
    shift text,
    driver_code text,
    driver_name text,
    uber_uuid text,
    contract_num text,
    vehicle_key text,
    mission_id bigint,
    agency_id bigint,
    label text,
    ride_type text,
    source text,
    justif text,
    uber_cash numeric(12,2),
    given numeric(12,2),
    change numeric(12,2),
    course_amount numeric(12,2),
    commission_pct numeric(6,2),
    prime numeric(12,2),
    prime_paid numeric(12,2),
    status text,
    signed boolean,
    comment text,
    manager_name text,
    import_key text,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid DEFAULT auth.uid(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    promo numeric(12,2),
    promo_status text,
    CONSTRAINT cash_moves_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT cash_moves_caisse_check CHECK ((caisse = ANY (ARRAY['uber'::text, 'bolt'::text, 'depenses'::text, 'rh'::text, 'courses'::text, 'bonus'::text]))),
    CONSTRAINT cash_moves_flow_check CHECK ((flow = ANY (ARRAY['in'::text, 'out'::text, 'virement'::text]))),
    CONSTRAINT cash_moves_justif_check CHECK ((justif = ANY (ARRAY['OK'::text, 'KO'::text, 'N.A'::text, 'En attente'::text]))),
    CONSTRAINT cash_moves_kind_check CHECK ((kind = ANY (ARRAY['encaissement'::text, 'depense'::text, 'avance'::text, 'remboursement'::text, 'course'::text, 'bonus'::text, 'recharge'::text, 'depot'::text, 'autre'::text]))),
    CONSTRAINT cash_moves_promo_check CHECK (((promo IS NULL) OR (promo >= (0)::numeric))),
    CONSTRAINT cash_moves_promo_status_check CHECK (((promo_status IS NULL) OR (promo_status = ANY (ARRAY['À vérifier'::text, 'Payée'::text, 'Non payée'::text])))),
    CONSTRAINT cash_moves_shift_check CHECK ((shift = ANY (ARRAY['Jour'::text, 'Nuit'::text])))
);

CREATE SEQUENCE public.cash_moves_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cash_moves_id_seq OWNED BY public.cash_moves.id;

CREATE TABLE public.cash_sheets (
    id bigint NOT NULL,
    agency_id bigint,
    day date NOT NULL,
    shift text NOT NULL,
    path text NOT NULL,
    file_name text,
    note text,
    created_by uuid DEFAULT auth.uid(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_sheets_shift_check CHECK ((shift = ANY (ARRAY['Jour'::text, 'Nuit'::text])))
);

CREATE SEQUENCE public.cash_sheets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cash_sheets_id_seq OWNED BY public.cash_sheets.id;

CREATE TABLE public.uber_catalog (
    k text NOT NULL,
    url text,
    op text,
    method text,
    n integer DEFAULT 0 NOT NULL,
    first_at timestamp with time zone,
    last_at timestamp with time zone,
    size integer,
    req text,
    res text,
    by_user uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.uber_days (
    vehicle_key text NOT NULL,
    day date NOT NULL,
    agency_id bigint,
    win_from timestamp with time zone,
    win_to timestamp with time zone,
    km_uber numeric,
    km_off numeric,
    n_gps integer,
    segs jsonb DEFAULT '[]'::jsonb NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    computed_by uuid
);

CREATE TABLE public.uber_drivers (
    uuid text NOT NULL,
    name text,
    phone text,
    email text,
    status text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    agency_id bigint
);

CREATE TABLE public.uber_live (
    plate_key text NOT NULL,
    plate text NOT NULL,
    vehicle_key text,
    agency_id bigint,
    driver_name text,
    status text NOT NULL,
    raw text,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    status_since timestamp with time zone DEFAULT now() NOT NULL,
    reader uuid,
    complete boolean DEFAULT false NOT NULL,
    photo_url text,
    perf jsonb,
    CONSTRAINT uber_live_status_check CHECK ((status = ANY (ARRAY['available'::text, 'to_pickup'::text, 'on_trip'::text, 'offline'::text, 'unknown'::text])))
);

CREATE TABLE public.uber_live_log (
    id bigint NOT NULL,
    plate_key text NOT NULL,
    plate text,
    vehicle_key text,
    agency_id bigint,
    driver_name text,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    driver_id text,
    lat0 double precision,
    lng0 double precision,
    lat1 double precision,
    lng1 double precision,
    CONSTRAINT uber_live_log_status_check CHECK ((status = ANY (ARRAY['available'::text, 'to_pickup'::text, 'on_trip'::text, 'offline'::text, 'unknown'::text, 'gone'::text])))
);

CREATE SEQUENCE public.uber_live_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.uber_live_log_id_seq OWNED BY public.uber_live_log.id;

CREATE TABLE public.uber_live_readers (
    user_id uuid NOT NULL,
    device text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    rows integer DEFAULT 0 NOT NULL,
    url text,
    diag text,
    complete boolean DEFAULT false NOT NULL
);

CREATE TABLE public.uber_payments (
    tx text NOT NULL,
    at timestamp with time zone NOT NULL,
    driver_uuid text,
    driver_name text,
    trip text,
    description text,
    cash numeric(12,2) DEFAULT 0 NOT NULL,
    revenue numeric(12,2) DEFAULT 0 NOT NULL,
    payout numeric(12,2) DEFAULT 0 NOT NULL,
    fare numeric(12,2) DEFAULT 0 NOT NULL,
    tip numeric(12,2) DEFAULT 0 NOT NULL,
    toll numeric(12,2) DEFAULT 0 NOT NULL,
    bonus numeric(12,2) DEFAULT 0 NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    first_name text,
    last_name text,
    raw jsonb,
    agency_id bigint
);

CREATE TABLE public.uber_perf (
    driver_id text NOT NULL,
    period text NOT NULL,
    period_from timestamp with time zone,
    driver_name text,
    plate text,
    vehicle_key text,
    agency_id bigint,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.uber_suspects (
    id bigint NOT NULL,
    log_id bigint,
    plate_key text NOT NULL,
    plate text,
    vehicle_key text,
    agency_id bigint,
    driver_id text,
    driver_name text,
    route_from timestamp with time zone NOT NULL,
    route_to timestamp with time zone NOT NULL,
    lat double precision,
    lng double precision,
    next_status text NOT NULL,
    next_at timestamp with time zone NOT NULL,
    level text DEFAULT 'Suspect'::text NOT NULL,
    win_until timestamp with time zone NOT NULL,
    km_after numeric,
    km_free numeric,
    moved_m integer,
    km_done boolean DEFAULT false NOT NULL,
    km_note text,
    verdict text,
    status text DEFAULT 'À vérifier'::text NOT NULL,
    comment text,
    checked_by uuid,
    checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cx_status text,
    CONSTRAINT uber_suspects_cx_status_check CHECK (((cx_status IS NULL) OR (cx_status = ANY (ARRAY['client'::text, 'chauffeur'::text])))),
    CONSTRAINT uber_suspects_level_check CHECK ((level = ANY (ARRAY['Suspect'::text, 'Info'::text]))),
    CONSTRAINT uber_suspects_status_check CHECK ((status = ANY (ARRAY['À vérifier'::text, 'Justifié'::text, 'Confirmé'::text]))),
    CONSTRAINT uber_suspects_verdict_check CHECK (((verdict IS NULL) OR (verdict = ANY (ARRAY['roulé'::text, 'sur place'::text, 'non mesuré'::text, 'course réalisée'::text]))))
);

ALTER TABLE public.uber_suspects ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.uber_suspects_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.uber_trips (
    uuid text NOT NULL,
    agency_id bigint,
    driver_uuid text,
    driver_name text,
    vehicle_uuid text,
    plate text,
    vehicle_key text,
    service text,
    product text,
    payment text,
    requested_at timestamp with time zone NOT NULL,
    dropoff_at timestamp with time zone,
    pickup_addr text,
    drop_addr text,
    km numeric,
    status text NOT NULL,
    pu_lat double precision,
    pu_lon double precision,
    pu_prec text,
    chk jsonb,
    chk_at timestamp with time zone,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    imported_by uuid
);

ALTER TABLE ONLY public.cash_files ALTER COLUMN id SET DEFAULT nextval('public.cash_files_id_seq'::regclass);

ALTER TABLE ONLY public.cash_log ALTER COLUMN id SET DEFAULT nextval('public.cash_log_id_seq'::regclass);

ALTER TABLE ONLY public.cash_moves ALTER COLUMN id SET DEFAULT nextval('public.cash_moves_id_seq'::regclass);

ALTER TABLE ONLY public.cash_sheets ALTER COLUMN id SET DEFAULT nextval('public.cash_sheets_id_seq'::regclass);

ALTER TABLE ONLY public.uber_live_log ALTER COLUMN id SET DEFAULT nextval('public.uber_live_log_id_seq'::regclass);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.bolt_sessions
    ADD CONSTRAINT bolt_sessions_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.cash_files
    ADD CONSTRAINT cash_files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cash_log
    ADD CONSTRAINT cash_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cash_moves
    ADD CONSTRAINT cash_moves_import_key_key UNIQUE (import_key);

ALTER TABLE ONLY public.cash_moves
    ADD CONSTRAINT cash_moves_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cash_sheets
    ADD CONSTRAINT cash_sheets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.uber_catalog
    ADD CONSTRAINT uber_catalog_pkey PRIMARY KEY (k);

ALTER TABLE ONLY public.uber_days
    ADD CONSTRAINT uber_days_pkey PRIMARY KEY (vehicle_key, day);

ALTER TABLE ONLY public.uber_drivers
    ADD CONSTRAINT uber_drivers_pkey PRIMARY KEY (uuid);

ALTER TABLE ONLY public.uber_live_log
    ADD CONSTRAINT uber_live_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.uber_live
    ADD CONSTRAINT uber_live_pkey PRIMARY KEY (plate_key);

ALTER TABLE ONLY public.uber_live_readers
    ADD CONSTRAINT uber_live_readers_pkey PRIMARY KEY (user_id, device);

ALTER TABLE ONLY public.uber_payments
    ADD CONSTRAINT uber_payments_pkey PRIMARY KEY (tx);

ALTER TABLE ONLY public.uber_perf
    ADD CONSTRAINT uber_perf_pkey PRIMARY KEY (driver_id, period);

ALTER TABLE ONLY public.uber_suspects
    ADD CONSTRAINT uber_suspects_log_id_key UNIQUE (log_id);

ALTER TABLE ONLY public.uber_suspects
    ADD CONSTRAINT uber_suspects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.uber_trips
    ADD CONSTRAINT uber_trips_pkey PRIMARY KEY (uuid);

CREATE INDEX bolt_sessions_agency ON public.bolt_sessions USING btree (agency_id, at);

CREATE INDEX bolt_sessions_at ON public.bolt_sessions USING btree (at);

CREATE INDEX cash_files_agency ON public.cash_files USING btree (agency_id);

CREATE INDEX cash_files_drive ON public.cash_files USING btree (id) WHERE (drive_id IS NULL);

CREATE INDEX cash_files_move ON public.cash_files USING btree (move_id) WHERE (move_id IS NOT NULL);

CREATE INDEX cash_files_ref ON public.cash_files USING btree (agency_id, dep_ref) WHERE (dep_ref IS NOT NULL);

CREATE INDEX cash_log_move ON public.cash_log USING btree (move_id);

CREATE INDEX cash_moves_agency ON public.cash_moves USING btree (agency_id, day);

CREATE INDEX cash_moves_day ON public.cash_moves USING btree (day);

CREATE INDEX cash_moves_driver ON public.cash_moves USING btree (driver_code, day);

CREATE INDEX cash_moves_mission ON public.cash_moves USING btree (mission_id) WHERE (mission_id IS NOT NULL);

CREATE INDEX cash_sheets_shift ON public.cash_sheets USING btree (agency_id, day, shift);

CREATE INDEX uber_days_day ON public.uber_days USING btree (day);

CREATE INDEX uber_live_log_open ON public.uber_live_log USING btree (plate_key) WHERE (ended_at IS NULL);

CREATE INDEX uber_live_log_time ON public.uber_live_log USING btree (started_at);

CREATE INDEX uber_live_log_veh ON public.uber_live_log USING btree (vehicle_key, started_at);

CREATE INDEX uber_live_obs ON public.uber_live USING btree (observed_at);

CREATE INDEX uber_live_veh ON public.uber_live USING btree (vehicle_key);

CREATE INDEX uber_payments_agency ON public.uber_payments USING btree (agency_id, at);

CREATE INDEX uber_payments_at ON public.uber_payments USING btree (at);

CREATE INDEX uber_payments_driver ON public.uber_payments USING btree (driver_uuid, at);

CREATE INDEX uber_perf_period ON public.uber_perf USING btree (period);

CREATE INDEX uber_suspects_at ON public.uber_suspects USING btree (next_at DESC);

CREATE INDEX uber_suspects_todo ON public.uber_suspects USING btree (km_done, next_at) WHERE (NOT km_done);

CREATE INDEX uber_suspects_veh ON public.uber_suspects USING btree (vehicle_key, next_at DESC);

CREATE INDEX uber_trips_at ON public.uber_trips USING btree (requested_at);

CREATE INDEX uber_trips_drv ON public.uber_trips USING btree (driver_uuid, requested_at);

CREATE INDEX uber_trips_veh ON public.uber_trips USING btree (vehicle_key, requested_at);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER bolt_sessions_agency BEFORE INSERT ON public.bolt_sessions FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();

CREATE TRIGGER cash_moves_agency BEFORE INSERT ON public.cash_moves FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();

CREATE TRIGGER cash_moves_guard BEFORE INSERT OR UPDATE ON public.cash_moves FOR EACH ROW EXECUTE FUNCTION public.cash_guard();

CREATE TRIGGER cash_moves_log AFTER INSERT OR DELETE OR UPDATE ON public.cash_moves FOR EACH ROW EXECUTE FUNCTION public.cash_log_trg();

CREATE TRIGGER uber_drivers_agency BEFORE INSERT ON public.uber_drivers FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();

CREATE TRIGGER uber_payments_agency BEFORE INSERT ON public.uber_payments FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();

CREATE CONSTRAINT TRIGGER uber_suspect_trg AFTER INSERT ON public.uber_live_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.uber_suspect_trg();
