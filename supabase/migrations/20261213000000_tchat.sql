-- =============================================================================
-- Tchat de Ludy (22/11/2026, demande d'Ahmed : parler aux gestionnaires en ligne sans sortir de Ludy pour WhatsApp).
-- Conversations à deux (direct) ou de groupe, messages texte, fichiers (PDF, images, tableurs), messages audio, appels audio / vidéo
-- (WebRTC entre navigateurs ; la base ne porte que la signalisation : offre, réponse, candidats ICE). Historique gardé.
-- Qui est en ligne = signaux des connexions (user_sessions, moins de 3 min), lisibles par chat_users() pour tout compte validé.
-- Droits : tout compte validé (admin, gestionnaire, lecture seule, RH) ; chacun ne lit que ses conversations ; fichiers dans le seau
-- privé « chat » (<conversation>/<fichier>), lisibles par les membres de la conversation seulement.
-- À exécuter dans Supabase > SQL Editor après 20261212000000_uber_perf_contrat.sql. Rejouable.
-- =============================================================================
create table if not exists public.chat_threads (
  id bigint generated always as identity primary key,
  kind text not null default 'direct' check (kind in ('direct', 'group')),
  name text,                                   -- groupe : nom ; direct : vide (nom de l'autre membre affiché)
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  last_at timestamptz,                         -- dernier message (tri de la liste)
  last_text text                               -- aperçu du dernier message
);
create table if not exists public.chat_members (
  thread_id bigint not null references public.chat_threads(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);
create index if not exists chat_members_user on public.chat_members(user_id);
create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  thread_id bigint not null references public.chat_threads(id) on delete cascade,
  user_id uuid references public.profiles(user_id) on delete set null,
  kind text not null default 'text' check (kind in ('text', 'file', 'image', 'audio', 'call', 'system')),
  body text,                                   -- texte, ou légende ; appel : « audio » / « video »
  path text,                                   -- fichier dans le seau chat (<thread>/<uuid>.<ext>)
  file_name text,
  file_size integer,
  mime text,
  duration_s integer,                          -- audio : durée ; appel : durée de la communication
  call_id uuid,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists chat_messages_thread on public.chat_messages(thread_id, id desc);
create table if not exists public.chat_calls (
  id uuid primary key default gen_random_uuid(),
  thread_id bigint not null references public.chat_threads(id) on delete cascade,
  caller uuid not null references public.profiles(user_id) on delete cascade,
  callee uuid not null references public.profiles(user_id) on delete cascade,
  kind text not null default 'audio' check (kind in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'accepted', 'ended', 'declined', 'missed', 'busy', 'failed')),
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  ended_by uuid
);
create index if not exists chat_calls_callee on public.chat_calls(callee, status, started_at desc);
create index if not exists chat_calls_caller on public.chat_calls(caller, status, started_at desc);
-- signalisation WebRTC (offre, réponse, candidats ICE, raccroché) : lignes effacées à la fin de l'appel
create table if not exists public.chat_signals (
  id bigint generated always as identity primary key,
  call_id uuid not null references public.chat_calls(id) on delete cascade,
  from_uid uuid not null,
  to_uid uuid not null,
  kind text not null check (kind in ('offer', 'answer', 'ice', 'hangup', 'renegotiate')),
  data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists chat_signals_to on public.chat_signals(to_uid, call_id, id);

-- ---------- Droits ----------
alter table public.chat_threads enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_calls enable row level security;
alter table public.chat_signals enable row level security;
revoke all on public.chat_threads, public.chat_members, public.chat_messages, public.chat_calls, public.chat_signals from anon, authenticated;
grant select on public.chat_threads, public.chat_members, public.chat_messages, public.chat_calls, public.chat_signals to authenticated;

/** Compte validé (tout rôle sauf « en attente ») */
create or replace function public.chat_can() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role from profiles where user_id = auth.uid()), 'pending') <> 'pending'
$$;
/** Conversations dont je suis membre */
create or replace function public.chat_my_threads() returns setof bigint language sql stable security definer set search_path = public as $$
  select thread_id from chat_members where user_id = auth.uid()
$$;
revoke execute on function public.chat_can(), public.chat_my_threads() from public, anon;
grant execute on function public.chat_can(), public.chat_my_threads() to authenticated;

drop policy if exists chat_threads_read on public.chat_threads;
create policy chat_threads_read on public.chat_threads for select to authenticated using (id in (select public.chat_my_threads()));
drop policy if exists chat_members_read on public.chat_members;
create policy chat_members_read on public.chat_members for select to authenticated using (thread_id in (select public.chat_my_threads()));
drop policy if exists chat_messages_read on public.chat_messages;
create policy chat_messages_read on public.chat_messages for select to authenticated using (thread_id in (select public.chat_my_threads()));
drop policy if exists chat_calls_read on public.chat_calls;
create policy chat_calls_read on public.chat_calls for select to authenticated using (caller = (select auth.uid()) or callee = (select auth.uid()));
drop policy if exists chat_signals_read on public.chat_signals;
create policy chat_signals_read on public.chat_signals for select to authenticated using (to_uid = (select auth.uid()));

-- ---------- Annuaire et présence ----------
/** Comptes validés avec qui parler : nom, rôle, en ligne (signal de connexion de moins de 3 min) */
create or replace function public.chat_users() returns table (user_id uuid, name text, email text, role text, online boolean, last_seen timestamptz)
language sql stable security definer set search_path = public as $$
  select p.user_id, coalesce(nullif(p.name, ''), split_part(p.email, '@', 1)) as name, p.email, p.role,
    coalesce(s.last_seen > now() - interval '3 minutes', false) as online, s.last_seen
  from profiles p
  left join lateral (select max(last_seen) as last_seen from user_sessions u where u.user_id = p.user_id and u.active and u.page is distinct from 'Déconnecté') s on true
  where p.role <> 'pending' and public.chat_can()
  order by online desc, lower(coalesce(nullif(p.name, ''), p.email))
$$;
revoke execute on function public.chat_users() from public, anon;
grant execute on function public.chat_users() to authenticated;

-- ---------- Conversations ----------
/** Conversation directe avec un autre compte (créée si elle manque) */
create or replace function public.chat_open(p_user uuid) returns bigint language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); t bigint;
begin
  if me is null or not public.chat_can() then raise exception 'Accès refusé'; end if;
  if p_user is null or p_user = me then raise exception 'Choisissez un autre compte'; end if;
  if not exists (select 1 from profiles where user_id = p_user and role <> 'pending') then raise exception 'Compte inconnu ou en attente'; end if;
  select t1.id into t from chat_threads t1
    where t1.kind = 'direct' and exists (select 1 from chat_members a where a.thread_id = t1.id and a.user_id = me)
      and exists (select 1 from chat_members b where b.thread_id = t1.id and b.user_id = p_user) limit 1;
  if t is null then
    insert into chat_threads (kind, created_by) values ('direct', me) returning id into t;
    insert into chat_members (thread_id, user_id) values (t, me), (t, p_user);
  end if;
  return t;
