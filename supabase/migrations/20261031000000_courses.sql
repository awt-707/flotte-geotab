-- =============================================================================
-- Courses privées (21/10/2026) : découverte client, devis, missions avec chauffeur (cahier des charges « Process de découverte
-- client » et grille tarifaire Ludy 10/2026). À exécuter une fois dans Supabase > SQL Editor (après 20261030000000_droits.sql).
-- Rejouable sans risque.
-- - pricing_grid : grille tarifaire (une ligne), lue par l'administrateur et les gestionnaires, modifiée par l'administrateur seul
-- - missions : demandes / devis / missions (fiche de découverte complète dans data), numéro DEV-aaaa-nnnn
-- =============================================================================
create table if not exists public.pricing_grid (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
-- grille Ludy « Courses privées » en vigueur 10/2026 (prix TTC en MAD, TVA 10 %), seulement si aucune grille n'est encore enregistrée
insert into public.pricing_grid (id, data) values (1, $g${
  "valid": "10/2026", "vat": 10, "ttc": true,
  "cats": [{ "id": "SONATA", "label": "Berline — 4 passagers", "model": "Hyundai Sonata", "seats": 4 },
           { "id": "STARIA", "label": "Van — 7 passagers", "model": "Hyundai Staria", "seats": 7 }],
  "hourly": { "SONATA": 220, "STARIA": 300 }, "hourlyMinH": 2,
  "half": { "h": 4, "km": 80, "SONATA": 800, "STARIA": 1100 },
  "day": { "h": 8, "km": 150, "SONATA": 1500, "STARIA": 2000 },
  "airport": [{ "dest": "Casablanca", "SONATA": 320, "STARIA": 570 }, { "dest": "Rabat", "SONATA": 950, "STARIA": 1450 },
              { "dest": "Marrakech", "SONATA": 1950, "STARIA": 2830 }, { "dest": "Tanger", "SONATA": 2890, "STARIA": 4210 },
              { "dest": "Agadir", "SONATA": 3650, "STARIA": 5330 }, { "dest": "Fès", "SONATA": 2670, "STARIA": 3890 },
              { "dest": "Tétouan", "SONATA": 3100, "STARIA": 4510 }],
  "intercity": [{ "dest": "En ville (Casa)", "SONATA": 150, "STARIA": 200 }, { "dest": "Rabat", "SONATA": 780, "STARIA": 1130 },
                { "dest": "Marrakech", "SONATA": 1720, "STARIA": 2720 }, { "dest": "Tanger", "SONATA": 2570, "STARIA": 3790 },
                { "dest": "Agadir", "SONATA": 3490, "STARIA": 5150 }, { "dest": "Fès", "SONATA": 2360, "STARIA": 3470 },
                { "dest": "Tétouan", "SONATA": 2770, "STARIA": 4080 }],
  "nightPct": 15, "nightFrom": 22, "nightTo": 6,
  "wait15": { "SONATA": 55, "STARIA": 75 }, "waitFreeAirport": 60, "waitFreeOther": 15,
  "kmExtra": { "SONATA": 3, "STARIA": 5 },
  "proPct": 10, "depositPct": 30, "returnPct": 30,
  "cancel": "Annulation gratuite plus de 24 h avant ; 50 % entre 24 h et 2 h avant ; 100 % moins de 2 h avant ou en cas d'absence.",
  "notes": "Forfaits transferts et intervilles tout compris : péages, carburant, bagages et retour à vide inclus. Prix fixes, sans majoration de demande. Tarif unique quel que soit le canal (direct, QR chauffeur, hôtel B2B) : aucune remise hors cette grille sans accord de la direction.",
  "company": "LUDY, marque de services exploitée par LUXURY & DISCOVERY, SARLAU — Capital de 100 000,00 MAD — RC n° 189499, ICE n° 003775111000088 — Agrément n° 2939/TOUR/2025 — décision n° PCT/ATT.5",
  "contact": "www.ludy.ma · reservation@ludy.ma · WhatsApp +212 (0)7 01 04 24 96"
}$g$::jsonb)
on conflict (id) do nothing;

create table if not exists public.missions (
  id bigserial primary key,
  number text unique,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  status text not null default 'Demande' check (status in ('Demande', 'Devis envoyé', 'Accepté', 'Acompte reçu', 'Confirmée', 'En cours', 'Terminée', 'Facturée', 'Annulée', 'Refusée')),
  agency_id bigint references public.agencies(id) on delete set null,
  client_name text, client_company text, client_phone text, client_email text,
  kind text,                              -- type de prestation (transfert, mise à disposition…)
  category text,                          -- catégorie de véhicule de la grille (SONATA, STARIA…)
  vehicle_key text,                       -- véhicule bloqué pour la mission (contrôle Geotab)
  driver_name text,
  start_at timestamptz, end_at timestamptz,
  level text,                             -- Standard / Intensive / 24h-VIP
  needs_validation boolean not null default false,
  validated_by uuid, validated_at timestamptz,
  total_ttc double precision, deposit double precision,
  data jsonb not null default '{}'::jsonb -- fiche de découverte, lignes du devis, conditions, historique des statuts
);
create index if not exists missions_start on public.missions(start_at);
create index if not exists missions_vk on public.missions(vehicle_key, start_at);
create sequence if not exists public.mission_number_seq;

-- numéro de devis DEV-aaaa-nnnn attribué par la base (jamais deux fois le même)
create or replace function public.mission_number() returns trigger language plpgsql set search_path = public as $$
begin
  if new.number is null then new.number := 'DEV-' || to_char(now() at time zone 'Africa/Casablanca', 'YYYY') || '-' || lpad(nextval('public.mission_number_seq')::text, 4, '0'); end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists missions_number on public.missions;
create trigger missions_number before insert or update on public.missions for each row execute function public.mission_number();

alter table public.pricing_grid enable row level security;
alter table public.missions enable row level security;
revoke all on public.pricing_grid, public.missions from anon;
revoke insert, update, delete, truncate, references, trigger on public.pricing_grid, public.missions from authenticated;
grant select on public.pricing_grid, public.missions to authenticated;
grant insert (data) on public.pricing_grid to authenticated;
grant update (data, updated_at, updated_by) on public.pricing_grid to authenticated;
-- missions : pas de numéro, d'auteur ni de validation écrits par le site (base) ; validation par l'administrateur seul (règle ci-dessous)
grant insert (status, agency_id, client_name, client_company, client_phone, client_email, kind, category, vehicle_key, driver_name,
  start_at, end_at, level, needs_validation, total_ttc, deposit, data) on public.missions to authenticated;
grant update (status, agency_id, client_name, client_company, client_phone, client_email, kind, category, vehicle_key, driver_name,
  start_at, end_at, level, needs_validation, validated_by, validated_at, total_ttc, deposit, data) on public.missions to authenticated;
grant delete on public.missions to authenticated;
grant usage on sequence public.missions_id_seq, public.mission_number_seq to authenticated;

-- Grille : lue par l'administrateur et les gestionnaires, modifiée par l'administrateur seul
drop policy if exists read_mgr on public.pricing_grid;
drop policy if exists admin_all on public.pricing_grid;
create policy read_mgr on public.pricing_grid for select to authenticated using (public.my_role() in ('admin', 'manager'));
create policy admin_all on public.pricing_grid for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Missions : administrateur = tout ; gestionnaire = celles de ses agences, celles qu'il a créées et celles sans agence ;
-- lecture seule = lecture de ses agences
drop policy if exists read_agency on public.missions;
drop policy if exists mgr_insert on public.missions;
drop policy if exists mgr_update on public.missions;
drop policy if exists admin_delete on public.missions;
create policy read_agency on public.missions for select to authenticated
  using ((select public.is_admin()) or created_by = auth.uid() or agency_id = any((select public.my_agency_ids())::bigint[])
    or (public.my_role() = 'manager' and agency_id is null));
create policy mgr_insert on public.missions for insert to authenticated
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and (agency_id is null or agency_id = any((select public.my_agency_ids())::bigint[]))
    and validated_by is null and validated_at is null));
