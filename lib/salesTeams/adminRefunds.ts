import "server-only";
import type Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {randomUUID} from "node:crypto";
import {calculateRefundAllocation,reasonMatchesResponsibility,type RefundReasonCode,type RefundResponsibility} from "@/lib/refundAllocation";
import {teamId} from "./policy";
import {fundTeamAdminRefund} from "./cashFunding";
import {teamRpc} from "./server";
import {TEAM_STRIPE_API_VERSION,teamOperationId,runTeamProviderOperation,type TeamOperationScope,type TeamProviderRequest} from "./providerOperation";
import {inspectTeamReceiptFinancials} from "./financialChecks";
import type {TeamEventSource} from "./financialReadback";
import type {TeamReceiptComposition} from "./receipts";

export type TeamAdminRefundRequest={id:string;receipt_id:string;sale_id:string;creator_id:string;requested_by:string;amount_cents:number;responsibility:RefundResponsibility;reason_code:RefundReasonCode;cashReserved?:boolean;
 context:TeamReceiptComposition["context"];expected_revision:number;refunded_before_cents:number;operation_id:string;created_at:string;request:TeamProviderRequest;scope:TeamOperationScope;source:TeamEventSource;
 receipt:{id:string;revision:number;subtotalCents:number;refundedCents:number;lossCents:number;chargeId:string;paymentIntentId:string;held:boolean};
 operation:null|{id:string;status:string;provider_id:string|null;first_dispatch_at:string;idempotency_key:string};observedStatus:string|null;result:null|{status:string;refundId:string|null}};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original team refund requires reconciliation");};
