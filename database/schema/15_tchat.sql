-- =============================================================================
-- Tchat : conversations, messages, appels audio / vidéo (structure)
-- Conversations à deux ou de groupe, messages (texte, fichiers du seau « chat », audio), appels WebRTC (la base relaie la signalisation).
-- Droits : tout compte validé ; chacun ne lit que ses conversations.
-- Tables : chat_calls, chat_members, chat_messages, chat_signals, chat_threads
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.chat_badge() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select jsonb_build_object(
    'unread', (select count(*) from chat_messages m join chat_members me on me.thread_id = m.thread_id and me.user_id = auth.uid()
      where m.created_at > me.last_read_at and m.user_id is distinct from auth.uid() and m.kind <> 'system'),
    'last_id', (select max(m.id) from chat_messages m where m.thread_id in (select public.chat_my_threads())),
    'ringing', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'thread_id', c.thread_id, 'kind', c.kind, 'caller', c.caller, 'started_at', c.started_at,
        'caller_name', coalesce(nullif(p.name, ''), split_part(p.email, '@', 1)))), '[]')
      from chat_calls c join profiles p on p.user_id = c.caller where c.callee = auth.uid() and c.status = 'ringing' and c.started_at > now() - interval '2 minutes'))
  where public.chat_can()
$$;

