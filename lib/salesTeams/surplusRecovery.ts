import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {teamId} from "./policy";
import type {TeamReceiptComposition} from "./receipts";
import type {TeamSurplusMoneySource} from "./surplusPayoutPolicy";
import {readTeamUnknownSurplus} from "./surplusRecoveryReadback";

/** Original-only recovery works after new money is disabled. The database binds
 * exact event identity and consumes independent money atomically, or keeps hold. */
export async function recoverTeamDailySurplus(c:TeamReceiptComposition,requestId:string,checkId=randomUUID()){
 teamId(requestId);teamId(checkId);const context=snapshotProviderJson(c.context);
 const rpc=async<T>(name:string,extra:Record<string,unknown>={}):Promise<T>=>{
  if(!isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context))throw Error("Surplus recovery context changed");
  const request=c.admin.rpc(name,{p_check_id:checkId,p_request_id:requestId,p_context:context,...extra});
  const result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;
 };
 const q=await rpc<TeamSurplusMoneySource>("begin_sales_team_surplus_recovery_v1");if(q.id!==requestId)throw Error("Original surplus recovery changed");
 const proof=await readTeamUnknownSurplus(c,q);if(!proof)return {requestId,operationId:q.operation_id,status:"reconciliation_required",bankConfirmed:false as const};
 const result=await rpc<{requestId:string;recorded:boolean;complete:boolean;bankConfirmed:false}>("complete_sales_team_surplus_recovery_v1",{p_proof:proof});
 if(result.requestId!==requestId||result.bankConfirmed!==false)throw Error("Original surplus recovery disposition changed");
 return {...result,operationId:q.operation_id,status:result.complete?"observed":"reconciliation_required"};
}
