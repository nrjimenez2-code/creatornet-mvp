import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import type Stripe from "stripe";
import {surplusDatabase,seedTeamSurplusCash} from "./sales-team-surplus-postgres";
import {teamSurplusPayoutFixture} from "./sales-team-surplus-payout-fixture";
import {teamFixtureId as id} from "./sales-team-postgres";
import {reserveTeamDailySurplus} from "@/lib/salesTeams/surplusReservations";
import {dispatchTeamDailySurplus} from "@/lib/salesTeams/surplusExecution";
import {TEAM_STRIPE_API_VERSION} from "@/lib/salesTeams/providerOperation";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
import {installSignedSurplusEventsFixture} from "./sales-team-surplus-events-schema";
export {signedSurplusCandidate} from "./sales-team-surplus-events-schema";
export async function signedSurplusDatabase(db:PGlite,install=true){
 await surplusDatabase(db);
 for(const file of ["20261028000209_sales_team_surplus_execution.sql","20261028222238_sales_team_surplus_recovery.sql"])await db.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
 await installSignedSurplusEventsFixture(db,install);return db;
}
export async function seedSignedSurplus(db:PGlite){
 const h=await seedTeamSurplusCash(db,{maximumCents:5000}),run=await h.claim(),prepared=await reserveTeamDailySurplus(h.c,{...run,requestId:id(201)});
 if(!("request" in prepared))throw Error("Synthetic original required");const q=prepared.request,f=teamSurplusPayoutFixture();await db.exec("update sales_team_controls_v1 set surplus_execution_enabled=true");let sequence=0,lost=false;
 const payout={...f.payout,created:Math.floor(Date.now()/1000),amount:Number(q.amount_cents),destination:q.destination_id,metadata:q.request.params.metadata};
 const debit={...f.debit,created:payout.created,available_on:payout.created},returned={...f.returned,created:payout.created,available_on:payout.created};
 const event={id:"evt_original",object:"event",type:"payout.created",api_version:TEAM_STRIPE_API_VERSION,account:null,context:null,created:payout.created,livemode:false,
  request:{id:"req_originalCreate",idempotency_key:`cn-team-v1:${q.operation_id}`},data:{object:{...payout,lastResponse:undefined}}} as unknown as Stripe.Event;
 const raw=jest.fn(async(method:string,path:string):Promise<Record<string,unknown>>=>{
  if(method==="POST"){if(path!=="/v1/payouts")throw Error(path);if(lost)throw Error("Synthetic lost original response");return {...payout,lastResponse:{requestId:"req_originalCreate"}};}
  const value=path==="/v1/account"?{...f.account,id:h.c.context.platformAccountId}:path==="/v1/balance_settings"?f.settings:path.startsWith("/v1/accounts/")?{...f.bank,id:q.destination_id,account:h.c.context.platformAccountId}:
   path==="/v1/balance"?{object:"balance",livemode:false,available:[{currency:"usd",amount:1000000,source_types:{card:1000000}}],pending:[]}:
   path==="/v1/events"?{object:"list",url:"/v1/events",has_more:false,data:[event]}:path==="/v1/events/evt_original"?event:
   path==="/v1/payouts/po_original"?payout:path==="/v1/balance_transactions/txn_debit"?debit:path==="/v1/balance_transactions/txn_return"?returned:null;
  if(method!=="GET"||!value)throw Error(path);return {...value,lastResponse:{requestId:`req_signedSurplus${++sequence}`}};
 });
 const originalRpc=h.c.admin.rpc.bind(h.c.admin),rpc=jest.fn(async(name:string,args:Record<string,unknown>)=>{
  await db.exec("savepoint signed_surplus_rpc");const result=await originalRpc(name,args);
  if(result.error)await db.exec("rollback to savepoint signed_surplus_rpc");await db.exec("release savepoint signed_surplus_rpc");return result;
 });
 const c={...h.c,admin:{...h.c.admin,rpc},stripe:{rawRequest:raw}} as unknown as TeamReceiptComposition;
 const invoke=async<T=unknown>(name:string,args:Record<string,unknown>)=>{const result=await rpc(name,args);if(result.error)throw result.error;return result.data as T;};
 return {...h,c,run,q,event,payout,debit,returned,raw,rpc,invoke,losePost:()=>{lost=true;},dispatch:()=>dispatchTeamDailySurplus(c,{...run,requestId:q.id},true)};
}
