-- =============================================================================
-- Planning chauffeurs : PDF partagés sur WhatsApp (22/10/2026, demande d'Ahmed). À exécuter dans Supabase > SQL Editor
-- (après 20261107000000_ex_chauffeurs.sql). Rejouable sans risque.
-- Seau privé « plannings » : PDF de la semaine et de la veille de shift, rangés par agence (<agence>/<lundi>_….pdf) ;
-- dépôt par ceux qui peuvent modifier le planning de l'agence, lecture (lien signé 7 jours) par ceux qui peuvent le lire.
-- =============================================================================
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('plannings', 'plannings', false) on conflict (id) do nothing;
    execute 'drop policy if exists plannings_insert on storage.objects';
    execute 'drop policy if exists plannings_select on storage.objects';
    execute $p$create policy plannings_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'plannings' and (storage.foldername(name))[1] ~ '^\d+$' and public.plan_can_edit(((storage.foldername(name))[1])::bigint, null))$p$;
    execute $p$create policy plannings_select on storage.objects for select to authenticated
      using (bucket_id = 'plannings' and (storage.foldername(name))[1] ~ '^\d+$' and public.plan_can_read(((storage.foldername(name))[1])::bigint))$p$;
  end if;
end $$;