create policy mgr_update on public.missions for update to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and (created_by = auth.uid() or agency_id is null or agency_id = any((select public.my_agency_ids())::bigint[]))))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and (agency_id is null or agency_id = any((select public.my_agency_ids())::bigint[]))));
create policy admin_delete on public.missions for delete to authenticated using ((select public.is_admin()));

-- validation de l'exploitation (section 17) : seulement l'administrateur ; un gestionnaire ne peut ni valider ni retirer une validation
create or replace function public.mission_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(public.my_role(), 'service') = 'manager' then
    if tg_op = 'INSERT' and (new.validated_by is not null or new.validated_at is not null) then
      raise exception 'validation réservée à l''administrateur';
    end if;
    if tg_op = 'UPDATE' and (new.validated_by is distinct from old.validated_by or new.validated_at is distinct from old.validated_at) then
      raise exception 'validation réservée à l''administrateur';
    end if;
    -- devis à valider : pas d'envoi ni de confirmation tant que l'administrateur n'a pas validé
    if new.needs_validation and new.validated_at is null and new.status not in ('Demande', 'Annulée', 'Refusée') then
      raise exception 'validation de l''exploitation requise avant « % »', new.status;
    end if;
  end if;
  -- mission modifiée après validation (prix, dates, véhicule demandé, niveau) : la validation tombe, à refaire
  if tg_op = 'UPDATE' and old.validated_at is not null and new.validated_at is not distinct from old.validated_at
     and (new.total_ttc is distinct from old.total_ttc or new.start_at is distinct from old.start_at or new.end_at is distinct from old.end_at
          or new.category is distinct from old.category or new.level is distinct from old.level) then
    -- gestionnaire : un devis validé déjà envoyé ou confirmé n'est modifié que par l'administrateur (le prix validé protège l'entreprise)
    if coalesce(public.my_role(), '') = 'manager' and new.needs_validation and new.status not in ('Demande', 'Annulée', 'Refusée') then
      raise exception 'devis validé par l''exploitation : prix, dates, véhicule et niveau modifiables seulement par l''administrateur';
    end if;
    new.validated_at := null; new.validated_by := null;
  end if;
  return new;
end $$;
drop trigger if exists missions_guard on public.missions;
create trigger missions_guard before insert or update on public.missions for each row execute function public.mission_guard();
