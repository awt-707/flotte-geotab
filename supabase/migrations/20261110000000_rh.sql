-- =============================================================================
-- Ressources humaines (24/10/2026, demande d'Ahmed). À exécuter dans Supabase > SQL Editor
-- (après 20261109000000_contrats_travail.sql). Rejouable sans risque.
-- - hr_employees : salariés (chauffeurs : présence comptée sur les contrats Ludy ; staff : pointage sur Ludy),
--   société, agence, date d'entrée, période d'essai, salaire, durée hebdomadaire, congés acquis par mois
-- - hr_events : congés, arrêts maladie, absences, avances, remboursements, primes, avenants (justificatifs dans « rh »)
-- - hr_clock : pointage du staff (arrivée, pause, reprise, départ ; ouverture de Ludy confirmée par la date de
--   naissance ; essais manqués gardés). Écrit seulement par hr_clock_do (contrôle de la date de naissance dans la base)
--   ou corrigé par l'administrateur.
-- Droits : administrateur = tout ; gestionnaire = chauffeurs des agences auxquelles il est rattaché ; le staff
-- (salaires des collègues compris) est réservé à l'administrateur ; chacun lit son propre pointage.
-- =============================================================================
create table if not exists public.hr_employees (
  id bigserial primary key,
  kind text not null check (kind in ('chauffeur', 'staff')),
  employer_id bigint references public.employers(id) on delete set null,
  agency_id bigint references public.agencies(id) on delete set null,
  driver_code text,
  user_id uuid references public.profiles(user_id) on delete set null,
  name text not null,
  cin text, birth_date date, phone text, email text, position text,
  hired_on date,
  trial_months numeric(4,2) not null default 1.5 check (trial_months >= 0 and trial_months <= 12),
  trial_renewable boolean not null default true,
  trial_decision text check (trial_decision in ('renouvelée', 'confirmée', 'rompue')),
  trial_decided_on date,
  salary numeric(12,2) check (salary >= 0),
  weekly_hours numeric(5,2) not null default 44 check (weekly_hours > 0 and weekly_hours <= 80),
  leave_per_month numeric(4,2) not null default 1.5 check (leave_per_month >= 0 and leave_per_month <= 5),
  pointage boolean not null default false,
  work_contract_id bigint references public.work_contracts(id) on delete set null,
  left_on date, left_reason text, note text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(),
  check (kind = 'staff' or (user_id is null and not pointage)),
  check (kind = 'chauffeur' or driver_code is null)
);
create unique index if not exists hr_employees_driver on public.hr_employees(driver_code) where driver_code is not null;
create unique index if not exists hr_employees_user on public.hr_employees(user_id) where user_id is not null;

create table if not exists public.hr_events (
  id bigserial primary key,
  employee_id bigint not null references public.hr_employees(id) on delete cascade,
  kind text not null check (kind in ('conge', 'maladie', 'absence', 'avance', 'remboursement', 'prime', 'avenant', 'autre')),
  day_from date not null, day_to date check (day_to is null or day_to >= day_from),
  days numeric(6,2) check (days >= 0),           -- jours décomptés (congés, absences, arrêt)
  amount numeric(12,2) check (amount >= 0),       -- avance, remboursement, prime
  new_salary numeric(12,2) check (new_salary >= 0),   -- avenant : salaire à partir de day_from
  justified boolean,                              -- absence justifiée / non justifiée
  status text,                                    -- congé : Demandé / Validé / Refusé ; avance : À rembourser / Remboursée ; prime : À payer / Payée
  label text,                                     -- motif, objet de l'avenant
  doc_path text,                                  -- justificatif (stockage « rh »)
  plan_absence_id bigint,                         -- absence posée dans le planning des chauffeurs
  cancelled_at timestamptz, cancel_reason text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now()
);
create index if not exists hr_events_emp on public.hr_events(employee_id, day_from);

create table if not exists public.hr_clock (
  id bigserial primary key,
  employee_id bigint not null references public.hr_employees(id) on delete cascade,
  user_id uuid,
  kind text not null check (kind in ('in', 'pause', 'resume', 'out', 'session', 'fail')),
  at timestamptz not null default now(),
  client text, note text,
  created_by uuid default auth.uid()
);
create index if not exists hr_clock_emp on public.hr_clock(employee_id, at);

alter table public.work_contracts add column if not exists employee_id bigint references public.hr_employees(id) on delete set null;

-- ---------- droits ----------
create or replace function public.hr_can(p_kind text, p_agency bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (p_kind = 'chauffeur' and public.my_role() = 'manager' and p_agency = any(public.my_agency_ids()))
$$;
create or replace function public.hr_can_emp(p_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.hr_employees e where e.id = p_id and public.hr_can(e.kind, e.agency_id))
$$;

alter table public.hr_employees enable row level security;
alter table public.hr_events enable row level security;
alter table public.hr_clock enable row level security;
revoke all on public.hr_employees, public.hr_events, public.hr_clock from anon, authenticated;
grant select, insert, update, delete on public.hr_employees, public.hr_events, public.hr_clock to authenticated;
grant usage, select on sequence public.hr_employees_id_seq, public.hr_events_id_seq, public.hr_clock_id_seq to authenticated;

drop policy if exists hr_read on public.hr_employees;
drop policy if exists hr_insert on public.hr_employees;
drop policy if exists hr_update on public.hr_employees;
drop policy if exists hr_delete on public.hr_employees;
create policy hr_read on public.hr_employees for select to authenticated using (public.hr_can(kind, agency_id));
create policy hr_insert on public.hr_employees for insert to authenticated with check (public.hr_can(kind, agency_id));
create policy hr_update on public.hr_employees for update to authenticated using (public.hr_can(kind, agency_id)) with check (public.hr_can(kind, agency_id));
create policy hr_delete on public.hr_employees for delete to authenticated using ((select public.is_admin()));

drop policy if exists hr_read on public.hr_events;
drop policy if exists hr_insert on public.hr_events;
drop policy if exists hr_update on public.hr_events;
drop policy if exists hr_delete on public.hr_events;
create policy hr_read on public.hr_events for select to authenticated using (public.hr_can_emp(employee_id));
create policy hr_insert on public.hr_events for insert to authenticated with check (public.hr_can_emp(employee_id));
create policy hr_update on public.hr_events for update to authenticated using (public.hr_can_emp(employee_id)) with check (public.hr_can_emp(employee_id));
create policy hr_delete on public.hr_events for delete to authenticated using ((select public.is_admin()));

-- pointage : chacun lit le sien ; l'administrateur lit et corrige tout ; aucune autre écriture directe (hr_clock_do)
drop policy if exists hr_read on public.hr_clock;
drop policy if exists hr_admin on public.hr_clock;
create policy hr_read on public.hr_clock for select to authenticated using ((select public.is_admin()) or user_id = auth.uid());
create policy hr_admin on public.hr_clock for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- auteur, dates ; un gestionnaire ne change ni l'agence vers une autre agence (contrôlé par la règle) ni la nature du salarié
create or replace function public.hr_touch() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now();
  else new.created_by := old.created_by; new.created_at := old.created_at; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists hr_touch on public.hr_employees;
create trigger hr_touch before insert or update on public.hr_employees for each row execute function public.hr_touch();
drop trigger if exists hr_touch on public.hr_events;
create trigger hr_touch before insert or update on public.hr_events for each row execute function public.hr_touch();

-- ---------- pointage du staff ----------
-- état : dernier événement (arrivée / pause / reprise / départ) des 18 dernières heures ; au-delà, journée oubliée = hors service
create or replace function public.hr_state(p_emp bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  with last as (
    select kind, at from public.hr_clock where employee_id = p_emp and kind in ('in', 'pause', 'resume', 'out') and at > now() - interval '18 hours'
    order by at desc, id desc limit 1),
  arrived as (
    select max(at) as at from public.hr_clock where employee_id = p_emp and kind = 'in' and at > now() - interval '18 hours')
  select jsonb_build_object(
    'state', case (select kind from last) when 'in' then 'on' when 'resume' then 'on' when 'pause' then 'pause' else 'off' end,
    'since', (select at from last),
    'arrived', case when (select kind from last) in ('in', 'pause', 'resume') then (select at from arrived) end)
$$;
create or replace function public.hr_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when e.id is null then null else jsonb_build_object('id', e.id, 'name', e.name, 'kind', e.kind, 'pointage', e.pointage) || public.hr_state(e.id) end
  from (select 1) x left join public.hr_employees e on e.user_id = auth.uid() and e.left_on is null
$$;
create or replace function public.hr_clock_do(p_kind text, p_birth date default null, p_client text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.hr_employees; st text; n int;
begin
  select * into e from public.hr_employees where user_id = auth.uid() and left_on is null and pointage;
  if e.id is null then return jsonb_build_object('ok', false, 'error', 'Pointage non activé pour ce compte'); end if;
  if p_kind not in ('in', 'pause', 'resume', 'out') then return jsonb_build_object('ok', false, 'error', 'Action inconnue'); end if;
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
revoke all on function public.hr_clock_do(text, date, text) from public, anon;
grant execute on function public.hr_clock_do(text, date, text) to authenticated;
revoke all on function public.hr_me() from public, anon;
grant execute on function public.hr_me() to authenticated;
revoke all on function public.hr_state(bigint) from public, anon, authenticated;

-- ---------- justificatifs : stockage privé « rh », <salarié>/<fichier> ----------
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('rh', 'rh', false) on conflict (id) do nothing;
    execute 'drop policy if exists rh_insert on storage.objects';
    execute 'drop policy if exists rh_select on storage.objects';
    execute 'drop policy if exists rh_delete on storage.objects';
    execute $p$create policy rh_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'rh' and (storage.foldername(name))[1] ~ '^\d+$' and public.hr_can_emp(((storage.foldername(name))[1])::bigint))$p$;
    execute $p$create policy rh_select on storage.objects for select to authenticated
      using (bucket_id = 'rh' and (storage.foldername(name))[1] ~ '^\d+$' and public.hr_can_emp(((storage.foldername(name))[1])::bigint))$p$;
    execute $p$create policy rh_delete on storage.objects for delete to authenticated using (bucket_id = 'rh' and (select public.is_admin()))$p$;
  end if;
end $$;

-- ---------- réglages ----------
insert into public.params (key, label, value, note, sort) values
  ('rhMaxShiftH', 'RH : durée maximale d''un contrat compté comme un shift (heures)', '16', 'Au-delà : contrat à vérifier, heures non comptées (jour de présence compté)', 900),
  ('rhAlertDays', 'RH : alerte de fin de période d''essai (jours avant)', '7', null, 901)
on conflict (key) do nothing;
