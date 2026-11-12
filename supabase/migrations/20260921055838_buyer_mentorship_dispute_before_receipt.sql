begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Reuse the original receipt transaction and dispute observer. An existing
-- receipt means the caller must obtain a fresh observation basis before reads;
-- never manufacture a current basis for evidence retrieved before a race.
create function public.record_buyer_mentorship_disputed_capture_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,
  p_proof jsonb,p_event_id text,p_dispute_id text,p_disputed_cents bigint,p_status text,p_event_created bigint)
returns text language plpgsql security invoker set search_path=pg_catalog as $$
declare receipt jsonb; snapshot jsonb;
begin
  if p_proof->'paymentNumber'='1'::jsonb then
    receipt:=public.record_buyer_mentorship_first_receipt_v1(p_request_id,p_buyer_id,p_context,p_proof);
  else
    receipt:=public.record_buyer_mentorship_later_receipt_v1(p_request_id,p_buyer_id,p_context,p_proof);
  end if;
  snapshot:=public.hold_buyer_mentorship_dispute_v1(p_request_id,p_buyer_id,p_context,p_event_id,p_dispute_id,
    p_proof->>'paymentIntentId',p_proof->>'chargeId');
  if receipt->'recorded' is distinct from 'true'::jsonb then return 'reconciliation_required'; end if;
  return public.apply_buyer_mentorship_dispute_v1(p_request_id,p_buyer_id,p_context,p_event_id,p_dispute_id,
    p_proof->>'paymentIntentId',p_proof->>'chargeId',snapshot,p_disputed_cents,p_status,p_event_created);
end $$;
revoke all on function public.record_buyer_mentorship_disputed_capture_v1(uuid,uuid,jsonb,jsonb,text,text,bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.record_buyer_mentorship_disputed_capture_v1(uuid,uuid,jsonb,jsonb,text,text,bigint,text,bigint) to service_role;
commit;
