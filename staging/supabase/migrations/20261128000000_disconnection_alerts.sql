-- Local staging only. Internal, observed platform disconnections; no mail/jobs.
alter table public.fleet_settings add column disconnection_enabled boolean not null default false;
alter table public.fleet_settings add column disconnection_policy text not null default 'any'
  check(disconnection_policy in('any','all'));
alter table public.fleet_settings add column duty_mode text not null default 'contract'
  check(duty_mode in('contract','shift'));

create table public.fleet_disconnection_checkpoints (
  identity_id uuid primary key references public.fleet_identities(id) on delete cascade,
  state jsonb not null check(jsonb_typeof(state)='object' and pg_column_size(state)<=32768),
  updated_at timestamptz not null check(isfinite(updated_at))
);
alter table public.fleet_disconnection_checkpoints enable row level security;
revoke all on public.fleet_disconnection_checkpoints from public,anon,authenticated;
grant all on public.fleet_disconnection_checkpoints to service_role;

create table public.fleet_disconnection_alerts (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.fleet_identities(id) on delete cascade,
  driver_id uuid not null references public.fleet_drivers(id) on delete cascade,
  source text not null references public.fleet_sources(id) check(source in('uber','bolt')),
  vehicle_key text references public.vehicles(key) on delete set null,
  contract_id text check(contract_id is null or length(contract_id) between 1 and 120),
  duty_key text not null check(length(duty_key) between 1 and 500),
  observed_online_at timestamptz not null check(isfinite(observed_online_at)),
  disconnected_at timestamptz not null check(isfinite(disconnected_at) and disconnected_at>observed_online_at),
  opened_at timestamptz not null default now() check(isfinite(opened_at)),
  last_seen_at timestamptz not null default now() check(isfinite(last_seen_at)),
  status text not null default 'open' check(status in('open','suspended','resolved')),
  resolved_at timestamptz check(resolved_at is null or isfinite(resolved_at)),
  evidence jsonb not null default '{}' check(jsonb_typeof(evidence)='object' and pg_column_size(evidence)<=32768),
  check((status='resolved' and resolved_at is not null and resolved_at>=disconnected_at)
    or (status in('open','suspended') and resolved_at is null)),
  unique(identity_id,disconnected_at,duty_key)
);
create index fleet_disconnection_alerts_recent on public.fleet_disconnection_alerts(disconnected_at desc,id);
create index fleet_disconnection_alerts_driver on public.fleet_disconnection_alerts(driver_id,disconnected_at desc);
alter table public.fleet_disconnection_alerts enable row level security;
revoke all on public.fleet_disconnection_alerts from public,anon,authenticated;
grant select on public.fleet_disconnection_alerts to authenticated;
grant all on public.fleet_disconnection_alerts to service_role;
create policy read_scope on public.fleet_disconnection_alerts for select to authenticated
  using(public.fleet_can_read(driver_id));

-- Identity merges relocate identities before deleting their old profile. Move
-- incident ownership in the same transaction so that cascade does not erase it.
create function public.fleet_preserve_disconnections_on_merge()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  update public.fleet_disconnection_alerts a set driver_id=i.driver_id
    from public.fleet_identities i where a.driver_id=old.id and i.id=a.identity_id and i.driver_id<>old.id;
  update public.fleet_disconnection_checkpoints c set state=jsonb_set(c.state,'{driver_id}',to_jsonb(i.driver_id::text))
    from public.fleet_identities i where i.id=c.identity_id and i.driver_id<>old.id
      and c.state->>'driver_id'=old.id::text;
  return old;
end $$;
revoke all on function public.fleet_preserve_disconnections_on_merge() from public,anon,authenticated,service_role;
create trigger fleet_preserve_disconnections_before_delete before delete on public.fleet_drivers
  for each row execute function public.fleet_preserve_disconnections_on_merge();

