-- Local staging only. Explicit administrative identity decisions; no money,
-- financial history, provider observation or vehicle assignment is rewritten.
do $$ begin
 if (select value from public.params where key='environment') is distinct from 'staging'
 then raise exception 'Staging required';end if;
end $$;

create function public.provider_earnings_reconciliation_queue(p_snapshot uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare target public.provider_earnings_snapshots; org uuid;
begin
 if (select value from public.params where key='environment') is distinct from 'staging'
  or auth.uid() is null or public.is_admin() is distinct from true then raise exception 'Administrateur local requis' using errcode='42501';end if;
 select organization_id into org from public.uber_report_settings where id=1;
 select * into target from public.provider_earnings_snapshots s where s.organization_id=org
  and (p_snapshot is null or s.id=p_snapshot)
  order by (s.period_start<=now() and s.period_end>now()) desc,s.period_start desc,s.observed_at desc limit 1;
 if target.id is null then return jsonb_build_object('version',1,'snapshot',null,'rows','[]'::jsonb,'drivers','[]'::jsonb,'agencies','[]'::jsonb);end if;
 return jsonb_build_object('version',1,'snapshot',jsonb_build_object('id',target.id,'revision',target.revision,
   'period_start',target.period_start,'period_end',target.period_end,'observed_at',target.observed_at,'total_rows',target.coverage->'driver_rows_observed'),
  'rows',coalesce((select jsonb_agg(jsonb_build_object('provider_row',r.provider_row,'provider_driver_id',r.provider_driver_id,
   'driver_name',r.driver_name,'driver_name_complete',r.driver_name_complete,'mapping_status',r.mapping_status,
   'latest_decision',(select jsonb_build_object('decision','confirmed_identity','created_at',a.at,
    'driver_code',a.evidence->>'ludy_driver_code','agency_id',a.evidence->'agency_id',
    'evidence_kind',a.evidence->>'evidence_kind','evidence_reference',a.evidence->>'evidence_reference')
    from public.fleet_link_audit a where a.evidence->>'method'='financial_manual_review'
     and a.evidence->>'organization_id'=r.organization_id::text
     and a.evidence->>'provider_driver_id'=r.provider_driver_id::text
    order by a.at desc,a.id desc limit 1)) order by r.provider_row)
   from public.provider_earnings_rows r where r.snapshot_id=target.id and r.mapping_status<>'confirmed'),'[]'::jsonb),
  'drivers',coalesce((select jsonb_agg(jsonb_build_object('code',d.code,'name',d.name,'agency_id',d.agency_id) order by d.name,d.code) from public.drivers d),'[]'::jsonb),
  'agencies',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) order by a.name,a.id) from public.agencies a),'[]'::jsonb));
end $$;
revoke all on function public.provider_earnings_reconciliation_queue(uuid) from public,anon,service_role;
grant execute on function public.provider_earnings_reconciliation_queue(uuid) to authenticated;

