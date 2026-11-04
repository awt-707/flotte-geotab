-- Optional visible organization label for selecting the confirmed Uber report scope.
alter table public.uber_report_settings add column organization_label text
 check(organization_label is null or (organization_label=btrim(organization_label)
   and length(organization_label) between 1 and 160 and organization_label !~ '[[:cntrl:]]'));

-- One signature with a default retains existing five-argument callers and avoids
-- ambiguous PostgREST overloads. Configuration and its revision remain atomic.
drop function public.uber_report_configure(boolean,uuid,jsonb,text,uuid);
create function public.uber_report_configure(p_enabled boolean,p_org uuid,p_mapping jsonb,p_format text,p_user uuid,p_org_label text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result public.uber_report_settings; label text:=btrim(p_org_label);
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Administrator required';end if;
 if p_enabled is null or p_format is null or p_format not in('dmy','ymd','mdy') or jsonb_typeof(p_mapping) is distinct from 'object'
  or exists(select 1 from jsonb_each(p_mapping) e where e.key not in('Casablanca','Marrakech') or jsonb_typeof(e.value)<>'number'
   or e.value::text !~ '^[1-9][0-9]*$' or not exists(select 1 from public.agencies a where a.id=(e.value::text)::bigint
     and lower(btrim(a.city))=case when e.key='Casablanca' then 'casablanca' else 'marrakech' end))
  or p_enabled and (p_org is null or p_mapping='{}'::jsonb)
  or p_org_label is not null and (length(label) not between 1 and 160 or p_org_label ~ '[[:cntrl:]]')
  then raise exception 'Invalid report configuration';end if;
 update public.uber_report_settings set enabled=p_enabled,organization_id=p_org,organization_label=label,city_agencies=p_mapping,date_format=p_format,
  revision=revision+1,updated_at=now(),last_status=case when p_enabled then 'ready' else 'unconfigured' end,last_error=null
  where id=1 returning * into result;
 return to_jsonb(result);
end $$;
revoke all on function public.uber_report_configure(boolean,uuid,jsonb,text,uuid,text) from public,anon,authenticated;
grant execute on function public.uber_report_configure(boolean,uuid,jsonb,text,uuid,text) to service_role;
