-- =============================================================================
-- Temps réel (Supabase Realtime) : tables suivies par le site (bandeau d'alertes, page En direct).
-- Sans Supabase (publication supabase_realtime absente), ce fichier ne fait rien : le site retombe sur la lecture périodique.
-- =============================================================================
do $$ declare t text; begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then raise notice 'pas de Supabase Realtime : rien à faire'; return; end if;
  foreach t in array array['alerts', 'live_status'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