end $$;
/** Groupe : nom + membres (moi compris) */
create or replace function public.chat_group(p_name text, p_members uuid[]) returns bigint language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); t bigint; u uuid;
begin
  if me is null or not public.chat_can() then raise exception 'Accès refusé'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Nom du groupe obligatoire'; end if;
  insert into chat_threads (kind, name, created_by) values ('group', left(trim(p_name), 80), me) returning id into t;
  insert into chat_members (thread_id, user_id) values (t, me);
  foreach u in array coalesce(p_members, '{}') loop
    if u <> me and exists (select 1 from profiles where user_id = u and role <> 'pending') then
      insert into chat_members (thread_id, user_id) values (t, u) on conflict do nothing;
    end if;
  end loop;
  insert into chat_messages (thread_id, user_id, kind, body) values (t, me, 'system', 'Groupe créé');
  update chat_threads set last_at = now(), last_text = 'Groupe créé' where id = t;
  return t;
end $$;
/** Ajouter un membre à un groupe (membre du groupe seulement) */
create or replace function public.chat_group_add(p_thread bigint, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n text;
begin
  if me is null or not exists (select 1 from chat_members where thread_id = p_thread and user_id = me) then raise exception 'Accès refusé'; end if;
  if not exists (select 1 from chat_threads where id = p_thread and kind = 'group') then raise exception 'Pas un groupe'; end if;
  select coalesce(nullif(name, ''), email) into n from profiles where user_id = p_user and role <> 'pending';
  if n is null then raise exception 'Compte inconnu'; end if;
  insert into chat_members (thread_id, user_id) values (p_thread, p_user) on conflict do nothing;
  insert into chat_messages (thread_id, user_id, kind, body) values (p_thread, me, 'system', n || ' ajouté(e) au groupe');
  update chat_threads set last_at = now(), last_text = n || ' ajouté(e)' where id = p_thread;
end $$;
/** Quitter un groupe */
create or replace function public.chat_group_leave(p_thread bigint) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n text;
begin
  if me is null then raise exception 'Accès refusé'; end if;
  if not exists (select 1 from chat_threads where id = p_thread and kind = 'group') then raise exception 'Pas un groupe'; end if;
  select coalesce(nullif(name, ''), email) into n from profiles where user_id = me;
  delete from chat_members where thread_id = p_thread and user_id = me;
  insert into chat_messages (thread_id, user_id, kind, body) values (p_thread, me, 'system', n || ' a quitté le groupe');
end $$;

/** Envoi d'un message (texte, fichier, image, audio). Renvoie la ligne créée. */
create or replace function public.chat_send(p_thread bigint, p_kind text, p_body text, p_path text default null, p_name text default null,
  p_size integer default null, p_mime text default null, p_duration integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m chat_messages; prev text;
begin
  if me is null or not exists (select 1 from chat_members where thread_id = p_thread and user_id = me) then raise exception 'Accès refusé'; end if;
  if p_kind not in ('text', 'file', 'image', 'audio') then raise exception 'Type inconnu'; end if;
  if p_kind = 'text' and coalesce(trim(p_body), '') = '' then raise exception 'Message vide'; end if;
  if p_kind <> 'text' and (p_path is null or p_path !~ ('^' || p_thread || '/[A-Za-z0-9_.-]{1,120}$')) then raise exception 'Fichier hors de la conversation'; end if;
  insert into chat_messages (thread_id, user_id, kind, body, path, file_name, file_size, mime, duration_s)
    values (p_thread, me, p_kind, left(p_body, 4000), p_path, left(p_name, 200), p_size, left(p_mime, 100), p_duration) returning * into m;
  prev := case p_kind when 'text' then left(p_body, 120) when 'audio' then '🎤 Message audio' when 'image' then '🖼 ' || coalesce(p_name, 'Image') else '📎 ' || coalesce(p_name, 'Fichier') end;
  update chat_threads set last_at = m.created_at, last_text = prev where id = p_thread;
  update chat_members set last_read_at = m.created_at where thread_id = p_thread and user_id = me;
  return to_jsonb(m);
end $$;
/** Message retiré par son auteur (texte remplacé, fichier gardé dans le stockage jusqu'au ménage) */
create or replace function public.chat_delete(p_id bigint) returns void language plpgsql security definer set search_path = public as $$
begin
  update chat_messages set deleted_at = now(), body = null where id = p_id and user_id = auth.uid() and deleted_at is null and kind <> 'call';
end $$;
/** Conversation lue jusqu'à maintenant */
create or replace function public.chat_read(p_thread bigint) returns void language sql security definer set search_path = public as $$
  update chat_members set last_read_at = now() where thread_id = p_thread and user_id = auth.uid()
$$;
/** Mes conversations : membres, dernier message, non lus */
create or replace function public.chat_list() returns table (id bigint, kind text, name text, last_at timestamptz, last_text text, unread bigint,
  members jsonb)
language sql stable security definer set search_path = public as $$
  select t.id, t.kind, t.name, t.last_at, t.last_text,
    (select count(*) from chat_messages m where m.thread_id = t.id and m.created_at > me.last_read_at and m.user_id is distinct from auth.uid() and m.kind <> 'system') as unread,
    (select coalesce(jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', coalesce(nullif(p.name, ''), split_part(p.email, '@', 1)), 'role', p.role) order by p.name), '[]')
      from chat_members cm join profiles p on p.user_id = cm.user_id where cm.thread_id = t.id) as members
  from chat_threads t join chat_members me on me.thread_id = t.id and me.user_id = auth.uid()
  where public.chat_can()
  order by t.last_at desc nulls last, t.id desc
$$;
/** Non lus (pastille du menu) et appels qui sonnent pour moi */
create or replace function public.chat_badge() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'unread', (select count(*) from chat_messages m join chat_members me on me.thread_id = m.thread_id and me.user_id = auth.uid()
      where m.created_at > me.last_read_at and m.user_id is distinct from auth.uid() and m.kind <> 'system'),
    'last_id', (select max(m.id) from chat_messages m where m.thread_id in (select public.chat_my_threads())),
    'ringing', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'thread_id', c.thread_id, 'kind', c.kind, 'caller', c.caller, 'started_at', c.started_at,
        'caller_name', coalesce(nullif(p.name, ''), split_part(p.email, '@', 1)))), '[]')
      from chat_calls c join profiles p on p.user_id = c.caller where c.callee = auth.uid() and c.status = 'ringing' and c.started_at > now() - interval '2 minutes'))
  where public.chat_can()
