-- Per-vehicle volatile display data. Historical telemetry remains in its archive.
-- Install before desktop-workers.sql, inside the reviewed promotion transaction.
create table public.desktop_vehicle_live (
 vehicle_key text primary key references public.vehicles(key) on delete cascade,
 data jsonb not null check(jsonb_typeof(data)='object' and pg_column_size(data)<=65536
   and jsonb_typeof(data->'device_id')='string' and jsonb_typeof(data->'captured_at')='string'),
 observed_at timestamptz not null default clock_timestamp()
);
alter table public.desktop_vehicle_live enable row level security;
revoke all on public.desktop_vehicle_live from public,anon,authenticated,service_role;
grant select on public.desktop_vehicle_live to authenticated;
create policy read_vehicle on public.desktop_vehicle_live for select to authenticated using (
 exists(select 1 from public.vehicles v where v.key=vehicle_key)
);
create function public.desktop_vehicle_live_stamp() returns trigger
language plpgsql set search_path='' as $$
begin
 -- The server timestamps receipt. A delayed older refresh cannot replace a
 -- newer snapshot from this device. The binding is checked on every UI read.
 if tg_op='UPDATE' and old.data->>'device_id'=new.data->>'device_id'
    and (old.data->>'captured_at')::timestamptz>(new.data->>'captured_at')::timestamptz then return null;end if;
 new.observed_at:=clock_timestamp();return new;
end $$;
revoke all on function public.desktop_vehicle_live_stamp() from public,anon,authenticated,service_role;
create trigger desktop_vehicle_live_stamp before insert or update on public.desktop_vehicle_live
for each row execute function public.desktop_vehicle_live_stamp();
