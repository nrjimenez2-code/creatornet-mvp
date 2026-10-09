begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $patch$
declare source text; needle text;
begin
  source:=pg_get_functiondef('public.validate_server_payment_contract_v1(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  needle:=$old$'automatic_payment_methods',jsonb_build_object('enabled',false),'application_fee_amount',fee$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Manual intent validator differs'; end if;
  source:=replace(source,needle,$new$'payment_method_types',jsonb_build_array('card'),'application_fee_amount',fee$new$);
  needle:=$old$  if p_request is distinct from jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/payment_intents','params',params) then$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Manual intent request comparison differs'; end if;
  source:=replace(source,needle,$new$  -- Only an already persisted legacy operation may retain the rejected shape.
  -- This does not release it, alter it, or authorize a replacement operation.
  if exists(select 1 from public.server_payment_intent_operations_v1 op where op.attempt_id=s.attempt_id
      and op.contract=p_contract and op.request=p_request
      and op.request#>'{params,automatic_payment_methods}'='{"enabled":false}'::jsonb) then
    params:=(params-'payment_method_types')||jsonb_build_object('automatic_payment_methods',jsonb_build_object('enabled',false));
  end if;
  if p_request is distinct from jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/payment_intents','params',params) then$new$);
  execute source;
end $patch$;
commit;
