import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {teamId} from "./policy";
import {TEAM_STRIPE_API_VERSION,teamOperationId,type TeamOperationScope,type TeamProviderRequest} from "./providerOperation";
import {readTeamCashProof} from "./cashReadback";
import type {TeamReceiptComposition} from "./receipts";

export type TeamTransferRequest={id:string;operation_id:string;receipt_id:string;sale_id:string;creator_id:string;beneficiary:"creator"|"closer";
 beneficiary_user_id:string;destination_id:string;amount_cents:number;receipt_revision:number;original_worker_run_id:string;
 chargeId:string;approvedRecipientId:string;context:TeamReceiptComposition["context"];request:TeamProviderRequest;scope:TeamOperationScope;canceled:boolean;completed:boolean};
export function validateTeamTransferRequest(c:TeamReceiptComposition,q:TeamTransferRequest){
 const check=(v:unknown)=>{if(!v)throw Error("Original earned transfer requires reconciliation");};
 for(const value of [q.id,q.operation_id,q.receipt_id,q.sale_id,q.creator_id,q.beneficiary_user_id,q.original_worker_run_id])teamId(value);
 check(isDeepStrictEqual(q.context,c.context)&&['creator','closer'].includes(q.beneficiary)&&Number.isSafeInteger(Number(q.amount_cents))&&Number(q.amount_cents)>0&&Number(q.amount_cents)<=99999999&&
  /^acct_[A-Za-z0-9]+$/.test(q.destination_id)&&q.destination_id===q.approvedRecipientId&&/^ch_[A-Za-z0-9]+$/.test(q.chargeId)&&
  isDeepStrictEqual(q.scope,{scopeId:q.id,scopeKey:"settlement:v1",kind:"transfer",saleId:q.sale_id,creatorId:q.creator_id,actorId:null,workerRunId:q.original_worker_run_id})&&teamOperationId(q.scope)===q.operation_id);
 const expected:TeamProviderRequest={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST",path:"/v1/transfers",params:{amount:Number(q.amount_cents),currency:"usd",destination:q.destination_id,
  source_transaction:q.chargeId,source_type:"card",transfer_group:`cn_team_${q.sale_id}`,metadata:{team_protocol:"creatornet-team-distribution-v1",team_sale_id:q.sale_id,team_receipt_id:q.receipt_id,team_transfer_request_id:q.id,team_provider_operation_id:q.operation_id,team_beneficiary:q.beneficiary}}};
 check(isDeepStrictEqual(q.request,expected));
}
/** Reserve an exact existing earned share. This performs only independent GETs
 * and database admission; it neither dispatches nor credits a bank payout. */
export async function reserveTeamEarnedTransfer(c:TeamReceiptComposition,args:{runId:string;leaseToken:string;taskId:string;requestId:string;receiptId:string;beneficiary:"creator"|"closer"}){
 for(const value of [args.runId,args.leaseToken,args.taskId,args.requestId,args.receiptId])teamId(value);
 if(!['creator','closer'].includes(args.beneficiary))throw Error("An earned transfer beneficiary is required");
 const scope={p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:c.context};
 const rpc=async<T>(name:string,extra:Record<string,unknown>):Promise<T>=>{
  if(!isDeepStrictEqual(await c.observeContext(),c.context))throw Error("Settlement context changed");
  const request=c.admin.rpc(name,{...scope,...extra}),result=await (typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);
  if(result.error)throw result.error;return result.data as T;
 };
 const readId=randomUUID();await rpc("begin_sales_team_settlement_cash_v1",{p_read_id:readId});
 const proof=await readTeamCashProof(c.context,c.observeContext,async timeout=>await c.stripe.rawRequest("GET","/v1/balance",{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout}) as unknown as Stripe.Response<Stripe.Balance>);
 await rpc("complete_sales_team_settlement_cash_v1",{p_read_id:readId,p_proof:proof});
 const q=await rpc<TeamTransferRequest>("reserve_sales_team_transfer_v1",{p_task_id:args.taskId,p_request_id:args.requestId,p_receipt_id:args.receiptId,p_beneficiary:args.beneficiary,p_read_id:readId});
 validateTeamTransferRequest(c,q);if(q.id!==args.requestId||q.receipt_id!==args.receiptId||q.beneficiary!==args.beneficiary)throw Error("Original settlement task changed");return q;
}
