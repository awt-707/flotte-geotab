-- =============================================================================
-- Shift jour / nuit (16/10/2026) : le Classement rattache chaque événement au shift de son contrat.
-- driver_rule_counts renvoie aussi le n° de contrat. À exécuter dans Supabase > SQL Editor (après 20261019000000_securite.sql).
-- Rejouable sans risque. Tant qu'elle n'est pas exécutée, le site rattache les événements au shift principal du chauffeur.
-- =============================================================================
drop function if exists public.driver_rule_counts(date, date);
create or replace function public.driver_rule_counts(p_from date, p_to date)
returns table (driver_code text, rule_id text, vehicle_key text, contract_num text, n integer) language sql stable set search_path = public as $$
  with cd as (select contract_num, min(day) d from journal where contract_num is not null and contract_num <> '' group by 1)
  select e.driver_code, e.rule_id, e.vehicle_key, e.contract_num, count(*)::int
    from events e join rules r on r.id = e.rule_id and r.weight > 0
    left join cd on cd.contract_num = e.contract_num
   where e.day between p_from - 2 and p_to + 1 and coalesce(e.driver_code, '') not in ('', 'HORS_CONTRAT')
     and coalesce(cd.d, e.day) between p_from and p_to
   group by 1, 2, 3, 4
$$;
revoke execute on function public.driver_rule_counts(date, date) from public, anon;
grant execute on function public.driver_rule_counts(date, date) to authenticated, service_role;
