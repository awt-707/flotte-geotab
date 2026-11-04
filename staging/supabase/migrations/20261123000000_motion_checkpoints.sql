-- Local staging only: retain measured progress across short process restarts.
-- Checkpoints are never exposed to browser roles and never launch an external job.
create table public.fleet_motion_checkpoints (
  identity_id uuid primary key references public.fleet_identities(id) on delete cascade,
  vehicle_key text not null references public.vehicles(key) on delete cascade,
  source text not null references public.fleet_sources(id) check(source in ('uber','bolt')),
  state jsonb not null check(jsonb_typeof(state)='object' and state ?& array['identity_id','vehicle_key','source','version'] and state->>'version'='1'),
  updated_at timestamptz not null,
  check(state->>'identity_id'=identity_id::text and state->>'vehicle_key'=vehicle_key and state->>'source'=source)
);
alter table public.fleet_motion_checkpoints enable row level security;
revoke all on public.fleet_motion_checkpoints from public,anon,authenticated;
grant all on public.fleet_motion_checkpoints to service_role;

create function public.fleet_save_motion_checkpoints(p_states jsonb)
returns void language plpgsql set search_path=public as $$
begin
  if p_states is null or jsonb_typeof(p_states)<>'array' or jsonb_array_length(p_states)>5000 then
    raise exception 'Checkpoints de suivi invalides';
  end if;
  -- The local server owns one serialized motion worker. Replace its snapshot atomically
  -- so an online return, expired assignment or unavailable source cannot leave old progress.
  delete from public.fleet_motion_checkpoints c
  where not exists(select 1 from jsonb_array_elements(p_states) s where (s->>'identity_id')::uuid=c.identity_id);
  insert into public.fleet_motion_checkpoints(identity_id,vehicle_key,source,state,updated_at)
  select (s->>'identity_id')::uuid,s->>'vehicle_key',s->>'source',s->'state',(s->>'updated_at')::timestamptz
  from jsonb_array_elements(p_states) s
  on conflict(identity_id) do update set vehicle_key=excluded.vehicle_key,source=excluded.source,
    state=excluded.state,updated_at=excluded.updated_at;
end $$;
revoke all on function public.fleet_save_motion_checkpoints(jsonb) from public,anon,authenticated;
grant execute on function public.fleet_save_motion_checkpoints(jsonb) to service_role;