CREATE FUNCTION public.chat_call_set(p_id uuid, p_status text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

CREATE FUNCTION public.chat_call_start(p_thread bigint, p_kind text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

CREATE FUNCTION public.chat_can() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((select role from profiles where user_id = auth.uid()), 'pending') <> 'pending'
$$;

CREATE FUNCTION public.chat_delete(p_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update chat_messages set deleted_at = now(), body = null where id = p_id and user_id = auth.uid() and deleted_at is null and kind <> 'call';
end $$;

CREATE FUNCTION public.chat_folder_ok(p_folder text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  select p_folder ~ '^[0-9]{1,18}$' and exists (select 1 from chat_members where thread_id = p_folder::bigint and user_id = auth.uid())
$_$;

CREATE FUNCTION public.chat_group(p_name text, p_members uuid[]) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

CREATE FUNCTION public.chat_group_add(p_thread bigint, p_user uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

CREATE FUNCTION public.chat_group_leave(p_thread bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare me uuid := auth.uid(); n text;
begin
  if me is null then raise exception 'Accès refusé'; end if;
  if not exists (select 1 from chat_threads where id = p_thread and kind = 'group') then raise exception 'Pas un groupe'; end if;
  select coalesce(nullif(name, ''), email) into n from profiles where user_id = me;
  delete from chat_members where thread_id = p_thread and user_id = me;
  insert into chat_messages (thread_id, user_id, kind, body) values (p_thread, me, 'system', n || ' a quitté le groupe');
end $$;

CREATE FUNCTION public.chat_list() RETURNS TABLE(id bigint, kind text, name text, last_at timestamp with time zone, last_text text, unread bigint, members jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select t.id, t.kind, t.name, t.last_at, t.last_text,
    (select count(*) from chat_messages m where m.thread_id = t.id and m.created_at > me.last_read_at and m.user_id is distinct from auth.uid() and m.kind <> 'system') as unread,
    (select coalesce(jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', coalesce(nullif(p.name, ''), split_part(p.email, '@', 1)), 'role', p.role) order by p.name), '[]')
      from chat_members cm join profiles p on p.user_id = cm.user_id where cm.thread_id = t.id) as members
  from chat_threads t join chat_members me on me.thread_id = t.id and me.user_id = auth.uid()
  where public.chat_can()
  order by t.last_at desc nulls last, t.id desc
$$;

CREATE FUNCTION public.chat_my_threads() RETURNS SETOF bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select thread_id from chat_members where user_id = auth.uid()
$$;

CREATE FUNCTION public.chat_open(p_user uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

CREATE FUNCTION public.chat_read(p_thread bigint) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update chat_members set last_read_at = now() where thread_id = p_thread and user_id = auth.uid()
$$;

CREATE FUNCTION public.chat_send(p_thread bigint, p_kind text, p_body text, p_path text DEFAULT NULL::text, p_name text DEFAULT NULL::text, p_size integer DEFAULT NULL::integer, p_mime text DEFAULT NULL::text, p_duration integer DEFAULT NULL::integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
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
end $_$;

CREATE FUNCTION public.chat_signal(p_call uuid, p_kind text, p_data jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare me uuid := auth.uid(); c chat_calls;
begin
  select * into c from chat_calls where id = p_call and (caller = me or callee = me) and status in ('ringing', 'accepted') for share;
  if c.id is null then raise exception 'Appel terminé'; end if;
  if p_kind not in ('offer', 'answer', 'ice', 'hangup', 'renegotiate') then raise exception 'Signal inconnu'; end if;
  if length(coalesce(p_data::text, '')) > 60000 then raise exception 'Signal trop long'; end if;
  insert into chat_signals (call_id, from_uid, to_uid, kind, data) values (p_call, me, case when me = c.caller then c.callee else c.caller end, p_kind, p_data);
end $$;

CREATE FUNCTION public.chat_signals_after(p_call uuid, p_after bigint) RETURNS TABLE(id bigint, call_id uuid, from_uid uuid, to_uid uuid, kind text, data jsonb, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select s.id, s.call_id, s.from_uid, s.to_uid, s.kind, s.data, s.created_at from chat_signals s where s.call_id = p_call and s.to_uid = auth.uid() and s.id > coalesce(p_after, 0) order by s.id
$$;

CREATE FUNCTION public.chat_users() RETURNS TABLE(user_id uuid, name text, email text, role text, online boolean, last_seen timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.user_id, coalesce(nullif(p.name, ''), split_part(p.email, '@', 1)) as name, p.email, p.role,
    coalesce(s.last_seen > now() - interval '3 minutes', false) as online, s.last_seen
  from profiles p
  left join lateral (select max(last_seen) as last_seen from user_sessions u where u.user_id = p.user_id and u.active and u.page is distinct from 'Déconnecté') s on true
  where p.role <> 'pending' and public.chat_can()
  order by online desc, lower(coalesce(nullif(p.name, ''), p.email))
$$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.chat_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id bigint NOT NULL,
    caller uuid NOT NULL,
    callee uuid NOT NULL,
    kind text DEFAULT 'audio'::text NOT NULL,
    status text DEFAULT 'ringing'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    answered_at timestamp with time zone,
    ended_at timestamp with time zone,
    ended_by uuid,
    CONSTRAINT chat_calls_kind_check CHECK ((kind = ANY (ARRAY['audio'::text, 'video'::text]))),
    CONSTRAINT chat_calls_status_check CHECK ((status = ANY (ARRAY['ringing'::text, 'accepted'::text, 'ended'::text, 'declined'::text, 'missed'::text, 'busy'::text, 'failed'::text])))
);

CREATE TABLE public.chat_members (
    thread_id bigint NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.chat_messages (
    id bigint NOT NULL,
    thread_id bigint NOT NULL,
    user_id uuid,
    kind text DEFAULT 'text'::text NOT NULL,
    body text,
    path text,
    file_name text,
    file_size integer,
    mime text,
    duration_s integer,
    call_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT chat_messages_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'file'::text, 'image'::text, 'audio'::text, 'call'::text, 'system'::text])))
);

ALTER TABLE public.chat_messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.chat_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.chat_signals (
    id bigint NOT NULL,
    call_id uuid NOT NULL,
    from_uid uuid NOT NULL,
    to_uid uuid NOT NULL,
    kind text NOT NULL,
    data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_signals_kind_check CHECK ((kind = ANY (ARRAY['offer'::text, 'answer'::text, 'ice'::text, 'hangup'::text, 'renegotiate'::text])))
);

ALTER TABLE public.chat_signals ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.chat_signals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.chat_threads (
    id bigint NOT NULL,
    kind text DEFAULT 'direct'::text NOT NULL,
    name text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_at timestamp with time zone,
    last_text text,
    CONSTRAINT chat_threads_kind_check CHECK ((kind = ANY (ARRAY['direct'::text, 'group'::text])))
);

ALTER TABLE public.chat_threads ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.chat_threads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.chat_calls
    ADD CONSTRAINT chat_calls_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chat_members
    ADD CONSTRAINT chat_members_pkey PRIMARY KEY (thread_id, user_id);

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chat_signals
    ADD CONSTRAINT chat_signals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_pkey PRIMARY KEY (id);

CREATE INDEX chat_calls_callee ON public.chat_calls USING btree (callee, status, started_at DESC);

CREATE INDEX chat_calls_caller ON public.chat_calls USING btree (caller, status, started_at DESC);

CREATE INDEX chat_members_user ON public.chat_members USING btree (user_id);

CREATE INDEX chat_messages_thread ON public.chat_messages USING btree (thread_id, id DESC);

CREATE INDEX chat_signals_to ON public.chat_signals USING btree (to_uid, call_id, id);
