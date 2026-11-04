do $$ begin if(select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;end $$;
alter table public.fleet_parking_zones
 add column archived_at timestamptz,
 add column archived_by uuid references auth.users(id) on delete set null,
 add constraint fleet_parking_archive_disabled check(archived_at is null or (isfinite(archived_at) and not enabled)),
 add constraint fleet_parking_archive_actor check(archived_at is not null or archived_by is null);
comment on column public.fleet_parking_zones.archived_at is 'Hidden from current maps and inactive; historical parking events remain attached to this zone.';

create function public.fleet_archive_parking_zone(p_id uuid,p_revision bigint,p_user uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare zone public.fleet_parking_zones;
begin
 if(select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Administrator required';end if;
 if p_id is null or p_revision is null or p_revision<=0 then raise exception 'Invalid zone or revision';end if;
 select * into zone from public.fleet_parking_zones where id=p_id for update;
 if not found then return jsonb_build_object('outcome','missing');end if;
 if zone.archived_at is not null or zone.revision<>p_revision then return jsonb_build_object('outcome','conflict');end if;
 -- The existing reset trigger increments revision and clears live/pending state.
 -- Events and their foreign key remain intact. Delayed detector commits fail
 -- their enabled/revision checks against the same locked zone row.
 update public.fleet_parking_zones set enabled=false,archived_at=now(),archived_by=p_user,updated_at=now()
  where id=p_id returning * into zone;
 return jsonb_build_object('outcome','archived','id',zone.id,'revision',zone.revision,'archived_at',zone.archived_at);
end $$;
revoke all on function public.fleet_archive_parking_zone(uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.fleet_archive_parking_zone(uuid,bigint,uuid) to service_role;
