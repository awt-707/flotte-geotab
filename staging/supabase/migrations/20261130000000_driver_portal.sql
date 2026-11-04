-- Local staging. Driver access uses opaque portal sessions, never a Supabase
-- authenticated JWT. No existing fleet role, grants or policies are broadened.
do $$ begin
  if (select value from public.params where key='environment') is distinct from 'staging' then
    raise exception 'Base locale de staging obligatoire';
  end if;
end $$;

create table public.driver_portal_accounts (
  id uuid primary key default gen_random_uuid(),
  ludy_driver_code text not null unique references public.drivers(code) on update cascade,
  agency_id bigint references public.agencies(id),
  display_name text not null check(length(display_name) between 1 and 160),
  credential_hash text not null unique check(credential_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now()
);
create table public.driver_portal_sessions (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid not null references public.driver_portal_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check(isfinite(expires_at) and expires_at>created_at)
);
create index driver_portal_sessions_account on public.driver_portal_sessions(account_id);
create table public.driver_reports (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.driver_portal_accounts(id) on delete cascade,
  category text not null check(category in('accident','traffic','incident')),
  city text not null check(city in('Casablanca','Marrakech','Autre')),
  place text not null check(length(btrim(place)) between 2 and 240),
  description text not null check(length(btrim(description)) between 5 and 2000),
  status text not null default 'pending' check(status in('pending','verified','rejected','closed')),
  admin_note text not null default '' check(length(admin_note)<=1000),
  reported_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null
);
create index driver_reports_account_recent on public.driver_reports(account_id,reported_at desc);
create index driver_reports_moderation on public.driver_reports(status,reported_at desc);
create table public.driver_notifications (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.driver_portal_accounts(id) on delete cascade,
  event_key text not null check(length(event_key) between 1 and 240),
  kind text not null check(kind in('overconsumption','speeding','harsh_driving','info')),
  title text not null check(length(title) between 1 and 160),
  message text not null check(length(message) between 1 and 1000),
  observed_at timestamptz not null check(isfinite(observed_at)),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  evidence jsonb not null default '{}' check(jsonb_typeof(evidence)='object' and pg_column_size(evidence)<=32768),
  unique(account_id,event_key)
);
create index driver_notifications_account_recent on public.driver_notifications(account_id,observed_at desc);
do $$ declare t text; begin
  foreach t in array array['driver_portal_accounts','driver_portal_sessions','driver_reports','driver_notifications'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;
