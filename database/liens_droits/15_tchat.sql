-- =============================================================================
-- Tchat : conversations, messages, appels audio / vidéo (clés étrangères et droits : RLS, règles, GRANT)
-- Conversations à deux ou de groupe, messages (texte, fichiers du seau « chat », audio), appels WebRTC (la base relaie la signalisation).
-- Droits : tout compte validé ; chacun ne lit que ses conversations.
-- Tables : chat_calls, chat_members, chat_messages, chat_signals, chat_threads
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Clés étrangères

ALTER TABLE ONLY public.chat_calls
    ADD CONSTRAINT chat_calls_callee_fkey FOREIGN KEY (callee) REFERENCES public.profiles(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_calls
    ADD CONSTRAINT chat_calls_caller_fkey FOREIGN KEY (caller) REFERENCES public.profiles(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_calls
    ADD CONSTRAINT chat_calls_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_members
    ADD CONSTRAINT chat_members_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_members
    ADD CONSTRAINT chat_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE SET NULL;

ALTER TABLE ONLY public.chat_signals
    ADD CONSTRAINT chat_signals_call_id_fkey FOREIGN KEY (call_id) REFERENCES public.chat_calls(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(user_id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

ALTER TABLE public.chat_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_calls_read ON public.chat_calls FOR SELECT TO authenticated USING (((caller = ( SELECT auth.uid() AS uid)) OR (callee = ( SELECT auth.uid() AS uid))));

ALTER TABLE public.chat_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_members_read ON public.chat_members FOR SELECT TO authenticated USING ((thread_id IN ( SELECT public.chat_my_threads() AS chat_my_threads)));

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_messages_read ON public.chat_messages FOR SELECT TO authenticated USING ((thread_id IN ( SELECT public.chat_my_threads() AS chat_my_threads)));

ALTER TABLE public.chat_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_signals_read ON public.chat_signals FOR SELECT TO authenticated USING ((to_uid = ( SELECT auth.uid() AS uid)));

ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_threads_read ON public.chat_threads FOR SELECT TO authenticated USING ((id IN ( SELECT public.chat_my_threads() AS chat_my_threads)));

-- ----------------------------------------------------------------------------- Droits et commentaires

REVOKE ALL ON FUNCTION public.chat_badge() FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_badge() TO authenticated;
GRANT ALL ON FUNCTION public.chat_badge() TO service_role;

REVOKE ALL ON FUNCTION public.chat_call_set(p_id uuid, p_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_call_set(p_id uuid, p_status text) TO authenticated;
GRANT ALL ON FUNCTION public.chat_call_set(p_id uuid, p_status text) TO service_role;

REVOKE ALL ON FUNCTION public.chat_call_start(p_thread bigint, p_kind text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_call_start(p_thread bigint, p_kind text) TO authenticated;
GRANT ALL ON FUNCTION public.chat_call_start(p_thread bigint, p_kind text) TO service_role;

REVOKE ALL ON FUNCTION public.chat_can() FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_can() TO authenticated;
GRANT ALL ON FUNCTION public.chat_can() TO service_role;

REVOKE ALL ON FUNCTION public.chat_delete(p_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_delete(p_id bigint) TO authenticated;
GRANT ALL ON FUNCTION public.chat_delete(p_id bigint) TO service_role;

REVOKE ALL ON FUNCTION public.chat_folder_ok(p_folder text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_folder_ok(p_folder text) TO authenticated;
GRANT ALL ON FUNCTION public.chat_folder_ok(p_folder text) TO service_role;

REVOKE ALL ON FUNCTION public.chat_group(p_name text, p_members uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_group(p_name text, p_members uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.chat_group(p_name text, p_members uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.chat_group_add(p_thread bigint, p_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_group_add(p_thread bigint, p_user uuid) TO authenticated;
GRANT ALL ON FUNCTION public.chat_group_add(p_thread bigint, p_user uuid) TO service_role;

REVOKE ALL ON FUNCTION public.chat_group_leave(p_thread bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_group_leave(p_thread bigint) TO authenticated;
GRANT ALL ON FUNCTION public.chat_group_leave(p_thread bigint) TO service_role;

REVOKE ALL ON FUNCTION public.chat_list() FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_list() TO authenticated;
GRANT ALL ON FUNCTION public.chat_list() TO service_role;

REVOKE ALL ON FUNCTION public.chat_my_threads() FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_my_threads() TO authenticated;
GRANT ALL ON FUNCTION public.chat_my_threads() TO service_role;

REVOKE ALL ON FUNCTION public.chat_open(p_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_open(p_user uuid) TO authenticated;
GRANT ALL ON FUNCTION public.chat_open(p_user uuid) TO service_role;

REVOKE ALL ON FUNCTION public.chat_read(p_thread bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_read(p_thread bigint) TO authenticated;
GRANT ALL ON FUNCTION public.chat_read(p_thread bigint) TO service_role;

REVOKE ALL ON FUNCTION public.chat_send(p_thread bigint, p_kind text, p_body text, p_path text, p_name text, p_size integer, p_mime text, p_duration integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_send(p_thread bigint, p_kind text, p_body text, p_path text, p_name text, p_size integer, p_mime text, p_duration integer) TO authenticated;
GRANT ALL ON FUNCTION public.chat_send(p_thread bigint, p_kind text, p_body text, p_path text, p_name text, p_size integer, p_mime text, p_duration integer) TO service_role;

REVOKE ALL ON FUNCTION public.chat_signal(p_call uuid, p_kind text, p_data jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_signal(p_call uuid, p_kind text, p_data jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.chat_signal(p_call uuid, p_kind text, p_data jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.chat_signals_after(p_call uuid, p_after bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_signals_after(p_call uuid, p_after bigint) TO authenticated;
GRANT ALL ON FUNCTION public.chat_signals_after(p_call uuid, p_after bigint) TO service_role;

REVOKE ALL ON FUNCTION public.chat_users() FROM PUBLIC;
GRANT ALL ON FUNCTION public.chat_users() TO authenticated;
GRANT ALL ON FUNCTION public.chat_users() TO service_role;

GRANT ALL ON TABLE public.chat_calls TO service_role;
GRANT SELECT ON TABLE public.chat_calls TO authenticated;

GRANT ALL ON TABLE public.chat_members TO service_role;
GRANT SELECT ON TABLE public.chat_members TO authenticated;

GRANT ALL ON TABLE public.chat_messages TO service_role;
GRANT SELECT ON TABLE public.chat_messages TO authenticated;

GRANT ALL ON SEQUENCE public.chat_messages_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.chat_messages_id_seq TO service_role;

GRANT ALL ON TABLE public.chat_signals TO service_role;
GRANT SELECT ON TABLE public.chat_signals TO authenticated;

GRANT ALL ON SEQUENCE public.chat_signals_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.chat_signals_id_seq TO service_role;

GRANT ALL ON TABLE public.chat_threads TO service_role;
GRANT SELECT ON TABLE public.chat_threads TO authenticated;

GRANT ALL ON SEQUENCE public.chat_threads_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.chat_threads_id_seq TO service_role;