$$;
revoke execute on function public.chat_open(uuid), public.chat_group(text, uuid[]), public.chat_group_add(bigint, uuid), public.chat_group_leave(bigint),
  public.chat_send(bigint, text, text, text, text, integer, text, integer), public.chat_delete(bigint), public.chat_read(bigint), public.chat_list(), public.chat_badge() from public, anon;
grant execute on function public.chat_open(uuid), public.chat_group(text, uuid[]), public.chat_group_add(bigint, uuid), public.chat_group_leave(bigint),
  public.chat_send(bigint, text, text, text, text, integer, text, integer), public.chat_delete(bigint), public.chat_read(bigint), public.chat_list(), public.chat_badge() to authenticated;

-- ---------- Appels audio / vidéo (WebRTC ; la base relaie la signalisation) ----------
/** Lancer un appel dans une conversation directe. Renvoie l'appel (jsonb). */
create or replace function public.chat_call_start(p_thread bigint, p_kind text) returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); other uuid; c chat_calls;
begin
  if me is null or not exists (select 1 from chat_members where thread_id = p_thread and user_id = me) then raise exception 'Accès refusé'; end if;
  if p_kind not in ('audio', 'video') then raise exception 'Type d''appel inconnu'; end if;
  select user_id into other from chat_members where thread_id = p_thread and user_id <> me limit 1;
  if other is null or (select kind from chat_threads where id = p_thread) <> 'direct' then raise exception 'Appel possible seulement dans une conversation à deux'; end if;
  -- appels restés ouverts (page fermée) : clos
  update chat_calls set status = case when status = 'ringing' then 'missed' else 'ended' end, ended_at = now()
    where (caller = me or callee = me) and status in ('ringing', 'accepted') and started_at < now() - interval '2 minutes';
  if exists (select 1 from chat_calls where (caller = other or callee = other) and status in ('ringing', 'accepted')) then
    insert into chat_messages (thread_id, user_id, kind, body) values (p_thread, me, 'call', p_kind || ' busy');
    raise exception 'Correspondant déjà en communication';
  end if;
  insert into chat_calls (thread_id, caller, callee, kind) values (p_thread, me, other, p_kind) returning * into c;
  insert into chat_messages (thread_id, user_id, kind, body, call_id) values (p_thread, me, 'call', p_kind || ' ringing', c.id);
  update chat_threads set last_at = now(), last_text = case when p_kind = 'video' then '🎥 Appel vidéo' else '📞 Appel audio' end where id = p_thread;
  return to_jsonb(c);
