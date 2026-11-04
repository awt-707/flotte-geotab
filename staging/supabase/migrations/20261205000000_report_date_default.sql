-- Use an unambiguous year-first convention until an operator explicitly
-- selects a localized export format. Existing configured projects are kept.
alter table public.uber_report_settings alter column date_format set default 'ymd';
update public.uber_report_settings set date_format='ymd'
where id=1 and revision=1 and not enabled and organization_id is null and city_agencies='{}'::jsonb;
