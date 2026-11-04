-- Operational metadata only: no browser session, token, CSV or personal data.
alter table public.uber_report_settings
 add column collector_seen_at timestamptz,
 add column collector_state jsonb not null default '{}'
  check(jsonb_typeof(collector_state)='object' and pg_column_size(collector_state)<=8192);

comment on column public.uber_report_settings.collector_state is
 'Last authenticated local extension report status; interpreted as stale after 150 seconds.';
