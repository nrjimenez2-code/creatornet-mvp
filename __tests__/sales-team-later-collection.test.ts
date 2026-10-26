/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import type {SupabaseClient} from "@supabase/supabase-js";
import type Stripe from "stripe";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {membershipMonthBoundary} from "@/lib/membershipAgreement";
import {prepareNextTeamCollection,prepareTeamCollection,confirmTeamCollection,stopTeamCollection,readTeamCollection,type TeamCollection} from "@/lib/salesTeams/collection";
import {recordTeamCapture} from "@/lib/salesTeams/receipts";
import {teamPaymentFixture} from "@/test-support/sales-team-payment-fixture";
import {teamCaptureFixture} from "@/test-support/sales-team-capture-fixture";
import {teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import {teamIntentRequest,type TeamPaymentContract} from "@/lib/salesTeams/paymentProtocol";
import {teamLaterCollectionReady,teamLaterCollectionSchemaReady} from "@/lib/salesTeams/policy";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261025195351_sales_team_later_collection.sql";
const predecessors=[sharedCashReconciliationCandidate,...["20261023042321_sales_team_retained_refund_funding.sql","20261023060912_sales_team_automatic_recovery.sql","20261023063905_sales_team_worker_refund_recovery.sql","20261023174324_sales_team_no_outbound_shared_recovery.sql","20261023180144_sales_team_transfer_reservations.sql","20261023182527_sales_team_transfer_observations.sql","20261023184139_sales_team_transfer_execution.sql","20261023190044_sales_team_automatic_settlement.sql","20261024210829_sales_team_transfer_reversal_observations.sql","20261024213841_sales_team_transfer_recovery_reservations.sql","20261024215948_sales_team_transfer_recovery_execution.sql","20261025184802_sales_team_transfer_reversal_recovery.sql","20261025191826_sales_team_combined_settlement.sql"].map(n=>`supabase/migrations/${n}`)];
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,advanceClock:(ms:number)=>Promise<void>;
const realNow=Date.now.bind(Date);let offset=0;
beforeAll(async()=>{db=createLocalPostgres();advanceClock=await installTeamLocalClock(db);await sharedCashDatabase(db);for(const path of [...predecessors,candidate])await db.exec(readFileSync(path,"utf8"));},30000);
beforeEach(async()=>{offset=0;await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied");}};
async function fixture(monthly?:{minimumMonths:number;autoRenew:boolean}){await db.exec("update sales_team_controls_v1 set fulfillment_enabled=true,event_reconciliation_enabled=true,financial_reconciliation_enabled=true");f=await seedTeamCapture(db,monthly?{paymentKind:"monthly",beforeApproval:async()=>{await db.query("update products set type='mentorship',membership_terms=$1",[{version:"monthly-mentorship-v1",...monthly}]);}}:{});const receipt=await f.record();await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id]);}
async function ageToPeriod(n:number){const anchor=Number((await db.query<{s:number}>("select extract(epoch from anchor_at) s from sales_team_payment_runtime_v1 where sale_id=$1",[f.sale])).rows[0].s);offset=membershipMonthBoundary(anchor,n-1)*1000-realNow()+1000;jest.spyOn(Date,"now").mockImplementation(()=>realNow()+offset);await advanceClock(Math.floor(offset));}
const next=()=>f.rpc<TeamCollection&{status?:string}>("reserve_sales_team_next_payment_v1",[f.sale,f.buyer,f.contract.context]);
test("later collection is independently default off",async()=>{expect((await db.query("select later_collection_enabled enabled from sales_team_controls_v1")).rows).toEqual([{enabled:false}]);expect(teamLaterCollectionSchemaReady({})).toBe(false);expect(teamLaterCollectionReady({})).toBe(false);await fixture();await ageToPeriod(2);await denied(next,/LATER_TEAM_PAYMENT_HELD/);expect((await db.query("select count(*)::int n from sales_team_later_payment_windows_v1")).rows).toEqual([{n:0}]);});
test.each(["2024-01-31T14:23:47Z","2023-01-31T14:23:47Z","2024-02-29T23:59:59Z"])("SQL month boundaries preserve original UTC day/time from %s",async date=>{
 const anchor=Date.parse(date)/1000;for(const month of [0,1,2,12,25])expect(Number((await db.query<{s:number}>("select extract(epoch from creatornet_team_private.team_month_boundary_v1(to_timestamp($1),$2)) s",[anchor,month])).rows[0].s)).toBe(membershipMonthBoundary(anchor,month));
});
test("next fixed payment is not admitted early",async()=>{await fixture();await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");expect(await next()).toMatchObject({status:"not_due",periodNumber:2});expect((await db.query("select count(*)::int n from sales_team_payment_obligations_v1")).rows).toEqual([{n:1}]);});
test("the exact due fixed obligation is derived once with its own immutable collection window",async()=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true,new_sales_enabled=false,access_enabled=false;update sales_team_memberships_v1 set status='removed'");
 const second=await next();expect(second.obligation).toMatchObject({period_number:2,amount_cents:3333});expect((await next()).obligation?.id).toBe(second.obligation?.id);expect(second.setup?.customer_operation_id).toBeDefined();expect(second.receipt).toBeNull();
 await denied(()=>db.exec("update sales_team_later_payment_windows_v1 set expires_at=expires_at+interval '1 day'"),/IMMUTABLE/);
});
test.each(["stop","financial_hold","review","dispute","unfulfilled"])("%s prevents a new due obligation atomically",async fault=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");
 if(fault==="stop")await f.rpc("stop_sales_team_payment_v1",[f.sale,f.buyer]);if(fault==="financial_hold")await db.exec("update sales_team_payment_runtime_v1 set financial_hold=true");if(fault==="review")await db.exec("update sales_team_receipts_v1 set review_hold=true");if(fault==="dispute")await db.exec("update sales_team_receipts_v1 set dispute_hold=true");if(fault==="unfulfilled")await db.exec("set constraints all immediate;alter table sales_team_shared_receipts_v1 disable trigger user;delete from sales_team_shared_receipts_v1");
 await denied(next,/LATER_TEAM_PAYMENT_HELD/);expect((await db.query("select count(*)::int n from sales_team_payment_obligations_v1")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_later_payment_windows_v1")).rows).toEqual([{n:0}]);
});
test.each(["anon","authenticated"])("%s cannot enroll or read a private later obligation",async role=>{await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");const second=await next();await db.exec(`set role ${role}`);await denied(next,/permission denied/i);await denied(()=>f.rpc("read_sales_team_period_payment_v1",[f.sale,f.buyer,second.obligation!.id]),/permission denied/i);});
test("service can enroll but cannot fabricate a later window or read another buyer's obligation",async()=>{await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true;set role service_role");const second=await next();await denied(()=>db.exec("insert into sales_team_later_payment_windows_v1 default values"),/permission denied/i);await denied(()=>f.rpc("read_sales_team_period_payment_v1",[f.sale,id(11),second.obligation!.id]),/OWNED_TEAM_OBLIGATION_REQUIRED/);});

const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function collectionHarness(){
 const admin={rpc:async(name:string,args:Record<string,unknown>)=>{
  try{if(!/^[a-z_0-9]+$/.test(name)||Object.keys(args).some(k=>!/^p_[a-z_]+$/.test(k)))throw Error("Invalid fixture RPC");
   return {data:clone((await db.query<{r:unknown}>(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(",")}) r`,Object.values(args))).rows[0].r),error:null};
  }catch(error){return {data:null,error};}
 },from:(table:string)=>{
  if(!["sales_team_provider_operations_v1","sales_team_payment_confirmations_v1"].includes(table))throw Error(table);
  const filters:Record<string,unknown>={};let columns="*";
  const chain={select:(v:string)=>{if(!/^[a-z_,*]+$/.test(v))throw Error(v);columns=v;return chain;},eq:(k:string,v:unknown)=>{if(!/^[a-z_]+$/.test(k))throw Error(k);filters[k]=v;return chain;},maybeSingle:async()=>{
   const rows=(await db.query(`select ${columns} from public.${table} where ${Object.keys(filters).map((k,i)=>`${k}=$${i+1}`).join(" and ")}`,Object.values(filters))).rows;
   if(rows.length>1)throw Error("Ambiguous fixture select");return {data:rows[0]?clone(rows[0]):null,error:null};}};return chain;
 }} as unknown as SupabaseClient;
 let requestNumber=0,pi:Stripe.PaymentIntent|null=null,token:Stripe.ConfirmationToken|null=null,capture:ReturnType<typeof teamCaptureFixture>|null=null,timeoutConfirm=false;
 const response=<T>(value:T):T=>clone({...value,lastResponse:{requestId:`req_later${++requestNumber}`}});
 const provider=jest.fn(async(http:string,path:string,params:Record<string,unknown>={})=>{
  const stamp=Math.floor(Date.now()/1000);
  if(http==="GET"&&path==="/v1/customers/cus_original"){
   const saved=await readTeamCollection({admin},f.sale,f.buyer);return response({id:"cus_original",object:"customer",livemode:false,created:Math.floor(Date.parse(saved.setup!.created_at)/1000),metadata:saved.setup!.customer_request.params.metadata});
  }
  if(http==="POST"&&path==="/v1/payment_intents"){
   const period=(params.metadata as Record<string,string>).period_number;
   pi={...clone(teamPaymentFixture("installments").pi),...params,id:`pi_later${period}`,created:stamp} as Stripe.PaymentIntent;
   token={...clone(teamPaymentFixture("installments").token),id:`ctoken_later${period}`,created:stamp,expires_at:stamp+3600} as Stripe.ConfirmationToken;
   return response(pi);
  }
  if(pi&&token){
   if(http==="POST"&&path===`/v1/payment_intents/${pi.id}/confirm`){
    const obligationId=pi.metadata.team_obligation_id,saved=await readTeamCollection({admin},f.sale,f.buyer,obligationId),contract=saved.attempt!.contract;
    capture=teamCaptureFixture(contract);capture.paymentIntent={...pi,status:"succeeded",amount_received:pi.amount,payment_method:"pm_original",latest_charge:`ch_later${contract.periodNumber}`};
    capture.charge={...capture.charge,id:`ch_later${contract.periodNumber}`,payment_intent:pi.id,balance_transaction:`txn_later${contract.periodNumber}`,created:stamp};
    capture.balance={...capture.balance,id:`txn_later${contract.periodNumber}`,source:capture.charge.id,created:stamp,available_on:stamp+86400};
    pi=capture.paymentIntent;token.payment_intent=pi.id;token.expires_at=null;
    if(timeoutConfirm){timeoutConfirm=false;throw Error("Uncertain original confirmation");}return response(pi);
   }
   if(http==="POST"&&path===`/v1/payment_intents/${pi.id}/cancel`){pi={...pi,status:"canceled"};return response(pi);}
   if(http==="GET"&&path===`/v1/payment_intents/${pi.id}`)return response(pi);
   if(http==="GET"&&path===`/v1/confirmation_tokens/${token.id}`)return response(token);
   if(capture&&http==="GET"&&path===`/v1/charges/${capture.charge.id}`)return response(capture.charge);
   if(capture&&http==="GET"&&path===`/v1/balance_transactions/${capture.balance.id}`)return response(capture.balance);
  }
  throw Error(`Unexpected fixture provider ${http} ${path}`);
 });
 const c={admin,stripe:{rawRequest:provider as Stripe["rawRequest"]},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence};
 const posts=()=>provider.mock.calls.filter(([http])=>http==="POST");
 return {c,provider,posts,uncertain:()=>{timeoutConfirm=true;},confirm:async(s:TeamCollection)=>confirmTeamCollection(c,f.sale,f.buyer,{obligationId:s.obligation!.id,requestId:id(70+s.obligation!.period_number),kind:"token",tokenId:`ctoken_later${s.obligation!.period_number}`})};
}
async function paidPeriod(h:ReturnType<typeof collectionHarness>,period:number){
 await ageToPeriod(period);const prepared=await prepareNextTeamCollection(h.c,f.sale,f.buyer);expect(prepared.view.phase).toBe("needs_method");
 await h.confirm(prepared.saved);const captured=await recordTeamCapture(h.c,f.sale,f.buyer,prepared.saved.obligation!.id);expect(captured.status).toBe("verified");
 if(!("receiptId" in captured))throw Error("Missing fixture receipt");await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,captured.receiptId]);return prepared.saved;
}

test("each accepted fixed installment reaches the shared Library and cumulative commission exactly once",async()=>{
 await fixture();await db.exec("update sales_team_controls_v1 set later_collection_enabled=true,new_sales_enabled=false,access_enabled=false;update sales_team_memberships_v1 set status='removed'");const h=collectionHarness();
 for(const period of [2,3]){const saved=await paidPeriod(h,period);await recordTeamCapture(h.c,f.sale,f.buyer,saved.obligation!.id);expect((await prepareTeamCollection(h.c,f.sale,f.buyer,true,saved.obligation!.id)).view.phase).toBe("paid");}
 expect(await next()).toEqual({status:"complete"});expect(h.posts().filter(([,path])=>path==="/v1/payment_intents")).toHaveLength(2);
 expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_shared_receipts_v1")).rows).toEqual([{n:3}]);
 expect((await db.query("select sum(subtotal_cents)::int amount from sales_team_receipts_v1")).rows).toEqual([{amount:10001}]);expect((await db.query("select sum(earned_cents)::int amount from sales_team_commission_balances_v1")).rows).toEqual([{amount:1000}]);
 expect((await db.query("select paid_count,status,earnings_credited_cents from purchases")).rows).toEqual([{paid_count:3,status:"paid",earnings_credited_cents:7420}]);
 const first=await readTeamCollection(h.c,f.sale,f.buyer);expect(first.attempt?.contract.periodNumber).toBe(1);expect(first.obligation?.id).toBe(f.contract.obligationId);expect(first.confirmation?.request_id).toBe(id(70));expect(first.state?.payment_intent_id).toBe("pi_original");
});

test("an unknown later confirmation drains through independent capture after expiry with every new-money gate off",async()=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");const h=collectionHarness(),prepared=await prepareNextTeamCollection(h.c,f.sale,f.buyer);h.uncertain();
 await expect(h.confirm(prepared.saved)).rejects.toThrow(/reconciliation/i);const count=h.posts().length;
 offset+=25*3600000;await advanceClock(Math.floor(offset));await db.exec("update sales_team_controls_v1 set access_enabled=false,new_sales_enabled=false,later_collection_enabled=false,payment_collection_enabled=false,receipt_recording_enabled=true;update sales_team_payment_runtime_v1 set financial_hold=true");
 expect((await recordTeamCapture(h.c,f.sale,f.buyer,prepared.saved.obligation!.id)).status).toBe("verified");expect(h.posts()).toHaveLength(count);
 expect((await db.query("select covered_periods from sales_team_payment_runtime_v1")).rows).toEqual([{covered_periods:2}]);
});

test("Stop cancels the exact later unpaid intent while retaining the paid sale and first receipt",async()=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");const h=collectionHarness(),prepared=await prepareNextTeamCollection(h.c,f.sale,f.buyer);
 expect((await stopTeamCollection(h.c,f.sale,f.buyer,prepared.saved.obligation!.id)).automaticDebitsStopped).toBe(true);
 expect(h.posts().filter(([,path])=>path.endsWith("/cancel")).map(([,path])=>path)).toEqual(["/v1/payment_intents/pi_later2/cancel"]);
 expect((await db.query("select status from sales_team_sale_requests_v1")).rows).toEqual([{status:"accepted"}]);expect((await db.query("select count(*)::int n from sales_team_payment_closures_v1")).rows).toEqual([{n:0}]);expect((await db.query("select count(*)::int n from sales_team_receipts_v1")).rows).toEqual([{n:1}]);
 await denied(()=>h.confirm(prepared.saved),/reconciliation|RECONCILIATION/i);
});

test.each(["event_reconciliation_enabled","financial_reconciliation_enabled","fulfillment_enabled","receipt_recording_enabled","payment_collection_enabled"])("%s remains required for later money",async control=>{
 await fixture();await ageToPeriod(2);await db.exec(`update sales_team_controls_v1 set later_collection_enabled=true,${control}=false`);await denied(next,/LATER_TEAM_PAYMENT_HELD/);
});
test.each(["event","check"])("a pending %s on a previous receipt holds later money",async kind=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");
 if(kind==="event")await db.query("insert into sales_team_payment_events_v1(event_id,event_type,event_created,sale_id,obligation_id,payment_intent_id,object_id,context) values('evt_prior','charge.updated',$1,$2,$3,'pi_original','ch_original',$4)",[Math.floor(Date.now()/1000),f.sale,f.contract.obligationId,f.contract.context]);
 else await db.query("insert into sales_team_financial_checks_v1(id,receipt_id,context,actor_id) select $1,id,$2,$3 from sales_team_receipts_v1",[id(90),f.contract.context,id(1)]);
 await denied(next,/LATER_TEAM_PAYMENT_HELD/);
});
test.each(["anchor","customer","coverage","capture"])("mutated %s cannot derive authority from runtime alone",async fault=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");
 if(fault==="anchor")await db.exec("update sales_team_payment_runtime_v1 set anchor_at=anchor_at-interval '1 day'");if(fault==="customer")await db.exec("update sales_team_payment_runtime_v1 set customer_id='cus_replacement'");if(fault==="coverage")await db.exec("update sales_team_payment_runtime_v1 set covered_periods=2");if(fault==="capture")await db.exec("set constraints all immediate;alter table sales_team_capture_provenance_v1 disable trigger user;delete from sales_team_capture_provenance_v1");
 await denied(next,/VERIFIED_FIRST_TEAM_PAYMENT_REQUIRED/);
});
test.each(["amount","due"])("a mutated later %s is denied again at intent admission",async fault=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");const second=await next(),o=second.obligation!;
 await db.query(fault==="amount"?"update sales_team_payment_obligations_v1 set amount_cents=amount_cents+1 where id=$1":"update sales_team_payment_obligations_v1 set due_at=due_at-interval '1 day' where id=$1",[o.id]);
 const scope:TeamOperationScope={scopeId:f.sale,saleId:f.sale,creatorId:id(1),actorId:f.buyer,kind:"intent",scopeKey:`intent:${o.id}`},contract:TeamPaymentContract={...f.contract,obligationId:o.id,periodNumber:2,operationId:teamOperationId(scope),amountCents:o.amount_cents,expiresAt:Math.floor(Date.parse(second.collection_expires_at!)/1000)};
 await denied(()=>f.rpc("reserve_sales_team_period_intent_v1",[f.sale,f.buyer,contract.operationId,contract,teamIntentRequest(contract,f.evidence),o.id]),/TEAM_PAYMENT_COLLECTION_HELD/);
});

test.each([{minimumMonths:1,autoRenew:true},{minimumMonths:3,autoRenew:false}])("accepted monthly terms control each collection and commission: %j",async terms=>{
 await fixture(terms);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");const h=collectionHarness();
 for(const period of [2,3])await paidPeriod(h,period);
 if(terms.autoRenew){await paidPeriod(h,4);expect((await db.query("select sum(earned_cents)::int amount from sales_team_commission_balances_v1")).rows).toEqual([{amount:1000}]);}
 else{expect(await next()).toEqual({status:"complete"});expect((await db.query("select sum(earned_cents)::int amount from sales_team_commission_balances_v1")).rows).toEqual([{amount:3000}]);}
});

async function reservedLater(){
 const second=await next(),o=second.obligation!,scope:TeamOperationScope={scopeId:f.sale,saleId:f.sale,creatorId:id(1),actorId:f.buyer,kind:"intent",scopeKey:`intent:${o.id}`,workerRunId:null};
 const contract:TeamPaymentContract={...f.contract,obligationId:o.id,periodNumber:o.period_number,operationId:teamOperationId(scope),amountCents:o.amount_cents,expiresAt:Math.floor(Date.parse(second.collection_expires_at!)/1000)},request=teamIntentRequest(contract,f.evidence);
 await f.rpc("reserve_sales_team_period_intent_v1",[f.sale,f.buyer,contract.operationId,contract,request,o.id]);return {second,scope,contract,request};
}
test.each(["later_collection_enabled","event_reconciliation_enabled","financial_reconciliation_enabled","stop","anchor","amount"])("%s loss after claim blocks the actual later dispatch assertion",async fault=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");const t=await reservedLater(),claim=await f.rpc<{operation:{lease_token:string}}>("claim_sales_team_provider_operation_v1",[t.contract.operationId,t.scope,f.contract.context,t.request]);
 if(fault.endsWith("enabled"))await db.exec(`update sales_team_controls_v1 set ${fault}=false`);if(fault==="stop")await f.rpc("stop_sales_team_payment_v1",[f.sale,f.buyer]);if(fault==="anchor")await db.exec("update sales_team_payment_runtime_v1 set anchor_at=anchor_at-interval '1 day'");if(fault==="amount")await db.query("update sales_team_payment_obligations_v1 set amount_cents=amount_cents+1 where id=$1",[t.contract.obligationId]);
 await denied(()=>f.rpc("assert_sales_team_provider_dispatch_v1",[t.contract.operationId,claim.operation.lease_token]),/NO_LONGER_ADMITTED/);
});
test("expired never-journaled periods retain the frozen window and cannot silently extend or dispatch",async()=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");const second=await next(),h=collectionHarness();offset+=25*3600000;await advanceClock(Math.floor(offset));
 expect((await next()).collection_expires_at).toBe(second.collection_expires_at);await denied(()=>prepareTeamCollection(h.c,f.sale,f.buyer,true,second.obligation!.id),/TEAM_PAYMENT_COLLECTION_HELD/);expect(h.posts()).toHaveLength(0);
 expect((await db.query("select count(*)::int n from sales_team_later_payment_windows_v1")).rows).toEqual([{n:1}]);
});
test("a late control loss rolls back the whole newly derived obligation and window",async()=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true;create function public.hold_fixture_later_window() returns trigger language plpgsql as $$begin update public.sales_team_controls_v1 set financial_reconciliation_enabled=false;return new;end$$;create trigger hold_fixture_later_window after insert on sales_team_later_payment_windows_v1 for each row execute function public.hold_fixture_later_window()");
 await denied(next,/LATER_TEAM_PAYMENT_HELD/);expect((await db.query("select count(*)::int n from sales_team_payment_obligations_v1")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_later_payment_windows_v1")).rows).toEqual([{n:0}]);
});
test("read-only overview retains the exact pending later original after Stop or expiry",async()=>{
 await fixture();const overview=()=>f.rpc<{payment:TeamCollection;nextPayment?:{status:string}}>("read_sales_team_collection_overview_v1",[f.sale,f.buyer]);expect((await overview()).nextPayment?.status).toBe("not_due");
 await ageToPeriod(2);expect((await overview()).nextPayment?.status).toBe("due");await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");const second=await next();await f.rpc("stop_sales_team_payment_v1",[f.sale,f.buyer]);offset+=25*3600000;await advanceClock(Math.floor(offset));
 expect((await overview()).payment.obligation?.id).toBe(second.obligation!.id);expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1")).rows).toEqual([{n:3}]);
});
test("the first confirmation and history retain period one when later attempts coexist",async()=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");await reservedLater();
 expect(await f.rpc("reserve_sales_team_confirmation_v1",[f.sale,f.buyer,id(70),f.confirmationId,"token",f.base.confirmation.tokenProof,f.base.confirmation.request])).toMatchObject({obligation_id:f.contract.obligationId,operation_id:f.confirmationId});
 const first=await f.rpc<TeamCollection>("read_sales_team_payment_v1",[f.sale,f.buyer]);expect(first.attempt?.contract.periodNumber).toBe(1);expect(first.confirmation?.operation_id).toBe(f.confirmationId);expect(first.state?.payment_intent_id).toBe("pi_original");
});
test("a later confirmation request cannot reuse a different period's identity",async()=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");const h=collectionHarness(),prepared=await prepareNextTeamCollection(h.c,f.sale,f.buyer);
 await denied(()=>confirmTeamCollection(h.c,f.sale,f.buyer,{requestId:id(70),kind:"token",tokenId:"ctoken_later2",obligationId:prepared.saved.obligation!.id}),/ORIGINAL_TEAM_CONFIRMATION_CHANGED/);expect(h.posts().filter(([,path])=>path.endsWith("/confirm"))).toHaveLength(0);
});
test.each(["scopeId","creatorId","actorId","workerRunId"])("later admission rejects a changed %s",async field=>{
 await fixture();await ageToPeriod(2);await db.exec("update sales_team_controls_v1 set later_collection_enabled=true");const t=await reservedLater();expect(await f.rpc("sales_team_operation_admitted_v1",[{...t.scope,[field]:id(11)},f.contract.context])).toBe(false);
});
const digests=async()=>(await db.query<Record<string,string>>("select creatornet_team_private.transfer_contract_digest_v1() transfer,creatornet_team_private.shared_cash_contract_digest_v1() shared,creatornet_team_private.retained_cash_contract_digest_v1() retained,creatornet_team_private.recovery_contract_digest_v1() recovery")).rows[0];
test.each(["creatornet_team_private.later_payment_schedule_v1(uuid)","creatornet_team_private.later_payment_admitted_v1(uuid,jsonb)","public.read_sales_team_collection_overview_v1(uuid,uuid)","public.reserve_sales_team_period_confirmation_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb,uuid)"])("all reviewed digests bind named later authority %s",async signature=>{
 const before=await digests(),source=(await db.query<{s:string}>("select pg_get_functiondef($1::regprocedure) s",[signature])).rows[0].s,changed=source.replace(/AS \$function\$/i,"AS $function$\n-- synthetic reviewed source mutation\n");expect(changed).not.toBe(source);await db.exec(changed);const after=await digests();for(const name of Object.keys(before))expect(after[name]).not.toBe(before[name]);
});
test.each(["dependency","late_grant"])("%s failure rolls back the complete F35 candidate",async fault=>{
 const isolated=createLocalPostgres();try{
  await sharedCashDatabase(isolated);for(const path of predecessors)await isolated.exec(readFileSync(path,"utf8"));
  if(fault==="dependency")await isolated.exec("alter function public.reserve_sales_team_intent_v1(uuid,uuid,uuid,jsonb,jsonb) rename to fixture_missing_later_intent_dependency");
  const names=['public.reserve_sales_team_confirmation_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb)','public.sales_team_operation_admitted_before_refund_v1(jsonb,jsonb)','public.close_unpaid_sales_team_payment_v1(uuid,uuid,jsonb)','public.read_sales_team_payment_before_fulfillment_v1(uuid,uuid)','public.sales_team_operation_admitted_v1(jsonb,jsonb)','creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'];
  const inventory=async()=>(await isolated.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proacl::text grants from pg_proc where oid=any($1::regprocedure[]) order by oid",[names])).rows,before=await inventory();
  const source=readFileSync(candidate,"utf8"),sql=fault==="late_grant"?source.replace("commit;","grant execute on function public.missing_later_final_grant() to service_role;commit;"):source;
  await expect(isolated.exec(sql)).rejects.toThrow(fault==="dependency"?/reserve_sales_team_intent_v1/:/missing_later_final_grant/);await isolated.exec("rollback");expect(await inventory()).toEqual(before);
  expect((await isolated.query("select to_regclass('public.sales_team_later_payment_windows_v1') relation,exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_team_controls_v1' and column_name='later_collection_enabled') control")).rows).toEqual([{relation:null,control:false}]);
 }finally{await isolated.close();}
},30000);
