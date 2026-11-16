-- Organisation des retours de véhicules à l'agence (16/11/2026, demande d'Ahmed : « les chauffeurs viennent tous en même temps,
-- ça engendre du retard »). Page Retours (#/retours) : véhicules sous contrat classés du plus proche au plus loin de leur agence
-- (position Geotab, distance à vol d'oiseau) ou par heure de départ du contrat, une heure de retour par chauffeur (créneaux),
-- message WhatsApp individuel (se déconnecter d'Uber / Bolt et rentrer à l'agence), arrivée à l'agence relevée par le GPS.
-- * agencies : position GPS de l'agence (lat, lng), adresse, rayon d'arrivée (mètres) ; réglés par l'administrateur (page Agences).
-- * return_calls : un appel de retour par contrat (heure de retour prévue, message envoyé, arrivée, retour fait, annulé).

alter table public.agencies add column if not exists lat double precision;
alter table public.agencies add column if not exists lng double precision;
alter table public.agencies add column if not exists address text;
alter table public.agencies add column if not exists return_radius_m integer;

create table if not exists public.return_calls (
  id bigserial primary key,
  agency_id bigint references public.agencies(id) on delete set null,
  contract_num text not null,
  vehicle_key text not null,
  driver_name text,
  phone text,
  rank integer,
  slot_at timestamptz,
  sent_at timestamptz,
  sent_by text,
  dist_at_send_m integer,
  arrived_at timestamptz,
  done_at timestamptz,
  cancelled_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
-- un seul appel ouvert (ni fait ni annulé) par contrat
create unique index if not exists return_calls_open on public.return_calls (contract_num) where done_at is null and cancelled_at is null;
create index if not exists return_calls_veh on public.return_calls (vehicle_key, created_at);
create index if not exists return_calls_created on public.return_calls (created_at);

-- heure de mise à jour posée par la base ; agence = celle du véhicule ; auteur jamais modifié
create or replace function public.return_calls_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    if new.agency_id is null then new.agency_id := (select agency_id from vehicles where key = new.vehicle_key); end if;
  else
    new.created_at := old.created_at; new.created_by := old.created_by; new.contract_num := old.contract_num; new.vehicle_key := old.vehicle_key;
  end if;
  return new;
end $$;
drop trigger if exists return_calls_guard on public.return_calls;
create trigger return_calls_guard before insert or update on public.return_calls for each row execute function public.return_calls_guard();

alter table public.return_calls enable row level security;
revoke all on public.return_calls from anon, authenticated;
grant select, insert, update on public.return_calls to authenticated;
grant delete on public.return_calls to authenticated;
grant usage, select on sequence public.return_calls_id_seq to authenticated;
grant all on public.return_calls to service_role;
grant usage, select on sequence public.return_calls_id_seq to service_role;

-- administrateur : tout ; gestionnaire : véhicules de ses agences ; lecture seule : lecture des véhicules de ses agences
drop policy if exists rc_read on public.return_calls;
drop policy if exists rc_ins on public.return_calls;
drop policy if exists rc_upd on public.return_calls;
drop policy if exists rc_del on public.return_calls;
create policy rc_read on public.return_calls for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]));
create policy rc_ins on public.return_calls for insert to authenticated
  with check ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));
create policy rc_upd on public.return_calls for update to authenticated
  using ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])))
  with check ((select public.is_admin()) or ((select public.my_role()) = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));
create policy rc_del on public.return_calls for delete to authenticated using ((select public.is_admin()));

-- intervalle entre deux retours (minutes) et rayon d'arrivée par défaut (mètres)
insert into public.params (key, label, value, note, sort) values
  ('returnSlotMin', 'Retours : minutes entre deux retours de véhicule', '10', 'Page Retours : heure de retour de chaque chauffeur = première heure + rang × cet intervalle', 410),
  ('returnRadiusM', 'Retours : rayon d''arrivée à l''agence (mètres)', '300', 'Véhicule à moins de cette distance de l''agence = arrivé', 411)
on conflict (key) do nothing;
