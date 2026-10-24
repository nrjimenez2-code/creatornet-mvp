import "server-only";
import {isDeepStrictEqual} from "node:util";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {teamId} from "./policy";
import {readTeamBoundTransferReversal,type TeamTransferReversalOriginal} from "./transferReversalReadback";
import type {TeamReceiptComposition} from "./receipts";

/** Consume one existing bound original using the actual observation worker.
 * No new operation, provider POST, original adoption or bank assertion exists. */
export async function observeTeamBoundTransferReversal(c:TeamReceiptComposition,args:{runId:string;leaseToken:string;taskId:string;operationId:string;checkId:string}){
 for(const value of [args.runId,args.leaseToken,args.taskId,args.operationId,args.checkId])teamId(value);
 const context=snapshotProviderJson(c.context);
 const rpc=async<T>(name:string,extra:Record<string,unknown>):Promise<T>=>{
  if(!isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context))throw Error("Reversal observation context changed");
  const request=c.admin.rpc(name,{p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:context,p_task_id:args.taskId,...extra});
  const result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;
 };
 const begun=await rpc<{checkId:string;completed:boolean;held:boolean;original:TeamTransferReversalOriginal}>("begin_sales_team_reversal_check_v1",{p_operation_id:args.operationId,p_check_id:args.checkId});
 if(begun.checkId!==args.checkId||begun.original.operation.id!==args.operationId)throw Error("Original reversal observation check changed");
 if(begun.completed)return {completed:true,recorded:false,held:begun.held};
 const proof=await readTeamBoundTransferReversal({...c,context},begun.original);
 return rpc<{completed:boolean;recorded:boolean;held:boolean;returnedPrincipalCents:number;actualTransferReversalCostCents:number}>("complete_sales_team_reversal_check_v1",{p_check_id:args.checkId,p_proof:proof});
}
