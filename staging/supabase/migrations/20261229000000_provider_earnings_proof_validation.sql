-- Staging only. Reject malformed proof metadata instead of returning SQL NULL.
-- No financial amount, observation or historical proof is rewritten.
do $$ begin
 if (select value from public.params where key='environment') is distinct from 'staging'
 then raise exception 'Staging required';end if;
end $$;
create or replace function public.provider_earnings_provenance_valid(a jsonb,p jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare e jsonb; fields text[]:=array[]::text[]; name text; n numeric; s numeric:=0; gross numeric:=0; k text;
begin
 if p is null or p='null'::jsonb then return true;end if;
 if jsonb_typeof(p)<>'object' or p->'version' is distinct from '1'::jsonb or pg_column_size(p)>8192 then return false;end if;
 if p->>'status'='unavailable' then
  return coalesce(p->>'reason'=any(array['missing_breakdown','incomplete_breakdown','unknown_component','invalid_component','conflicting_component','total_mismatch','amount_overflow','conflicting_reported_amount'])
   and not exists(select 1 from jsonb_object_keys(p) key where key not in ('version','status','reason')),false);
 end if;
 if p->>'status' is distinct from 'verified' or p->>'basis' is distinct from 'visible_total_earnings_breakdown'
  or p->>'gross_definition' is distinct from 'before_uber_fees_and_provider_taxes'
  or p->>'net_definition' is distinct from 'after_uber_fees_before_provider_taxes'
  or p->>'formula' is distinct from 'fare_plus_tips_plus_bonus' or p->>'reconciliation' is distinct from 'exact'
  or jsonb_typeof(p->'entries') is distinct from 'array'
  or exists(select 1 from jsonb_object_keys(p) key where key not in ('version','status','basis','gross_definition','net_definition','formula','reconciliation','total_minor','entries'))
 then return false;end if;
 if jsonb_array_length(p->'entries') not between 1 and 30 then return false;end if;
 for e in select value from jsonb_array_elements(p->'entries') loop
  name:=e->>'field';
  if jsonb_typeof(e)<>'object' or name is null or name<>all(array['fare','commission','taxes','tips','bonus']) or name=any(fields)
   or exists(select 1 from jsonb_object_keys(e) key where key not in ('field','label','minor'))
   or (name='fare' and e->>'label' is distinct from 'Fare')
   or (name='commission' and e->>'label' is distinct from 'Service Fee')
   or (name='taxes' and e->>'label' is distinct from 'Taxes')
   or (name='tips' and coalesce(e->>'label','') not in ('Tip','Tips'))
   or (name='bonus' and coalesce(e->>'label','') not in ('Promotion','Promotions'))
   or jsonb_typeof(e->'minor') is distinct from 'number' or coalesce(e->>'minor','') !~ '^-?[0-9]+$'
  then return false;end if;
  n:=(e->>'minor')::numeric;if abs(n)>9007199254740991 or a->(name||'_minor') is distinct from e->'minor' then return false;end if;
  fields:=array_append(fields,name);s:=s+n;if name in ('fare','tips','bonus') then gross:=gross+n;end if;
 end loop;
 if not('fare'=any(fields)) or abs(s)>9007199254740991 or abs(gross)>9007199254740991 then return false;end if;
 foreach k in array array['fare','commission','taxes','tips','bonus'] loop
  if not(k=any(fields)) and a->(k||'_minor') is distinct from '0'::jsonb then return false;end if;
 end loop;
 return coalesce(a->'revenue_minor'=to_jsonb(s) and a->'net_minor'=to_jsonb(gross+coalesce((a->>'commission_minor')::numeric,0)) and a->'gross_minor'=to_jsonb(gross) and p->'total_minor'=to_jsonb(s),false);
exception when others then return false;
end $$;
revoke all on function public.provider_earnings_provenance_valid(jsonb,jsonb) from public,anon,authenticated,service_role;
