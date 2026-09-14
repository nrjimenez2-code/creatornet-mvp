-- Provider credentials are server-only and encrypted by the application.
-- The browser receives an explicit status projection through authenticated routes.
create table public.scheduling_connections_v1 (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('calcom', 'calendly')),
  status text not null default 'pending' check (status in
    ('pending', 'connected', 'reconnect_required', 'disconnecting', 'disconnected', 'error')),
  account_id text,
  account_name text,
  organization_id text,
  credentials_ciphertext text,
  webhook_id text,
  webhook_secret_ciphertext text,
  token_expires_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  generation bigint not null default 0,
  last_checked_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (creator_id, provider),
  check (status <> 'connected' or (
    account_id is not null and credentials_ciphertext is not null and
    webhook_id is not null and webhook_secret_ciphertext is not null and token_expires_at is not null)),
  check ((lease_id is null) = (lease_until is null))
);

-- An account cannot grant two CreatorNet identities credit for the same webhook.
create unique index scheduling_connections_account_v1 on public.scheduling_connections_v1(provider, account_id)
  where account_id is not null and status <> 'disconnected';

create table public.scheduling_oauth_attempts_v1 (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('calcom', 'calendly')),
  verifier_ciphertext text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);
create index scheduling_oauth_attempts_expiry_v1 on public.scheduling_oauth_attempts_v1(expires_at);

-- Event types are fetched with the creator's OAuth token, never trusted from a pasted URL.
create table public.scheduling_event_types_v1 (
  connection_id uuid not null references public.scheduling_connections_v1(id) on delete cascade,
  provider_event_id text not null,
  title text not null,
  booking_url text not null check (booking_url like 'https://%'),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (connection_id, provider_event_id)
);

alter table public.scheduling_connections_v1 enable row level security;
alter table public.scheduling_oauth_attempts_v1 enable row level security;
alter table public.scheduling_event_types_v1 enable row level security;
revoke all on public.scheduling_connections_v1, public.scheduling_oauth_attempts_v1,
  public.scheduling_event_types_v1 from public, anon, authenticated;
grant all on public.scheduling_connections_v1, public.scheduling_oauth_attempts_v1,
  public.scheduling_event_types_v1 to service_role;