end $$;
/** Changer l'état d'un appel (accepté, terminé, refusé, manqué, échec) par l'un des deux correspondants */
create or replace function public.chat_call_set(p_id uuid, p_status text) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c chat_calls; d integer; txt text;
begin
  select * into c from chat_calls where id = p_id and (caller = me or callee = me) for update;   -- verrou : aucun signal inséré pendant la clôture
  if c.id is null then raise exception 'Appel inconnu'; end if;
  if p_status = 'accepted' then
    if c.status <> 'ringing' or c.callee <> me then return; end if;
    update chat_calls set status = 'accepted', answered_at = now() where id = p_id;
    update chat_messages set body = c.kind || ' accepted' where call_id = p_id;
    return;
  end if;
  if p_status not in ('ended', 'declined', 'missed', 'failed') then raise exception 'État inconnu'; end if;
  if c.status in ('ended', 'declined', 'missed', 'busy', 'failed') then return; end if;
  if p_status = 'ended' and c.status = 'ringing' then p_status := case when me = c.caller then 'missed' else 'declined' end; end if;
  d := case when c.answered_at is null then null else greatest(0, extract(epoch from now() - c.answered_at))::integer end;
  update chat_calls set status = p_status, ended_at = now(), ended_by = me where id = p_id;
  txt := c.kind || ' ' || p_status;
  update chat_messages set body = txt, duration_s = d where call_id = p_id;
  update chat_threads set last_at = now(), last_text = case when c.kind = 'video' then '🎥 ' else '📞 ' end
    || case p_status when 'ended' then 'Appel' || coalesce(' · ' || (d / 60) || ' min ' || lpad((d % 60)::text, 2, '0'), '') when 'declined' then 'Appel refusé' when 'missed' then 'Appel manqué' else 'Appel échoué' end where id = c.thread_id;
  delete from chat_signals where call_id = p_id;
