-- Email OTP attempts must pass through the server route. The token hook binds
-- an admission to the Auth-created session using a single-use random User-Agent.
-- No OTPs, email addresses, access tokens, or refresh tokens are stored here.
create schema if not exists auth_private;
revoke all on schema auth_private from public, anon, authenticated;
grant usage on schema auth_private to service_role, supabase_auth_admin;

create table auth_private.email_code_ip_limits (
  ip_key text primary key,
  window_started_at timestamptz not null,
  attempts integer not null
);
alter table auth_private.email_code_ip_limits enable row level security;
revoke all on auth_private.email_code_ip_limits from public, anon, authenticated;
grant select, insert, update, delete on auth_private.email_code_ip_limits to service_role;
create index email_code_ip_limits_window on auth_private.email_code_ip_limits(window_started_at);

create function public.email_code_ip_admit(p_ip_key text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare state auth_private.email_code_ip_limits; t timestamptz := clock_timestamp();
begin
  if p_ip_key is null or p_ip_key !~ '^[a-f0-9]{64}$' then raise exception 'Invalid IP key'; end if;
  delete from auth_private.email_code_ip_limits where ip_key in (
    select ip_key from auth_private.email_code_ip_limits where window_started_at < t - interval '24 hours'
    order by window_started_at limit 100 for update skip locked
  );
  insert into auth_private.email_code_ip_limits values(p_ip_key,t,0) on conflict do nothing;
  select * into state from auth_private.email_code_ip_limits where ip_key=p_ip_key for update;
  if state.window_started_at <= t - interval '5 minutes' then state.attempts := 0; state.window_started_at := t; end if;
  if state.attempts >= 30 then
    return jsonb_build_object('allowed',false,'retry_after',greatest(1,ceil(extract(epoch from state.window_started_at+interval '5 minutes'-t))::integer));
  end if;
  update auth_private.email_code_ip_limits set attempts=state.attempts+1,window_started_at=state.window_started_at where ip_key=p_ip_key;
  return jsonb_build_object('allowed',true);
end;
$$;
revoke all on function public.email_code_ip_admit(text) from public, anon, authenticated;
grant execute on function public.email_code_ip_admit(text) to service_role;

create table auth_private.email_code_attempts (
  email_key text primary key check (email_key ~ '^[a-f0-9]{64}$'),
  attempts integer not null default 0 check (attempts between 0 and 5),
  window_started_at timestamptz not null default clock_timestamp(),
  locked_until timestamptz,
  next_send_at timestamptz,
  code_hash text,
  code_expires_at timestamptz,
  admission_hash text,
  admission_expires_at timestamptz,
  admitted_session_id uuid,
  updated_at timestamptz not null default clock_timestamp()
);
alter table auth_private.email_code_attempts enable row level security;
revoke all on auth_private.email_code_attempts from public, anon, authenticated;
grant select, insert, update, delete on auth_private.email_code_attempts to service_role;
grant select, update on auth_private.email_code_attempts to supabase_auth_admin;
create policy email_code_auth_hook on auth_private.email_code_attempts
  for all to supabase_auth_admin using (true) with check (true);
create index email_code_attempts_updated on auth_private.email_code_attempts(updated_at);

-- Only the server can reserve attempts. Row locks serialize all tabs/instances.
create function public.email_code_admit(p_email_key text, p_action text, p_code_hash text, p_admission_hash text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  state auth_private.email_code_attempts;
  t timestamptz := clock_timestamp();
  code_matches boolean := false;

begin
  if p_email_key is null or p_email_key !~ '^[a-f0-9]{64}$' or
     p_action is null or p_action not in ('send', 'verify') or
     p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$' or
     (p_action = 'verify' and (p_admission_hash is null or p_admission_hash !~ '^[a-f0-9]{64}$')) then
    raise exception 'Invalid admission input';
  end if;
  -- Bounded housekeeping retains active lockouts but discards idle hashes.
  delete from auth_private.email_code_attempts where email_key in (
    select email_key from auth_private.email_code_attempts
    where updated_at < t - interval '24 hours' order by updated_at limit 100 for update skip locked
  );
  insert into auth_private.email_code_attempts(email_key) values(p_email_key) on conflict do nothing;
  select * into state from auth_private.email_code_attempts where email_key = p_email_key for update;
  if state.locked_until > t then
    return jsonb_build_object('allowed', false, 'reason', 'locked', 'retry_after', ceil(extract(epoch from state.locked_until - t))::integer);
  end if;
  -- Do not reset an unfinished reservation while its provider call is active.
  if state.admission_expires_at > t then
    return jsonb_build_object('allowed', false, 'reason', 'busy', 'retry_after', ceil(extract(epoch from state.admission_expires_at - t))::integer);
  end if;
  if state.locked_until is not null or state.window_started_at <= t - interval '15 minutes' then
    state.attempts := 0;
    state.locked_until := null;
    state.window_started_at := t;
  end if;
  if p_action = 'send' then
    if state.next_send_at > t then
      return jsonb_build_object('allowed', false, 'reason', 'resend', 'retry_after', ceil(extract(epoch from state.next_send_at - t))::integer);
    end if;
    -- Sending another code never resets the attempt budget.
    state.next_send_at := t + interval '60 seconds';
    state.code_hash := p_code_hash;
    state.code_expires_at := t + interval '10 minutes';
    state.admission_hash := null;
    state.admission_expires_at := null;
    state.admitted_session_id := null;
  else
    state.attempts := state.attempts + 1;
    code_matches := coalesce(state.code_hash = p_code_hash and state.code_expires_at > t, false);
    state.admission_hash := case when code_matches then p_admission_hash else null end;
    state.admission_expires_at := case when code_matches then t + interval '30 seconds' else null end;
    if code_matches then state.code_hash := null; end if;
    state.admitted_session_id := null;
    if state.attempts = 5 then state.locked_until := t + interval '15 minutes'; end if;
  end if;
  update auth_private.email_code_attempts set
    attempts = state.attempts, window_started_at = state.window_started_at,
    locked_until = state.locked_until, next_send_at = state.next_send_at,
    code_hash = state.code_hash, code_expires_at = state.code_expires_at,
    admission_hash = state.admission_hash, admission_expires_at = state.admission_expires_at,
    admitted_session_id = state.admitted_session_id, updated_at = t
    where email_key = p_email_key;
  return jsonb_build_object('allowed', p_action = 'send' or code_matches,
    'reason', case when p_action = 'verify' and not code_matches then case when state.locked_until > t then 'locked' else 'invalid' end else null end,
    'attempts_remaining', 5 - state.attempts,
    'retry_after', case when state.locked_until > t then 900 else 0 end);
end;
$$;

-- Success is established by the token hook, never by an untrusted client flag.
create function public.email_code_finish(p_email_key text, p_admission_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare state auth_private.email_code_attempts; t timestamptz := clock_timestamp(); verified boolean;
begin
  select * into state from auth_private.email_code_attempts where email_key = p_email_key for update;
  if not found or state.admission_hash is distinct from p_admission_hash then
    return jsonb_build_object('verified', false, 'retry_after', 30);
  end if;
  verified := state.admitted_session_id is not null;
  update auth_private.email_code_attempts set
    attempts = case when verified then 0 else attempts end,
    locked_until = case when verified then null else locked_until end,
    window_started_at = case when verified then t else window_started_at end,
    admission_hash = null, admission_expires_at = null, admitted_session_id = null, updated_at = t
    where email_key = p_email_key;
  return jsonb_build_object('verified', verified, 'retry_after',
    case when not verified and state.locked_until > t then ceil(extract(epoch from state.locked_until - t))::integer else 0 end,
    'attempts_remaining', case when verified then 5 else 5 - state.attempts end);
end;
$$;

-- Enable this as the project's Custom Access Token hook ONLY after the protected
-- route is deployed and verified. No changes to provider configuration here.
-- OTP covers both GET/link and POST/code paths. Protect legacy names as well.
-- OAuth and token refresh do not spend OTP attempts or invalidate active sessions.
create function public.creatornet_email_code_token_hook(event jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_email_key text; agent text; v_session_id uuid; v_user_id uuid; admitted boolean;
begin
  if event->>'authentication_method' not in ('otp','magiclink','email/signup','recovery','invite','email_change') then
    return jsonb_build_object('claims', event->'claims');
  end if;
  v_user_id := (event->>'user_id')::uuid;
  v_session_id := (event->'claims'->>'session_id')::uuid;
  select s.user_agent into agent from auth.sessions s where s.id = v_session_id and s.user_id = v_user_id;
  -- Hosting runtimes may append a User-Agent product/comment. Bind only the
  -- complete leading random admission product, requiring a token boundary.
  agent := substring(agent from '^(CreatorNetEmailCode/[a-f0-9]{64})(?:[[:space:]]|$)');
  if agent is null or agent !~ '^CreatorNetEmailCode/[a-f0-9]{64}$' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Please verify your code on the CreatorNet sign-in page.'));
  end if;
  select encode(sha256(convert_to(lower(btrim(u.email)), 'UTF8')), 'hex') into v_email_key
    from auth.users u where u.id = v_user_id;
  update auth_private.email_code_attempts a set admitted_session_id = v_session_id
    where a.email_key = v_email_key
      and a.admission_hash = encode(sha256(convert_to(agent, 'UTF8')), 'hex')
      and a.admission_expires_at > clock_timestamp()
      and a.admitted_session_id is null
    returning true into admitted;
  if admitted is not true then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Please verify your code on the CreatorNet sign-in page.'));
  end if;
  return jsonb_build_object('claims', event->'claims');
end;
$$;

revoke all on function public.email_code_admit(text,text,text,text) from public, anon, authenticated;
revoke all on function public.email_code_finish(text,text) from public, anon, authenticated;
revoke all on function public.creatornet_email_code_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.email_code_admit(text,text,text,text) to service_role;
grant execute on function public.email_code_finish(text,text) to service_role;
grant execute on function public.creatornet_email_code_token_hook(jsonb) to supabase_auth_admin;
grant usage on schema public, auth to supabase_auth_admin;
grant select(id,user_id,user_agent) on auth.sessions to supabase_auth_admin;
grant select(id,email) on auth.users to supabase_auth_admin;
