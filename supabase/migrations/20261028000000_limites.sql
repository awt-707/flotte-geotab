-- =============================================================================
-- Limites de l'hébergement (17/10/2026) : suivi dans Réglages, alerte à 80 %, PDF de manifestes anciens effacés.
-- À exécuter une fois dans Supabase > SQL Editor (après 20261027000000_manifestes.sql). Rejouable sans risque.
-- - usage_daily : appels du relais En direct (fonction geotab-live) comptés par jour (quota de l'offre Supabase)
-- - usage_stats() : taille de la base, du stockage (par seau) et appels du mois ; administrateur (et collecteur) seulement
-- - paramètres : limites de l'offre (modifiables si l'offre change) et durée de conservation des PDF de manifestes
-- =============================================================================
create table if not exists public.usage_daily (
  day date not null, kind text not null, n bigint not null default 0,
  primary key (day, kind)
);
alter table public.usage_daily enable row level security;
revoke all on public.usage_daily from anon, authenticated;

-- +1 appel (relais En direct, clé service) ; jour à l'heure du Maroc approchée par UTC+1
create or replace function public.bump_usage(p_kind text) returns void language sql security definer set search_path = public as $$
  insert into usage_daily (day, kind, n) values ((now() + interval '1 hour')::date, p_kind, 1)
  on conflict (day, kind) do update set n = usage_daily.n + 1
$$;
revoke execute on function public.bump_usage(text) from public, anon, authenticated;
grant execute on function public.bump_usage(text) to service_role;

create or replace function public.usage_stats() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare st jsonb := '{}'::jsonb; m date := date_trunc('month', now() + interval '1 hour')::date;
begin
  if not (is_admin() or coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role') then
    raise exception 'réservé à l''administrateur';
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'select coalesce(jsonb_object_agg(bucket_id, mb), ''{}''::jsonb) from (select bucket_id, round(sum(coalesce((metadata->>''size'')::bigint, 0)) / 1048576.0, 1) mb
      from storage.objects group by bucket_id) x' into st;
  end if;
  return jsonb_build_object(
    'db_mb', round(pg_database_size(current_database()) / 1048576.0, 1),
    'storage_mb', st,
    'live_month', (select coalesce(sum(n), 0) from usage_daily where kind = 'live' and day >= m),
    'live_since', (select min(day) from usage_daily where kind = 'live' and day >= m),
    'live_days', (select count(*) from usage_daily where kind = 'live' and day >= m),
    'month', m);
end $$;
revoke execute on function public.usage_stats() from public, anon;
grant execute on function public.usage_stats() to authenticated, service_role;

insert into public.params (key, label, value, note, sort) values
  ('limDbMb', 'Limite de la base (Mo)', '500', 'Offre Supabase : gratuite 500 Mo, Pro 8 000 Mo. Alerte à 80 % (Réglages, tableau de bord).', 95),
  ('limStorageMb', 'Limite du stockage (Mo)', '1024', 'Offre Supabase : gratuite 1 024 Mo (1 Go), Pro 102 400 Mo (100 Go). PDF des manifestes et fichiers de l''application.', 96),
  ('limLiveMonth', 'Limite des appels En direct par mois', '500000', 'Offre Supabase (appels de fonctions) : gratuite 500 000, Pro 2 000 000. Une page En direct affichée ≈ 840 appels par heure.', 97),
  ('manifestKeepDays', 'PDF des manifestes conservés (jours)', '30', 'Au-delà, le PDF est effacé du stockage chaque nuit (l''historique du manifeste reste ; le lien envoyé n''est valable que 7 jours). 0 = jamais effacé.', 98)
on conflict (key) do nothing;