const objectId=(v:unknown)=>typeof v==="string"?v:(v as {id?:string}|null)?.id??"";
const requestId=(v:unknown)=>(v as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
const options={apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000};
function validateRequest(c:TeamReceiptComposition,q:TeamAdminRefundRequest){
 for(const value of [q.id,q.receipt_id,q.sale_id,q.creator_id,q.requested_by,q.operation_id])teamId(value);
 check(isDeepStrictEqual(c.context,q.context)&&q.receipt.id===q.receipt_id&&q.source.saleId===q.sale_id&&q.source.paymentIntentId===q.receipt.paymentIntentId&&isDeepStrictEqual(q.source.context,q.context)&&
  /^ch_[A-Za-z0-9]+$/.test(q.receipt.chargeId)&&/^pi_[A-Za-z0-9]+$/.test(q.receipt.paymentIntentId)&&Number.isSafeInteger(Number(q.amount_cents))&&Number(q.amount_cents)>0&&Number(q.amount_cents)<=q.receipt.subtotalCents&&
  reasonMatchesResponsibility(q.reason_code,q.responsibility)&&q.scope.scopeId===q.id&&q.scope.scopeKey==="refund:v1"&&q.scope.kind==="refund"&&q.scope.saleId===q.sale_id&&q.scope.creatorId===q.creator_id&&q.scope.actorId===q.requested_by&&q.scope.workerRunId===null&&teamOperationId(q.scope)===q.operation_id);
 const expected:TeamProviderRequest={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST",path:"/v1/refunds",params:{charge:q.receipt.chargeId,amount:Number(q.amount_cents),metadata:{team_protocol:"creatornet-team-distribution-v1",team_sale_id:q.sale_id,team_obligation_id:q.source.obligationId,team_refund_request_id:q.id,team_provider_operation_id:q.operation_id}}};
 check(isDeepStrictEqual(q.request,expected));
 if(q.operation)check(q.operation.id===q.operation_id&&q.operation.idempotency_key===`cn-team-v1:${q.operation_id}`&&Number.isFinite(Date.parse(q.operation.first_dispatch_at))&&["dispatching","unknown","bound"].includes(q.operation.status)&&(!q.operation.provider_id||/^re_[A-Za-z0-9]+$/.test(q.operation.provider_id)));
}
export async function readTeamAdminRefund(c:TeamReceiptComposition,actorId:string,request:string){
 teamId(actorId);teamId(request);check(isDeepStrictEqual(await c.observeContext(),c.context));
 const q=await teamRpc<TeamAdminRefundRequest|null>(c.admin,"read_sales_team_refund_request_v1",{p_actor_id:actorId,p_request_id:request,p_context:c.context});
 if(q)validateRequest(c,q);return q;
}
export async function reserveTeamAdminRefund(c:TeamReceiptComposition,args:{actorId:string;requestId:string;receiptId:string;expectedRevision:number;amountCents:number;responsibility:RefundResponsibility;reasonCode:RefundReasonCode}){
 for(const value of [args.actorId,args.requestId,args.receiptId])teamId(value);
 check(Number.isSafeInteger(args.amountCents)&&args.amountCents>0&&Number.isSafeInteger(args.expectedRevision)&&args.expectedRevision>=0&&reasonMatchesResponsibility(args.reasonCode,args.responsibility)&&isDeepStrictEqual(await c.observeContext(),c.context));
 const q=await teamRpc<TeamAdminRefundRequest>(c.admin,"reserve_sales_team_refund_v1",{p_actor_id:args.actorId,p_request_id:args.requestId,p_receipt_id:args.receiptId,p_expected_revision:args.expectedRevision,
  p_amount_cents:args.amountCents,p_responsibility:args.responsibility,p_reason_code:args.reasonCode,p_context:c.context});validateRequest(c,q);return q;
}
export async function previewTeamAdminRefund(c:TeamReceiptComposition,actorId:string,receiptId:string,amountCents:number,responsibility:RefundResponsibility,reasonCode:RefundReasonCode){
 teamId(actorId);teamId(receiptId);check(Number.isSafeInteger(amountCents)&&amountCents>0&&reasonMatchesResponsibility(reasonCode,responsibility));
 const inspected=await inspectTeamReceiptFinancials(c,receiptId,actorId);check(inspected.held===false);
 const p=await teamRpc<{receiptId:string;revision:number;subtotalCents:number;refundedCents:number;remainingCents:number;originalProcessingCostCents:number;platformFeeReturnedCents:number;originalProcessingCreditCents:number;auxiliaryCostCents:number;chargeId:string;paymentIntentId:string;eligible:boolean}>(c.admin,"read_sales_team_admin_refund_preview_v1",{p_actor_id:actorId,p_receipt_id:receiptId,p_context:c.context});
 check(p.eligible&&amountCents<=p.remainingCents&&Number.isSafeInteger(p.originalProcessingCostCents));
 const platformFee=Math.round(p.subtotalCents*1200/10000),allocation=calculateRefundAllocation({grossAmountCents:p.subtotalCents,platformFeeCents:platformFee,processingFeeCents:p.originalProcessingCostCents,
  creatorNetCents:p.subtotalCents-platformFee-p.originalProcessingCostCents,refundedBeforeCents:p.refundedCents,applicationFeeRefundedBeforeCents:p.platformFeeReturnedCents+p.originalProcessingCreditCents,requestedRefundAmountCents:amountCents,responsibility});
 return {receiptId:p.receiptId,revision:p.revision,amountCents,remainingCents:p.remainingCents,refundedBeforeCents:p.refundedCents,responsibility,reasonCode,originalProcessingShareCents:allocation.processingFeeAllocationCents,
  chargeId:p.chargeId,paymentIntentId:p.paymentIntentId};
}
function inspectRefund(q:TeamAdminRefundRequest,r:Stripe.Refund,now:number){
 check(r.object==="refund"&&/^re_[A-Za-z0-9]+$/.test(r.id)&&objectId(r.charge)===q.receipt.chargeId&&objectId(r.payment_intent)===q.receipt.paymentIntentId&&r.amount===Number(q.amount_cents)&&r.currency==="usd"&&
  r.transfer_reversal===null&&r.source_transfer_reversal===null&&isDeepStrictEqual(r.metadata,q.request.params.metadata)&&Number.isSafeInteger(r.created)&&r.created>=Math.floor(Date.parse(q.operation?.first_dispatch_at??q.created_at)/1000)-5&&r.created<=now+5&&
  ["succeeded","pending","requires_action","failed","canceled"].includes(r.status??"")&&/^req_[A-Za-z0-9]+$/.test(requestId(r)));
 return {id:r.id,chargeId:objectId(r.charge),paymentIntentId:objectId(r.payment_intent),amountCents:r.amount,currency:r.currency,status:r.status!,created:r.created,context:q.context,metadata:r.metadata,providerRequestId:requestId(r)};
}
export function teamAdminRefundView(q:TeamAdminRefundRequest,disposition:string){
 return {requestId:q.id,receiptId:q.receipt_id,amountCents:Number(q.amount_cents),responsibility:q.responsibility,reasonCode:q.reason_code,disposition,
  refundId:q.result?.refundId??q.operation?.provider_id??null,providerStatus:q.observedStatus??q.result?.status??null,held:q.receipt.held};
}
/** Only explicit fresh dispatch reaches the existing journal's create callback.
 * Recovery reconciles a real provider event's original idempotency key, never
 * metadata alone, and can only retrieve the original refund thereafter. */
export async function processTeamAdminRefund(c:TeamReceiptComposition,actorId:string,request:string,admitNew=false){
 let q=await readTeamAdminRefund(c,actorId,request);check(q);
 if(q.result?.status==="canceled_before_dispatch"){
  if(q.receipt.held){await inspectTeamReceiptFinancials(c,q.receipt_id,actorId);q=await readTeamAdminRefund(c,actorId,request);check(q);}
  if(q.cashReserved)await teamRpc(c.admin,"resolve_sales_team_refund_cash_v1",{p_actor_id:actorId,p_request_id:q.id,p_context:c.context});
  return teamAdminRefundView(q,"canceled_before_dispatch");
 }
 let recoveryCheckId:string|undefined;
 if(q.operation&&!q.receipt.held){
  const begun=await teamRpc<{checkId:string}>(c.admin,"begin_sales_team_financial_check_v1",{p_check_id:randomUUID(),p_receipt_id:q.receipt_id,p_actor_id:actorId,p_event_id:null,p_worker_run_id:null,p_context:c.context});recoveryCheckId=begun.checkId;
 }
 if(!q.operation){
  if(!admitNew||q.requested_by!==actorId)return teamAdminRefundView(q,"not_dispatched");
  const inspection=await inspectTeamReceiptFinancials(c,q.receipt_id,actorId);
  q=await teamRpc<TeamAdminRefundRequest>(c.admin,"attach_sales_team_refund_check_v1",{p_actor_id:actorId,p_request_id:q.id,p_check_id:inspection.checkId});validateRequest(c,q);
  await fundTeamAdminRefund(c,actorId,q.id);
 }
 const original=q;
 const get=async<T>(path:string,params:Record<string,unknown>={})=>{const value=await c.stripe.rawRequest("GET",path,params,options) as T;check(/^req_[A-Za-z0-9]+$/.test(requestId(value)));return value;};
 const retrieve=async(id:string)=>{check(/^re_[A-Za-z0-9]+$/.test(id));const refund=await get<Stripe.Refund>(`/v1/refunds/${id}`);inspectRefund(original,refund,Math.floor(Date.now()/1000));return {id:refund.id,requestId:requestId(refund),refund};};
 const result=await runTeamProviderOperation<{id:string;requestId:string;refund:Stripe.Refund}>({admin:c.admin,scope:original.scope,context:c.context,request:original.request,observeContext:c.observeContext,
  assertSource:async()=>{check(admitNew&&actorId===original.requested_by&&await teamRpc<boolean>(c.admin,"sales_team_refund_operation_admitted_v1",{p_scope:original.scope,p_context:c.context}));},
  create:async(frozen,opts)=>{check(admitNew&&actorId===original.requested_by);const refund=await c.stripe.rawRequest(frozen.method,frozen.path,frozen.params,opts) as unknown as Stripe.Refund;inspectRefund(original,refund,Math.floor(Date.now()/1000));return {id:refund.id,requestId:requestId(refund),refund};},retrieve,
  reconcileUnknown:async()=>{
   check(original.operation?.first_dispatch_at);const started=Date.now(),events:Stripe.Event[]=[],seen=new Set<string>(),eventReads=new Map<string,string>();let after:string|undefined,complete=false;
   for(let page=0;page<3;page++){
    check(Date.now()>=started&&Date.now()-started<30000);
    const list=await get<Stripe.ApiList<Stripe.Event>>("/v1/events",{type:"refund.created",created:{gte:Math.floor(Date.parse(original.operation.first_dispatch_at)/1000)-5},limit:100,...(after?{starting_after:after}:{})});
    check(list.object==="list"&&Array.isArray(list.data)&&list.data.length<=100&&typeof list.has_more==="boolean");
    for(const e of list.data){check(e.object==="event"&&/^evt_[A-Za-z0-9_]+$/.test(e.id)&&!seen.has(e.id));seen.add(e.id);events.push(e);eventReads.set(e.id,requestId(list));}
    if(!list.has_more){complete=true;break;}check(list.data.length>0);after=list.data.at(-1)!.id;
   }
   if(!complete)return null;
   const matches=events.filter(e=>e.type==="refund.created"&&e.request?.idempotency_key===original.operation!.idempotency_key);
   if(matches.length!==1)return null;const event=matches[0];
   const originalRequestId=event.request?.id??"",idempotencyKey=event.request?.idempotency_key??"";
   check(event.account==null&&event.livemode===(c.context.mode==="live")&&Number.isSafeInteger(event.created)&&event.created>=Math.floor(Date.parse(original.operation.first_dispatch_at)/1000)-5&&/^req_[A-Za-z0-9]+$/.test(originalRequestId));
   const snapshot=event.data.object as Stripe.Refund,found=await retrieve(snapshot.id);
   const immutable=(r:Stripe.Refund)=>({id:r.id,object:r.object,charge:objectId(r.charge),pi:objectId(r.payment_intent),amount:r.amount,currency:r.currency,created:r.created,metadata:r.metadata});
   check(isDeepStrictEqual(immutable(snapshot),immutable(found.refund))&&Date.now()>=started&&Date.now()-started<25000);
   await teamRpc(c.admin,"record_sales_team_refund_recovery_v1",{p_actor_id:actorId,p_request_id:original.id,p_proof:{eventId:event.id,eventType:event.type,eventCreated:event.created,livemode:event.livemode,account:null,
    idempotencyKey,originalRequestId,refundId:found.id,chargeId:original.receipt.chargeId,paymentIntentId:original.receipt.paymentIntentId,amountCents:Number(original.amount_cents),currency:"usd",refundCreated:found.refund.created,
    metadata:found.refund.metadata,context:c.context,eventReadRequestId:eventReads.get(event.id),refundReadRequestId:requestId(found.refund),readStartedAt:started}});
   return {...found,requestId:originalRequestId};
  },validate:object=>{check(object.id===object.refund.id);inspectRefund(original,object.refund,Math.floor(Date.now()/1000));}});
 q=await readTeamAdminRefund(c,actorId,request);check(q);
 if(result.status!=="bound")return teamAdminRefundView(q,result.status);
 const bound=q,started=Date.now(),first=await retrieve(result.object.id),second=await retrieve(result.object.id);
 const proof=inspectRefund(bound,second.refund,Math.floor(Date.now()/1000)),stable=(r:Stripe.Refund)=>{const p=inspectRefund(bound,r,Math.floor(Date.now()/1000));const {providerRequestId,...fields}=p;void providerRequestId;return fields;};
 check(isDeepStrictEqual(stable(first.refund),stable(second.refund))&&Date.now()>=started&&Date.now()-started<25000&&isDeepStrictEqual(await c.observeContext(),c.context));
 q=await teamRpc<TeamAdminRefundRequest>(c.admin,"record_sales_team_refund_result_v1",{p_actor_id:actorId,p_request_id:q.id,p_proof:{...proof,readStartedAt:started}});
 if(["succeeded","failed","canceled"].includes(proof.status))await teamRpc(c.admin,"record_sales_team_refund_responsibility_v1",{p_actor_id:actorId,p_request_id:q.id});
 await inspectTeamReceiptFinancials(c,q.receipt_id,actorId,recoveryCheckId);
 if(q.cashReserved)await teamRpc(c.admin,"resolve_sales_team_refund_cash_v1",{p_actor_id:actorId,p_request_id:q.id,p_context:c.context});
 q=await readTeamAdminRefund(c,actorId,request);check(q);const status=q.observedStatus??proof.status;return teamAdminRefundView(q,status==="succeeded"?"refund_observed":status==="failed"||status==="canceled"?"refund_not_completed":"refund_pending");
}
export async function cancelUnsentTeamRefund(c:TeamReceiptComposition,actorId:string,requestId:string){
 const q=await readTeamAdminRefund(c,actorId,requestId);check(q);
 await teamRpc(c.admin,"cancel_unsent_sales_team_refund_v1",{p_actor_id:actorId,p_request_id:requestId,p_context:c.context});
 await inspectTeamReceiptFinancials(c,q.receipt_id,actorId);
 if(q.cashReserved)await teamRpc(c.admin,"resolve_sales_team_refund_cash_v1",{p_actor_id:actorId,p_request_id:q.id,p_context:c.context});
 const saved=await readTeamAdminRefund(c,actorId,requestId);check(saved);return teamAdminRefundView(saved,"canceled_before_dispatch");
}
