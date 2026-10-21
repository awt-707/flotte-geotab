-- =============================================================================
-- Devis envoyés directement par Ludy, PDF joint (21/10/2026, demande d'Ahmed) ; adresse d'envoi des e-mails aux clients réglable.
-- À exécuter une fois dans Supabase > SQL Editor (après 20261101000000_connexions.sql). Rejouable sans risque.
-- - params mailName / mailReplyTo / mailFrom : expéditeur des e-mails aux clients (devis, manifestes), Réglages > E-mails aux clients
-- - stockage privé « devis » : PDF des devis envoyés (aaaa-mm/identifiant.pdf), lus par le collecteur qui envoie l'e-mail
-- - demande « quote_mail » : un gestionnaire n'envoie que les devis des missions qu'il voit
-- =============================================================================
insert into public.params (key, label, value, note, sort) values
  ('mailName', 'E-mails aux clients : nom de l''expéditeur', 'Ludy', 'Nom affiché chez le client (devis, manifestes).', 110),
  ('mailReplyTo', 'E-mails aux clients : adresse de réponse', '', 'Les réponses du client arrivent à cette adresse (ex. reservation@ludy.ma). Vide : compte d''envoi de Ludy.', 111),
  ('mailFrom', 'E-mails aux clients : adresse d''envoi', '', 'Adresse affichée comme expéditeur. Doit être déclarée dans Gmail du compte du collecteur (« Envoyer des e-mails en tant que »), sinon l''e-mail part du compte du collecteur avec l''adresse de réponse ci-dessus.', 112)
on conflict (key) do nothing;

-- Demandes : quote_mail ajouté (le reste à l'identique de 20261030000000_droits.sql)
drop policy if exists mgr_insert on public.jobs;
create policy mgr_insert on public.jobs for insert to authenticated
  with check (created_by = auth.uid() and ((select public.is_admin()) or (public.my_role() = 'manager' and (
    kind in ('sync_now', 'recompute', 'after_inject', 'apply_plates')
    or (kind = 'driver_report' and case when coalesce(arg, '') ~ '^\s*\{' then (arg::jsonb ->> 'code') = any((select public.my_driver_codes())::text[]) else false end)
    or (kind = 'manifest_mail' and case when coalesce(arg, '') ~ '^\s*\{"id":\s*\d{1,18}\s*[,}]' then exists (select 1 from public.manifests m
      where m.id = (arg::jsonb ->> 'id')::bigint and m.vehicle_key = any((select public.my_vehicle_keys())::text[])) else false end)
    or (kind = 'quote_mail' and case when coalesce(arg, '') ~ '^\s*\{"id":\s*\d{1,18}\s*[,}]' then exists (select 1 from public.missions x
      where x.id = (arg::jsonb ->> 'id')::bigint and (x.created_by = auth.uid() or x.agency_id is null
        or x.agency_id = any((select public.my_agency_ids())::bigint[]))) else false end)))));

-- Stockage des devis (privé) : nom de fichier imposé ; lecture : administrateur, ou l'auteur du dépôt
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('devis', 'devis', false) on conflict (id) do nothing;
    execute 'drop policy if exists devis_insert on storage.objects';
    execute 'drop policy if exists devis_select on storage.objects';
    execute $p$create policy devis_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'devis' and public.my_role() in ('admin', 'manager') and name ~ '^\d{4}-\d{2}/[0-9A-Za-z-]{8,64}\.pdf$')$p$;
    execute $p$create policy devis_select on storage.objects for select to authenticated
      using (bucket_id = 'devis' and ((select public.is_admin()) or owner_id = auth.uid()::text))$p$;
  end if;
end $$;
