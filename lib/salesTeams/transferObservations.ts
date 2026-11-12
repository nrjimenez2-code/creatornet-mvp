import "server-only";
import {isDeepStrictEqual} from "node:util";
import {teamId} from "./policy";
import {readTeamBoundTransfer,recoverTeamUnknownTransfer} from "./transferReadback";
import {validateTeamTransferRequest,type TeamTransferRequest} from "./transferReservations";
import type {TeamReceiptComposition} from "./receipts";

/** Observe one already admitted original. No provider POST, accounting caller
 * identity substitution or new-money authority is available in this bridge. */
export async function observeTeamAdmittedTransfer(c:TeamReceiptComposition,args:{runId:string;leaseToken:string;taskId:string;requestId:string;checkId:string}){
 for(const value of [args.runId,args.leaseToken,args.taskId,args.requestId,args.checkId])teamId(value);
 const rpc=async<T>(name:string,extra:Record<string,unknown>):Promise<T>=>{
  if(!isDeepStrictEqual(await c.observeContext(),c.context))throw Error("Transfer observation context changed");
  const request=c.admin.rpc(name,{p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:c.context,p_task_id:args.taskId,...extra});
  const result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;
 };
 const begun=await rpc<{checkId:string;completed:boolean;request:TeamTransferRequest}>("begin_sales_team_transfer_check_v1",{p_request_id:args.requestId,p_check_id:args.checkId});
 validateTeamTransferRequest(c,begun.request);if(begun.checkId!==args.checkId||begun.request.id!==args.requestId)throw Error("Original transfer check changed");
 if(begun.completed)return {requestId:args.requestId,completed:true,recorded:false,held:begun.request.held??true};
 const proof=begun.request.operation?.provider_id?await readTeamBoundTransfer(c,begun.request):await recoverTeamUnknownTransfer(c,begun.request);
 if(!proof)return {requestId:args.requestId,completed:false,recorded:false,held:true};
 return rpc<{requestId:string;completed:boolean;recorded:boolean;held:boolean;actualTransferCostCents:number}>("complete_sales_team_transfer_check_v1",{p_check_id:args.checkId,p_proof:proof});
}
