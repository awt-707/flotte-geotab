-- =============================================================================
-- Anomalies carburant (17/10/2026). À exécuter une fois dans Supabase > SQL Editor (après 20261023000000_relecture.sql). Rejouable sans risque.
-- Achats de la carte carburant (extract Afriquia) injectés depuis le site (Carburant > Anomalies carburant), croisés sur le site avec
-- les pleins détectés par Geotab et la jauge. Lecture : admin = tout, sinon les véhicules de ses agences. Import : admin et gestionnaire
-- (gestionnaire : seulement les véhicules de ses agences). Statut de vérification modifiable, jamais écrasé par un nouvel import.
-- =============================================================================

create table if not exists public.fuel_card_tx (
  id text primary key, card text, vehicle_key text, plate text, at timestamptz not null, day date, product text,
  liters double precision, unit_price double precision, amount_ttc double precision, station text, ticket text, mode text, invoice text,
  status text, note text, imported_at timestamptz not null default now(), imported_by uuid
);
create index if not exists fuel_card_tx_at on public.fuel_card_tx(at);
create index if not exists fuel_card_tx_vk on public.fuel_card_tx(vehicle_key, at);
alter table public.fuel_card_tx enable row level security;
grant select on public.fuel_card_tx to authenticated;
grant update (status, note) on public.fuel_card_tx to authenticated;
drop policy if exists read_agency on public.fuel_card_tx;
create policy read_agency on public.fuel_card_tx for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]));
drop policy if exists mgr_update on public.fuel_card_tx;
create policy mgr_update on public.fuel_card_tx for update to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));

create or replace function public.import_fuel_card(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_add integer; n_upd integer; n_same integer; n_skip integer := 0; adm boolean := is_admin(); keys text[] := my_vehicle_keys();
begin
  if coalesce(my_role(), '') not in ('admin', 'manager') then raise exception 'droits insuffisants'; end if;
  create temp table _f on commit drop as
    select distinct on (r.id) r.* from jsonb_populate_recordset(null::fuel_card_tx, coalesce(p_rows, '[]')) r
     where coalesce(r.id, '') <> '' and r.at is not null order by r.id;
  if not adm then
    select count(*) into n_skip from _f f left join fuel_card_tx o on o.id = f.id
     where not (coalesce(f.vehicle_key, '') = any(keys)) or (o.id is not null and not (coalesce(o.vehicle_key, '') = any(keys)));
    delete from _f f using (select f2.id from _f f2 left join fuel_card_tx o on o.id = f2.id
      where not (coalesce(f2.vehicle_key, '') = any(keys)) or (o.id is not null and not (coalesce(o.vehicle_key, '') = any(keys)))) x where f.id = x.id;
  end if;
  create temp table _g on commit drop as
    select f.*, o.id is not null as known,
      (o.id is not null and o.vehicle_key is not distinct from f.vehicle_key and o.at = f.at and o.liters is not distinct from f.liters
        and o.product is not distinct from f.product and o.amount_ttc is not distinct from f.amount_ttc and o.station is not distinct from f.station
        and o.plate is not distinct from f.plate and o.unit_price is not distinct from f.unit_price and o.mode is not distinct from f.mode
        and o.invoice is not distinct from f.invoice) as same
      from _f f left join fuel_card_tx o on o.id = f.id;
  select count(*) filter (where not known), count(*) filter (where known and not same), count(*) filter (where same) into n_add, n_upd, n_same from _g;
  insert into fuel_card_tx (id, card, vehicle_key, plate, at, day, product, liters, unit_price, amount_ttc, station, ticket, mode, invoice, imported_at, imported_by)
  select id, card, vehicle_key, plate, at, day, product, liters, unit_price, amount_ttc, station, ticket, mode, invoice, now(), auth.uid() from _g where not same
  on conflict (id) do update set card = excluded.card, vehicle_key = excluded.vehicle_key, plate = excluded.plate, at = excluded.at, day = excluded.day,
    product = excluded.product, liters = excluded.liters, unit_price = excluded.unit_price, amount_ttc = excluded.amount_ttc, station = excluded.station,
    ticket = excluded.ticket, mode = excluded.mode, invoice = excluded.invoice, imported_at = excluded.imported_at, imported_by = excluded.imported_by;
  return jsonb_build_object('added', n_add, 'updated', n_upd, 'same', n_same, 'skipped', n_skip);
end $$;
revoke execute on function public.import_fuel_card(jsonb) from public, anon;
grant execute on function public.import_fuel_card(jsonb) to authenticated, service_role;
