begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- One transaction for an original capture observed only after its refund.
-- Existing receipt accounting validates ownership/economics and takes the same
-- buyer/product and PaymentIntent locks. No transient gross earnings or access
-- become visible before the existing reversal and financial hold commit.
create function public.record_buyer_mentorship_refunded_capture_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,
  p_proof jsonb,p_event_id text,p_refunded_cents bigint)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare receipt jsonb; refund jsonb;
begin
  if p_refunded_cents is null or p_refunded_cents<1 or p_proof is null or
    p_refunded_cents>(p_proof->>'amountCents')::bigint then raise exception 'Invalid refunded capture'; end if;
  if p_proof->'paymentNumber'='1'::jsonb then
    receipt:=public.record_buyer_mentorship_first_receipt_v1(p_request_id,p_buyer_id,p_context,p_proof);
  else
    receipt:=public.record_buyer_mentorship_later_receipt_v1(p_request_id,p_buyer_id,p_context,p_proof);
  end if;
  refund:=public.apply_buyer_mentorship_refund_v1(p_request_id,p_buyer_id,p_context,p_event_id,
    p_proof->>'paymentIntentId',p_proof->>'chargeId',(p_proof->>'amountCents')::bigint,p_refunded_cents);
  return refund || jsonb_build_object('receiptRecorded',receipt->'recorded','purchaseId',receipt->'purchaseId','ledgerId',receipt->'ledgerId');
end $$;
revoke all on function public.record_buyer_mentorship_refunded_capture_v1(uuid,uuid,jsonb,jsonb,text,bigint) from public,anon,authenticated;
grant execute on function public.record_buyer_mentorship_refunded_capture_v1(uuid,uuid,jsonb,jsonb,text,bigint) to service_role;
commit;
