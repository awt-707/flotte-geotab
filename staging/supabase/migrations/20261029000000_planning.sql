-- =============================================================================
-- Planning des gestionnaires (17/10/2026) : l'administrateur indique, par agence, qui est de service chaque jour
-- en shift jour / nuit ; les véhicules de l'agence sont répartis automatiquement entre les gestionnaires de service.
-- À exécuter une fois dans Supabase > SQL Editor (après 20261028000000_limites.sql). Rejouable sans risque.
-- =============================================================================
create table if not exists public.manager_shifts (
  agency_id bigint not null references public.agencies(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  day date not null,
  shift text not null check (shift in ('Jour', 'Nuit')),
  primary key (agency_id, user_id, day, shift)
);
create index if not exists manager_shifts_day on public.manager_shifts(day, shift);
alter table public.manager_shifts enable row level security;
revoke all on public.manager_shifts from anon;
grant select, insert, delete on public.manager_shifts to authenticated;
drop policy if exists read_agency on public.manager_shifts;
drop policy if exists admin_all on public.manager_shifts;
create policy read_agency on public.manager_shifts for select to authenticated
  using ((select public.is_admin()) or agency_id = any((select public.my_agency_ids())::bigint[]));
create policy admin_all on public.manager_shifts for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Répartition d'un shift : véhicules actifs de chaque agence (triés par plaque) donnés tour à tour aux gestionnaires
-- de service (triés par e-mail) ; même planning = même répartition. Agences visibles par l'utilisateur seulement.
create or replace function public.shift_plan(p_day date, p_shift text)
returns table (agency_id bigint, user_id uuid, email text, vehicle_key text, plate text)
language sql stable security definer set search_path = public as $$
  with ag as (
    select a.id from agencies a where (select is_admin()) or a.id = any(my_agency_ids())
  ), m as (
    select s.agency_id, s.user_id, p.email, row_number() over (partition by s.agency_id order by p.email, s.user_id) - 1 as i,
           count(*) over (partition by s.agency_id) as n
      from manager_shifts s join profiles p on p.user_id = s.user_id
     where s.day = p_day and s.shift = p_shift and s.agency_id in (select id from ag) and p.role in ('manager', 'admin')
  ), v as (
    select ve.agency_id, ve.key, ve.plate, row_number() over (partition by ve.agency_id order by ve.plate, ve.key) - 1 as j
      from vehicles ve
     where ve.agency_id in (select id from ag) and upper(coalesce(ve.active, 'OUI')) <> 'NON'
  )
  select m.agency_id, m.user_id, m.email, v.key, v.plate
    from v join m on m.agency_id = v.agency_id and m.i = v.j % m.n
   order by m.agency_id, m.email, v.plate
$$;
revoke execute on function public.shift_plan(date, text) from public, anon;
grant execute on function public.shift_plan(date, text) to authenticated;
