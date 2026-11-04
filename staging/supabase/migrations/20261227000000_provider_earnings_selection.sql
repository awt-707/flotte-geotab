-- Staging only. Select a bounded set of useful windows before loading amounts.
-- Keep every exact historical window; this migration neither rewrites nor prunes it.
do $$ begin
  if (select value from public.params where key='environment') is distinct from 'staging'
  then raise exception 'Staging required'; end if;
  if to_regclass('public.provider_earnings_rows') is null
    or to_regclass('public.provider_earnings_snapshots') is null
  then raise exception 'Provider Earnings migration required'; end if;
end $$;

-- Cover selection metadata, never JSON financial amounts. Existing agency and
-- driver indexes remain available when RLS or an explicit scope narrows a read.
create index provider_earnings_snapshot_selection
  on public.provider_earnings_snapshots(source,organization_id,currency,observed_at desc)
  include(id,period_start,period_end,revision);
create index provider_earnings_row_selection
  on public.provider_earnings_rows(source,organization_id,currency,observed_at desc,snapshot_id)
  include(period_start,period_end,snapshot_revision,coverage_complete,mapping_complete,agency_id,driver_code,mapping_status);

create function public.provider_earnings_select_windows(
  p_start timestamptz,
  p_end timestamptz,
  p_organization_ids uuid[],
  p_agency_id bigint default null,
  p_driver_code text default null
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  caller_role text:=public.my_role();
  fleet_scope boolean;
  selected_ids uuid[];
begin
  if auth.uid() is null or caller_role is null or caller_role not in ('admin','manager')
  then raise exception 'Financial access required' using errcode='42501'; end if;
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end)
    or p_end<=p_start or p_end-p_start>interval '367 days'
    or p_organization_ids is null or cardinality(p_organization_ids)>100
    or array_position(p_organization_ids,null) is not null
    or (p_agency_id is not null and p_agency_id<=0)
    or (p_driver_code is not null and (length(p_driver_code) not between 1 and 100
      or btrim(p_driver_code)='' or p_driver_code ~ '[[:cntrl:]]'))
  then raise exception 'Invalid Earnings selection' using errcode='22023'; end if;
  if caller_role='manager' and p_agency_id is not null
    and not(p_agency_id=any(coalesce(public.my_agency_ids(),array[]::bigint[])))
  then raise exception 'Financial agency inaccessible' using errcode='42501'; end if;
  fleet_scope:=caller_role='admin' and p_agency_id is null and p_driver_code is null;

  with visible as materialized (
    -- Only an unfiltered administrator uses fleet metadata, including an empty
    -- fleet with zero driver rows. No header is used for a manager/scoped read.
    select s.id as snapshot_id,s.organization_id,s.currency,s.period_start,s.period_end,
      s.observed_at,s.revision,coalesce(s.coverage->'complete'='true'::jsonb,false) as complete
    from public.provider_earnings_snapshots s
    where fleet_scope and s.source='uber' and s.period_start<p_end and s.period_end>p_start
      and (cardinality(p_organization_ids)=0 or s.organization_id=any(p_organization_ids))
    union all
    select r.snapshot_id,r.organization_id,r.currency,r.period_start,r.period_end,
      r.observed_at,r.snapshot_revision as revision,
      bool_and(r.coverage_complete and r.mapping_complete) as complete
    from public.provider_earnings_rows r
    where not fleet_scope and r.source='uber' and r.period_start<p_end and r.period_end>p_start
      and (cardinality(p_organization_ids)=0 or r.organization_id=any(p_organization_ids))
      and (p_agency_id is null or r.agency_id=p_agency_id)
      and (p_driver_code is null or r.driver_code=p_driver_code)
    group by r.snapshot_id,r.organization_id,r.currency,r.period_start,r.period_end,r.observed_at,r.snapshot_revision
  ), ranked as (
    select v.*,row_number() over(partition by organization_id,currency
      order by complete desc,observed_at desc,revision desc,snapshot_id) as preferred
    from visible v
  ), bounded as (
    -- An exact requested window is retained even if it is old/partial. The
    -- other choice is the newest complete overlap, or newest partial if none
    -- is complete. The caller still validates row counts, revisions and money.
    select distinct snapshot_id from ranked
    where (period_start=p_start and period_end=p_end) or preferred=1
    order by snapshot_id limit 101
  )
  select coalesce(array_agg(snapshot_id order by snapshot_id),array[]::uuid[])
  into selected_ids from bounded;
  if cardinality(selected_ids)>100
  then raise exception 'Too many Earnings scopes; narrow the selection' using errcode='54000'; end if;
  return jsonb_build_object('version',1,'snapshot_ids',to_jsonb(selected_ids),'selection_complete',true);
end $$;
revoke all on function public.provider_earnings_select_windows(timestamptz,timestamptz,uuid[],bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.provider_earnings_select_windows(timestamptz,timestamptz,uuid[],bigint,text)
  to authenticated;
