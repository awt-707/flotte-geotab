-- Staging only. Collected agendas are retired; existing agency entries stay.
do $$ begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
end $$;
delete from public.ops_event_reviews where event_id in (select id from public.ops_events where source_id<>'manual');
delete from public.ops_events where source_id<>'manual';
update public.ops_event_sources set enabled=false,status=case when id='manual' then 'manual' else 'disabled' end,last_error=null,received_count=0 where id is not null;
alter table public.ops_events add constraint ops_events_manual_only check(source_id='manual');

-- One atomic write for every admin intent. The browser reuses its creation UUID
-- when retrying an uncertain response; concurrent edits require the same version.
create function public.ops_mutate_manual_event(p_action text,p_id uuid,p_expected text,p_row jsonb,p_user uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare old public.ops_events; target public.ops_events; created boolean;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Administrator required';end if;
 if p_action is null or p_action not in ('create','update','delete') or p_id is null then raise exception 'Invalid event action';end if;
 if p_action<>'create' and (p_expected is null or p_expected!~'^[a-f0-9]{64}$') then raise exception 'Version required';end if;
 if p_action<>'delete' then
  if jsonb_typeof(p_row) is distinct from 'object' or p_row->>'title' is null or length(trim(p_row->>'title')) not between 1 and 240
   or p_row->>'place' is null or length(trim(p_row->>'place')) not between 1 and 240
   or p_row->>'city' is null or p_row->>'city' not in ('Casablanca','Marrakech')
   or p_row->>'fingerprint' is null or p_row->>'fingerprint'!~'^[a-f0-9]{64}$'
   or p_row->>'starts_at' is null or not isfinite((p_row->>'starts_at')::timestamptz)
   or (p_row->>'ends_at' is not null and (not isfinite((p_row->>'ends_at')::timestamptz) or (p_row->>'ends_at')::timestamptz<(p_row->>'starts_at')::timestamptz))
  then raise exception 'Invalid manual event';end if;
 end if;
 if p_action='create' then
  insert into public.ops_events(id,source_id,external_key,source_url,city,title,place,starts_at,ends_at,source_date_text,time_precision,fingerprint,status,observed_at,reviewed_at,reviewed_by)
  values(p_id,'manual',p_id::text,'',p_row->>'city',trim(p_row->>'title'),trim(p_row->>'place'),(p_row->>'starts_at')::timestamptz,(p_row->>'ends_at')::timestamptz,'Saisie de l’agence','minute',p_row->>'fingerprint','approved',now(),now(),p_user)
  on conflict(id) do nothing returning * into target;
  created:=found;
  if not created then
   select * into old from public.ops_events where id=p_id for update;
   if old.source_id is distinct from 'manual' or old.fingerprint is distinct from p_row->>'fingerprint' then return jsonb_build_object('conflict',true);end if;
   return jsonb_build_object('ok',true,'id',p_id,'duplicate',true);
  end if;
 else
  select * into old from public.ops_events where id=p_id and source_id='manual' for update;
  if not found then return jsonb_build_object('missing',true);end if;
  if old.fingerprint is distinct from p_expected then return jsonb_build_object('conflict',true);end if;
  if p_action='delete' then
   delete from public.ops_event_reviews where event_id=p_id;
   delete from public.ops_events where id=p_id;
   return jsonb_build_object('ok',true,'id',p_id);
  end if;
  update public.ops_events set city=p_row->>'city',title=trim(p_row->>'title'),place=trim(p_row->>'place'),
   starts_at=(p_row->>'starts_at')::timestamptz,ends_at=(p_row->>'ends_at')::timestamptz,
   source_url='',source_date_text='Saisie de l’agence',time_precision='minute',fingerprint=p_row->>'fingerprint',
   status='approved',observed_at=now(),reviewed_at=now(),reviewed_by=p_user where id=p_id returning * into target;
 end if;
 insert into public.ops_event_reviews(event_id,decision,fingerprint,reviewed_by) values(p_id,'approved',target.fingerprint,p_user);
 return jsonb_build_object('ok',true,'id',p_id,'fingerprint',target.fingerprint);
end $$;
revoke all on function public.ops_mutate_manual_event(text,uuid,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.ops_mutate_manual_event(text,uuid,text,jsonb,uuid) to service_role;
