-- =============================================================================
-- Caisse : encaissements Bolt en espèces (30/10/2026, demande d'Ahmed : même logique que Uber, copie dans le classeur de la caisse).
-- À exécuter dans Supabase > SQL Editor (après 20261118000000_devis_validation.sql). Rejouable sans risque.
-- - cash_moves.caisse : 'bolt' (encaissement du shift : espèces Bolt remises par le chauffeur ; uber_cash = espèces de la plateforme)
-- - bolt_sessions : export Bolt Fleet « Journal d'activité des services » (une ligne par session de service : chauffeur, véhicule,
--   courses, total des paiements, espèces…) ; clé = début de la session + chauffeur + plaque : réimporter n'ajoute pas de doublon ;
--   ajout seulement (jamais modifié par le site), comme les transactions Uber
-- - agence d'une session : celle du véhicule (plaque), sinon la seule agence (cash_agency_trg)
-- =============================================================================
alter table public.cash_moves drop constraint if exists cash_moves_caisse_check;
alter table public.cash_moves add constraint cash_moves_caisse_check check (caisse in ('uber', 'bolt', 'depenses', 'rh', 'courses', 'bonus'));

create table if not exists public.bolt_sessions (
  key text primary key,                      -- début (aaaa-mm-jj hh:mm) | chauffeur | plaque
  at timestamptz not null,                   -- début de la session (heure du Maroc dans l'export)
  driver_name text,                          -- nom du chauffeur dans Bolt
  vehicle text, plate text, vehicle_key text,
  minutes numeric(10,2), online_min numeric(10,2), pause_min numeric(10,2), span text,
  trips integer not null default 0, done integer not null default 0, cancel_pax integer not null default 0, cancel_drv integer not null default 0,
  total numeric(12,2) not null default 0,    -- « Total des paiements » (chiffre d'affaires)
  cash numeric(12,2) not null default 0,     -- « Espèce » : espèces encaissées par le chauffeur
  terminal numeric(12,2) not null default 0, app numeric(12,2) not null default 0, business numeric(12,2) not null default 0,
  raw jsonb,                                 -- ligne complète de l'export (en-têtes d'origine), recopiée dans le classeur
  agency_id bigint references public.agencies(id) on delete set null,
  imported_at timestamptz not null default now(), imported_by uuid default auth.uid()
);
create index if not exists bolt_sessions_at on public.bolt_sessions(at);
create index if not exists bolt_sessions_agency on public.bolt_sessions(agency_id, at);

-- agence d'une ligne sans agence (20261105000000 + sessions Bolt : agence du véhicule)
create or replace function public.cash_agency_trg() returns trigger language plpgsql security definer set search_path = public as $$
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
drop trigger if exists bolt_sessions_agency on public.bolt_sessions;
create trigger bolt_sessions_agency before insert on public.bolt_sessions for each row execute function public.cash_agency_trg();

alter table public.bolt_sessions enable row level security;
revoke all on public.bolt_sessions from anon;
revoke insert, update, delete, truncate, references, trigger on public.bolt_sessions from authenticated;
grant select, insert on public.bolt_sessions to authenticated;   -- import : ajout seulement (doublons ignorés), jamais de modification
grant delete on public.bolt_sessions to authenticated;
drop policy if exists mgr_all on public.bolt_sessions;
drop policy if exists mgr_ins on public.bolt_sessions;
drop policy if exists admin_delete on public.bolt_sessions;
create policy mgr_all on public.bolt_sessions for select to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[])));
create policy mgr_ins on public.bolt_sessions for insert to authenticated
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[])));
create policy admin_delete on public.bolt_sessions for delete to authenticated using ((select public.is_admin()));
