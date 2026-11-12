import "server-only";
import {isDeepStrictEqual} from "node:util";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {teamId} from "./policy";
import {readTeamBoundTransferReversal,recoverTeamUnknownTransferReversal,type TeamTransferReversalOriginal} from "./transferReversalReadback";
import type {TeamReceiptComposition} from "./receipts";

/** Original-only observation under an actual current worker. The checked SQL
 * consumer binds event/key proof and F29 accounting in one transaction. This
 * composition cannot claim a new operation or issue a financial POST. */
export async function recoverTeamOriginalTransferReversal(c:TeamReceiptComposition,args:{runId:string;leaseToken:string;taskId:string;operationId:string;checkId:string}){
 for(const value of [args.runId,args.leaseToken,args.taskId,args.operationId,args.checkId])teamId(value);
 const context=snapshotProviderJson(c.context);
 const rpc=async<T>(name:string,extra:Record<string,unknown>):Promise<T>=>{
  if(!isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context))throw Error("Original reversal recovery context changed");
  const request=c.admin.rpc(name,{p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:context,p_task_id:args.taskId,...extra});
  const result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;
 };
 const begun=await rpc<{checkId:string;completed:boolean;held:boolean;original:TeamTransferReversalOriginal}>("begin_sales_team_reversal_recovery_v1",{p_operation_id:args.operationId,p_check_id:args.checkId});
 if(begun.checkId!==args.checkId||begun.original.operation.id!==args.operationId)throw Error("Original reversal recovery check changed");
 if(begun.completed)return {completed:true,recorded:false,held:begun.held};
 const proof=begun.original.operation.provider_id?await readTeamBoundTransferReversal({...c,context},begun.original):await recoverTeamUnknownTransferReversal({...c,context},begun.original);
 if(!proof)return {completed:false,recorded:false,held:true};
 return rpc<{completed:boolean;recorded:boolean;held:boolean;recovered?:boolean;eventId?:string;returnedPrincipalCents:number;actualTransferReversalCostCents:number}>("complete_sales_team_reversal_recovery_v1",{p_check_id:args.checkId,p_proof:proof});
}
