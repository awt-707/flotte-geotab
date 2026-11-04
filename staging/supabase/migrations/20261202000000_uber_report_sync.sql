-- Browser-export transport only. Raw reports and Uber session credentials are never stored.
create table public.uber_report_settings (
 id integer primary key check(id=1), enabled boolean not null default false,
 organization_id uuid, city_agencies jsonb not null default '{}' check(jsonb_typeof(city_agencies)='object'),
 date_format text not null default 'dmy' check(date_format in('dmy','ymd','mdy')),
 revision bigint not null default 1, updated_at timestamptz not null default now(),
 last_attempt_at timestamptz, last_success_at timestamptz,
 last_status text not null default 'unconfigured' check(last_status in('unconfigured','ready','imported','empty','error')),
 last_error text, last_counts jsonb not null default '{}',
 check(not enabled or organization_id is not null and city_agencies<>'{}'::jsonb)
);
insert into public.uber_report_settings(id) values(1);
create table public.uber_report_import_log (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 config_revision bigint not null, file_sha256 text not null check(file_sha256 ~ '^[a-f0-9]{64}$'),
 counts jsonb not null check(jsonb_typeof(counts)='object' and pg_column_size(counts)<=16384),
 results jsonb not null check(jsonb_typeof(results)='array' and pg_column_size(results)<=8192),
 created_at timestamptz not null default now(),
 unique(organization_id,config_revision,file_sha256)
);
do $$ declare t text; begin
 foreach t in array array['uber_report_settings','uber_report_import_log'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

create function public.uber_report_configure(p_enabled boolean,p_org uuid,p_mapping jsonb,p_format text,p_user uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result public.uber_report_settings;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Administrator required';end if;
 if p_enabled is null or p_format is null or p_format not in('dmy','ymd','mdy') or jsonb_typeof(p_mapping) is distinct from 'object'
  or exists(select 1 from jsonb_each(p_mapping) e where e.key not in('Casablanca','Marrakech') or jsonb_typeof(e.value)<>'number'
   or e.value::text !~ '^[1-9][0-9]*$' or not exists(select 1 from public.agencies a where a.id=(e.value::text)::bigint
     and lower(btrim(a.city))=case when e.key='Casablanca' then 'casablanca' else 'marrakech' end))
  or p_enabled and (p_org is null or p_mapping='{}'::jsonb) then raise exception 'Invalid report configuration';end if;
 update public.uber_report_settings set enabled=p_enabled,organization_id=p_org,city_agencies=p_mapping,date_format=p_format,
  revision=revision+1,updated_at=now(),last_status=case when p_enabled then 'ready' else 'unconfigured' end,last_error=null
  where id=1 returning * into result;
 return to_jsonb(result);
end $$;
revoke all on function public.uber_report_configure(boolean,uuid,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.uber_report_configure(boolean,uuid,jsonb,text,uuid) to service_role;

create function public.uber_report_commit(p_org uuid,p_revision bigint,p_hash text,p_batches jsonb,p_counts jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare config public.uber_report_settings; batch jsonb; results jsonb:='[]'; result jsonb; prior public.uber_report_import_log;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 select * into config from public.uber_report_settings where id=1 for update;
 if not config.enabled or config.organization_id is distinct from p_org or config.revision is distinct from p_revision then raise exception 'Report configuration changed';end if;
 if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_batches) is distinct from 'array' or jsonb_array_length(p_batches)>2
  or jsonb_typeof(p_counts) is distinct from 'object' or pg_column_size(p_counts)>16384 then raise exception 'Invalid report batch';end if;
 if exists(select 1 from jsonb_array_elements(p_batches) b where coalesce(b->>'city','') not in('Casablanca','Marrakech')
   or config.city_agencies->>(b->>'city') is distinct from b->>'agency_id')
  or exists(select 1 from jsonb_array_elements(p_batches) b group by b->>'city' having count(*)>1) then raise exception 'Report agency mismatch';end if;
 select * into prior from public.uber_report_import_log where organization_id=p_org and config_revision=p_revision and file_sha256=p_hash;
 if found then
  update public.uber_report_settings set last_success_at=now(),last_attempt_at=now(),last_status=case when jsonb_array_length(prior.results)=0 then 'empty' else 'imported' end,last_error=null,last_counts=prior.counts where id=1;
  return jsonb_build_object('duplicate',true,'results',prior.results,'counts',prior.counts);
 end if;
 for batch in select value from jsonb_array_elements(p_batches) loop
  result:=public.ops_import_demand(batch,batch->'rows');
  results:=results||jsonb_build_array(jsonb_build_object('city',batch->>'city','agency_id',(batch->>'agency_id')::bigint,'result',result));
 end loop;
 insert into public.uber_report_import_log(organization_id,config_revision,file_sha256,counts,results) values(p_org,p_revision,p_hash,p_counts,results);
 update public.uber_report_settings set last_success_at=now(),last_attempt_at=now(),last_status=case when jsonb_array_length(p_batches)=0 then 'empty' else 'imported' end,
  last_error=null,last_counts=p_counts where id=1;
 return jsonb_build_object('duplicate',false,'results',results,'counts',p_counts);
end $$;
revoke all on function public.uber_report_commit(uuid,bigint,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.uber_report_commit(uuid,bigint,text,jsonb,jsonb) to service_role;
