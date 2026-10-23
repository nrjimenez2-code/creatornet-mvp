import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {teamRpc} from "./server";
import {teamId} from "./policy";
import type {TeamReceiptComposition} from "./receipts";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Protected platform funds require review");};
/** Pending and instant balances are not refund funding. A negative balance in
 * another USD source cannot be hidden by selecting only the card component. */
export function inspectTeamCashBalance(balance:Stripe.Balance,live:boolean){
 check(balance.object==="balance"&&balance.livemode===live&&Array.isArray(balance.available));
 const rows=balance.available.filter(row=>row.currency==="usd");check(rows.length===1);
 const row=rows[0],card=row.source_types?.card;
 check(Number.isSafeInteger(row.amount)&&Number.isSafeInteger(card));
 return Math.min(row.amount,card!);
}

/** A cash reservation is committed before the provider journal admits a POST.
 * Neither a lost response nor elapsed time releases that reservation. Recovery
 * of an existing refund never requires a new funding reservation or POST. */
export async function fundTeamAdminRefund(c:TeamReceiptComposition,actorId:string,requestId:string){
 teamId(actorId);teamId(requestId);
 check(isDeepStrictEqual(await c.observeContext(),c.context));
 const readId=randomUUID();
 await teamRpc(c.admin,"begin_sales_team_cash_read_v1",{p_read_id:readId,p_actor_id:actorId,p_context:c.context});
 const started=Date.now();
 const get=async()=>{
  const remaining=20000-(Date.now()-started);check(remaining>0&&remaining<=20000);
  const balance=await c.stripe.rawRequest("GET","/v1/balance",{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:Math.min(10000,remaining)}) as unknown as Stripe.Response<Stripe.Balance>;
  check(/^req_[A-Za-z0-9]+$/.test(balance.lastResponse?.requestId??""));
  return {availableCents:inspectTeamCashBalance(balance,c.context.mode==="live"),requestId:balance.lastResponse.requestId};
 };
 const first=await get(),second=await get();
 check(first.availableCents===second.availableCents&&Date.now()>=started&&Date.now()-started<20000&&isDeepStrictEqual(await c.observeContext(),c.context));
 await teamRpc(c.admin,"complete_sales_team_cash_read_v1",{p_read_id:readId,p_actor_id:actorId,p_proof:{context:c.context,availableCents:second.availableCents,firstRequestId:first.requestId,secondRequestId:second.requestId,readStartedAt:started}});
 return teamRpc(c.admin,"reserve_sales_team_refund_cash_v1",{p_actor_id:actorId,p_request_id:requestId,p_read_id:readId,p_context:c.context});
}