end $$;
/** Signal WebRTC à l'autre correspondant */
create or replace function public.chat_signal(p_call uuid, p_kind text, p_data jsonb) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c chat_calls;
begin
  select * into c from chat_calls where id = p_call and (caller = me or callee = me) and status in ('ringing', 'accepted') for share;
  if c.id is null then raise exception 'Appel terminé'; end if;
  if p_kind not in ('offer', 'answer', 'ice', 'hangup', 'renegotiate') then raise exception 'Signal inconnu'; end if;
  if length(coalesce(p_data::text, '')) > 60000 then raise exception 'Signal trop long'; end if;
  insert into chat_signals (call_id, from_uid, to_uid, kind, data) values (p_call, me, case when me = c.caller then c.callee else c.caller end, p_kind, p_data);
end $$;
/** Signaux reçus après un identifiant (repli sans temps réel) */
create or replace function public.chat_signals_after(p_call uuid, p_after bigint)
returns table (id bigint, call_id uuid, from_uid uuid, to_uid uuid, kind text, data jsonb, created_at timestamptz) language sql stable security definer set search_path = public as $$
  select s.id, s.call_id, s.from_uid, s.to_uid, s.kind, s.data, s.created_at from chat_signals s where s.call_id = p_call and s.to_uid = auth.uid() and s.id > coalesce(p_after, 0) order by s.id