create function public.provider_earnings_reconcile(p_snapshot uuid,p_revision bigint,p_row integer,
 p_driver_code text,p_agency_id bigint,p_evidence_kind text,p_evidence_reference text,
 p_confirm boolean default false,p_assign_missing_agency boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); snapshot public.provider_earnings_snapshots; entry public.provider_earnings_rows;
 reference public.drivers; identity_ids uuid[]; source_driver uuid; canonical uuid; destination uuid;
 old_agency bigint; audit_id uuid; decision text; evidence jsonb; org uuid;
 retained_vehicle text; source_vehicle text;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' or actor is null
 then raise exception 'Administrateur local requis' using errcode='42501';end if;
 -- Revalidate the role inside the write transaction. A concurrent role change
 -- waits for this decision; the HTTP/UI role is never trusted as authorization.
 perform 1 from public.profiles where user_id=actor and role='admin' for share;
 if not found then raise exception 'Administrateur local requis' using errcode='42501';end if;
 if p_revision is null or p_revision<1 or p_row is null or p_row not between 0 and 4999
  or length(btrim(coalesce(p_driver_code,''))) not between 1 and 120 or p_agency_id is null or p_agency_id<=0
  or p_evidence_kind is null or p_evidence_kind not in('provider_profile','provider_export','signed_record')
  or length(btrim(coalesce(p_evidence_reference,''))) not between 10 and 1000 or p_evidence_reference~'[[:cntrl:]]'
  or p_confirm is distinct from true or p_assign_missing_agency is null then raise exception 'Preuve et sélection explicites requises' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fleet-link-assignments',0));
 select organization_id into org from public.uber_report_settings where id=1 for share;
 select * into snapshot from public.provider_earnings_snapshots where id=p_snapshot and organization_id=org for update;
 if not found or snapshot.revision<>p_revision then raise exception 'Le relevé a changé. Relisez la ligne avant de confirmer.' using errcode='40001';end if;
 select * into entry from public.provider_earnings_rows where snapshot_id=p_snapshot and provider_row=p_row and snapshot_revision=p_revision for update;
 if not found or entry.mapping_status='confirmed' then raise exception 'Cette ligne doit être relue.' using errcode='40001';end if;
 select * into reference from public.drivers where code=p_driver_code for update;
 if not found then raise exception 'Fiche Ludy absente' using errcode='22023';end if;
 perform 1 from public.agencies where id=p_agency_id for share;
 if not found or (reference.agency_id is not null and reference.agency_id<>p_agency_id)
 then raise exception 'Agence incompatible avec la fiche Ludy' using errcode='22023';end if;
 old_agency:=reference.agency_id;
 if p_confirm and entry.provider_driver_id is null then raise exception 'UUID fournisseur non prouvé : fournissez une preuve fournisseur avant le rapprochement' using errcode='22023';end if;
 if p_confirm and old_agency is null and not p_assign_missing_agency
 then raise exception 'Confirmez explicitement l’agence de cette fiche sans agence' using errcode='22023';end if;
 decision:='confirmed_identity';
 evidence:=jsonb_build_object('method','financial_manual_review','actor',actor,'snapshot_id',p_snapshot,'snapshot_revision',p_revision,
  'provider_row',p_row,'organization_id',org,'provider_driver_id',entry.provider_driver_id,'ludy_driver_code',p_driver_code,
  'agency_id',p_agency_id,'evidence_kind',p_evidence_kind,'evidence_reference',btrim(p_evidence_reference));
 if p_confirm then
  lock table public.fleet_identities in share row exclusive mode;
  select array_agg(distinct i.driver_id) into identity_ids from public.fleet_identities i
   where i.source='uber' and lower(i.organization_id)=org::text and lower(i.external_id)=entry.provider_driver_id::text;
  if cardinality(identity_ids)>1 then raise exception 'UUID déjà associé à plusieurs profils : revue requise' using errcode='23505';end if;
  source_driver:=identity_ids[1];
  select id into destination from public.fleet_drivers where ludy_driver_code=p_driver_code for update;
  if source_driver is not null and exists(select 1 from public.fleet_drivers where id=source_driver and ludy_driver_code is not null and ludy_driver_code<>p_driver_code)
  then raise exception 'Cet UUID possède déjà une autre fiche Ludy' using errcode='23505';end if;
  if exists(select 1 from public.fleet_drivers d where d.id in(destination,source_driver)
    and d.agency_id is not null and d.agency_id<>p_agency_id)
  then raise exception 'Agence contradictoire sur un profil existant : revue requise' using errcode='23505';end if;
  if exists(select 1 from public.fleet_identities i where i.driver_id in(destination,source_driver)
    and i.source='uber' and lower(i.organization_id)=org::text and i.external_id is not null and lower(i.external_id)<>entry.provider_driver_id::text)
  then raise exception 'La fiche choisie possède déjà un autre UUID Uber pour cette flotte' using errcode='23505';end if;
  if old_agency is null then update public.drivers set agency_id=p_agency_id where code=p_driver_code;end if;
  if source_driver is null then
   source_driver:=destination;
   if source_driver is null then insert into public.fleet_drivers(name) values(reference.name) returning id into source_driver;end if;
   insert into public.fleet_identities(driver_id,source,source_key,external_id,organization_id,provisional)
    values(source_driver,'uber',org::text||':'||entry.provider_driver_id::text,entry.provider_driver_id::text,org::text,false);
  end if;
  select vehicle_key into retained_vehicle from public.fleet_drivers where id=coalesce(destination,source_driver) for update;
  select vehicle_key into source_vehicle from public.fleet_drivers where id=source_driver for update;
  if destination is not null and destination<>source_driver and source_vehicle is not null
   and source_vehicle is distinct from retained_vehicle then
   raise exception 'Les profils portent des véhicules différents : revue des associations existantes requise' using errcode='23505';
  end if;
  if destination is not null and destination<>source_driver and exists(
   select 1 from public.fleet_drivers a join public.fleet_drivers b on b.id=destination where a.id=source_driver
    and (a.auto_link_disabled is distinct from b.auto_link_disabled or a.vehicle_link_method is distinct from b.vehicle_link_method)) then
   raise exception 'Les profils ont des modes de véhicule différents : revue des associations existantes requise' using errcode='23505';
  end if;
  -- Reuse the historical-reference preserving merge, without the wrapper that
  -- changes manual/automatic vehicle mode. No vehicle is selected by this RPC.
  canonical:=public.fleet_link_driver_base(source_driver,p_driver_code,retained_vehicle,p_agency_id);
  update public.fleet_drivers set link_method='manual',link_evidence=evidence where id=canonical;
  update public.fleet_identities set provisional=false where driver_id=canonical and source='uber'
   and lower(organization_id)=org::text and lower(external_id)=entry.provider_driver_id::text;
  insert into public.fleet_link_audit(driver_id,action,method,evidence) values(canonical,'associate','manual',evidence) returning id into audit_id;
 end if;
 return jsonb_build_object('version',1,'audit_id',audit_id,'decision',decision,'financial_history_unchanged',true,
  'awaiting_provider_uuid',entry.provider_driver_id is null,'awaiting_next_collection',p_confirm,
  'agency_assigned',p_confirm and old_agency is null);
end $$;
revoke all on function public.provider_earnings_reconcile(uuid,bigint,integer,text,bigint,text,text,boolean,boolean) from public,anon,service_role;
grant execute on function public.provider_earnings_reconcile(uuid,bigint,integer,text,bigint,text,text,boolean,boolean) to authenticated;
