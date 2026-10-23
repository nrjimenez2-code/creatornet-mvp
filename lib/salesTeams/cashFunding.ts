import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {teamRpc} from "./server";
import {teamId} from "./policy";
import type {TeamReceiptComposition} from "./receipts";
import {readTeamCashProof} from "./cashReadback";
export {inspectTeamCashBalance,readTeamCashProof} from "./cashReadback";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Protected platform funds require review");};
export type SharedCashSource={kind:"legacy_refund"|"tip_restoration";id:string};
export async function observeTeamCash(c:TeamReceiptComposition,actorId:string|null,source?:SharedCashSource){
 if(actorId!==null)teamId(actorId);
 check(isDeepStrictEqual(await c.observeContext(),c.context));
 const readId=randomUUID();
 await teamRpc(c.admin,source?"begin_sales_team_shared_cash_read_v1":"begin_sales_team_cash_read_v1",{p_read_id:readId,p_actor_id:actorId,p_context:c.context,...(source?{p_source_kind:source.kind,p_source_id:source.id}:{})});
 const proof=await readTeamCashProof(c.context,c.observeContext,async timeout=>await c.stripe.rawRequest("GET","/v1/balance",{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout}) as unknown as Stripe.Response<Stripe.Balance>);
 await teamRpc(c.admin,"complete_sales_team_cash_read_v1",{p_read_id:readId,p_actor_id:actorId,p_proof:proof});
 return readId;
}
export async function fundTeamAdminRefund(c:TeamReceiptComposition,actorId:string,requestId:string){
 teamId(actorId);teamId(requestId);
 const readId=await observeTeamCash(c,actorId);
 return teamRpc(c.admin,"reserve_sales_team_refund_cash_v1",{p_actor_id:actorId,p_request_id:requestId,p_read_id:readId,p_context:c.context});
}
export async function protectSharedCash(c:TeamReceiptComposition,source:SharedCashSource,actorId:string|null){
 const readId=await observeTeamCash(c,actorId,source);
 return teamRpc(c.admin,"admit_sales_team_shared_cash_v1",{p_read_id:readId,p_source_kind:source.kind,p_source_id:source.id,p_context:c.context});
}