$$;
revoke execute on function public.chat_call_start(bigint, text), public.chat_call_set(uuid, text), public.chat_signal(uuid, text, jsonb), public.chat_signals_after(uuid, bigint) from public, anon;
grant execute on function public.chat_call_start(bigint, text), public.chat_call_set(uuid, text), public.chat_signal(uuid, text, jsonb), public.chat_signals_after(uuid, bigint) to authenticated;

-- ---------- Stockage des fichiers (seau privé « chat », <conversation>/<fichier>) ----------
/** Dossier d'une conversation dont je suis membre */
create or replace function public.chat_folder_ok(p_folder text) returns boolean language sql stable security definer set search_path = public as $$
  select p_folder ~ '^[0-9]{1,18}$' and exists (select 1 from chat_members where thread_id = p_folder::bigint and user_id = auth.uid())
$$;
revoke execute on function public.chat_folder_ok(text) from public, anon;
grant execute on function public.chat_folder_ok(text) to authenticated;
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('chat', 'chat', false) on conflict (id) do nothing;
    execute 'drop policy if exists chat_insert on storage.objects';
    execute 'drop policy if exists chat_select on storage.objects';
    execute $p$create policy chat_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'chat' and public.chat_folder_ok((storage.foldername(name))[1]))$p$;
    execute $p$create policy chat_select on storage.objects for select to authenticated
      using (bucket_id = 'chat' and public.chat_folder_ok((storage.foldername(name))[1]))$p$;
  end if;
end $$;

-- ---------- Temps réel : messages, appels, signaux (filtrés par les règles RLS) ----------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.chat_messages'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table public.chat_calls'; exception when others then null; end;
    begin execute 'alter publication supabase_realtime add table public.chat_signals'; exception when others then null; end;
  end if;
end $$;
-- paramètres : serveurs ICE (STUN/TURN, JSON) réglables ; fichiers du tchat gardés 180 jours (messages gardés)
insert into public.params (key, label, value, note, sort) values
  ('chatIce', 'Tchat : serveurs TURN / STUN des appels (JSON)', '', 'Vide = serveurs STUN publics de Google (suffisent sur la plupart des réseaux). Si des appels échouent (« Connexion impossible »), ajouter un serveur TURN : [{"urls":"turn:…","username":"…","credential":"…"}].', 130),
  ('chatFileDays', 'Tchat : fichiers gardés (jours)', '180', 'Fichiers, images et messages audio effacés du stockage après ce délai ; les messages restent.', 131)
on conflict (key) do update set label = excluded.label, note = excluded.note, sort = excluded.sort;

