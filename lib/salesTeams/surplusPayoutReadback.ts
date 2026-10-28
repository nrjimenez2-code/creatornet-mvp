import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import type {TeamReceiptComposition} from "./receipts";
import {validateTeamSurplusRequest,type TeamSurplusRequest} from "./surplusReservations";
import {assertTeamSurplusJournal,inspectTeamSurplusDestination,inspectTeamSurplusPayout,inspectTeamSurplusBalance,reconcileTeamSurplusPayout,type TeamSurplusMoneySource} from "./surplusPayoutPolicy";

type Reader=Pick<TeamReceiptComposition,"context"|"observeContext"|"stripe">;
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original payout readback requires review");};
const requestId=(v:unknown)=>(v as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
function boundedReader(c:Reader,budgetMs:number,now:()=>number){
 const started=now(),context=snapshotProviderJson(c.context),pending=new Set<Promise<unknown>>(),requests=new Set<string>();
 const bounded=()=>check(now()>=started&&now()-started<budgetMs);
 const current=async()=>{bounded();check(isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context));bounded();};
 const get=async<T>(path:string):Promise<T>=>{
  bounded();const request=c.stripe.rawRequest("GET",path,{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:Math.max(1,Math.min(10000,budgetMs-(now()-started)))});pending.add(request);
  try{const result=await request;bounded();const id=requestId(result);check(/^req_[A-Za-z0-9]+$/.test(id)&&!requests.has(id));requests.add(id);return result as T;}finally{pending.delete(request);}
 };
 return {started,context,current,get,requests,drain:async()=>{await Promise.allSettled([...pending]);}};
}

/** Fresh eligibility proof only. Reads the approved platform, manual payout
 * settings and exact bank; no configuration, bank attachment or POST is possible. */
export async function readTeamSurplusDestination(c:Reader,request:TeamSurplusRequest,options:{now?:()=>number}={}){
 const now=options.now??Date.now,q=snapshotProviderJson(request),reader=boundedReader(c,30000,now);check(isDeepStrictEqual(q.context,reader.context));
 validateTeamSurplusRequest({context:reader.context},q);
 try{
  await reader.current();
  const [account,settings,bank]=await Promise.all([
   reader.get<Stripe.Account>("/v1/account"),reader.get<Stripe.BalanceSettings>("/v1/balance_settings"),reader.get<Stripe.BankAccount>(`/v1/accounts/${q.context.platformAccountId}/external_accounts/${q.destination_id}`),
  ]);
  const proof=inspectTeamSurplusDestination(q,account,settings,bank);await reader.current();
  return {...proof,context:q.context,requestId:q.id,policyRevision:Number(q.policy.revision),policyDigest:q.policy.contract_sha256,
   accountRequestId:requestId(account),settingsRequestId:requestId(settings),bankRequestId:requestId(bank),readStartedAt:reader.started,observedAt:Math.floor(now()/1000)};
 }finally{await reader.drain();}
}

/** Independent original payout/debit/return reads. A bank becoming unavailable
 * cannot erase money that already moved. Every result still says bankConfirmed=false. */
export async function readTeamSurplusPayout(c:Reader,source:TeamSurplusMoneySource,payoutId:string,options:{now?:()=>number}={}){
 const now=options.now??Date.now,q=snapshotProviderJson(source),reader=boundedReader(c,45000,now);check(isDeepStrictEqual(q.context,reader.context));
 assertTeamSurplusJournal(q,Math.floor(now()/1000));check(/^po_[A-Za-z0-9]+$/.test(payoutId)&&(!q.operation.provider_id||q.operation.provider_id===payoutId));
 try{
  await reader.current();const first=inspectTeamSurplusPayout(q,await reader.get<Stripe.Payout>(`/v1/payouts/${payoutId}`),payoutId,Math.floor(now()/1000));
  const [debit,returned]=await Promise.all([
   reader.get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${first.debitBalanceId}`),first.returnBalanceId?reader.get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${first.returnBalanceId}`):Promise.resolve(null),
  ]);
  const second=inspectTeamSurplusPayout(q,await reader.get<Stripe.Payout>(`/v1/payouts/${payoutId}`),payoutId,Math.floor(now()/1000));
  const authority=(p:typeof first)=>({id:p.id,status:p.status,created:p.created,amountCents:p.amountCents,currency:p.currency,destinationId:p.destinationId,debitBalanceId:p.debitBalanceId,returnBalanceId:p.returnBalanceId,failureCode:p.failureCode});
  check(isDeepStrictEqual(authority(first),authority(second))&&!reader.requests.has(q.operation.provider_request_id??""));
  const debitProof=inspectTeamSurplusBalance(q,second,debit,"debit",Math.floor(now()/1000)),returnProof=returned?inspectTeamSurplusBalance(q,second,returned,"return",Math.floor(now()/1000)):null;
  await reader.current();
  return {...reconcileTeamSurplusPayout(q,second,debitProof,returnProof,Math.floor(now()/1000)),context:q.context,requestId:q.id,operationId:q.operation_id,
   firstPayoutRequestId:first.providerRequestId,secondPayoutRequestId:second.providerRequestId,readStartedAt:reader.started,observedAt:Math.floor(now()/1000)};
 }finally{await reader.drain();}
}
