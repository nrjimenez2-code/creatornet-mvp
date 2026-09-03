begin;

-- One private coordination row per buyer/product identity. The route persists
-- the attempt and order UUID before calling Stripe, so separate HTTP retries
-- use the same Stripe idempotency key and identical request parameters.
create table if not exists public.product_checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references auth.users(id) on delete cascade,
  purchase_identity text not null,
  creator_id uuid not null references public.profiles(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  post_id uuid references public.posts(id) on delete restrict,
  attempt_key uuid not null default gen_random_uuid(),
  order_id uuid not null,
  terms_fingerprint text not null,
  stripe_checkout_session_id text,
  stripe_checkout_url text,
  status text not null default 'creating',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_checkout_attempts_identity_nonempty_check
    check (length(purchase_identity) > 0),
  constraint product_checkout_attempts_fingerprint_check
    check (terms_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint product_checkout_attempts_status_check
    check (status in ('creating', 'open', 'complete')),
  constraint product_checkout_attempts_buyer_identity_key
    unique (buyer_id, purchase_identity),
  constraint product_checkout_attempts_attempt_key_key unique (attempt_key),
  constraint product_checkout_attempts_order_id_key unique (order_id),
  constraint product_checkout_attempts_session_id_key unique (stripe_checkout_session_id)
);

comment on table public.product_checkout_attempts is
  'Server-only coordination state that prevents multiple payable product Checkout Sessions per buyer/product.';

alter table public.product_checkout_attempts enable row level security;
revoke all on table public.product_checkout_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.product_checkout_attempts to service_role;

commit;
