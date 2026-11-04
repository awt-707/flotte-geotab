-- =============================================================================
-- Planning des chauffeurs par agence (22/10/2026, demande d'Ahmed). À exécuter dans Supabase > SQL Editor
-- (après 20261105000000_chauffeurs_auto.sql). Rejouable sans risque.
-- - driver_roster : réglages de chaque chauffeur pour le planning (shift habituel, véhicule habituel, 2 jours de repos, actif)
-- - driver_plan : une case = un véhicule × un jour × un shift (jour / nuit) → un chauffeur ; une case modifiée à la main est
--   verrouillée (la génération automatique ne la change plus) ; un chauffeur au plus une fois par jour
-- - driver_absences : absences (du … au …) ; la semaine se réajuste en remplaçant l'absent
-- - plan_weeks : semaine publiée (partagée aux chauffeurs) et verrouillée par l'administrateur
-- - plan_log : historique (qui a modifié, publié, verrouillé, quand)
-- Accès : lecture = administrateur et utilisateurs de l'agence ; modification = administrateur, et gestionnaires de l'agence si
-- le réglage planManagersEdit le permet et que la semaine n'est pas verrouillée ; lecture seule = jamais.
-- =============================================================================
create table if not exists public.driver_roster (
  driver_code text primary key,
  agency_id bigint references public.agencies(id) on delete set null,
  shift text check (shift in ('Jour', 'Nuit')),
  vehicle_key text,
  off_days smallint[] not null default '{}',     -- jours de repos : 1 = lundi … 7 = dimanche
  active boolean not null default true,
  note text,
  updated_at timestamptz not null default now(), updated_by uuid default auth.uid()
);
create table if not exists public.driver_plan (
  id bigserial primary key,
  agency_id bigint references public.agencies(id) on delete cascade,
  day date not null,
  shift text not null check (shift in ('Jour', 'Nuit')),
  vehicle_key text not null,
  driver_code text,
  locked boolean not null default false,
  note text,
  updated_at timestamptz not null default now(), updated_by uuid default auth.uid(),
  unique (day, shift, vehicle_key)
);
create index if not exists driver_plan_agency on public.driver_plan(agency_id, day);
create index if not exists driver_plan_driver on public.driver_plan(driver_code, day) where driver_code is not null;
create table if not exists public.driver_absences (
  id bigserial primary key,
  agency_id bigint references public.agencies(id) on delete cascade,
  driver_code text not null,
  day_from date not null, day_to date not null check (day_to >= day_from),
  reason text,
  created_at timestamptz not null default now(), created_by uuid default auth.uid()
);
create index if not exists driver_absences_days on public.driver_absences(agency_id, day_from, day_to);
create table if not exists public.plan_weeks (
  agency_id bigint not null references public.agencies(id) on delete cascade,
  week date not null,                            -- lundi
  published_at timestamptz, published_by uuid,
  locked boolean not null default false, locked_by uuid, locked_at timestamptz,
  primary key (agency_id, week)
);
create table if not exists public.plan_log (
  id bigserial primary key, agency_id bigint, at timestamptz not null default now(), by uuid default auth.uid(), action text, detail text
);
create index if not exists plan_log_agency on public.plan_log(agency_id, at);

insert into public.params (key, label, value, note, sort) values
  ('planManagersEdit', 'Planning chauffeurs : les gestionnaires peuvent modifier', 'oui',
   'oui : les gestionnaires modifient le planning de leurs agences (sauf semaine verrouillée par l''administrateur) ; non : administrateur seul.', 130)
on conflict (key) do nothing;

-- l'utilisateur peut-il modifier le planning de cette agence (et de cette semaine) ?
create or replace function public.plan_can_edit(p_agency bigint, p_week date default null) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or (
    my_role() = 'manager' and p_agency = any(my_agency_ids())
    and coalesce((select value from params where key = 'planManagersEdit'), 'oui') <> 'non'
    and (p_week is null or not exists (select 1 from plan_weeks w where w.agency_id = p_agency and w.week = p_week and w.locked)))
$$;
create or replace function public.plan_can_read(p_agency bigint) returns boolean language sql stable security definer set search_path = public as $$
  select is_admin() or p_agency = any(my_agency_ids())
$$;

alter table public.driver_roster enable row level security;
alter table public.driver_plan enable row level security;
alter table public.driver_absences enable row level security;
alter table public.plan_weeks enable row level security;
alter table public.plan_log enable row level security;
revoke all on public.driver_roster, public.driver_plan, public.driver_absences, public.plan_weeks, public.plan_log from anon;
revoke insert, update, delete, truncate, references, trigger on public.driver_roster, public.driver_plan, public.driver_absences, public.plan_weeks, public.plan_log from authenticated;
grant select on public.driver_roster, public.driver_plan, public.driver_absences, public.plan_weeks, public.plan_log to authenticated;
grant insert, update, delete on public.driver_roster, public.driver_absences to authenticated;   -- cases et semaines : par les fonctions ci-dessous
grant usage on sequence public.driver_absences_id_seq to authenticated;

do $$
declare t text;
begin
  foreach t in array array['driver_roster', 'driver_plan', 'driver_absences', 'plan_weeks', 'plan_log'] loop
    execute format('drop policy if exists plan_read on public.%I', t);
    execute format('create policy plan_read on public.%I for select to authenticated using ((select public.plan_can_read(agency_id)))', t);
  end loop;
  foreach t in array array['driver_roster', 'driver_absences'] loop
    execute format('drop policy if exists plan_write on public.%I', t);
    execute format('create policy plan_write on public.%I for all to authenticated using ((select public.plan_can_edit(agency_id))) with check ((select public.plan_can_edit(agency_id)))', t);
  end loop;
end $$;

-- Enregistre les cases d'une période (une semaine) en une fois : cases remplacées, historique tenu
create or replace function public.plan_save(p_agency bigint, p_from date, p_to date, p_cells jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w date; n_changed integer; n_cells integer;
begin
  if p_to < p_from or p_to - p_from > 41 then raise exception 'période invalide'; end if;
  for w in select distinct (d - ((extract(isodow from d)::int - 1) * interval '1 day'))::date from generate_series(p_from, p_to, interval '1 day') d loop
    if not plan_can_edit(p_agency, w) then raise exception 'modification du planning non autorisée (droits ou semaine verrouillée)'; end if;
  end loop;
  create temp table _n on commit drop as
    select (c->>'day')::date as day, c->>'shift' as shift, c->>'vehicle_key' as vehicle_key, nullif(c->>'driver_code', '') as driver_code,
           coalesce((c->>'locked')::boolean, false) as locked, nullif(c->>'note', '') as note
      from jsonb_array_elements(coalesce(p_cells, '[]')) c where (c->>'day')::date between p_from and p_to;
  select count(*) into n_cells from _n;
  select count(*) into n_changed from _n full join (select * from driver_plan where agency_id = p_agency and day between p_from and p_to) o
    using (day, shift, vehicle_key) where _n.driver_code is distinct from o.driver_code;
  delete from driver_plan where agency_id = p_agency and day between p_from and p_to;
  insert into driver_plan (agency_id, day, shift, vehicle_key, driver_code, locked, note, updated_at, updated_by)
  select p_agency, day, shift, vehicle_key, driver_code, locked, note, now(), auth.uid() from _n
  on conflict (day, shift, vehicle_key) do update set agency_id = excluded.agency_id, driver_code = excluded.driver_code, locked = excluded.locked,
    note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  if n_changed > 0 then insert into plan_log (agency_id, action, detail) values (p_agency, 'modification', p_from || ' → ' || p_to || ' : ' || n_changed || ' case(s) changée(s)' || coalesce(' · ' || p_note, '')); end if;
  return jsonb_build_object('cells', n_cells, 'changed', n_changed);
end $$;

-- Publier (partagé aux chauffeurs) ou verrouiller / déverrouiller une semaine (verrou : administrateur seul)
create or replace function public.plan_week_set(p_agency bigint, p_week date, p_action text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_action = 'publier' then
    if not plan_can_edit(p_agency, p_week) then raise exception 'publication non autorisée'; end if;
    insert into plan_weeks (agency_id, week, published_at, published_by) values (p_agency, p_week, now(), auth.uid())
    on conflict (agency_id, week) do update set published_at = now(), published_by = auth.uid();
  elsif p_action in ('verrouiller', 'déverrouiller') then
    if not is_admin() then raise exception 'verrouillage réservé à l''administrateur'; end if;
    insert into plan_weeks (agency_id, week, locked, locked_by, locked_at) values (p_agency, p_week, p_action = 'verrouiller', auth.uid(), now())
    on conflict (agency_id, week) do update set locked = (p_action = 'verrouiller'), locked_by = auth.uid(), locked_at = now();
  else raise exception 'action inconnue'; end if;
  insert into plan_log (agency_id, action, detail) values (p_agency, p_action, 'semaine du ' || to_char(p_week, 'DD/MM/YYYY'));
  return (select to_jsonb(w) from plan_weeks w where agency_id = p_agency and week = p_week);
end $$;
revoke execute on function public.plan_save(bigint, date, date, jsonb, text), public.plan_week_set(bigint, date, text) from public, anon;
grant execute on function public.plan_save(bigint, date, date, jsonb, text), public.plan_week_set(bigint, date, text) to authenticated;
grant execute on function public.plan_can_edit(bigint, date), public.plan_can_read(bigint) to authenticated;

-- historique des réglages chauffeurs et absences
create or replace function public.plan_log_trg() returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
  insert into plan_log (agency_id, action, detail) values ((j->>'agency_id')::bigint,
    case tg_table_name when 'driver_absences' then 'absence' else 'chauffeur' end || ' ' || lower(tg_op),
    case tg_table_name when 'driver_absences' then (j->>'driver_code') || ' du ' || (j->>'day_from') || ' au ' || (j->>'day_to') || coalesce(' · ' || (j->>'reason'), '')
      else (j->>'driver_code') || ' : shift ' || coalesce(j->>'shift', '—') || ', véhicule ' || coalesce(j->>'vehicle_key', '—') || ', repos ' || coalesce(nullif(translate(j->>'off_days', '[]', ''), ''), '—')
        || case when (j->>'active') = 'false' then ', inactif' else '' end end);
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists driver_roster_log on public.driver_roster;
create trigger driver_roster_log after insert or update or delete on public.driver_roster for each row execute function public.plan_log_trg();
drop trigger if exists driver_absences_log on public.driver_absences;
create trigger driver_absences_log after insert or update or delete on public.driver_absences for each row execute function public.plan_log_trg();
