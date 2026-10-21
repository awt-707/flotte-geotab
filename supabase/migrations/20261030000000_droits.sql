-- =============================================================================
-- Droits (relecture du 18/10/2026). À exécuter une fois dans Supabase > SQL Editor (après 20261029000000_planning.sql). Rejouable sans risque.
-- 1. Supabase donne par défaut TOUS les droits sur les tables à anon / authenticated : les « grant update (colonnes) » des migrations
--    précédentes ne limitaient donc rien (seules les règles RLS protégeaient). Les droits d'écriture sont retirés puis redonnés colonne
--    par colonne : un gestionnaire ne peut plus changer que le statut / commentaire d'une alerte, le statut d'un plein ou d'un ticket…
-- 2. Demandes (jobs) : l'auteur est toujours l'utilisateur connecté (non falsifiable) ; chacun ne lit que ses demandes (admin : toutes).
-- 3. PDF des manifestes (stockage) : lisibles seulement pour les véhicules de ses agences (ou par celui qui les a créés).
-- =============================================================================

-- 1. anon n'écrit rien ; authenticated : seulement les colonnes prévues (les règles RLS restent en plus)
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon;
revoke update on public.alerts, public.fuel, public.fuel_card_tx, public.drivers, public.vehicles, public.profiles, public.rules, public.params,
  public.manifests, public.jobs from authenticated;
revoke insert on public.drivers, public.jobs, public.manifests from authenticated;
revoke truncate, references, trigger on all tables in schema public from authenticated;
grant update (status, comment) on public.alerts to authenticated;
grant update (status) on public.fuel to authenticated;
grant update (status, note) on public.fuel_card_tx to authenticated;
grant insert (code, name, phone, email, agency_id, source, status, detected_at, note) on public.drivers to authenticated;
grant update (name, phone, email, status, note, agency_id) on public.drivers to authenticated;
grant update (tank_l, ref_l100, revenue, active, agency_id) on public.vehicles to authenticated;
grant update (role, name, pages) on public.profiles to authenticated;
grant update (weight) on public.rules to authenticated;
grant update (value) on public.params to authenticated;
grant insert (vehicle_key, plate, driver_name, driver_phone, client, depart_at, file_name, file_path, message, data) on public.manifests to authenticated;
grant insert (kind, arg) on public.jobs to authenticated;

-- 2. Demandes : auteur = utilisateur connecté ; lecture de ses propres demandes
drop policy if exists mgr_insert on public.jobs;
create policy mgr_insert on public.jobs for insert to authenticated
  with check (created_by = auth.uid() and ((select public.is_admin()) or (public.my_role() = 'manager' and (
    kind in ('sync_now', 'recompute', 'after_inject', 'apply_plates')
    or (kind = 'driver_report' and case when coalesce(arg, '') ~ '^\s*\{' then (arg::jsonb ->> 'code') = any((select public.my_driver_codes())::text[]) else false end)
    or (kind = 'manifest_mail' and case when coalesce(arg, '') ~ '^\s*\{"id":\s*\d{1,18}\s*[,}]' then exists (select 1 from public.manifests m
      where m.id = (arg::jsonb ->> 'id')::bigint and m.vehicle_key = any((select public.my_vehicle_keys())::text[])) else false end)))));
drop policy if exists read_mgr on public.jobs;
create policy read_mgr on public.jobs for select to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and created_by = auth.uid()));

-- 3. Stockage des manifestes : nom de fichier imposé (aaaa-mm/identifiant.pdf), lecture limitée aux véhicules de ses agences
do $$ begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists manifestes_insert on storage.objects';
    execute 'drop policy if exists manifestes_select on storage.objects';
    execute $p$create policy manifestes_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'manifestes' and public.my_role() in ('admin', 'manager') and name ~ '^\d{4}-\d{2}/[0-9A-Za-z-]{8,64}\.pdf$')$p$;
    execute $p$create policy manifestes_select on storage.objects for select to authenticated
      using (bucket_id = 'manifestes' and ((select public.is_admin())
        or (public.my_role() = 'manager' and (owner_id = auth.uid()::text
          or exists (select 1 from public.manifests m where m.file_path = name and m.vehicle_key = any((select public.my_vehicle_keys())::text[]))))))$p$;
  end if;
end $$;