-- ---------- Téléphone (application Android, service en arrière-plan) : messages non lus et appels dans watch_poll ----------
-- Même fonction que 20261203000000_retours_alertes.sql, plus la clé « chat » : {unread, msgs: [{id, thread_id, from, text, at}], ringing: [...]}.
create or replace function public.watch_poll(p_secret text) returns jsonb language plpgsql security definer set search_path = public as $$
declare d watch_devices; v_role text; v_ag bigint[]; v_keys text[]; v_admin boolean;
begin
  select * into d from watch_devices where secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex');
  if d.id is null then raise exception 'watch_unknown' using errcode = '28000'; end if;
  v_role := coalesce((select role from profiles where user_id = d.user_id), '');
  if v_role not in ('admin', 'manager', 'viewer', 'rh') then raise exception 'watch_unknown' using errcode = '28000'; end if;
  v_admin := v_role = 'admin';
  v_ag := coalesce((select array_agg(agency_id) from user_agencies where user_id = d.user_id), '{}');
  v_keys := coalesce((select array_agg(key) from vehicles where agency_id = any(v_ag)), '{}');
  if d.last_seen is null or d.last_seen < now() - interval '1 minute' then update watch_devices set last_seen = now() where id = d.id; end if;
  return jsonb_build_object(
    'now', now(),
    'user_id', d.user_id,
    'params', coalesce((select jsonb_object_agg(key, value) from params where key in ('pauseShiftMin', 'pauseRemindMin', 'pauseMoveM', 'trackArriveM', 'returnRadiusM')), '{}'),
    'pauses', case when v_role = 'rh' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'vehicle_key', p.vehicle_key, 'plate', p.plate, 'driver_name', p.driver_name,
        'driver_phone', p.driver_phone, 'started_at', p.started_at, 'planned_min', p.planned_min, 'start_lat', p.start_lat, 'start_lon', p.start_lon,
        'moved_at', p.moved_at, 'moved_m', p.moved_m, 'moved_note', p.moved_note) order by p.started_at)
      from driver_pauses p where p.ended_at is null and p.started_at > now() - interval '24 hours'
        and (v_admin or p.vehicle_key = any(v_keys) or p.agency_id = any(v_ag))), '[]') end,
    'tracks', case when v_role = 'rh' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'mission_id', t.mission_id, 'vehicle_key', t.vehicle_key, 'plate', t.plate,
        'driver_name', t.driver_name, 'started_at', t.started_at, 'dest_label', t.dest_label, 'dest_lat', t.dest_lat, 'dest_lon', t.dest_lon,
        'arrived_at', t.arrived_at) order by t.started_at)
      from mission_tracks t where t.ended_at is null and t.started_at > now() - interval '48 hours'
        and (v_admin or t.vehicle_key = any(v_keys) or t.agency_id = any(v_ag))), '[]') end,
    'returns', case when v_role = 'rh' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'contract_num', r.contract_num, 'vehicle_key', r.vehicle_key,
        'plate', coalesce(v.plate, r.vehicle_key), 'driver_name', r.driver_name, 'slot_at', r.slot_at, 'sent_at', r.sent_at, 'arrived_at', r.arrived_at,
        'agency', a.name, 'lat', a.lat, 'lng', a.lng, 'radius_m', a.return_radius_m) order by r.slot_at nulls last, r.sent_at)
      from return_calls r left join vehicles v on v.key = r.vehicle_key left join agencies a on a.id = r.agency_id
      where r.sent_at is not null and r.done_at is null and r.cancelled_at is null and r.created_at > now() - interval '24 hours'
        and (v_admin or r.vehicle_key = any(v_keys))), '[]') end,
    'chat', jsonb_build_object(
      'unread', (select count(*) from chat_messages m join chat_members me on me.thread_id = m.thread_id and me.user_id = d.user_id
        where m.created_at > me.last_read_at and m.user_id is distinct from d.user_id and m.kind not in ('system', 'call')),
      'msgs', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'thread_id', m.thread_id, 'from', coalesce(nullif(p.name, ''), split_part(p.email, '@', 1)),
          'group', t.name, 'text', case m.kind when 'text' then left(m.body, 160) when 'audio' then '🎤 Message audio' when 'image' then '🖼 ' || coalesce(m.file_name, 'Image') else '📎 ' || coalesce(m.file_name, 'Fichier') end,
          'at', m.created_at) order by m.id desc)
        from chat_messages m join chat_members me on me.thread_id = m.thread_id and me.user_id = d.user_id join chat_threads t on t.id = m.thread_id
        left join profiles p on p.user_id = m.user_id
        where m.created_at > me.last_read_at and m.created_at > now() - interval '2 hours' and m.user_id is distinct from d.user_id and m.kind not in ('system', 'call') and m.deleted_at is null
        limit 10), '[]'),
      'ringing', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'thread_id', c.thread_id, 'kind', c.kind, 'started_at', c.started_at,
          'caller_name', coalesce(nullif(p.name, ''), split_part(p.email, '@', 1)))) from chat_calls c join profiles p on p.user_id = c.caller
        where c.callee = d.user_id and c.status = 'ringing' and c.started_at > now() - interval '2 minutes'), '[]')));
end $$;
revoke execute on function public.watch_poll(text) from public;
grant execute on function public.watch_poll(text) to anon, authenticated, service_role;
