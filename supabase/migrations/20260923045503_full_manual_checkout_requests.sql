begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Before any acceptance/preparation RPC, retain the server quote and identities
-- under the buyer's request ID. Unknown replies never allocate a new attempt.
create table public.full_manual_checkout_requests_v1 (
  request_id uuid primary key,
  buyer_id uuid not null,
  product_id uuid not null,
  post_id uuid not null,
  context jsonb not null references public.exact_installment_context_pin_v2(context),
  attempt_id uuid not null unique default gen_random_uuid(),
  attempt_key uuid not null unique default gen_random_uuid(),
  order_id uuid not null unique default gen_random_uuid(),
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.full_manual_checkout_requests_v1 enable row level security;
revoke all on public.full_manual_checkout_requests_v1 from public,anon,authenticated,service_role;
grant select on public.full_manual_checkout_requests_v1 to service_role;

create function public.plan_full_manual_checkout_v1(p_request_id uuid,p_buyer_id uuid,p_product_id uuid,p_post_id uuid,p_context jsonb,p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare saved public.full_manual_checkout_requests_v1%rowtype; t jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_request_id is null or p_buyer_id is null or
    p_product_id is null or p_post_id is null or
    not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Owned current full checkout context required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||p_product_id::text,72913));
  select * into saved from public.full_manual_checkout_requests_v1 where request_id=p_request_id;
  if found then
    if saved.buyer_id is distinct from p_buyer_id or saved.product_id is distinct from p_product_id or saved.post_id is distinct from p_post_id or
      saved.context is distinct from p_context or saved.snapshot is distinct from p_snapshot then
      raise exception 'Original full checkout request differs'; end if;
    return to_jsonb(saved);
  end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' or
    p_snapshot-array['product','processingFees','acceptance','termsText']<>'{}'::jsonb or
    jsonb_typeof(p_snapshot->'termsText') is distinct from 'string' or length(p_snapshot->>'termsText')>100000 or
    jsonb_typeof(p_snapshot->'product') is distinct from 'object' or jsonb_typeof(p_snapshot->'processingFees') is distinct from 'object' or
    p_snapshot#>>'{product,id}' is distinct from p_product_id::text or p_snapshot#>>'{product,type}' is distinct from 'mentorship' or
    p_snapshot#>'{product,active}'='false'::jsonb or p_snapshot#>'{product,membership_terms}' is not null and p_snapshot#>'{product,membership_terms}'<>'null'::jsonb or
    p_snapshot#>'{acceptance,accepted}' is distinct from 'true'::jsonb or
    encode(sha256(convert_to(p_snapshot->>'termsText','UTF8')),'hex') is distinct from p_snapshot#>>'{acceptance,fingerprint}' then
    raise exception 'Original full quote snapshot differs'; end if;
  t:=(p_snapshot->>'termsText')::jsonb;
  if t->>'buyerId' is distinct from p_buyer_id::text or t->>'productId' is distinct from p_product_id::text or
    t->>'postId' is distinct from p_post_id::text or t->>'creatorId' is distinct from p_snapshot#>>'{product,creator_id}' or
    t->>'creatorId'=p_buyer_id::text or t->>'kind' is distinct from 'one_time' or
    t->>'version' is distinct from p_snapshot#>>'{acceptance,version}' then raise exception 'Original full quote owner differs'; end if;
  if exists(select 1 from public.product_checkout_attempts where buyer_id=p_buyer_id and product_id=p_product_id) or
    exists(select 1 from public.purchases where buyer_id=p_buyer_id and (product_id=p_product_id or post_id=p_post_id)) or
    exists(select 1 from public.full_manual_checkout_requests_v1 r where r.buyer_id=p_buyer_id and r.product_id=p_product_id and
      not exists(select 1 from public.product_checkout_releases_v1 h where h.attempt_id=r.attempt_id and h.buyer_id=r.buyer_id and
        h.attempt_key=r.attempt_key and h.context=r.context)) then
    raise exception 'Existing full checkout requires original recovery'; end if;
  insert into public.full_manual_checkout_requests_v1(request_id,buyer_id,product_id,post_id,context,snapshot)
    values(p_request_id,p_buyer_id,p_product_id,p_post_id,p_context,p_snapshot) returning * into saved;
  return to_jsonb(saved);
end $$;
revoke all on function public.plan_full_manual_checkout_v1(uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.plan_full_manual_checkout_v1(uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;
commit;
