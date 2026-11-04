-- =============================================================================
-- Caisse (22/10/2026, demande d'Ahmed) : suivi du cash des chauffeurs, repris du classeur « Suivi Cash Chauffeurs - Luxury »
-- (encaissements Uber par shift, dépenses, avances RH, courses privées, bonus, dépôts en banque, rapprochement Uber, paie).
-- À exécuter une fois dans Supabase > SQL Editor (après 20261102000000_devis_mail.sql). Rejouable sans risque.
-- - cash_moves : journal unique de tous les mouvements (une ligne = une opération d'une caisse), jamais effacé par un gestionnaire
--   (annulation tracée) ; chaque création / modification gardée dans cash_log
-- - uber_payments : export Uber « Opérations de paiement » (espèces collectées, revenus) ; uber_drivers : export « Driver Status »
-- - drivers.uber_uuid : chauffeur Ludy ↔ chauffeur Uber
-- =============================================================================
alter table public.drivers add column if not exists uber_uuid text;
create unique index if not exists drivers_uber_uuid on public.drivers(uber_uuid) where uber_uuid is not null;
grant update (uber_uuid) on public.drivers to authenticated;

create table if not exists public.uber_drivers (
  uuid text primary key, name text, phone text, email text, status text, updated_at timestamptz not null default now()
);
create table if not exists public.uber_payments (
  tx text primary key,                       -- UUID de la transaction (jamais deux fois)
  at timestamptz not null,                   -- heure de la transaction
  driver_uuid text, driver_name text, trip text, description text,
  cash numeric(12,2) not null default 0,     -- espèces collectées par le chauffeur (positif)
  revenue numeric(12,2) not null default 0,  -- « Vos revenus » (chiffre d'affaires)
  payout numeric(12,2) not null default 0,   -- « Montant vous étant versé »
  fare numeric(12,2) not null default 0, tip numeric(12,2) not null default 0, toll numeric(12,2) not null default 0,
  bonus numeric(12,2) not null default 0,
  imported_at timestamptz not null default now()
);
create index if not exists uber_payments_at on public.uber_payments(at);
create index if not exists uber_payments_driver on public.uber_payments(driver_uuid, at);

create table if not exists public.cash_moves (
  id bigserial primary key,
  caisse text not null check (caisse in ('uber', 'depenses', 'rh', 'courses', 'bonus')),
  kind text not null check (kind in ('encaissement', 'depense', 'avance', 'remboursement', 'course', 'bonus', 'recharge', 'depot', 'autre')),
  flow text not null check (flow in ('in', 'out', 'virement')),   -- entrée de cash, sortie de cash, virement (hors caisse)
  amount numeric(12,2) not null check (amount >= 0),
  day date not null,                          -- date du shift (début) ou de l'opération
  shift text check (shift in ('Jour', 'Nuit')),
  driver_code text, driver_name text, uber_uuid text, contract_num text, vehicle_key text,
  mission_id bigint references public.missions(id) on delete set null,
  agency_id bigint references public.agencies(id) on delete set null,
  label text,                                 -- catégorie de dépense, motif d'avance ou de bonus, opération
  ride_type text,                             -- Course Uber, Course Privée, Course Bolt, Course InDrive, Non applicable
  source text,                                -- Chauffeur, Banque, Caisse RH, Cash Nico…
  justif text check (justif in ('OK', 'KO', 'N.A', 'En attente')),
  uber_cash numeric(12,2),                    -- encaissement : espèces affichées par Uber pour le shift
  given numeric(12,2), change numeric(12,2),  -- encaissement : remis par le chauffeur, monnaie rendue (amount = remis - monnaie)
  course_amount numeric(12,2), commission_pct numeric(6,2), prime numeric(12,2), prime_paid numeric(12,2),   -- course privée
  status text,                                -- bonus : Payé / A payer
  signed boolean,                             -- avance signée par le chauffeur
  comment text,
  manager_name text,                          -- gestionnaire (repris de l'historique ; sinon e-mail de l'auteur)
  import_key text unique,                     -- ligne reprise d'un classeur : pas de doublon à la réimportation
  cancelled_at timestamptz, cancel_reason text,
  created_at timestamptz not null default now(), created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(), updated_by uuid
);
create index if not exists cash_moves_day on public.cash_moves(day);
create index if not exists cash_moves_driver on public.cash_moves(driver_code, day);
create index if not exists cash_moves_mission on public.cash_moves(mission_id) where mission_id is not null;

create table if not exists public.cash_log (
  id bigserial primary key, move_id bigint, at timestamptz not null default now(), by uuid, op text, old jsonb, new jsonb
);
create index if not exists cash_log_move on public.cash_log(move_id);

-- historique de chaque mouvement (création, modification, suppression)
create or replace function public.cash_log_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into cash_log (move_id, by, op, old, new) values (coalesce(new.id, old.id), auth.uid(), lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end, case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  return coalesce(new, old);
end $$;
drop trigger if exists cash_moves_log on public.cash_moves;
create trigger cash_moves_log after insert or update or delete on public.cash_moves for each row execute function public.cash_log_trg();

-- garde : un gestionnaire ne change que ses propres saisies des dernières 24 h ; au-delà (ou celles des autres), seulement le
-- justificatif, le statut, la signature, le commentaire et la prime déjà payée ; l'administrateur peut tout corriger
create or replace function public.cash_guard() returns trigger language plpgsql set search_path = public as $$
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
      a := to_jsonb(old) - array['justif', 'status', 'signed', 'comment', 'prime_paid', 'updated_at', 'updated_by', 'flow'];
      b := to_jsonb(new) - array['justif', 'status', 'signed', 'comment', 'prime_paid', 'updated_at', 'updated_by', 'flow'];
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
drop trigger if exists cash_moves_guard on public.cash_moves;
create trigger cash_moves_guard before insert or update on public.cash_moves for each row execute function public.cash_guard();

alter table public.cash_moves enable row level security;
alter table public.cash_log enable row level security;
alter table public.uber_payments enable row level security;
alter table public.uber_drivers enable row level security;
revoke all on public.cash_moves, public.cash_log, public.uber_payments, public.uber_drivers from anon;
revoke insert, update, delete, truncate, references, trigger on public.cash_moves, public.cash_log, public.uber_payments, public.uber_drivers from authenticated;
grant select on public.cash_moves, public.cash_log, public.uber_payments, public.uber_drivers to authenticated;
grant insert, update on public.cash_moves to authenticated;
grant delete on public.cash_moves to authenticated;   -- administrateur seul (règle ci-dessous)
grant insert, update on public.uber_payments, public.uber_drivers to authenticated;
grant delete on public.uber_payments, public.uber_drivers to authenticated;
grant usage on sequence public.cash_moves_id_seq to authenticated;

-- argent : administrateur et gestionnaires seulement (la lecture seule n'y a pas accès) ; gestionnaire = ses agences et ses saisies
drop policy if exists read_mgr on public.cash_moves;
drop policy if exists mgr_insert on public.cash_moves;
drop policy if exists mgr_update on public.cash_moves;
drop policy if exists admin_delete on public.cash_moves;
create policy read_mgr on public.cash_moves for select to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and (created_by = auth.uid() or agency_id is null
    or agency_id = any((select public.my_agency_ids())::bigint[]))));
create policy mgr_insert on public.cash_moves for insert to authenticated
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and (agency_id is null or agency_id = any((select public.my_agency_ids())::bigint[]))));
create policy mgr_update on public.cash_moves for update to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and (created_by = auth.uid() or agency_id is null
    or agency_id = any((select public.my_agency_ids())::bigint[]))))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and (agency_id is null or agency_id = any((select public.my_agency_ids())::bigint[]))));