-- A single commit persists the detector's complete checkpoint snapshot and its
-- explicit incident decisions. SQL never treats silence as an offline state.
create function public.fleet_commit_disconnections(p_states jsonb,p_alerts jsonb,p_changes jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare added integer:=0; changed integer:=0; saved integer:=0; removed integer:=0;
begin
  if (select value from public.params where key='environment') is distinct from 'staging' then
    raise exception 'Base locale de staging obligatoire';
  end if;
  if p_states is null or jsonb_typeof(p_states)<>'array' or jsonb_array_length(p_states)>5000
    or p_alerts is null or jsonb_typeof(p_alerts)<>'array' or jsonb_array_length(p_alerts)>5000
    or p_changes is null or jsonb_typeof(p_changes)<>'array' or jsonb_array_length(p_changes)>5000
    or pg_column_size(p_states)+pg_column_size(p_alerts)+pg_column_size(p_changes)>16777216 then
    raise exception 'Lot de déconnexions invalide';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  perform pg_advisory_xact_lock(hashtextextended('fleet-disconnections',0));
  if exists(select 1 from jsonb_array_elements(p_states) x where jsonb_typeof(x)<>'object')
    or exists(select 1 from jsonb_array_elements(p_alerts) x where jsonb_typeof(x)<>'object')
    or exists(select 1 from jsonb_array_elements(p_changes) x where jsonb_typeof(x)<>'object') then
    raise exception 'Éléments du lot de déconnexions invalides';
  end if;
  if exists(select 1 from jsonb_array_elements(p_states) x, jsonb_object_keys(x) k where k not in('identity_id','state','updated_at'))
    or exists(select 1 from jsonb_array_elements(p_alerts) x,jsonb_object_keys(x) k where k not in(
      'id','identity_id','driver_id','source','vehicle_key','contract_id','duty_key','observed_online_at','disconnected_at',
      'opened_at','last_seen_at','status','resolved_at','evidence'))
    or exists(select 1 from jsonb_array_elements(p_changes) x,jsonb_object_keys(x) k where k not in('id','status','last_seen_at','resolved_at')) then
    raise exception 'Champs de déconnexions non autorisés';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_states) as x(identity_id uuid,state jsonb,updated_at timestamptz)
      left join public.fleet_identities i on i.id=x.identity_id
      where x.identity_id is null or i.id is null or i.source not in('uber','bolt')
        or x.state is null or jsonb_typeof(x.state)<>'object' or pg_column_size(x.state)>32768
        or x.updated_at is null or not isfinite(x.updated_at) or x.updated_at>now()+interval '5 seconds'
        or x.state ? 'identity_id' and x.state->>'identity_id' is distinct from x.identity_id::text
        or x.state ? 'source' and x.state->>'source' is distinct from i.source)
    or exists(select 1 from jsonb_to_recordset(p_states) as x(identity_id uuid) group by identity_id having count(*)>1) then
    raise exception 'Checkpoints de déconnexion invalides';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_states) as x(identity_id uuid,state jsonb,updated_at timestamptz)
      join public.fleet_identities i on i.id=x.identity_id
      where not x.state ?& array['version','identity_id','driver_id','source','duty_key','policy','status','observed_at','online_at','offline_at']
        or x.state->'version' is distinct from '1'::jsonb
        or x.state->>'driver_id' is distinct from i.driver_id::text
        or jsonb_typeof(x.state->'duty_key') is distinct from 'string' or length(btrim(x.state->>'duty_key')) not between 1 and 500
        or coalesce(x.state->>'policy','') not in('any','all')
        or coalesce(x.state->>'status','') not in('available','on_trip','to_pickup','on_break','offline')
        or jsonb_typeof(x.state->'observed_at') is distinct from 'string'
        or jsonb_typeof(x.state->'online_at') not in('string','null')
        or jsonb_typeof(x.state->'offline_at') not in('string','null'))
    or exists(select 1 from jsonb_array_elements(p_states) x,jsonb_object_keys(x->'state') k
      where k not in('version','identity_id','driver_id','source','duty_key','policy','status','observed_at','online_at','offline_at')) then
    raise exception 'État du détecteur de déconnexion invalide';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_states) as x(state jsonb,updated_at timestamptz)
      where not isfinite((x.state->>'observed_at')::timestamptz)
        or (x.state->>'observed_at')::timestamptz>x.updated_at+interval '5 seconds'
        or x.state->>'online_at' is not null and (not isfinite((x.state->>'online_at')::timestamptz)
          or (x.state->>'online_at')::timestamptz>(x.state->>'observed_at')::timestamptz)
        or x.state->>'offline_at' is not null and (not isfinite((x.state->>'offline_at')::timestamptz)
          or (x.state->>'offline_at')::timestamptz>(x.state->>'observed_at')::timestamptz)) then
    raise exception 'Horodatages du détecteur de déconnexion invalides';
  end if;
  if exists(select 1 from jsonb_populate_recordset(null::public.fleet_disconnection_alerts,p_alerts) x
      left join public.fleet_identities i on i.id=x.identity_id
      where x.identity_id is null or i.id is null or x.driver_id is distinct from i.driver_id or x.source is distinct from i.source
        or x.source not in('uber','bolt') or x.duty_key is null or length(btrim(x.duty_key)) not between 1 and 500
        or x.contract_id is not null and length(x.contract_id) not between 1 and 120
        or x.vehicle_key is not null and not exists(select 1 from public.vehicles v where v.key=x.vehicle_key)
        or x.observed_online_at is null or not isfinite(x.observed_online_at)
        or x.disconnected_at is null or not isfinite(x.disconnected_at) or x.disconnected_at<=x.observed_online_at
        or x.disconnected_at>now()+interval '5 seconds'
        or coalesce(x.opened_at,now())>now()+interval '5 seconds' or not isfinite(coalesce(x.opened_at,now()))
        or coalesce(x.last_seen_at,now())>now()+interval '5 seconds' or not isfinite(coalesce(x.last_seen_at,now()))
        or coalesce(x.last_seen_at,now())<x.disconnected_at-interval '5 seconds'
        or coalesce(x.status,'open')<>'open' or x.resolved_at is not null
        or x.evidence is null or jsonb_typeof(x.evidence)<>'object' or pg_column_size(x.evidence)>32768
        or x.evidence->>'kind' is distinct from 'platform_disconnection'
        or coalesce(x.evidence->>'policy','') not in('any','all')
        or x.evidence ? 'duty' and jsonb_typeof(x.evidence->'duty') is distinct from 'object')
    or exists(select 1 from jsonb_to_recordset(p_alerts) as x(identity_id uuid,disconnected_at timestamptz,duty_key text)
      group by identity_id,disconnected_at,duty_key having count(*)>1) then
    raise exception 'Preuves de déconnexion invalides';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_changes) as x(id uuid,status text,last_seen_at timestamptz,resolved_at timestamptz)
      left join public.fleet_disconnection_alerts a on a.id=x.id
      where x.id is null or a.id is null or x.status is null or x.status not in('open','suspended','resolved')
        or a.status='resolved' and x.status<>'resolved'
        or x.last_seen_at is null or not isfinite(x.last_seen_at) or x.last_seen_at>now()+interval '5 seconds'
        or x.last_seen_at<a.last_seen_at or x.last_seen_at<a.disconnected_at-interval '5 seconds'
        or x.status='resolved' and (x.resolved_at is null or not isfinite(x.resolved_at)
          or x.resolved_at<a.disconnected_at or x.resolved_at>now()+interval '5 seconds' or x.resolved_at>x.last_seen_at+interval '5 seconds')
        or x.status<>'resolved' and x.resolved_at is not null)
    or exists(select 1 from jsonb_to_recordset(p_changes) as x(id uuid) group by id having count(*)>1) then
    raise exception 'Transitions de déconnexion invalides';
  end if;
  -- Identical event replays preserve the original ID, proof and lifecycle.
  insert into public.fleet_disconnection_alerts(id,identity_id,driver_id,source,vehicle_key,contract_id,duty_key,
      observed_online_at,disconnected_at,opened_at,last_seen_at,status,evidence)
    select coalesce(x.id,gen_random_uuid()),x.identity_id,x.driver_id,x.source,x.vehicle_key,x.contract_id,x.duty_key,
      x.observed_online_at,x.disconnected_at,coalesce(x.opened_at,now()),coalesce(x.last_seen_at,now()),'open',coalesce(x.evidence,'{}')
    from jsonb_populate_recordset(null::public.fleet_disconnection_alerts,p_alerts) x
    on conflict(identity_id,disconnected_at,duty_key) do nothing;
  get diagnostics added=row_count;
  update public.fleet_disconnection_alerts a set status=x.status,last_seen_at=x.last_seen_at,resolved_at=x.resolved_at
    from jsonb_to_recordset(p_changes) as x(id uuid,status text,last_seen_at timestamptz,resolved_at timestamptz)
    where a.id=x.id and (a.status,a.last_seen_at,a.resolved_at) is distinct from (x.status,x.last_seen_at,x.resolved_at);
  get diagnostics changed=row_count;
  delete from public.fleet_disconnection_checkpoints c
    where c.identity_id is not null and not exists(
      select 1 from jsonb_to_recordset(p_states) as x(identity_id uuid) where x.identity_id=c.identity_id);
  get diagnostics removed=row_count;
  insert into public.fleet_disconnection_checkpoints(identity_id,state,updated_at)
    select x.identity_id,x.state,x.updated_at from jsonb_to_recordset(p_states) as x(identity_id uuid,state jsonb,updated_at timestamptz)
    on conflict(identity_id) do update set state=excluded.state,updated_at=excluded.updated_at;
  get diagnostics saved=row_count;
  return jsonb_build_object('alerts_created',added,'changes_applied',changed,'states_saved',saved,'states_removed',removed);
end $$;
revoke all on function public.fleet_commit_disconnections(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fleet_commit_disconnections(jsonb,jsonb,jsonb) to service_role;
