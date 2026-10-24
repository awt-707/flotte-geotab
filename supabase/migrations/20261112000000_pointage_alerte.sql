-- =============================================================================
-- Alerte de pointage du staff (24/10/2026, demande d'Ahmed : être prévenu quand un salarié du staff n'a pas pointé).
-- À exécuter dans Supabase > SQL Editor (après 20261111000000_rh_acces.sql). Rejouable sans risque.
-- - hr_employees.work_start : heure d'arrivée prévue ; work_days : jours travaillés (ISO, 1 = lundi … 7 = dimanche)
-- - rhClockLateMin : alerte … minutes après l'heure prévue sans arrivée pointée (e-mail aux administrateurs et aux comptes RH)
-- - rhHolidays : jours fériés sans alerte de pointage (AAAA-MM-JJ séparés par des virgules)
-- =============================================================================
alter table public.hr_employees add column if not exists work_start time;
alter table public.hr_employees add column if not exists work_days text not null default '1,2,3,4,5,6';
alter table public.hr_employees drop constraint if exists hr_employees_work_days_check;
alter table public.hr_employees add constraint hr_employees_work_days_check check (work_days ~ '^([1-7](,[1-7])*)?$');
insert into public.params (key, label, value, note, sort) values
  ('rhClockLateMin', 'RH : arrivée non pointée (alerte … minutes après l''heure prévue)', '30', 'Staff au pointage obligatoire avec une heure d''arrivée prévue (fiche du salarié) ; e-mail aux administrateurs et aux comptes Ressources humaines', 909),
  ('rhHolidays', 'RH : jours fériés (pas d''alerte de pointage)', '', 'AAAA-MM-JJ séparés par des virgules', 910)
on conflict (key) do nothing;
