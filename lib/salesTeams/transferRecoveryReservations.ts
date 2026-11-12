import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {teamId} from "./policy";
import {TEAM_STRIPE_API_VERSION,teamOperationId,type TeamOperationScope,type TeamProviderRequest} from "./providerOperation";
import {validateTeamTransferRequest,type TeamTransferRequest,type TeamTransferJournal} from "./transferReservations";
import {readTeamOriginalTransferForRecovery} from "./transferReversalReadback";
import {readTeamFinancialSnapshot,type TeamEventSource} from "./financialReadback";
import {readTeamCashProof} from "./cashReadback";
import type {TeamReceiptComposition} from "./receipts";

export type TeamTransferRecoveryRequest={id:string;operation_id:string;transfer_request_id:string;original_worker_run_id:string;amount_cents:number;receipt_revision:number;cost_reserve_cents:number;
 context:TeamReceiptComposition["context"];request:TeamProviderRequest;scope:TeamOperationScope;transfer:TeamTransferRequest;operation:TeamTransferJournal|null;canceled:boolean;completed:boolean};
export function validateTeamTransferRecoveryRequest(c:Pick<TeamReceiptComposition,"context">,p:TeamTransferRecoveryRequest){
 const check=(value:unknown)=>{if(!value)throw Error("Original transfer recovery requires reconciliation");};
 for(const v of [p.id,p.operation_id,p.transfer_request_id,p.original_worker_run_id])teamId(v);
 const q=p.transfer;validateTeamTransferRequest(c,q);
 check(q.completed&&!q.canceled&&q.operation?.status==="bound"&&/^tr_[A-Za-z0-9]+$/.test(q.operation.provider_id??"")&&p.transfer_request_id===q.id&&isDeepStrictEqual(p.context,c.context)&&
  Number.isSafeInteger(Number(p.amount_cents))&&Number(p.amount_cents)>0&&Number(p.amount_cents)<=Number(q.amount_cents)&&Number.isSafeInteger(Number(p.cost_reserve_cents))&&Number(p.cost_reserve_cents)>=0&&Number(p.cost_reserve_cents)<=99999999&&
  isDeepStrictEqual(p.scope,{scopeId:p.id,scopeKey:"recovery:v1",kind:"reversal",saleId:q.sale_id,creatorId:q.creator_id,actorId:null,workerRunId:p.original_worker_run_id})&&teamOperationId(p.scope)===p.operation_id);
 const expected:TeamProviderRequest={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST",path:`/v1/transfers/${q.operation!.provider_id}/reversals`,params:{amount:Number(p.amount_cents),
  metadata:{team_protocol:"creatornet-team-recovery-v1",team_sale_id:q.sale_id,team_receipt_id:q.receipt_id,team_transfer_request_id:q.id,team_recovery_request_id:p.id,team_provider_operation_id:p.operation_id,team_beneficiary:q.beneficiary}}};
 check(isDeepStrictEqual(p.request,expected));
}

/** Supplied actual worker, bounded task and completed transfer. The database
 * derives the amount and freezes the original; only independent GETs occur. */
export async function reserveTeamTransferRecovery(c:TeamReceiptComposition,args:{runId:string;leaseToken:string;taskId:string;transferRequestId:string}){
 for(const v of [args.runId,args.leaseToken,args.taskId,args.transferRequestId])teamId(v);
 const context=snapshotProviderJson(c.context),scope={p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:context,p_task_id:args.taskId};
 const rpc=async<T>(name:string,extra:Record<string,unknown>):Promise<T>=>{
  if(!isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context))throw Error("Transfer recovery context changed");
  const request=c.admin.rpc(name,{...scope,...extra}),result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;
 };
 const task=await rpc<{id:string;request_id:string;financial_check_id:string;root_read_id:string;transfer:TeamTransferRequest;source_ready:boolean;reserved:TeamTransferRecoveryRequest|null}>("begin_sales_team_transfer_recovery_v1",{p_transfer_id:args.transferRequestId});
 if(task.id!==args.taskId||task.transfer.id!==args.transferRequestId)throw Error("Original transfer recovery task changed");
 if(task.reserved){validateTeamTransferRecoveryRequest({context},task.reserved);if(task.reserved.operation||task.reserved.canceled||task.reserved.completed)throw Error("Original transfer recovery requires reconciliation");}
 const phase=<T>(p_phase:string,p_payload:Record<string,unknown>={})=>rpc<T>("run_sales_team_transfer_recovery_v1",{p_phase,p_payload});
 if(!task.source_ready){
  const begun=await phase<{checkId:string;completed:boolean;held:boolean;source:TeamEventSource}>("begin_financial");
  if(begun.checkId!==task.financial_check_id)throw Error("Original recovery financial check changed");
  const checked=begun.completed?begun:await(async()=>{const fresh=await readTeamFinancialSnapshot({...c,context},begun.source,{eventId:null,balances:true});return phase<{held:boolean}>("complete_financial",{revision:fresh.revision,snapshot:fresh.snapshot});})();
  if(checked.held)throw Error("Current recovery financial evidence remains held");
 }
 const source=await phase<{readId:string;transfer:TeamTransferRequest;completed:boolean;ready:boolean}>("begin_root");
 if(source.readId!==task.root_read_id||source.transfer.id!==args.transferRequestId)throw Error("Original recovery transfer changed");
 const root=source.completed?source:await phase<{ready:boolean}>("complete_root",await readTeamOriginalTransferForRecovery({...c,context},source.transfer));
 if(!root.ready)throw Error("Unaccounted original transfer return requires reconciliation");
 const readId=randomUUID(),cashScope={p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:context,p_read_id:readId};
 // Cash RPCs deliberately have no task argument: they use the existing F23 proof.
 const cashRpc=async(name:string,extra:Record<string,unknown>={})=>{
  if(!isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context))throw Error("Transfer recovery context changed");
  const request=c.admin.rpc(name,{...cashScope,...extra}),result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;
 };
 await cashRpc("begin_sales_team_settlement_cash_v1");
 const cash=await readTeamCashProof(context,c.observeContext,async timeout=>await c.stripe.rawRequest("GET","/v1/balance",{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout}) as unknown as Stripe.Response<Stripe.Balance>);
 await cashRpc("complete_sales_team_settlement_cash_v1",{p_proof:cash});
 const saved=await rpc<TeamTransferRecoveryRequest>("reserve_sales_team_transfer_recovery_v1",{p_read_id:readId});validateTeamTransferRecoveryRequest({context},saved);
 if(saved.id!==task.request_id||saved.transfer_request_id!==args.transferRequestId)throw Error("Original transfer recovery reservation changed");return saved;
}
