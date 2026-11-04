-- Local portal sessions. Authentication and access rotation share the account
-- row lock, so an earlier credential cannot survive a completed reset.
do $$ begin
 if (select value from public.params where key='environment') is distinct from 'staging' then
  raise exception 'Base locale de staging obligatoire';
 end if;
end $$;

create function public.driver_portal_login(p_credential_hash text,p_token_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare account public.driver_portal_accounts; created timestamptz; expires timestamptz;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if p_credential_hash is null or p_credential_hash !~ '^[a-f0-9]{64}$'
  or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid credential digest';end if;
 select * into account from public.driver_portal_accounts where credential_hash=p_credential_hash and active for update;
 if not found then return null;end if;
 created:=clock_timestamp();expires:=created+interval '12 hours';
 delete from public.driver_portal_sessions where account_id=account.id and expires_at<=created;
 insert into public.driver_portal_sessions(token_hash,account_id,created_at,expires_at) values(p_token_hash,account.id,created,expires);
 return jsonb_build_object('name',account.display_name,'expires_at',expires);
end $$;

create function public.driver_portal_rotate(p_account uuid,p_credential_hash text,p_user uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare account public.driver_portal_accounts;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if p_user is null or not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Administrator required';end if;
 if p_account is null or p_credential_hash is not null and p_credential_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid access rotation';end if;
 select * into account from public.driver_portal_accounts where id=p_account for update;
 if not found then return null;end if;
 delete from public.driver_portal_sessions where account_id=account.id;
 update public.driver_portal_accounts set active=p_credential_hash is not null,
  credential_hash=coalesce(p_credential_hash,credential_hash),rotated_at=clock_timestamp() where id=account.id;
 return jsonb_build_object('ok',true,'active',p_credential_hash is not null);
end $$;
revoke all on function public.driver_portal_login(text,text),public.driver_portal_rotate(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.driver_portal_login(text,text),public.driver_portal_rotate(uuid,text,uuid) to service_role;

-- Legacy business helpers need staff identity. Preserve their existing staff
-- and service access while removing anonymous execution inherited from PUBLIC.
-- Trigger functions (including Auth provisioning) and pure formatters stay intact.
do $$ declare fn record; staff_allowed boolean; service_allowed boolean; begin
 for fn in select p.oid,p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and p.prokind='f' and p.prorettype<>'trigger'::regtype
   and has_function_privilege('anon',p.oid,'EXECUTE') loop
  staff_allowed:=has_function_privilege('authenticated',fn.oid,'EXECUTE');
  service_allowed:=has_function_privilege('service_role',fn.oid,'EXECUTE');
  execute format('revoke execute on function %s from public,anon',fn.signature);
  if staff_allowed then execute format('grant execute on function %s to authenticated',fn.signature);end if;
  if service_allowed then execute format('grant execute on function %s to service_role',fn.signature);end if;
 end loop;
end $$;