create policy admin_delete on public.cash_moves for delete to authenticated using ((select public.is_admin()));

drop policy if exists read_admin on public.cash_log;
create policy read_admin on public.cash_log for select to authenticated using ((select public.is_admin()));

drop policy if exists mgr_all on public.uber_payments;
drop policy if exists mgr_ins on public.uber_payments;
drop policy if exists mgr_upd on public.uber_payments;
drop policy if exists admin_delete on public.uber_payments;
create policy mgr_all on public.uber_payments for select to authenticated using (public.my_role() in ('admin', 'manager'));
create policy mgr_ins on public.uber_payments for insert to authenticated with check (public.my_role() in ('admin', 'manager'));
create policy mgr_upd on public.uber_payments for update to authenticated using (public.my_role() in ('admin', 'manager')) with check (public.my_role() in ('admin', 'manager'));
create policy admin_delete on public.uber_payments for delete to authenticated using ((select public.is_admin()));
drop policy if exists mgr_all on public.uber_drivers;
drop policy if exists mgr_ins on public.uber_drivers;
drop policy if exists mgr_upd on public.uber_drivers;
drop policy if exists admin_delete on public.uber_drivers;
create policy mgr_all on public.uber_drivers for select to authenticated using (public.my_role() in ('admin', 'manager'));
create policy mgr_ins on public.uber_drivers for insert to authenticated with check (public.my_role() in ('admin', 'manager'));
create policy mgr_upd on public.uber_drivers for update to authenticated using (public.my_role() in ('admin', 'manager')) with check (public.my_role() in ('admin', 'manager'));
create policy admin_delete on public.uber_drivers for delete to authenticated using ((select public.is_admin()));

insert into public.params (key, label, value, note, sort) values
  ('cashCommissionPct', 'Courses privées : prime du chauffeur (% de la course)', '10', 'Prime proposée à l''encaissement d''une course privée (modifiable course par course). Classeur : 10 %.', 120)
on conflict (key) do nothing;
