-- =============================================================================
-- Réservation client par QR code (23/11/2026, demande d'Ahmed) : un QR dans les voitures renvoie vers une page publique de
-- réservation (site/reserver.html). Le client saisit départ / destination ; le prix est estimé « façon Uber » à partir de la
-- distance et de la durée réelles (OSRM, calculées dans le navigateur) et d'un tarif réglable (prise en charge + MAD/km + MAD/min),
-- majoré de resvMarkupPct % (10 par défaut). Prix INDICATIF : la demande arrive dans Courses privées en « Demande », le gestionnaire
-- confirme le prix final. Aucun prix Uber en direct n'est récupérable (API publique fermée) : le tarif est calculé par Ludy.
-- Accès public (rôle anon) limité à deux fonctions : reservation_tariff (lecture du tarif + véhicule/agence) et create_reservation
-- (insertion d'une demande, SECURITY DEFINER, champs bornés). Aucune autre table n'est ouverte à anon.
-- À exécuter dans Supabase > SQL Editor après 20261217000000_suspects_annulation.sql. Rejouable.
-- =============================================================================

insert into public.params (key, label, value, note, sort) values
  ('resvEnabled', 'Réservation QR : activée', 'oui', 'Page publique de réservation par QR code (oui / non). Non = la page affiche « réservations fermées ».', 300),
  ('resvBase', 'Réservation QR : prise en charge (MAD)', '7', 'Montant fixe de départ, façon Uber.', 301),
  ('resvPerKm', 'Réservation QR : prix par km (MAD)', '3', 'Tarif par kilomètre (distance routière OSRM).', 302),
  ('resvPerMin', 'Réservation QR : prix par minute (MAD)', '0.6', 'Tarif par minute (durée routière OSRM).', 303),
  ('resvMinFare', 'Réservation QR : course minimum (MAD)', '20', 'Prix plancher avant majoration.', 304),
  ('resvMarkupPct', 'Réservation QR : majoration (%)', '10', 'Majoration appliquée au tarif (demande d''Ahmed : +10 %).', 305),
  ('resvNightPct', 'Réservation QR : majoration de nuit (%)', '15', 'Majoration si la prise en charge est de nuit (0 = pas de majoration de nuit).', 306),
  ('resvNightFrom', 'Réservation QR : début de nuit (heure)', '22', 'Heure de début de la plage de nuit.', 307),
  ('resvNightTo', 'Réservation QR : fin de nuit (heure)', '6', 'Heure de fin de la plage de nuit.', 308),
  ('resvNote', 'Réservation QR : message au client', 'Estimation indicative, confirmée par notre agence. Nous vous rappelons pour finaliser votre réservation.', 'Texte affiché sous le prix sur la page publique.', 309)
on conflict (key) do update set label = excluded.label, note = excluded.note, sort = excluded.sort;

-- Tarif + véhicule / agence du QR, lisible publiquement (anon). Ne renvoie que ce qui est nécessaire à la page de réservation.
create or replace function public.reservation_tariff(v text default null) returns jsonb language sql stable security definer set search_path = public as $$
  with p as (select key, value from public.params where key like 'resv%'),
  veh as (select key, plate, model, agency_id from public.vehicles
    where v is not null and (key = v or upper(regexp_replace(plate, '\s', '', 'g')) = upper(regexp_replace(v, '\s', '', 'g'))) limit 1),
  drv as (select c.name, c.num from public.contracts c join veh on c.vehicle_key = veh.key
    where c.start_at <= now() and (c.end_at is null or c.end_at >= now()) order by c.start_at desc limit 1)
  select jsonb_build_object(
    'enabled', lower(coalesce((select value from p where key = 'resvEnabled'), 'oui')) in ('oui', 'true', '1'),
    'note', (select value from p where key = 'resvNote'),
    'base', coalesce((select value from p where key = 'resvBase')::numeric, 0),
    'perKm', coalesce((select value from p where key = 'resvPerKm')::numeric, 0),
    'perMin', coalesce((select value from p where key = 'resvPerMin')::numeric, 0),
    'minFare', coalesce((select value from p where key = 'resvMinFare')::numeric, 0),
    'markupPct', coalesce((select value from p where key = 'resvMarkupPct')::numeric, 0),
    'nightPct', coalesce((select value from p where key = 'resvNightPct')::numeric, 0),
    'nightFrom', coalesce((select value from p where key = 'resvNightFrom')::numeric, 22),
    'nightTo', coalesce((select value from p where key = 'resvNightTo')::numeric, 6),
    'vehicle', (select jsonb_build_object('key', key, 'plate', plate, 'model', model) from veh),
    'agency', (select a.name from public.agencies a join veh on veh.agency_id = a.id),
    'driver', (select name from drv), 'contract', (select num from drv));   -- chauffeur présent dans la voiture en ce moment (contrat en cours)
$$;
revoke execute on function public.reservation_tariff(text) from public;
grant execute on function public.reservation_tariff(text) to anon, authenticated;

-- Demande de réservation publique : insère une mission « Demande » (prix indicatif recalculé côté base), champs bornés. SECURITY DEFINER.
create or replace function public.create_reservation(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_enabled boolean; vk text; v_ag bigint; km numeric; mn numeric; hour int; night boolean;
  base numeric; perkm numeric; permin numeric; minfare numeric; markup numeric; nightpct numeric; nfrom numeric; nto numeric;
  raw numeric; total numeric; m_id bigint; m_num text; f jsonb; nm text; ph text; v_plate text; v_drv text; v_ctr text;
begin
  select lower(coalesce(value, 'oui')) in ('oui', 'true', '1') into v_enabled from params where key = 'resvEnabled';
  if not coalesce(v_enabled, true) then raise exception 'réservations fermées'; end if;
  nm := btrim(left(coalesce(p->>'client', ''), 120)); ph := btrim(left(coalesce(p->>'phone', ''), 40));
  if nm = '' or ph = '' then raise exception 'nom et téléphone obligatoires'; end if;
  if coalesce(p->>'destLabel', '') = '' then raise exception 'destination obligatoire'; end if;
  km := greatest(0, coalesce((p->>'km')::numeric, 0)); mn := greatest(0, coalesce((p->>'min')::numeric, 0));
  vk := nullif(left(coalesce(p->>'v', ''), 40), '');
  select agency_id, plate, key into v_ag, v_plate, vk from vehicles where vk is not null and (key = vk or upper(regexp_replace(plate, '\s', '', 'g')) = upper(regexp_replace(vk, '\s', '', 'g'))) limit 1;
  -- chauffeur présent dans la voiture au moment de la demande (contrat en cours)
  select name, num into v_drv, v_ctr from contracts where vk is not null and vehicle_key = vk and start_at <= now() and (end_at is null or end_at >= now()) order by start_at desc limit 1;
  -- tarif
  select value::numeric into base from params where key = 'resvBase';
  select value::numeric into perkm from params where key = 'resvPerKm';
  select value::numeric into permin from params where key = 'resvPerMin';
  select value::numeric into minfare from params where key = 'resvMinFare';
  select value::numeric into markup from params where key = 'resvMarkupPct';
  select value::numeric into nightpct from params where key = 'resvNightPct';
  select value::numeric into nfrom from params where key = 'resvNightFrom';
  select value::numeric into nto from params where key = 'resvNightTo';
  hour := coalesce((p->>'hour')::int, extract(hour from coalesce((p->>'when')::timestamptz, now()) at time zone 'Africa/Casablanca')::int);
  night := coalesce(nightpct, 0) > 0 and (case when coalesce(nfrom, 22) <= coalesce(nto, 6) then hour >= nfrom and hour < nto else hour >= nfrom or hour < nto end);
  raw := coalesce(base, 0) + coalesce(perkm, 0) * km + coalesce(permin, 0) * mn;
  if raw < coalesce(minfare, 0) then raw := coalesce(minfare, 0); end if;
  if night then raw := raw * (1 + coalesce(nightpct, 0) / 100); end if;
  raw := raw * (1 + coalesce(markup, 0) / 100);
  total := round(raw / 5) * 5;
  f := jsonb_build_object(
    'source', 'qr', 'origin', left(coalesce(p->>'originLabel', ''), 250), 'dest', left(coalesce(p->>'destLabel', ''), 250),
    'originLat', (p->>'originLat')::numeric, 'originLon', (p->>'originLon')::numeric, 'destLat', (p->>'destLat')::numeric, 'destLon', (p->>'destLon')::numeric,
    'distanceKm', km, 'durationMin', mn, 'night', night, 'estimate', total, 'pax', least(99, greatest(0, coalesce((p->>'pax')::int, 0))),
    'clientNote', left(coalesce(p->>'note', ''), 500), 'vehicle', vk, 'plate', v_plate, 'driverNow', v_drv, 'contractNow', v_ctr);
  insert into missions (status, agency_id, client_name, client_phone, client_email, kind, start_at, needs_validation, total_ttc,
      data, created_by)
    values ('Demande', v_ag, nm, ph, nullif(left(coalesce(p->>'email', ''), 120), ''), 'Réservation (QR)',
      (p->>'when')::timestamptz, true, total,
      jsonb_build_object('f', f, 'reservation', true, 'history', jsonb_build_array(jsonb_build_object('at', now(), 'status', 'Demande', 'by', 'réservation QR'))), null)
    returning id, number into m_id, m_num;
  return jsonb_build_object('ok', true, 'number', m_num, 'estimate', total);
end $$;
revoke execute on function public.create_reservation(jsonb) from public;
grant execute on function public.create_reservation(jsonb) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Avis et réclamations clients (23/11/2026, demande d'Ahmed) : le même QR propose aussi de noter la course en cours (étoiles),
-- écrire un message et joindre une photo, dans la langue du client (ar, fr, it, de, en, es, pt). L'avis est rattaché à la plaque
-- et au chauffeur présent dans la voiture à ce moment (contrat en cours). Le message est traduit en français par le collecteur
-- (LanguageApp). Volet « Avis clients » du site : gestionnaire = ses agences, administrateur = tout.
-- -----------------------------------------------------------------------------
create table if not exists public.client_feedback (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  vehicle_key text, plate text, driver_name text, contract_num text, agency_id bigint,
  rating int check (rating between 0 and 5),      -- étoiles (0 = non noté)
  lang text,                                      -- langue d'origine du message
  comment text,                                   -- message du client (langue d'origine)
  comment_fr text,                                -- traduction française (écrite par le collecteur)
  photo text,                                     -- photo jointe (data URL, redimensionnée côté client)
  status text not null default 'Nouveau' check (status in ('Nouveau', 'Traité')),
  handled_by uuid, handled_at timestamptz
);
create index if not exists client_feedback_at on public.client_feedback(created_at desc);
create index if not exists client_feedback_ag on public.client_feedback(agency_id, created_at desc);
create index if not exists client_feedback_todo on public.client_feedback(status) where status = 'Nouveau';
create index if not exists client_feedback_tr on public.client_feedback(id) where comment is not null and comment_fr is null;

alter table public.client_feedback enable row level security;
revoke all on public.client_feedback from anon, authenticated;
grant select on public.client_feedback to authenticated;
grant all on public.client_feedback to service_role;
drop policy if exists cf_read on public.client_feedback;
create policy cf_read on public.client_feedback for select to authenticated
  using ((select public.is_admin()) or agency_id = any((select public.my_agency_ids())::bigint[]) or ((select public.my_role()) = 'manager' and agency_id is null));

-- Avis public (anon) : rattache plaque, agence et chauffeur du moment ; champs bornés
create or replace function public.create_feedback(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare vk text; v_ag bigint; v_plate text; v_drv text; v_ctr text; rt int; lng text; cmt text; pho text; fid bigint;
begin
  vk := nullif(left(coalesce(p->>'v', ''), 40), '');
  select agency_id, plate, key into v_ag, v_plate, vk from vehicles where vk is not null and (key = vk or upper(regexp_replace(plate, '\s', '', 'g')) = upper(regexp_replace(vk, '\s', '', 'g'))) limit 1;
  select name, num into v_drv, v_ctr from contracts where vk is not null and vehicle_key = vk and start_at <= now() and (end_at is null or end_at >= now()) order by start_at desc limit 1;
  rt := least(5, greatest(0, coalesce((p->>'rating')::int, 0)));
  lng := lower(left(coalesce(p->>'lang', ''), 5)); if lng not in ('fr', 'ar', 'it', 'de', 'en', 'es', 'pt') then lng := ''; end if;
  cmt := nullif(btrim(left(coalesce(p->>'comment', ''), 2000)), '');
  pho := p->>'photo'; if pho is not null and (left(pho, 11) <> 'data:image/' or length(pho) > 2600000) then pho := null; end if;
  if rt = 0 and cmt is null and pho is null then raise exception 'avis vide'; end if;
  insert into client_feedback (vehicle_key, plate, driver_name, contract_num, agency_id, rating, lang, comment, comment_fr, photo)
    values (vk, v_plate, v_drv, v_ctr, v_ag, nullif(rt, 0), nullif(lng, ''), cmt, case when lng = 'fr' then cmt else null end, pho)
    returning id into fid;
  return jsonb_build_object('ok', true, 'id', fid);
end $$;
revoke execute on function public.create_feedback(jsonb) from public;
grant execute on function public.create_feedback(jsonb) to anon, authenticated;

-- Classement d'un avis (Traité) par le gestionnaire de l'agence ou l'administrateur
create or replace function public.feedback_set(p_id bigint, p_status text) returns void language plpgsql security definer set search_path = public as $$
declare s client_feedback;
begin
  if coalesce(public.my_role(), '') not in ('admin', 'manager') then raise exception 'Accès refusé'; end if;
  if p_status not in ('Nouveau', 'Traité') then raise exception 'Statut inconnu'; end if;
  select * into s from client_feedback where id = p_id;
  if s.id is null then raise exception 'Avis inconnu'; end if;
  if not public.is_admin() and not (s.agency_id = any((select public.my_agency_ids())::bigint[]) or (public.my_role() = 'manager' and s.agency_id is null)) then raise exception 'Accès refusé'; end if;
  update client_feedback set status = p_status, handled_by = auth.uid(), handled_at = now() where id = p_id;
end $$;
revoke execute on function public.feedback_set(bigint, text) from public, anon;
grant execute on function public.feedback_set(bigint, text) to authenticated;

-- temps réel : nouvel avis affiché tout de suite dans le volet Avis clients
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.client_feedback'; exception when others then null; end;
  end if;
end $$;
