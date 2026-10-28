import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {teamId} from "./policy";
import {validateTeamSurplusRequest} from "./surplusReservations";
import type {TeamSurplusMoneySource} from "./surplusPayoutPolicy";
import {readTeamSurplusPayout} from "./surplusPayoutReadback";
import type {TeamReceiptComposition} from "./receipts";

/** Bound-original money truth. This has no new-money switch, bank eligibility
 * check, lease extension or POST capability; signed ingress remains separate. */
export async function observeTeamDailySurplus(c:TeamReceiptComposition,requestId:string,checkId=randomUUID()){
 teamId(requestId);teamId(checkId);const context=snapshotProviderJson(c.context);
 const current=async()=>{if(!isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context))throw Error("Surplus observation context changed");};
 const rpc=async<T>(name:string,payload:Record<string,unknown>):Promise<T>=>{
  await current();const request=c.admin.rpc(name,payload),result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);
  if(result.error)throw result.error;return result.data as T;
 };
 const scope={p_check_id:checkId,p_request_id:requestId,p_context:context};
 const q=await rpc<TeamSurplusMoneySource>("begin_sales_team_surplus_check_v1",scope);validateTeamSurplusRequest({context},q);
 if(q.id!==requestId)throw Error("Original surplus observation changed");
 const proof=await readTeamSurplusPayout(c,q,q.operation.provider_id!);
 const recorded=await rpc<{requestId:string;recorded:boolean;bankConfirmed:false;held:boolean}>("complete_sales_team_surplus_check_v1",{...scope,p_proof:proof});
 if(recorded.requestId!==requestId||recorded.bankConfirmed!==false)throw Error("Original surplus disposition changed");
 return {requestId,operationId:q.operation_id,status:proof.complete?"observed":"reconciliation_required",complete:proof.complete,disposition:proof.disposition,
  recorded:recorded.recorded,held:recorded.held,bankConfirmed:false as const};
}
