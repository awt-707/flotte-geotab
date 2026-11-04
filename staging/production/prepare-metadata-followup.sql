-- Read-only follow-up for the two differences found against the 37-file
-- baseline. No application rows, secrets or credentials are selected.
-- Run only on the already identified production Supabase project.
begin transaction isolation level repeatable read read only;
set local search_path=pg_catalog;
set local statement_timeout='10s';
set local lock_timeout='1s';
do $review$
declare result jsonb;
begin
 if current_setting('transaction_read_only')<>'on' then raise exception 'Read-only transaction required';end if;
 select jsonb_build_object(
 'format','ludy-production-function-review-v1',
 'transactionReadOnly',current_setting('transaction_read_only')='on',
 'environmentMarker',(select value from public.params where key='environment'),
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,
   'identityArguments',pg_get_function_identity_arguments(p.oid),
   'definition',pg_get_functiondef(p.oid),'definitionMd5',md5(pg_get_functiondef(p.oid)),
   'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text) order by p.proname)
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in('mission_guard','rls_auto_enable')),
 'eventTriggers',(select coalesce(jsonb_agg(jsonb_build_object('name',e.evtname,
   'event',e.evtevent,'enabled',e.evtenabled,'tags',e.evttags,
   'function',e.evtfoid::regprocedure::text) order by e.evtname),'[]'::jsonb)
   from pg_event_trigger e join pg_proc p on p.oid=e.evtfoid
   join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')
) into result;
 if pg_column_size(result)>1048576 then raise exception 'Function review exceeds size bound';end if;
 perform set_config('ludy_function_review.result',result::text,false);
end $review$;
commit;

-- Return a final result row in the Supabase SQL Editor, then clear the session
-- transport. COMMIT above ended a read-only transaction; no table was written.
with captured as materialized (
 select nullif(current_setting('ludy_function_review.result',true),'')::jsonb as function_review_json
), cleared as materialized (
 select set_config('ludy_function_review.result','',false) as state from captured
)
select captured.function_review_json from captured cross join cleared
where captured.function_review_json is not null and cleared.state='';
