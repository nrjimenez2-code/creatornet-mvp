import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {assertTeamSurplusJournal,type TeamSurplusMoneySource} from "./surplusPayoutPolicy";
import {readTeamSurplusPayout} from "./surplusPayoutReadback";
import type {TeamReceiptComposition} from "./receipts";

type Reader=Pick<TeamReceiptComposition,"context"|"observeContext"|"stripe">;
const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Exact original payout event requires review");};
const providerRequest=(value:unknown)=>(value as {lastResponse?:{requestId?:string}})?.lastResponse?.requestId??"";
const objectId=(value:unknown)=>typeof value==="string"?value:(value as {id?:string}|null)?.id??"";

/** Events retain their creation schema. Only the supported pinned snapshot is
 * accepted. Its immutable identity is separate from the current payout status. */
export function inspectTeamSurplusCreationEvent(q:TeamSurplusMoneySource,event:Stripe.Event,from:number,to:number){
 check(event.object==="event"&&/^evt_[A-Za-z0-9]+$/.test(event.id)&&event.type==="payout.created"&&event.api_version===TEAM_STRIPE_API_VERSION&&
  event.account==null&&event.context==null&&event.livemode===(q.context.mode==="live")&&Number.isSafeInteger(event.created)&&event.created>=from&&event.created<=to&&
  event.request?.idempotency_key===q.operation.idempotency_key&&/^req_[A-Za-z0-9]+$/.test(event.request?.id??""));
 const p=event.data.object as Stripe.Payout;
 check(p.object==="payout"&&/^po_[A-Za-z0-9]+$/.test(p.id)&&p.amount===Number(q.amount_cents)&&p.currency==="usd"&&objectId(p.destination)===q.destination_id&&
  p.livemode===event.livemode&&p.automatic===false&&p.method==="standard"&&p.source_type==="card"&&p.type==="bank_account"&&
  isDeepStrictEqual(p.metadata,q.request.params.metadata)&&p.original_payout==null&&p.reversed_by==null&&p.application_fee==null&&p.application_fee_amount==null&&
  Number.isSafeInteger(p.created)&&p.created>=from&&p.created<=event.created+5&&/^txn_[A-Za-z0-9]+$/.test(objectId(p.balance_transaction)));
 return {eventId:event.id,eventType:event.type,apiVersion:event.api_version,created:event.created,account:null,context:null,livemode:event.livemode,
  originalRequestId:event.request!.id!,idempotencyKey:event.request!.idempotency_key!,
  payout:{id:p.id,created:p.created,amountCents:p.amount,currency:p.currency,destinationId:objectId(p.destination),debitBalanceId:objectId(p.balance_transaction),metadata:p.metadata}};
}

/** At most three complete pages and two exact event GETs, bracketing the existing
 * independent payout/money reader. No POST, replacement, unsent inference or
 * new-money authority. Empty/ambiguous/expired/incomplete discovery stays held. */
export async function readTeamUnknownSurplus(c:Reader,source:TeamSurplusMoneySource,options:{now?:()=>number}={}){
 const now=options.now??Date.now,started=now(),q=snapshotProviderJson(source),op=q.operation;
 assertTeamSurplusJournal(q,Math.floor(started/1000));
 check(isDeepStrictEqual(q.context,c.context)&&!op.provider_id&&(op.status==="unknown"||op.status==="dispatching"&&Number.isFinite(Date.parse((op as typeof op&{lease_until?:string}).lease_until??""))&&Date.parse((op as typeof op&{lease_until:string}).lease_until)<=started));
 const from=Math.floor(Date.parse(op.first_dispatch_at)/1000)-5,to=Math.floor(started/1000);
 if(from<to-30*86400||from>to)return null;
 const requestIds=new Set<string>(),pending=new Set<Promise<unknown>>();let gets=0;
 const bounded=()=>check(now()>=started&&now()-started<60000);
 const current=async()=>{bounded();check(isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),q.context));bounded();return q.context;};
 const raw:Reader["stripe"]["rawRequest"]=async(method,path,params,settings)=>{
  await current();check(method==="GET"&&++gets<=9&&(/^\/v1\/events(?:\/evt_[A-Za-z0-9]+)?$/.test(path)||/^\/v1\/payouts\/po_[A-Za-z0-9]+$/.test(path)||/^\/v1\/balance_transactions\/txn_[A-Za-z0-9]+$/.test(path)));
  const request=c.stripe.rawRequest("GET",path,params,{...settings,apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:Math.max(1,Math.min(10000,60000-(now()-started)))});pending.add(request);
  try{const value=await request;bounded();const id=providerRequest(value);check(/^req_[A-Za-z0-9]+$/.test(id)&&!requestIds.has(id));requestIds.add(id);return value;}finally{pending.delete(request);}
 };
 const get=async<T>(path:string,params:Record<string,unknown>={})=>await raw("GET",path,params,{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000}) as unknown as T;
 const pages:{requestId:string;startingAfter:string|null;hasMore:boolean;events:{eventId:string;created:number;matchesOriginalKey:boolean}[]}[]=[];
 const ids=new Set<string>(),matches:Stripe.Event[]=[];let after:string|undefined,complete=false;
 try{
  for(let page=0;page<3;page++){
   const list=await get<Stripe.ApiList<Stripe.Event>>("/v1/events",{type:"payout.created",created:{gte:from,lte:to},limit:100,...(after?{starting_after:after}:{})});
   check(list.object==="list"&&list.url==="/v1/events"&&Array.isArray(list.data)&&list.data.length<=100&&typeof list.has_more==="boolean"&&(!list.has_more||list.data.length>0));
   const events=list.data.map(event=>{check(event.object==="event"&&/^evt_[A-Za-z0-9]+$/.test(event.id)&&!ids.has(event.id)&&event.type==="payout.created"&&Number.isSafeInteger(event.created)&&event.created>=from&&event.created<=to);ids.add(event.id);
    const matchesOriginalKey=event.request?.idempotency_key===op.idempotency_key;if(matchesOriginalKey)matches.push(event);return {eventId:event.id,created:event.created,matchesOriginalKey};});
   pages.push({requestId:providerRequest(list),startingAfter:after??null,hasMore:list.has_more,events});
   if(!list.has_more){complete=true;break;}after=list.data.at(-1)!.id;
  }
  if(!complete||matches.length!==1)return null;
  const discovered=inspectTeamSurplusCreationEvent(q,matches[0],from,to);
  const first=await get<Stripe.Event>(`/v1/events/${discovered.eventId}`),event=inspectTeamSurplusCreationEvent(q,first,from,to);
  check(isDeepStrictEqual(discovered,event)&&!requestIds.has(event.originalRequestId));
  const money=await readTeamSurplusPayout({...c,context:q.context,observeContext:current,stripe:{rawRequest:raw}},q,event.payout.id,{now});
  const second=await get<Stripe.Event>(`/v1/events/${event.eventId}`);check(isDeepStrictEqual(event,inspectTeamSurplusCreationEvent(q,second,from,to))&&!requestIds.has(event.originalRequestId));
  const p=money.payout;check(isDeepStrictEqual(event.payout,{id:p.id,created:p.created,amountCents:p.amountCents,currency:p.currency,destinationId:p.destinationId,debitBalanceId:p.debitBalanceId,metadata:p.metadata}));await current();
  return {context:q.context,requestId:q.id,operationId:q.operation_id,readStartedAt:started,observedAt:Math.floor(now()/1000),from,to,pages,event,
   firstEventRequestId:providerRequest(first),secondEventRequestId:providerRequest(second),money};
 }finally{await Promise.allSettled([...pending]);}
}
