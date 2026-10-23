import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import type {ExactPaymentContext} from "@/lib/installments/paymentContext";
const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Protected platform funds require review");};
/** Readback deliberately has no database, global client or credential factory.
 * Restricted payment runtimes supply their own already-authorized transport. */
export function inspectTeamCashBalance(balance:Stripe.Balance,live:boolean){
 check(balance.object==="balance"&&balance.livemode===live&&Array.isArray(balance.available));
 const rows=balance.available.filter(row=>row.currency==="usd");check(rows.length===1);
 const row=rows[0],card=row.source_types?.card;
 check(Number.isSafeInteger(row.amount)&&Number.isSafeInteger(card));
 return Math.min(row.amount,card!);
}
export async function readTeamCashProof(context:ExactPaymentContext,observeContext:()=>Promise<ExactPaymentContext>,read:(timeout:number)=>Promise<Stripe.Response<Stripe.Balance>>){
 check(isDeepStrictEqual(await observeContext(),context));
 const started=Date.now();
 const get=async()=>{
  const remaining=20000-(Date.now()-started);check(remaining>0&&remaining<=20000);
  const balance=await read(Math.min(10000,remaining));
  check(/^req_[A-Za-z0-9]+$/.test(balance.lastResponse?.requestId??""));
  return {availableCents:inspectTeamCashBalance(balance,context.mode==="live"),requestId:balance.lastResponse.requestId};
 };
 const first=await get(),second=await get();
 check(first.availableCents===second.availableCents);
 check(isDeepStrictEqual(await observeContext(),context)&&Date.now()>=started&&Date.now()-started<20000);
 return {context,availableCents:second.availableCents,firstRequestId:first.requestId,secondRequestId:second.requestId,readStartedAt:started};
}
