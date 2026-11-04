-- =============================================================================
-- Manifestes de passagers (17/10/2026) : générés dans Ludy (page Manifeste), partagés par WhatsApp / e-mail.
-- À exécuter une fois dans Supabase > SQL Editor (après 20261026000000_shift_avance.sql). Rejouable sans risque.
-- - parc : N° d'agrément (imprimé à la place du N° d'autorisation de l'entreprise) et nombre de places autorisées
-- - manifest_config : données de l'entreprise imprimées sur le manifeste, cachet (image), destinataires e-mail par défaut
-- - manifests : historique (données du formulaire, fichier PDF dans le stockage « manifestes »)
-- - stockage privé « manifestes » : PDF ; lien signé (7 jours) dans le message WhatsApp / e-mail
-- - demande « manifest_mail » : e-mail avec le PDF joint envoyé par le collecteur
-- =============================================================================
alter table public.parc add column if not exists agrement text;
alter table public.parc add column if not exists seats integer;

-- N° d'agrément des véhicules (liste du modèle de manifeste d'Ahmed), seulement s'il n'est pas déjà renseigné
update public.parc p set agrement = v.a from (values
  ('86433-T-1', 'TT/43186/2025'), ('86120-T-1', 'TT/43190/2025'), ('86122-T-1', 'TT/43189/2025'), ('86121-T-1', 'TT/43188/2025'),
  ('86437-T-1', 'TT/43187/2025'), ('86432-T-1', 'TT/43193/2025'), ('86431-T-1', 'TT/43192/2025'), ('86119-T-1', 'TT/43191/2025')) v(plate, a)
 where public.norm_plate(p.plate) = public.norm_plate(v.plate) and coalesce(p.agrement, '') = '';

create table if not exists public.manifest_config (
  id integer primary key default 1 check (id = 1),
  company jsonb not null default '{}'::jsonb,   -- nom, adresse, tel, autorisation, dossier
  email_to text,                                -- destinataires par défaut de l'envoi par e-mail (séparés par des virgules)
  stamp text,                                   -- cachet : image PNG (data:image/png;base64,…), fond transparent
  updated_at timestamptz not null default now()
);
insert into public.manifest_config (id, company) values (1, jsonb_build_object(
  'nom', 'LUXURY & DISCOVERY', 'adresse', 'IMM 33 APPT N°3 1ER ETAGE RUE LOUBNANE OCEAN RABAT, RABAT', 'tel', '0701042514',
  'autorisation', 'TT/43187/2025', 'dossier', '2939/TOUR/2025'))
on conflict (id) do nothing;

create table if not exists public.manifests (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  vehicle_key text, plate text, driver_name text, driver_phone text, client text,
  depart_at timestamptz, file_name text, file_path text,
  message text,                                 -- message de partage (WhatsApp / e-mail)
  data jsonb not null default '{}'::jsonb       -- formulaire (pour « Reprendre » une course)
);
create index if not exists manifests_created on public.manifests(created_at desc);

alter table public.manifest_config enable row level security;
alter table public.manifests enable row level security;
revoke all on public.manifest_config, public.manifests from anon;
grant select, insert, update on public.manifest_config to authenticated;
grant select, insert, update, delete on public.manifests to authenticated;
grant usage, select on sequence public.manifests_id_seq to authenticated;

-- Données de l'entreprise et cachet : lus par l'administrateur et les gestionnaires, modifiés par l'administrateur
drop policy if exists read_mgr on public.manifest_config;
drop policy if exists admin_all on public.manifest_config;
create policy read_mgr on public.manifest_config for select to authenticated using (public.my_role() in ('admin', 'manager'));
create policy admin_all on public.manifest_config for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Historique : véhicules de ses agences ; créé par l'administrateur ou un gestionnaire (ses véhicules)
drop policy if exists read_agency on public.manifests;
drop policy if exists mgr_insert on public.manifests;
drop policy if exists own_update on public.manifests;
drop policy if exists admin_delete on public.manifests;
create policy read_agency on public.manifests for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]));
create policy mgr_insert on public.manifests for insert to authenticated
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and vehicle_key = any((select public.my_vehicle_keys())::text[])));
create policy own_update on public.manifests for update to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and created_by = auth.uid()))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and created_by = auth.uid() and vehicle_key = any((select public.my_vehicle_keys())::text[])));
create policy admin_delete on public.manifests for delete to authenticated using ((select public.is_admin()));

-- Demandes du site : « manifest_mail » (e-mail avec le PDF joint) pour un manifeste que l'on peut lire
drop policy if exists mgr_insert on public.jobs;
create policy mgr_insert on public.jobs for insert to authenticated
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and (
    kind in ('sync_now', 'recompute', 'after_inject', 'apply_plates')
    or (kind = 'driver_report' and case when coalesce(arg, '') ~ '^\s*\{' then (arg::jsonb ->> 'code') = any((select public.my_driver_codes())::text[]) else false end)
    or (kind = 'manifest_mail' and case when coalesce(arg, '') ~ '^\s*\{"id":\s*\d{1,18}\s*[,}]' then exists (select 1 from public.manifests m
      where m.id = (arg::jsonb ->> 'id')::bigint and m.vehicle_key = any((select public.my_vehicle_keys())::text[])) else false end))));

-- Stockage des PDF (Supabase Storage, privé) : absent de la base de test, d'où le bloc conditionnel
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('manifestes', 'manifestes', false) on conflict (id) do nothing;
    execute 'drop policy if exists manifestes_insert on storage.objects';
    execute 'drop policy if exists manifestes_select on storage.objects';
    execute $p$create policy manifestes_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'manifestes' and public.my_role() in ('admin', 'manager'))$p$;
    execute $p$create policy manifestes_select on storage.objects for select to authenticated
      using (bucket_id = 'manifestes' and public.my_role() in ('admin', 'manager'))$p$;
  end if;
end $$;
