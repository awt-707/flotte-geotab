-- =============================================================================
-- Connexions en temps réel (21/10/2026, demande d'Ahmed) : qui a Ludy ouvert en ce moment, sur quelle page, depuis quel appareil.
-- À exécuter une fois dans Supabase > SQL Editor (après 20261031000000_courses.sql). Rejouable sans risque.
-- Chaque onglet ou application ouvert envoie un signal toutes les minutes (user_sessions) ; seul l'administrateur voit la liste.
-- =============================================================================
create table if not exists public.user_sessions (
  id text primary key check (id ~ '^[0-9A-Za-z-]{8,64}$'),   -- identifiant aléatoire de l'onglet / de l'application ouverte
  user_id uuid not null default auth.uid() references public.profiles(user_id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  page text,                                  -- page affichée
  client text,                                -- « Application 1.4.0 (Mac) », « Navigateur (Windows) »…
  active boolean not null default true        -- onglet visible et utilisé dans les 10 dernières minutes
);
create index if not exists user_sessions_seen on public.user_sessions(last_seen desc);
create index if not exists user_sessions_user on public.user_sessions(user_id, last_seen desc);

alter table public.user_sessions enable row level security;
revoke all on public.user_sessions from anon;
revoke insert, update, delete, truncate, references, trigger on public.user_sessions from authenticated;
grant select, delete on public.user_sessions to authenticated;
-- l'utilisateur n'écrit que ses propres signaux (user_id = auth.uid() par défaut, colonne non modifiable)
grant insert (id, page, client, active) on public.user_sessions to authenticated;
grant update (last_seen, page, client, active) on public.user_sessions to authenticated;

drop policy if exists own_write on public.user_sessions;
drop policy if exists own_update on public.user_sessions;
drop policy if exists read_admin on public.user_sessions;
drop policy if exists own_delete on public.user_sessions;
create policy own_write on public.user_sessions for insert to authenticated with check (user_id = auth.uid());
create policy own_update on public.user_sessions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_delete on public.user_sessions for delete to authenticated using (user_id = auth.uid() or (select public.is_admin()));
-- lecture : l'administrateur voit tout le monde, chacun voit ses propres sessions
create policy read_admin on public.user_sessions for select to authenticated using ((select public.is_admin()) or user_id = auth.uid());

-- signal d'un onglet ouvert : créé à la première fois, puis heure et page mises à jour (dernière activité fixée par la base)
create or replace function public.session_ping(p_id text, p_page text, p_client text, p_active boolean)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  insert into user_sessions (id, page, client, active) values (p_id, left(p_page, 80), left(p_client, 80), coalesce(p_active, true))
  on conflict (id) do update set last_seen = now(), page = excluded.page, client = excluded.client, active = excluded.active
    where user_sessions.user_id = auth.uid();
  -- ménage : signaux de plus de 30 jours
  delete from user_sessions where user_id = auth.uid() and last_seen < now() - interval '30 days';
end $$;
revoke execute on function public.session_ping(text, text, text, boolean) from public, anon;
grant execute on function public.session_ping(text, text, text, boolean) to authenticated;
