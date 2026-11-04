-- Limited reference snapshot for Ludy staging, not a complete database backup.
-- This session only reads; settings below apply to this transaction alone.
begin transaction isolation level repeatable read read only;
set local search_path = pg_catalog;
set local statement_timeout = '15s';
set local lock_timeout = '1s';
set local idle_in_transaction_session_timeout = '15s';
set local max_parallel_workers_per_gather = 0;
set local work_mem = '4MB';

-- One extra row detects a limit being exceeded, without an expensive COUNT(*).
select json_build_object(
  'format', 'ludy-reference-v1',
  'exported_at', current_timestamp,
  'read_only', current_setting('transaction_read_only'),
  'contract_days', 30,
  'tables', json_build_object(
    'agencies', (select coalesce(json_agg(r), '[]'::json) from (
      select id, name, city from public.agencies order by id limit 101
    ) r),
    'parc', (select coalesce(json_agg(r), '[]'::json) from (
      select plate, brand, model, fuel, agency_id from public.parc order by plate limit 2001
    ) r),
    'vehicles', (select coalesce(json_agg(r), '[]'::json) from (
      select key, plate, brand, model, fuel, active, agency_id, other_plates
      from public.vehicles order by key limit 2001
    ) r),
    'drivers', (select coalesce(json_agg(r), '[]'::json) from (
      select code, name, status, source, agency_id from public.drivers order by code limit 5001
    ) r),
    'contracts', (select coalesce(json_agg(r), '[]'::json) from (
      select num, client_code, name, plate, vehicle_key, model, start_at, end_at, status, origin, imported_at, updated_at
      from public.contracts where start_at >= current_timestamp - interval '30 days'
      order by start_at desc limit 2001
    ) r),
    'rules', (select coalesce(json_agg(r), '[]'::json) from (
      select id, name, weight, category from public.rules order by id limit 501
    ) r)
  )
);
commit;
