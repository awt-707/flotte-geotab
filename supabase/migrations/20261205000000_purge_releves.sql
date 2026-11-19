-- Place dans la base (19/11/2026, demande d'Ahmed : base à 497 Mo sur 500 Mo de l'offre gratuite ; « libère juste l'espace des logs de
-- positions », ne pas toucher aux contrats, à la caisse ni au reste).
-- Les relevés en direct écrits par l'application de bureau de Raphael prenaient 391 Mo : positions Geotab (telemetry_observations,
-- ~50 000 lignes par jour) et états Uber / Bolt lus à l'écran (fleet_observations, ~130 000 lignes par jour). Ses calculs lisent les
-- tables « dernier état » (fleet_latest…), jamais cet historique. On garde 24 h de relevés ; le reste est retiré toutes les heures.
-- Les relevés retirés le 19/11 (avant le 18/11 02:00 UTC) ont été copiés en fichiers compressés remis à Ahmed.
-- Tables absentes (base de test, serveur neuf) : rien n'est fait.

create or replace function public.ludy_purge_live_logs(p_keep interval default interval '24 hours')
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_tel bigint := 0; n_fleet bigint := 0;
begin
  set local lock_timeout = '5s';
  if to_regclass('public.telemetry_observations') is not null then
    -- archive protégée contre l'effacement (déclencheur telemetry_archive_immutable) : coupé le temps de l'effacement seulement
    if exists (select 1 from pg_trigger where tgname = 'telemetry_archive_immutable' and tgrelid = 'public.telemetry_observations'::regclass) then
      execute 'alter table public.telemetry_observations disable trigger telemetry_archive_immutable';
    end if;
    execute 'delete from public.telemetry_observations where observed_at < now() - $1' using p_keep;
    get diagnostics n_tel = row_count;
    if exists (select 1 from pg_trigger where tgname = 'telemetry_archive_immutable' and tgrelid = 'public.telemetry_observations'::regclass) then
      execute 'alter table public.telemetry_observations enable trigger telemetry_archive_immutable';
    end if;
  end if;
  if to_regclass('public.fleet_observations') is not null then
    execute 'delete from public.fleet_observations where observed_at < now() - $1' using p_keep;
    get diagnostics n_fleet = row_count;
  end if;
  return jsonb_build_object('telemetry_observations', n_tel, 'fleet_observations', n_fleet);
end $$;
revoke all on function public.ludy_purge_live_logs(interval) from public, anon, authenticated;
grant execute on function public.ludy_purge_live_logs(interval) to service_role;

-- toutes les heures à h:41 (pg_cron, s'il est installé)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'ludy-purge-releves';
    perform cron.schedule('ludy-purge-releves', '41 * * * *', 'select public.ludy_purge_live_logs()');
  end if;
end $$;
