-- Staging only. Provider Earnings are exact-period snapshots, not trip rows.
-- Fleet totals and driver subtotals are separate datasets and must not be added.
do $$ begin
  if (select value from public.params where key='environment') is distinct from 'staging'
  then raise exception 'Staging required'; end if;
  if to_regclass('public.revenue_refresh') is null then raise exception 'Revenue refresh migration required'; end if;
end $$;

create function public.provider_earnings_amounts_valid(p_amounts jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_amounts)='object'
    and p_amounts ?& array['revenue_minor','gross_minor','net_minor','cash_minor','payout_minor',
      'refunds_expenses_minor','adjustments_minor','start_balance_minor','end_balance_minor',
      'fare_minor','tips_minor','tolls_minor','bonus_minor','commission_minor']
    and not exists(select 1 from jsonb_each(p_amounts) e where
      e.key not in ('revenue_minor','gross_minor','net_minor','cash_minor','payout_minor',
        'refunds_expenses_minor','adjustments_minor','start_balance_minor','end_balance_minor',
        'fare_minor','tips_minor','tolls_minor','bonus_minor','commission_minor')
      or (e.value<>'null'::jsonb and case when jsonb_typeof(e.value)='number'
        and e.value::text ~ '^-?[0-9]+$' then abs((e.value::text)::numeric)>9007199254740991 else true end))
$$;
revoke all on function public.provider_earnings_amounts_valid(jsonb) from public,anon,authenticated,service_role;

create table public.provider_earnings_snapshots (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'uber' check(source='uber'),
  organization_id uuid not null,
  period_start timestamptz not null, period_end timestamptz not null,
  time_zone text not null check(time_zone='Africa/Casablanca'),
  period_label text not null check(length(period_label) between 1 and 200),
  period_mode text not null check(period_mode in ('provider','settlement','custom')),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  observed_at timestamptz not null, received_at timestamptz not null default now(),
  revision bigint not null default 1 check(revision>0),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  content_fingerprint text not null, mapping_fingerprint text not null,
  coverage jsonb not null, mapping_complete boolean not null,
  fleet_amounts jsonb not null check(public.provider_earnings_amounts_valid(fleet_amounts)),
  source_url text not null,
  unique(source,organization_id,period_start,period_end,currency),
  check(isfinite(period_start) and isfinite(period_end) and period_end>period_start
    and period_end-period_start<=interval '367 days'),
  check(isfinite(observed_at)), check(pg_column_size(coverage)<=2048)
);

create table public.provider_earnings_rows (
  snapshot_id uuid not null references public.provider_earnings_snapshots(id) on delete restrict,
  provider_row integer not null check(provider_row between 0 and 4999),
  source text not null check(source='uber'), organization_id uuid not null,
  period_start timestamptz not null, period_end timestamptz not null,
  time_zone text not null check(time_zone='Africa/Casablanca'),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  observed_at timestamptz not null, snapshot_revision bigint not null check(snapshot_revision>0),
  coverage_complete boolean not null, mapping_complete boolean not null,
  agency_rows_total integer not null check(agency_rows_total between 1 and 5000),
  driver_rows_total integer not null check(driver_rows_total between 1 and 5000),
  provider_driver_id uuid, driver_name text not null check(length(driver_name) between 1 and 200),
  driver_name_complete boolean not null,
  -- Historical mapping is evidence captured with this snapshot, not a cascading
  -- relation that rewrites financial history when a driver/agency is removed.
  fleet_driver_id uuid, driver_code text, agency_id bigint,
  mapping_status text not null check(mapping_status in ('confirmed','unmatched','ambiguous','unassociated')),
  amounts jsonb not null check(public.provider_earnings_amounts_valid(amounts)),
  primary key(snapshot_id,provider_row),
  check((mapping_status='confirmed' and provider_driver_id is not null and fleet_driver_id is not null
    and driver_code is not null and agency_id is not null and agency_id>0) or
    (mapping_status<>'confirmed' and driver_code is null and agency_id is null))
);
create unique index provider_earnings_one_provider_row on public.provider_earnings_rows(snapshot_id,provider_driver_id) where provider_driver_id is not null;
create index provider_earnings_scope_period on public.provider_earnings_rows(agency_id,source,period_start,period_end);
create index provider_earnings_driver_period on public.provider_earnings_rows(driver_code,source,period_start,period_end);
alter table public.provider_earnings_snapshots enable row level security;
alter table public.provider_earnings_rows enable row level security;
revoke all on public.provider_earnings_snapshots,public.provider_earnings_rows from public,anon,authenticated,service_role;
grant select on public.provider_earnings_snapshots,public.provider_earnings_rows to authenticated,service_role;
create policy provider_earnings_fleet_admin on public.provider_earnings_snapshots for select to authenticated
  using((select public.is_admin()));
