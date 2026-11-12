import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {teamId} from "./policy";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import type {TeamReceiptComposition} from "./receipts";

type Reader=Pick<TeamReceiptComposition,"context"|"observeContext"|"stripe">;
/** Service-resolved connection provenance. A last-four match, a user-provided
 * account ID, or this readback alone never proves the payout destination link. */
export type TeamBankConnectionSource={connectionId:string;ownerUserId:string;context:Reader["context"];
 connectedAccountId:string;financialAccountId:string};
export const TEAM_BANK_FEED_MAX_AGE_SECONDS=36*60*60;
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Bank connection evidence requires review");};
const requestId=(v:unknown)=>(v as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
const time=(v:number)=>Number.isSafeInteger(v)&&v>0;
function inspect(source:TeamBankConnectionSource,value:Stripe.FinancialConnections.Account,now:number){
 check(value.object==="financial_connections.account"&&value.id===source.financialAccountId&&value.livemode===(source.context.mode==="live")&&
  value.account_holder?.type==="account"&&value.account_holder.account===source.connectedAccountId&&!value.account_holder.customer&&
  ['active','inactive','disconnected'].includes(value.status)&&['cash','credit','investment','other'].includes(value.category)&&
  ['checking','savings','other','mortgage','line_of_credit','credit_card'].includes(value.subcategory)&&
  time(value.created)&&value.created<=now+5);
 const permissions=value.permissions??[],subscriptions=value.subscriptions??[];
 check(Array.isArray(permissions)&&new Set(permissions).size===permissions.length&&permissions.every(p=>['balances','ownership','payment_method','transactions'].includes(p))&&
  Array.isArray(subscriptions)&&new Set(subscriptions).size===subscriptions.length&&subscriptions.every(s=>s==="transactions"));
 const refresh=value.transaction_refresh;
 if(refresh)check(/^fctxnref_[A-Za-z0-9]+$/.test(refresh.id)&&time(refresh.last_attempted_at)&&refresh.last_attempted_at>=value.created&&refresh.last_attempted_at<=now+5&&
  ['pending','succeeded','failed'].includes(refresh.status)&&(refresh.next_refresh_available_at===null||time(refresh.next_refresh_available_at))&&
  (refresh.status!=="pending"||refresh.next_refresh_available_at===null));
 const health=value.status==="disconnected"?"disconnected":value.status==="inactive"?"reconnect_required":
  value.category!=="cash"||!['checking','savings'].includes(value.subcategory)?"unsupported_account":
  !permissions.includes("transactions")?"permission_required":!subscriptions.includes("transactions")?"subscription_required":
  !refresh?"refresh_required":refresh.status==="pending"?"refresh_pending":refresh.status==="failed"?"refresh_failed":
  now-refresh.last_attempted_at>TEAM_BANK_FEED_MAX_AGE_SECONDS?"stale":"ready";
 return {financialAccountId:value.id,connectedAccountId:source.connectedAccountId,status:value.status,category:value.category,subcategory:value.subcategory,
  permissions:[...permissions].sort(),transactionsPermitted:permissions.includes("transactions"),transactionsSubscribed:subscriptions.includes("transactions"),health,
  refresh:refresh?{id:refresh.id,status:refresh.status,lastAttemptedAt:refresh.last_attempted_at,nextAvailableAt:refresh.next_refresh_available_at}:null};
}
/** GET-only connection health candidate. No session, subscription, refresh,
 * reconnect, disconnect, bank attachment, or financial operation is issued.
 * This does not prove account-to-destination mapping, a transaction, or receipt
 * of a payout. Durable consent/mapping/check ownership must precede activation. */
export async function readTeamBankConnection(c:Reader,input:TeamBankConnectionSource){
 const source=snapshotProviderJson(input),context=snapshotProviderJson(c.context),started=Date.now();
 teamId(source.connectionId);teamId(source.ownerUserId);
 check(isDeepStrictEqual(source.context,context)&&/^acct_[A-Za-z0-9]+$/.test(source.connectedAccountId)&&
  source.connectedAccountId!==context.platformAccountId&&/^fca_[A-Za-z0-9]+$/.test(source.financialAccountId));
 const reader=c.stripe,observe=c.observeContext.bind(c),requests:string[]=[];
 const bounded=()=>check(Date.now()>=started&&Date.now()-started<45000);
 const current=async()=>{
  // The existing context observer can take up to 30 seconds; reserve its full
  // allowance before admission, and await it rather than abandoning work.
  bounded();check(Date.now()-started<15000);check(isDeepStrictEqual(snapshotProviderJson(await observe()),context));bounded();
 };
 const get=async()=>{
  bounded();const value=await reader.rawRequest("GET",`/v1/financial_connections/accounts/${source.financialAccountId}`,{},
   {apiVersion:TEAM_STRIPE_API_VERSION,stripeAccount:source.connectedAccountId,maxNetworkRetries:0,timeout:Math.max(1,Math.min(10000,45000-(Date.now()-started)))});
  bounded();const req=requestId(value);check(/^req_[A-Za-z0-9]+$/.test(req)&&!requests.includes(req));requests.push(req);
  return inspect(source,value as unknown as Stripe.FinancialConnections.Account,Math.floor(Date.now()/1000));
 };
 await current();const first=await get(),second=await get();check(isDeepStrictEqual(first,second));await current();bounded();
 return {version:"creatornet-bank-connection-observation-v1" as const,connectionId:source.connectionId,ownerUserId:source.ownerUserId,context,
  ...second,maxAgeSeconds:TEAM_BANK_FEED_MAX_AGE_SECONDS,readRequestIds:requests,readStartedAt:started,observedAt:Math.floor(Date.now()/1000),bankConfirmed:false as const};
}
