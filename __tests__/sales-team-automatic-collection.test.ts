/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {savedMethodDatabase,seedTeamSavedMethod,savedMethodPredecessors,savedMethodCandidate} from "@/test-support/sales-team-saved-method-postgres";
import {sharedCashDatabase} from "@/test-support/sales-team-shared-cash-postgres";
import {captureRpc,seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {membershipMonthBoundary} from "@/lib/membershipAgreement";
import {teamPaymentFixture} from "@/test-support/sales-team-payment-fixture";
import {teamCaptureFixture} from "@/test-support/sales-team-capture-fixture";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {runTeamAutomaticCollection} from "@/lib/salesTeams/automaticCollection";
import {readTeamCollection,confirmTeamCollection} from "@/lib/salesTeams/collection";
import {readTeamSavedMethodQuote,recordTeamSavedMethod} from "@/lib/salesTeams/savedMethod";
import {recordTeamCapture} from "@/lib/salesTeams/receipts";
import {prepareTeamManualCollection,readTeamAutomaticCollection} from "@/lib/salesTeams/savedCollection";
import {teamAutomaticCollectionReady,teamAutomaticCollectionSchemaReady} from "@/lib/salesTeams/policy";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261027024721_sales_team_automatic_collection.sql";
let db:PGlite,advance:(ms:number)=>Promise<void>,offset=0;const realNow=Date.now.bind(Date),env={...process.env};
const rpc=<T=Record<string,unknown>>(name:string,args:unknown[]=[])=>captureRpc<T>(db,name,args);
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied");}};
beforeAll(async()=>{db=createLocalPostgres();advance=await installTeamLocalClock(db);await savedMethodDatabase(db);await db.exec(readFileSync(candidate,"utf8"));await db.exec(readFileSync("supabase/migrations/20261027232440_sales_team_protected_daily_surplus.sql","utf8"));},30000);
beforeEach(async()=>{offset=0;await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();process.env={...env};});afterAll(async()=>{await db?.close();});
async function age(f:Awaited<ReturnType<typeof seedTeamSavedMethod>>,n=2){const anchor=Number((await db.query<{s:number}>("select extract(epoch from anchor_at) s from sales_team_payment_runtime_v1 where sale_id=$1",[f.sale])).rows[0].s);offset=membershipMonthBoundary(anchor,n-1)*1000-realNow()+1000;jest.spyOn(Date,"now").mockImplementation(()=>realNow()+offset);await advance(Math.floor(offset));}
async function nextSlot(){offset+=15*60*1000;await advance(Math.floor(offset));}
const enable=async()=>{for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY","CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_LATER_COLLECTION_SCHEMA_READY","CREATOR_TEAM_LATER_COLLECTION_READY","CREATOR_TEAM_PAYMENT_LIFECYCLE_SCHEMA_READY","CREATOR_TEAM_COLLECTION_RETRY_SCHEMA_READY","CREATOR_TEAM_SAVED_METHOD_SCHEMA_READY","CREATOR_TEAM_SAVED_METHOD_READY","CREATOR_TEAM_AUTOMATIC_COLLECTION_SCHEMA_READY","CREATOR_TEAM_AUTOMATIC_COLLECTION_READY","CREATOR_TEAM_PAYMENT_COLLECTION_READY","CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_RECORDING_READY","CREATOR_TEAM_FULFILLMENT_SCHEMA_READY","CREATOR_TEAM_FULFILLMENT_READY","CREATOR_TEAM_EVENT_SCHEMA_READY","CREATOR_TEAM_EVENT_RECONCILIATION_READY","CREATOR_TEAM_FINANCIAL_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_RECONCILIATION_READY"])process.env[key]="true";await db.exec("update sales_team_controls_v1 set automatic_collection_enabled=true,later_collection_enabled=true");};
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function harness(f:Awaited<ReturnType<typeof seedTeamSavedMethod>>){
 const errors:{name:string;message:string}[]=[],base=teamSupabaseFixture(db),admin={...base,rpc:async(name:string,args:Record<string,unknown>)=>{await db.exec("savepoint automatic_rpc");const result=await base.rpc(name,args);if(result.error){errors.push({name,message:String((result.error as Error).message)});await db.exec("rollback to savepoint automatic_rpc");}await db.exec("release savepoint automatic_rpc");return result;}} as unknown as SupabaseClient;
 let seq=0,generation=0,pi:Stripe.PaymentIntent|null=null,capture:ReturnType<typeof teamCaptureFixture>|null=null,events:Stripe.Event[]=[],unknown=false,outcome:"succeeded"|"requires_action"|"requires_payment_method"="succeeded",authentication=false,complete=true,method=copy(f.method),manualToken:Stripe.ConfirmationToken|null=null;
 const old=new Map<string,Stripe.PaymentIntent>(),response=<T>(value:T):T=>copy({...value,lastResponse:{requestId:`req_autoRead${++seq}`}});
 const provider=jest.fn(async(http:string,path:string,params:Record<string,unknown>={},options:Record<string,unknown>={})=>{
  const stamp=Math.floor(Date.now()/1000);
  if(http==="GET"&&path==="/v1/customers/cus_original"){const s=await readTeamCollection({admin},f.sale,f.buyer);return response({object:"customer",id:"cus_original",livemode:false,created:f.contract.acceptedAt,metadata:s.setup!.customer_request.params.metadata});}
  if(http==="POST"&&path==="/v1/payment_intents"){
   if(pi)old.set(pi.id,copy(pi));pi={...copy(teamPaymentFixture("installments").pi),...params,id:`pi_auto${++generation}`,created:stamp,setup_future_usage:params.setup_future_usage??null} as Stripe.PaymentIntent;return response(pi);
  }
  if(pi&&http==="POST"&&path===`/v1/payment_intents/${pi.id}/confirm`){
   const state=params.off_session===true?outcome:params.payment_method&&authentication?"requires_action":"succeeded",request=`req_autoPost${++seq}`;pi={...pi,status:state,payment_method:method.id,amount_received:state==="succeeded"?pi.amount:0,latest_charge:state==="succeeded"?`ch_auto${generation}`:state==="requires_payment_method"?`ch_failed${generation}`:null,client_secret:`${pi.id}_secret_fixture`,last_payment_error:state==="requires_payment_method"&&authentication?{type:"card_error",code:"authentication_required",decline_code:"authentication_required",payment_method:copy(method)}:null};
   if(manualToken&&params.confirmation_token){manualToken.payment_intent=pi.id;manualToken.expires_at=null;}
   if(state==="succeeded"){const source=await readTeamCollection({admin},f.sale,f.buyer,pi.metadata.team_obligation_id);capture=teamCaptureFixture(source.attempt!.contract);capture.paymentIntent=copy(pi);capture.charge={...capture.charge,id:`ch_auto${generation}`,payment_intent:pi.id,payment_method:method.id,created:stamp,balance_transaction:`txn_auto${generation}`};capture.balance={...capture.balance,id:`txn_auto${generation}`,source:capture.charge.id,created:stamp,available_on:stamp+86400};}
   const event={object:"event",id:`evt_auto${generation}`,type:state==="succeeded"?"payment_intent.succeeded":state==="requires_action"?"payment_intent.requires_action":"payment_intent.payment_failed",api_version:"2026-08-26.dahlia",created:stamp,livemode:false,account:null,context:null,request:{id:request,idempotency_key:options.idempotencyKey},data:{object:copy(pi)}} as unknown as Stripe.Event;events=[event];
   if(unknown){unknown=false;throw Error("Uncertain original automatic confirmation");}return {...copy(pi),lastResponse:{requestId:request}};
  }
  if(http==="GET"&&pi&&path===`/v1/payment_intents/${pi.id}`)return response(pi);
  if(http==="POST"&&pi&&path===`/v1/payment_intents/${pi.id}/cancel`){pi={...pi,status:"canceled"};return response(pi);}
  if(http==="GET"&&path.startsWith("/v1/payment_intents/")&&old.has(path.split("/").at(-1)!))return response(old.get(path.split("/").at(-1)!));
  if(http==="GET"&&path==="/v1/payment_intents")return response({object:"list",data:[...old.values(),...(pi?[pi]:[])],has_more:false});
  if(http==="GET"&&path===`/v1/payment_methods/${method.id}`)return response(method);
  if(http==="GET"&&manualToken&&path===`/v1/confirmation_tokens/${manualToken.id}`)return response(manualToken);
  if(http==="GET"&&path==="/v1/events")return response({object:"list",data:events,has_more:!complete});
  if(http==="GET"&&path.startsWith("/v1/events/"))return response(events.find(e=>e.id===path.split("/").at(-1)));
  if(http==="GET"&&pi&&path===`/v1/charges/ch_failed${generation}`)return response({object:"charge",id:`ch_failed${generation}`,livemode:false,payment_intent:pi.id,customer:pi.customer,amount:pi.amount,currency:"usd",status:"failed",paid:false,captured:false,amount_captured:0});
  if(http==="GET"&&capture&&path===`/v1/charges/${capture.charge.id}`)return response(capture.charge);
  if(http==="GET"&&capture&&path===`/v1/balance_transactions/${capture.balance.id}`)return response(capture.balance);
  throw Error(`Unexpected automatic fixture ${http} ${path}`);
 });
 const c={admin:admin as unknown as SupabaseClient,stripe:{rawRequest:provider as unknown as Stripe["rawRequest"]},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence};
 return {c,provider,errors,posts:()=>provider.mock.calls.filter(([http])=>http==="POST"),unknown:()=>{unknown=true;},action:()=>{outcome="requires_action";},failed:()=>{outcome="requires_payment_method";},authRequired:()=>{outcome="requires_payment_method";authentication=true;},incomplete:()=>{complete=false;},empty:()=>{events=[];},mutateEvent:(fn:(e:Stripe.Event)=>void)=>{fn(events[0]);},changeCard:()=>{method={...method,customer:"cus_foreign"};},bankDone:()=>{if(pi)pi={...pi,status:"requires_confirmation"};},newCard:()=>{outcome="succeeded";authentication=false;method={...copy(f.method),id:"pm_recovery",card:{...f.method.card!,fingerprint:"fp_recovery"}};manualToken={...copy(teamPaymentFixture("installments").token),id:"ctoken_recovery",created:Math.floor(Date.now()/1000),expires_at:Math.floor(Date.now()/1000)+3600,payment_method_preview:{...copy(teamPaymentFixture("installments").token.payment_method_preview!),card:method.card}} as Stripe.ConfirmationToken;return manualToken.id;}};
}
test("automatic collection is independently default off",async()=>{
 expect(teamAutomaticCollectionReady({})).toBe(false);expect(teamAutomaticCollectionSchemaReady({})).toBe(false);
 const f=await seedTeamSavedMethod(db);await age(f);expect((await db.query("select automatic_collection_enabled from sales_team_controls_v1")).rows).toEqual([{automatic_collection_enabled:false}]);expect(await rpc("claim_sales_team_collection_run_v1",[id(200),f.contract.context,true])).toEqual({status:"held"});
 expect((await db.query("select count(*)::int n from sales_team_automatic_collections_v1")).rows).toEqual([{n:0}]);
});
test("enabling automatic collection cannot backfill consent or enroll a historical manual card",async()=>{
 await db.exec("update sales_team_controls_v1 set fulfillment_enabled=true,event_reconciliation_enabled=true,financial_reconciliation_enabled=true");const f=await seedTeamCapture(db),receipt=await f.record();await rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id]);await age(f as Awaited<ReturnType<typeof seedTeamSavedMethod>>);await enable();const h=harness({...f,c:{admin:teamSupabaseFixture(db)},method:{} as Stripe.PaymentMethod} as Awaited<ReturnType<typeof seedTeamSavedMethod>>);
 expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({collected:0,held:0});expect(h.provider).not.toHaveBeenCalled();expect((await db.query("select count(*)::int n from sales_team_automatic_collections_v1")).rows).toEqual([{n:0}]);
});
test("the worker freezes exactly the due accepted installment and its checked saved-card lineage",async()=>{
 const f=await seedTeamSavedMethod(db);await age(f);await db.exec("update sales_team_controls_v1 set automatic_collection_enabled=true,later_collection_enabled=true");
 const run=await rpc<{status:string;runId:string;leaseToken:string}>("claim_sales_team_collection_run_v1",[id(200),f.contract.context,true]);expect(run.status).toBe("claimed");
 const task=await rpc<{id:string;obligation_id:string;kind:string}>("next_sales_team_collection_task_v1",[run.runId,run.leaseToken,f.contract.context,true]);expect(task.kind).toBe("new");
 const source=await rpc<{payment:{obligation:unknown};automatic:{consent_id:string};authority:{customerId:string}}>("read_sales_team_automatic_collection_v1",[f.sale,f.buyer,task.obligation_id]);expect(source.payment.obligation).toMatchObject({period_number:2,amount_cents:3333});expect(source.automatic.consent_id).toBe(id(70));expect(source.authority.customerId).toBe("cus_original");
 expect(await rpc("next_sales_team_collection_task_v1",[run.runId,run.leaseToken,f.contract.context,true])).toEqual(task);
 expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where kind='intent'")).rows).toEqual([{n:1}]);
});
test("each accepted fixed installment collects off session and reaches shared Library and commission once",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();const h=harness(f);
 for(const period of [2,3]){await age(f,period);expect({result:await runTeamAutomaticCollection(h.c,{admitNew:true}),errors:h.errors}).toMatchObject({result:{status:"complete",collected:1,held:0},errors:[]});expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({status:"slot_consumed"});}
 expect(h.posts().filter(([,path])=>path==="/v1/payment_intents").map(([, ,params={}])=>params.amount)).toEqual([3333,3335]);expect(h.posts().filter(([,path])=>path.endsWith("/confirm")).every(([, ,params={}])=>params.off_session===true&&params.payment_method==="pm_original"&&!Object.hasOwn(params,"confirmation_token"))).toBe(true);
 expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_shared_receipts_v1")).rows).toEqual([{n:3}]);expect((await db.query("select sum(earned_cents)::int amount from sales_team_commission_balances_v1")).rows).toEqual([{amount:1000}]);
});
test("an uncertain captured automatic original drains with new money off and a changed current card",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const h=harness(f);h.unknown();expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({status:"review_required",held:1});const count=h.posts().length;
 await nextSlot();await db.exec("update sales_team_controls_v1 set automatic_collection_enabled=false,saved_method_enabled=false,later_collection_enabled=false,payment_collection_enabled=false");h.changeCard();expect(await runTeamAutomaticCollection(h.c,{admitNew:false})).toMatchObject({status:"complete",collected:1});expect(h.posts()).toHaveLength(count);
 expect((await db.query("select count(*)::int n from sales_team_saved_confirmation_events_v1")).rows).toEqual([{n:1}]);
});
test("bank verification reconfirms the same saved-card original explicitly on session",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const h=harness(f);h.action();expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({status:"review_required",held:1});
 const automatic=(await db.query<{obligation_id:string}>("select obligation_id from sales_team_automatic_collections_v1")).rows[0];h.bankDone();
 expect(await confirmTeamCollection(h.c,f.sale,f.buyer,{kind:"reconfirm",requestId:id(240),obligationId:automatic.obligation_id})).toMatchObject({phase:"captured_pending_receipt"});
 const receipt=await recordTeamCapture(h.c,f.sale,f.buyer,automatic.obligation_id);expect(receipt.status).toBe("verified");const confirmations=h.posts().filter(([,path])=>path.endsWith("/confirm"));expect(confirmations).toHaveLength(2);expect(confirmations[0][1]).toBe(confirmations[1][1]);expect(confirmations[1][2]).toEqual({use_stripe_sdk:true,return_url:`${f.contract.context.siteOrigin}/purchase/team/${f.sale}`});
});
test("authentication_required decline returns the buyer to the same saved card and intent for bank verification",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const h=harness(f);h.authRequired();expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({held:1});
 const automatic=(await db.query<{obligation_id:string}>("select obligation_id from sales_team_automatic_collections_v1")).rows[0];
 expect(await confirmTeamCollection(h.c,f.sale,f.buyer,{kind:"reconfirm",requestId:id(241),obligationId:automatic.obligation_id})).toMatchObject({phase:"requires_action"});h.bankDone();
 expect(await confirmTeamCollection(h.c,f.sale,f.buyer,{kind:"reconfirm",requestId:id(242),obligationId:automatic.obligation_id})).toMatchObject({phase:"captured_pending_receipt"});expect((await recordTeamCapture(h.c,f.sale,f.buyer,automatic.obligation_id)).status).toBe("verified");
 const posts=h.posts().filter(([,path])=>path.endsWith("/confirm"));expect(new Set(posts.map(([,path])=>path)).size).toBe(1);expect(posts[1][2]).toEqual({payment_method:"pm_original",use_stripe_sdk:true,return_url:`${f.contract.context.siteOrigin}/purchase/team/${f.sale}`});expect(posts[2][2]).not.toHaveProperty("off_session");
});
test("a declined original accepts a newly consented manual card and uses that checked card for the next installment",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const h=harness(f);h.failed();expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({held:1});
 const automatic=(await db.query<{obligation_id:string}>("select obligation_id from sales_team_automatic_collections_v1")).rows[0],quote=await readTeamSavedMethodQuote(h.c,f.sale,f.buyer,automatic.obligation_id);expect(quote).not.toBeNull();
 const token=h.newCard();expect(await confirmTeamCollection(h.c,f.sale,f.buyer,{kind:"token",requestId:id(250),tokenId:token,obligationId:automatic.obligation_id,savedMethodConsent:{accepted:true,fingerprint:quote!.fingerprint}})).toMatchObject({phase:"captured_pending_receipt"});
 const receipt=await recordTeamCapture(h.c,f.sale,f.buyer,automatic.obligation_id);if(!("receiptId" in receipt))throw Error("Missing verified recovery receipt");await rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.receiptId]);expect(await recordTeamSavedMethod(h.c,f.sale,f.buyer,automatic.obligation_id)).toEqual({status:"verified"});
 expect((await db.query("select count(*)::int n from sales_team_automatic_manual_handoffs_v1")).rows).toEqual([{n:1}]);await age(f,3);expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({collected:1});expect(h.posts().filter(([,path,params={}])=>path.endsWith("/confirm")&&params.off_session===true).at(-1)?.[2]?.payment_method).toBe("pm_recovery");
});
test.each(["empty","incomplete","foreign_key","foreign_intent","connected","mode","event_type"])("%s event evidence cannot bind or replay an uncertain automatic POST",async fault=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const h=harness(f);h.unknown();await runTeamAutomaticCollection(h.c,{admitNew:true});const count=h.posts().length;
 if(fault==="empty")h.empty();if(fault==="incomplete")h.incomplete();if(fault==="foreign_key")h.mutateEvent(e=>{e.request!.idempotency_key="foreign";});if(fault==="foreign_intent")h.mutateEvent(e=>{(e.data.object as Stripe.PaymentIntent).id="pi_foreign";});if(fault==="connected")h.mutateEvent(e=>{e.account="acct_foreign";});if(fault==="mode")h.mutateEvent(e=>{e.livemode=true;});if(fault==="event_type")h.mutateEvent(e=>{e.type="payment_intent.processing";});
 await nextSlot();expect(await runTeamAutomaticCollection(h.c,{admitNew:false})).toMatchObject({status:"review_required",held:1});expect(h.posts()).toHaveLength(count);expect((await db.query("select count(*)::int n from sales_team_saved_confirmation_events_v1")).rows).toEqual([{n:0}]);
});
test("an unusable saved card can be handed to manual recovery before any intent exists, with the original window unchanged",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const h=harness(f);h.changeCard();expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({held:1});expect(h.posts()).toHaveLength(0);
 const automatic=(await db.query<{obligation_id:string}>("select obligation_id from sales_team_automatic_collections_v1")).rows[0],window=await db.query("select expires_at from sales_team_later_payment_windows_v1 where obligation_id=$1",[automatic.obligation_id]);
 expect((await prepareTeamManualCollection(h.c,f.sale,f.buyer,automatic.obligation_id)).view.phase).toBe("needs_method");expect((await readTeamAutomaticCollection(h.c,f.sale,f.buyer,automatic.obligation_id)).payment.manual_collection_handoff).toBe(true);
 expect((await db.query("select expires_at from sales_team_later_payment_windows_v1 where obligation_id=$1",[automatic.obligation_id])).rows).toEqual(window.rows);
 const token=h.newCard(),quote=await readTeamSavedMethodQuote(h.c,f.sale,f.buyer,automatic.obligation_id);expect(await confirmTeamCollection(h.c,f.sale,f.buyer,{kind:"token",requestId:id(251),tokenId:token,obligationId:automatic.obligation_id,savedMethodConsent:{accepted:true,fingerprint:quote!.fingerprint}})).toMatchObject({phase:"captured_pending_receipt"});expect(h.posts().filter(([,path])=>path==="/v1/payment_intents")).toHaveLength(1);expect(h.posts().filter(([,path])=>path.endsWith("/confirm"))[0][2]).toHaveProperty("confirmation_token",token);
});
test("manual takeover and direct binding cannot bypass an unknown automatic confirmation",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const h=harness(f);h.unknown();await runTeamAutomaticCollection(h.c,{admitNew:true});const automatic=(await db.query<{obligation_id:string}>("select obligation_id from sales_team_automatic_collections_v1")).rows[0];
 await denied(()=>rpc("request_sales_team_manual_collection_v1",[f.sale,f.buyer,automatic.obligation_id]),/NEEDS_RECONCILIATION/);
 const op=(await db.query<{id:string}>("select id from sales_team_provider_operations_v1 where kind='confirmation' and status='unknown'")).rows[0];await denied(()=>rpc("bind_sales_team_provider_operation_v1",[op.id,"pi_auto1","req_fabricated",true]),/EXACT_ORIGINAL_SAVED_CONFIRMATION_EVENT_REQUIRED/);
 expect(h.posts()).toHaveLength(2);expect((await db.query("select count(*)::int n from sales_team_automatic_manual_handoffs_v1")).rows).toEqual([{n:0}]);
});
test.each(["automatic_control","saved_control","Stop","financial_hold"])("%s loss after exact claim prevents the actual automatic confirmation POST",async fault=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const h=harness(f);let changed=false;
 const c={...h.c,observeContext:async()=>{if(!changed&&(await db.query<{n:number}>("select count(*)::int n from sales_team_provider_operations_v1 where kind='confirmation' and worker_run_id is not null and status='dispatching'")).rows[0].n){changed=true;if(fault==="automatic_control")await db.exec("update sales_team_controls_v1 set automatic_collection_enabled=false");if(fault==="saved_control")await db.exec("update sales_team_controls_v1 set saved_method_enabled=false");if(fault==="Stop")await rpc("stop_sales_team_payment_v1",[f.sale,f.buyer]);if(fault==="financial_hold")await db.exec("update sales_team_payment_runtime_v1 set financial_hold=true");}return f.contract.context;}};
 expect(await runTeamAutomaticCollection(c,{admitNew:true})).toMatchObject({held:1});expect(changed).toBe(true);expect(h.posts().filter(([,path])=>path.endsWith("/confirm"))).toHaveLength(0);expect((await db.query("select count(*)::int n from sales_team_receipts_v1")).rows).toEqual([{n:1}]);
});
test("saved Stop and unpaid original windows survive worker expiry without a fresh debit",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const run=await rpc<{runId:string;leaseToken:string}>("claim_sales_team_collection_run_v1",[id(200),f.contract.context,true]);const task=await rpc<{obligation_id:string}>("next_sales_team_collection_task_v1",[run.runId,run.leaseToken,f.contract.context,true]);offset+=91000;await advance(Math.floor(offset));
 await denied(()=>rpc("next_sales_team_collection_task_v1",[run.runId,run.leaseToken,f.contract.context,true]),/CURRENT_TEAM_COLLECTION_WORKER_REQUIRED/);await rpc("stop_sales_team_payment_v1",[f.sale,f.buyer]);await nextSlot();const h=harness(f);expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({held:1});expect(h.posts()).toHaveLength(0);expect((await readTeamCollection(h.c,f.sale,f.buyer,task.obligation_id)).runtime?.stop_requested_at).not.toBeNull();
});
test.each([false,true])("monthly renewal Stop=%s preserves the minimum and accepted renewal commission rule",async stopped=>{
 const f=await seedTeamSavedMethod(db,{minimumMonths:3,autoRenew:true});await enable();const h=harness(f);if(stopped)await rpc("request_sales_team_exit_v1",[f.sale,f.buyer,id(260),"stop_renewal",true]);
 for(const period of [2,3,...(stopped?[]:[4])]){await age(f,period);expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({collected:1,held:0});}
 if(stopped){await age(f,4);expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({collected:0,held:0});}
 expect((await db.query("select sum(earned_cents)::int amount from sales_team_commission_balances_v1")).rows).toEqual([{amount:3000}]);expect(h.posts().filter(([,path])=>path==="/v1/payment_intents").every(([, ,params])=>params?.amount===10001)).toBe(true);
});
test("closer departure and new-sales disable preserve the explicitly accepted automatic obligation",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);await db.exec("update sales_team_controls_v1 set new_sales_enabled=false,access_enabled=false;update sales_team_memberships_v1 set status='removed'");const h=harness(f);expect(await runTeamAutomaticCollection(h.c,{admitNew:true})).toMatchObject({collected:1});
});
test("an observation-only run cannot acquire fresh debit permission after flags are enabled",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const first=await rpc<{runId:string;leaseToken:string}>("claim_sales_team_collection_run_v1",[id(200),f.contract.context,true]);const original=await rpc<{id:string;obligation_id:string}>("next_sales_team_collection_task_v1",[first.runId,first.leaseToken,f.contract.context,true]);await rpc("finish_sales_team_collection_task_v1",[first.runId,first.leaseToken,f.contract.context,original.id,true]);await rpc("finish_sales_team_collection_run_v1",[first.runId,first.leaseToken,f.contract.context,false]);await nextSlot();
 const run=await rpc<{runId:string;leaseToken:string}>("claim_sales_team_collection_run_v1",[id(201),f.contract.context,false]),task=await rpc<{obligation_id:string;kind:string}>("next_sales_team_collection_task_v1",[run.runId,run.leaseToken,f.contract.context,true]);expect(task.obligation_id).toBe(original.obligation_id);expect(task.kind).toBe("original");expect((await db.query("select allow_new from sales_team_collection_runs_v1 where run_id=$1",[run.runId])).rows).toEqual([{allow_new:false}]);expect((await db.query("select creatornet_team_private.team_automatic_dispatch_ready_v1($1,$2) ready",[task.obligation_id,f.contract.context])).rows).toEqual([{ready:false}]);
});
const tables=["sales_team_collection_runs_v1","sales_team_automatic_collections_v1","sales_team_collection_tasks_v1","sales_team_collection_task_results_v1","sales_team_automatic_method_checks_v1","sales_team_automatic_manual_handoffs_v1","sales_team_saved_confirmation_events_v1"];
test.each(["anon","authenticated","service_role"])("%s cannot forge collection histories or use the raw capture bypass",async role=>{
 const f=await seedTeamSavedMethod(db);for(const table of tables)expect((await db.query("select relrowsecurity rls from pg_class where oid=$1::regclass",[`public.${table}`])).rows).toEqual([{rls:true}]);await db.exec(`set role ${role}`);
 for(const table of tables)await denied(()=>db.exec(`insert into public.${table} default values`),/permission denied/i);
 if(role!=="service_role")await denied(()=>rpc("read_sales_team_automatic_collection_v1",[f.sale,f.buyer,id(99)]),/permission denied/i);
 await denied(()=>rpc("record_team_capture_before_automatic_v1",[f.sale,f.buyer,id(99),id(98),{}]),/permission denied/i);
});
test("collection history is immutable and the core journal rejects a different original worker",async()=>{
 const f=await seedTeamSavedMethod(db);await enable();await age(f);const h=harness(f);await runTeamAutomaticCollection(h.c,{admitNew:true});await denied(()=>db.exec("update sales_team_collection_runs_v1 set allow_new=false"),/IMMUTABLE/);await denied(()=>db.exec("delete from sales_team_automatic_collections_v1"),/IMMUTABLE/);
 const op=(await db.query<{scope:Record<string,unknown>;request:unknown;id:string}>("select id,public.sales_team_operation_json_v1(id) scope,request from sales_team_provider_operations_v1 where kind='intent' and worker_run_id is not null")).rows[0];await denied(()=>rpc("claim_sales_team_provider_operation_v1",[op.id,{...op.scope,workerRunId:null},f.contract.context,op.request]),/ORIGINAL_PROVIDER_REQUEST_CHANGED/);
});
const digests=async()=>(await db.query<Record<string,string>>("select creatornet_team_private.transfer_contract_digest_v1() transfer,creatornet_team_private.shared_cash_contract_digest_v1() shared,creatornet_team_private.retained_cash_contract_digest_v1() retained,creatornet_team_private.recovery_contract_digest_v1() recovery")).rows[0];
test.each(["creatornet_team_private.team_current_automatic_authority_v1(uuid)","creatornet_team_private.team_automatic_dispatch_ready_v1(uuid,jsonb)","creatornet_team_private.guard_team_saved_confirmation_binding_v1()","public.request_sales_team_manual_collection_v1(uuid,uuid,uuid)","public.record_sales_team_saved_confirmation_event_v1(uuid,jsonb)","public.reserve_sales_team_saved_confirmation_v1(uuid,uuid,uuid,uuid,uuid,uuid,boolean,jsonb)"])("all financial digests bind automatic authority %s",async signature=>{
 const before=await digests(),source=(await db.query<{s:string}>("select pg_get_functiondef($1::regprocedure) s",[signature])).rows[0].s;await db.exec(source.replace(/AS \$function\$/i,"AS $function$\n-- synthetic automatic authority mutation\n"));const after=await digests();for(const name of Object.keys(before))expect(after[name]).not.toBe(before[name]);
});
test.each(["dependency","late_grant"])("%s failure restores automatic tables, aliases, grants, constraints and journal source",async fault=>{
 const isolated=createLocalPostgres();try{
  await sharedCashDatabase(isolated);for(const path of [...savedMethodPredecessors,savedMethodCandidate])await isolated.exec(readFileSync(path,"utf8"));if(fault==="dependency")await isolated.exec("alter function public.claim_sales_team_operation_before_refund_v1(uuid,jsonb,jsonb,jsonb) rename to fixture_missing_collection_journal");
  const names=[fault==="dependency"?"fixture_missing_collection_journal":"claim_sales_team_operation_before_refund_v1","sales_team_operation_admitted_v1","read_sales_team_period_payment_v1","read_sales_team_capture_source_v1","record_verified_sales_team_capture_v1","transfer_contract_digest_v1","shared_cash_contract_digest_v1","retained_cash_contract_digest_v1","recovery_contract_digest_v1"],inventory=async()=>(await isolated.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proacl::text grants from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace) and proname=any($1::text[]) order by oid",[names])).rows;
  const constraints=async()=>(await isolated.query("select conrelid::regclass::text relation,conname,pg_get_constraintdef(oid) body from pg_constraint where conrelid in ('public.sales_team_worker_runs_v1'::regclass,'public.sales_team_payment_confirmations_v1'::regclass) order by conname")).rows,before=await inventory(),oldConstraints=await constraints(),sql=readFileSync(candidate,"utf8");await expect(isolated.exec(fault==="late_grant"?sql.replace("commit;","grant execute on function public.missing_collection_final_grant() to service_role;commit;"):sql)).rejects.toThrow(fault==="dependency"?/claim_sales_team_operation_before_refund_v1/:/missing_collection_final_grant/);await isolated.exec("rollback");expect(await inventory()).toEqual(before);expect(await constraints()).toEqual(oldConstraints);
  for(const table of tables)expect((await isolated.query("select to_regclass($1) relation",[`public.${table}`])).rows).toEqual([{relation:null}]);expect((await isolated.query("select count(*)::int n from information_schema.columns where table_schema='public' and (table_name='sales_team_controls_v1' and column_name='automatic_collection_enabled' or table_name='sales_team_payment_confirmations_v1' and column_name='saved_method_consent_id')")).rows).toEqual([{n:0}]);
 }finally{await isolated.close();}
},30000);