create policy provider_earnings_driver_scope on public.provider_earnings_rows for select to authenticated
  using((select public.is_admin()) or (public.my_role()='manager' and mapping_status='confirmed'
    and agency_id=any((select public.my_agency_ids())::bigint[])));

create function public.provider_earnings_commit(p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  field_names text[]:=array['revenue_minor','gross_minor','net_minor','cash_minor','payout_minor',
    'refunds_expenses_minor','adjustments_minor','start_balance_minor','end_balance_minor',
    'fare_minor','tips_minor','tolls_minor','bonus_minor','commission_minor'];
  org uuid; period_from timestamptz; period_to timestamptz; observed timestamptz; currency_code text;
  complete boolean; total_rows integer; entry jsonb; row_number integer; metric_values jsonb;
  candidate_ids uuid[]; target_fleet uuid; target_code text; target_agency bigint; target_method text; reference_agency bigint;
  mapping_state text; mapped_rows jsonb:='[]'::jsonb; mapping_digest text; content_digest text;
  matched integer:=0; all_mapped boolean; old_agencies bigint[]:=array[0]::bigint[]; touched_agency bigint;
  existing public.provider_earnings_snapshots%rowtype; snapshot_uuid uuid; snapshot_version bigint;
begin
  if (select value from public.params where key='environment') is distinct from 'staging'
  then raise exception 'Staging required'; end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' or pg_column_size(p_snapshot)>4194304
    or p_snapshot->>'version' is distinct from '1' or p_snapshot->>'source' is distinct from 'uber_fleet_earnings'
    or exists(select 1 from jsonb_object_keys(p_snapshot) k where k not in
      ('version','source','organization_id','source_url','observed_at','provider_period','currency','fleet','drivers','coverage','sha256'))
    or coalesce(p_snapshot->>'organization_id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    or coalesce(p_snapshot->>'currency','') !~ '^[A-Z]{3}$'
    or coalesce(p_snapshot->>'sha256','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_snapshot->'drivers') is distinct from 'array'
    or jsonb_typeof(p_snapshot->'coverage') is distinct from 'object'
    or jsonb_typeof(p_snapshot->'provider_period') is distinct from 'object'
    or public.provider_earnings_amounts_valid(p_snapshot->'fleet') is distinct from true then
    raise exception 'Invalid provider earnings snapshot';
  end if;
  org:=(p_snapshot->>'organization_id')::uuid; currency_code:=p_snapshot->>'currency';
  period_from:=(p_snapshot#>>'{provider_period,start_at}')::timestamptz;
  period_to:=(p_snapshot#>>'{provider_period,end_at}')::timestamptz;
  observed:=(p_snapshot->>'observed_at')::timestamptz;
  if period_from is null or period_to is null or not isfinite(period_from) or not isfinite(period_to)
    or period_to<=period_from or period_to-period_from>interval '367 days' or period_to>now()+interval '8 days'
    or observed is null or not isfinite(observed) or observed>now()+interval '1 minute' or observed<now()-interval '15 minutes'
    or p_snapshot#>>'{provider_period,time_zone}' is distinct from 'Africa/Casablanca'
    or coalesce(p_snapshot#>>'{provider_period,mode}','') not in ('provider','settlement','custom')
    or length(coalesce(p_snapshot#>>'{provider_period,label}','')) not between 1 and 200
    or exists(select 1 from jsonb_object_keys(p_snapshot->'provider_period') k where k not in ('start_at','end_at','time_zone','label','mode'))
    or length(coalesce(p_snapshot->>'source_url',''))>500
    or coalesce(p_snapshot->>'source_url','') !~ ('^https://fleethub[.]uber[.]com/orgs/'||org::text||'/[A-Za-z0-9/_-]+$') then
    raise exception 'Invalid provider earnings period or source';
  end if;
  total_rows:=jsonb_array_length(p_snapshot->'drivers');
  if total_rows>5000 or jsonb_typeof(p_snapshot#>'{coverage,complete}') is distinct from 'boolean'
    or jsonb_typeof(p_snapshot#>'{coverage,filtered}') is distinct from 'boolean'
    or (p_snapshot#>>'{coverage,complete}'='true' and p_snapshot#>>'{coverage,filtered}'='true')
    or (p_snapshot#>>'{coverage,driver_rows_observed}')::integer is distinct from total_rows
    or coalesce(p_snapshot#>>'{coverage,pages}','') !~ '^[0-9]+$'
    or (p_snapshot#>>'{coverage,pages}')::integer not between 1 and 100
    or exists(select 1 from jsonb_object_keys(p_snapshot->'coverage') k where k not in ('complete','filtered','driver_rows_observed','driver_rows_total','pages','reason'))
    or pg_column_size(p_snapshot->'coverage')>2048 then raise exception 'Invalid provider earnings coverage';end if;
  complete:=(p_snapshot#>>'{coverage,complete}')::boolean;
  if (p_snapshot#>>'{coverage,driver_rows_total}')::integer<total_rows
    or (p_snapshot#>>'{coverage,driver_rows_total}')::integer>5000
    or (complete and p_snapshot#>>'{coverage,driver_rows_total}' is not null
      and (p_snapshot#>>'{coverage,driver_rows_total}')::integer<>total_rows)
    or exists(select 1 from jsonb_array_elements(p_snapshot->'drivers') r where r->>'provider_driver_id' is not null
      group by r->>'provider_driver_id' having count(*)>1) then raise exception 'Incomplete or duplicated earnings population';end if;

  -- Match only confirmed provider UUIDs in this organization. The shared lock
  -- serializes with local association changes; names never supply an agency.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fleet-link-assignments',0));
  for entry,row_number in select value,(ordinality-1)::integer from jsonb_array_elements(p_snapshot->'drivers') with ordinality loop
    if jsonb_typeof(entry) is distinct from 'object' or (entry->>'provider_row')::integer is distinct from row_number
      or length(btrim(coalesce(entry->>'driver_name',''))) not between 1 and 200 or entry->>'driver_name' ~ '[[:cntrl:]]'
      or jsonb_typeof(entry->'driver_name_complete') is distinct from 'boolean'
      or (entry->>'provider_driver_id' is not null and entry->>'provider_driver_id' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
      or exists(select 1 from jsonb_object_keys(entry) k where not(k=any(field_names)) and k not in ('provider_row','provider_driver_id','driver_name','driver_name_complete')) then
      raise exception 'Invalid earnings driver row';
    end if;
    select jsonb_object_agg(key,value) into metric_values from jsonb_each(entry) where key=any(field_names);
    if public.provider_earnings_amounts_valid(metric_values) is distinct from true then raise exception 'Invalid earnings driver amounts';end if;
    candidate_ids:=null; target_fleet:=null; target_code:=null; target_agency:=null; target_method:=null; reference_agency:=null;
    if entry->>'provider_driver_id' is not null then
      select array_agg(distinct i.driver_id) into candidate_ids from public.fleet_identities i
        where i.source='uber' and lower(i.organization_id)=org::text and not i.provisional
          and lower(i.external_id)=entry->>'provider_driver_id';
    end if;
    mapping_state:=case when cardinality(candidate_ids)>1 then 'ambiguous' else 'unmatched' end;
    if cardinality(candidate_ids)=1 then
      select d.id,d.ludy_driver_code,d.agency_id,d.link_method,r.agency_id
        into target_fleet,target_code,target_agency,target_method,reference_agency
        from public.fleet_drivers d left join public.drivers r on r.code=d.ludy_driver_code where d.id=candidate_ids[1];
      if target_code is not null and target_agency>0 and reference_agency=target_agency
        and target_method in ('manual','exact_name','name_spacing') then mapping_state:='confirmed';matched:=matched+1;
      else mapping_state:='unassociated';target_code:=null;target_agency:=null;end if;
    end if;
    mapped_rows:=mapped_rows||jsonb_build_array(jsonb_build_object(
      'provider_row',row_number,'provider_driver_id',entry->'provider_driver_id',
      'driver_name',entry->>'driver_name','driver_name_complete',(entry->>'driver_name_complete')::boolean,
      'fleet_driver_id',target_fleet,'driver_code',target_code,'agency_id',target_agency,
      'mapping_status',mapping_state,'amounts',metric_values));
  end loop;
  all_mapped:=matched=total_rows;
  mapping_digest:=md5(mapped_rows::text);
  content_digest:=md5((p_snapshot-'observed_at'-'sha256')::text);
  select * into existing from public.provider_earnings_snapshots
    where source='uber' and organization_id=org and period_start=period_from and period_end=period_to and currency=currency_code for update;
  if found then
    if observed<existing.observed_at or (not complete and (existing.coverage->>'complete')::boolean) then
      return jsonb_build_object('snapshot_id',existing.id,'revision',existing.revision,'duplicate',false,'ignored',true,
        'reason',case when observed<existing.observed_at then 'stale_observation' else 'complete_snapshot_preserved' end,
        'rows',(existing.coverage->>'driver_rows_observed')::integer,'coverage_complete',(existing.coverage->>'complete')::boolean,
        'mapping_complete',existing.mapping_complete);
    end if;
    if existing.content_fingerprint=content_digest and existing.mapping_fingerprint=mapping_digest and existing.observed_at=observed then
      return jsonb_build_object('snapshot_id',existing.id,'revision',existing.revision,'duplicate',true,'ignored',false,
        'rows',total_rows,'matched',matched,'unmatched',total_rows-matched,'coverage_complete',complete,'mapping_complete',all_mapped);
    end if;
    if existing.observed_at=observed and existing.content_fingerprint<>content_digest then raise exception 'Conflicting earnings observation';end if;
    select array_agg(distinct coalesce(agency_id,0)) into old_agencies from public.provider_earnings_rows where snapshot_id=existing.id;
  end if;
  insert into public.provider_earnings_snapshots(source,organization_id,period_start,period_end,time_zone,period_label,period_mode,
    currency,observed_at,sha256,content_fingerprint,mapping_fingerprint,coverage,mapping_complete,fleet_amounts,source_url)
  values('uber',org,period_from,period_to,'Africa/Casablanca',p_snapshot#>>'{provider_period,label}',p_snapshot#>>'{provider_period,mode}',
    currency_code,observed,p_snapshot->>'sha256',content_digest,mapping_digest,p_snapshot->'coverage',all_mapped,p_snapshot->'fleet',p_snapshot->>'source_url')
  on conflict(source,organization_id,period_start,period_end,currency) do update set
    period_label=excluded.period_label,period_mode=excluded.period_mode,observed_at=excluded.observed_at,received_at=now(),
    revision=public.provider_earnings_snapshots.revision+1,sha256=excluded.sha256,content_fingerprint=excluded.content_fingerprint,
    mapping_fingerprint=excluded.mapping_fingerprint,coverage=excluded.coverage,mapping_complete=excluded.mapping_complete,
    fleet_amounts=excluded.fleet_amounts,source_url=excluded.source_url
  returning id,revision into snapshot_uuid,snapshot_version;
  -- Replace rows only inside this exact snapshot window. Other periods and all
  -- historical CSV/cash tables remain untouched. Partial data cannot erase a full capture.
  delete from public.provider_earnings_rows where snapshot_id=snapshot_uuid;
  insert into public.provider_earnings_rows(snapshot_id,provider_row,source,organization_id,period_start,period_end,time_zone,currency,
    observed_at,snapshot_revision,coverage_complete,mapping_complete,agency_rows_total,driver_rows_total,
    provider_driver_id,driver_name,driver_name_complete,fleet_driver_id,driver_code,agency_id,mapping_status,amounts)
  select snapshot_uuid,r.provider_row,'uber',org,period_from,period_to,'Africa/Casablanca',currency_code,
    observed,snapshot_version,complete,all_mapped,(count(*) over(partition by r.agency_id))::integer,
    (count(*) over(partition by r.driver_code))::integer,r.provider_driver_id,r.driver_name,r.driver_name_complete,
    r.fleet_driver_id,r.driver_code,r.agency_id,r.mapping_status,r.amounts
  from jsonb_to_recordset(mapped_rows) as r(provider_row integer,provider_driver_id uuid,driver_name text,driver_name_complete boolean,
    fleet_driver_id uuid,driver_code text,agency_id bigint,mapping_status text,amounts jsonb);
  -- Only minimal refresh markers are published. Include old and new agencies,
  -- sorted, and the admin marker for the independent fleet total.
  for touched_agency in select distinct scope from (
    select unnest(coalesce(old_agencies,array[]::bigint[])) scope union select 0
    union select coalesce((r->>'agency_id')::bigint,0) from jsonb_array_elements(mapped_rows) r
  ) scopes order by scope loop
    insert into public.revenue_refresh(agency_id,version,touched_at) values(touched_agency,1,clock_timestamp())
      on conflict(agency_id) do update set version=public.revenue_refresh.version+1,touched_at=clock_timestamp();
  end loop;
  return jsonb_build_object('snapshot_id',snapshot_uuid,'revision',snapshot_version,'duplicate',false,'ignored',false,
    'rows',total_rows,'matched',matched,'unmatched',total_rows-matched,'coverage_complete',complete,'mapping_complete',all_mapped);
end $$;
revoke all on function public.provider_earnings_commit(jsonb) from public,anon,authenticated;
grant execute on function public.provider_earnings_commit(jsonb) to service_role;

do $$ begin
  if exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'
    and tablename in ('provider_earnings_snapshots','provider_earnings_rows')) then
    raise exception 'Earnings payloads must not be published; only refresh markers are allowed';
  end if;
end $$;
