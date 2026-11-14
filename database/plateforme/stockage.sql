-- =============================================================================
-- Stockage des fichiers (Supabase Storage) : seaux et règles d'accès, copie de la production (2026-11-14).
-- Produit par « node database/outils/production.js extraire ». Sans Supabase (schéma storage absent), ce fichier ne fait rien :
-- les mêmes règles sont à reproduire dans le service de fichiers choisi (voir database/OVH.md).
-- =============================================================================
do $$ begin
  if to_regclass('storage.buckets') is null then raise notice 'pas de Supabase Storage : rien à faire'; return; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('app', 'app', true, 52428800, null) on conflict (id) do nothing;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('app-keys', 'app-keys', false, null, null) on conflict (id) do nothing;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('caisse', 'caisse', false, null, null) on conflict (id) do nothing;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('contrats', 'contrats', false, null, null) on conflict (id) do nothing;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('devis', 'devis', false, null, null) on conflict (id) do nothing;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('manifestes', 'manifestes', false, null, null) on conflict (id) do nothing;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('plannings', 'plannings', false, null, null) on conflict (id) do nothing;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('rh', 'rh', false, null, null) on conflict (id) do nothing;
  execute 'drop policy if exists caisse_insert on storage.objects';
  execute 'create policy caisse_insert on storage.objects as permissive for insert to authenticated with check (((bucket_id = ''caisse''::text) AND cash_folder_ok((storage.foldername(name))[1])))';
  execute 'drop policy if exists caisse_select on storage.objects';
  execute 'create policy caisse_select on storage.objects as permissive for select to authenticated using (((bucket_id = ''caisse''::text) AND cash_folder_ok((storage.foldername(name))[1])))';
  execute 'drop policy if exists contrats_delete on storage.objects';
  execute 'create policy contrats_delete on storage.objects as permissive for delete to authenticated using (((bucket_id = ''contrats''::text) AND ((storage.foldername(name))[1] ~ ''^\d+$''::text) AND rh_scope(NULLIF(((storage.foldername(name))[1])::bigint, 0))))';
  execute 'drop policy if exists contrats_insert on storage.objects';
  execute 'create policy contrats_insert on storage.objects as permissive for insert to authenticated with check (((bucket_id = ''contrats''::text) AND ((storage.foldername(name))[1] ~ ''^\d+$''::text) AND wc_can(NULLIF(((storage.foldername(name))[1])::bigint, 0))))';
  execute 'drop policy if exists contrats_select on storage.objects';
  execute 'create policy contrats_select on storage.objects as permissive for select to authenticated using (((bucket_id = ''contrats''::text) AND ((storage.foldername(name))[1] ~ ''^\d+$''::text) AND wc_can(NULLIF(((storage.foldername(name))[1])::bigint, 0))))';
  execute 'drop policy if exists devis_insert on storage.objects';
  execute 'create policy devis_insert on storage.objects as permissive for insert to authenticated with check (((bucket_id = ''devis''::text) AND (my_role() = ANY (ARRAY[''admin''::text, ''manager''::text])) AND (name ~ ''^\d{4}-\d{2}/[0-9A-Za-z-]{8,64}\.pdf$''::text)))';
  execute 'drop policy if exists devis_select on storage.objects';
  execute 'create policy devis_select on storage.objects as permissive for select to authenticated using (((bucket_id = ''devis''::text) AND (( SELECT is_admin() AS is_admin) OR (owner_id = (auth.uid())::text))))';
  execute 'drop policy if exists manifestes_insert on storage.objects';
  execute 'create policy manifestes_insert on storage.objects as permissive for insert to authenticated with check (((bucket_id = ''manifestes''::text) AND (my_role() = ANY (ARRAY[''admin''::text, ''manager''::text])) AND (name ~ ''^\d{4}-\d{2}/[0-9A-Za-z-]{8,64}\.pdf$''::text)))';
  execute 'drop policy if exists manifestes_select on storage.objects';
  execute 'create policy manifestes_select on storage.objects as permissive for select to authenticated using (((bucket_id = ''manifestes''::text) AND (( SELECT is_admin() AS is_admin) OR ((my_role() = ''manager''::text) AND ((owner_id = (auth.uid())::text) OR (EXISTS ( SELECT 1
   FROM manifests m
  WHERE ((m.file_path = objects.name) AND (m.vehicle_key = ANY (( SELECT my_vehicle_keys() AS my_vehicle_keys)::text[]))))))))))';
  execute 'drop policy if exists plannings_insert on storage.objects';
  execute 'create policy plannings_insert on storage.objects as permissive for insert to authenticated with check (((bucket_id = ''plannings''::text) AND ((storage.foldername(name))[1] ~ ''^\d+$''::text) AND plan_can_edit(((storage.foldername(name))[1])::bigint, NULL::date)))';
  execute 'drop policy if exists plannings_select on storage.objects';
  execute 'create policy plannings_select on storage.objects as permissive for select to authenticated using (((bucket_id = ''plannings''::text) AND ((storage.foldername(name))[1] ~ ''^\d+$''::text) AND plan_can_read(((storage.foldername(name))[1])::bigint)))';
  execute 'drop policy if exists rh_delete on storage.objects';
  execute 'create policy rh_delete on storage.objects as permissive for delete to authenticated using (((bucket_id = ''rh''::text) AND (( SELECT is_admin() AS is_admin) OR (( SELECT is_rh() AS is_rh) AND ((storage.foldername(name))[1] ~ ''^\d+$''::text) AND hr_can_emp(((storage.foldername(name))[1])::bigint)))))';
  execute 'drop policy if exists rh_insert on storage.objects';
  execute 'create policy rh_insert on storage.objects as permissive for insert to authenticated with check (((bucket_id = ''rh''::text) AND ((storage.foldername(name))[1] ~ ''^\d+$''::text) AND hr_can_emp(((storage.foldername(name))[1])::bigint)))';
  execute 'drop policy if exists rh_select on storage.objects';
  execute 'create policy rh_select on storage.objects as permissive for select to authenticated using (((bucket_id = ''rh''::text) AND ((storage.foldername(name))[1] ~ ''^\d+$''::text) AND hr_can_emp(((storage.foldername(name))[1])::bigint)))';
end $$;
