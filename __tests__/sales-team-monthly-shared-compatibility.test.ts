/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {captureRpc as rpc,seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {enableTeamSalesFixture,approveTeamOffer,draftTeamSale} from "@/test-support/sales-team-sale-postgres";
import {teamCaptureFixture} from "@/test-support/sales-team-capture-fixture";
import {monthlySharedAccountingDatabase,monthlySharedReady,enableMonthlySharedFixture,seedMonthlySharedCapture,installedMonthlyGuardSha256,discoverLossCandidate,mirrorDiscoverSecurityFixture,installDiscoverLossFixture} from "@/test-support/sales-team-monthly-shared-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {sharedLifecycleFixture} from "@/test-support/sales-team-shared-lifecycle-fixture";
import {membershipMonthBoundary} from "@/lib/membershipAgreement";
import {recordTeamCapture} from "@/lib/salesTeams/receipts";
import {inspectTeamReceiptFinancials,reviewTeamRefundResponsibility} from "@/lib/salesTeams/financialChecks";
import {teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import type {TeamCollection} from "@/lib/salesTeams/collection";
import type {TeamPaymentContract,TeamTokenProof} from "@/lib/salesTeams/paymentProtocol";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
let advanceClock:(ms:number)=>Promise<void>;
const realNow=Date.now.bind(Date);
const controls="update sales_team_controls_v1 set fulfillment_enabled=true,event_reconciliation_enabled=true,financial_reconciliation_enabled=true";
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{
 await db.exec("savepoint denied");
 try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}
};
type Dispatch={status:string;operation:{lease_token:string}};
beforeAll(async()=>{db=createLocalPostgres();advanceClock=await installTeamLocalClock(db);await monthlySharedAccountingDatabase(db);await installDiscoverLossFixture(db);},30000);
beforeEach(async()=>{await db.exec("begin");});
afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});
afterAll(async()=>{await db?.close();});
async function customer(){
 await enableTeamSalesFixture(db);
 await db.exec(controls+`;update products set type='mentorship',membership_terms='{"version":"monthly-mentorship-v1","minimumMonths":1,"autoRenew":true}'`);
 const offer=await approveTeamOffer(db),draft=await draftTeamSale(db,offer.options.find(o=>o.kind==="monthly")!.id);
 const sale=draft.saleId,buyer=id(10),context=draft.source.financialConfig.context;
 await rpc(db,"accept_sales_team_sale_v1",[sale,buyer,draft.quote.fingerprint,true]);
 await db.exec("update sales_team_controls_v1 set payment_collection_enabled=true,receipt_recording_enabled=true");
 const scope:TeamOperationScope={scopeId:sale,saleId:sale,creatorId:id(1),actorId:buyer,kind:"customer",scopeKey:"customer:v1",workerRunId:null},operation=teamOperationId(scope);
 await rpc(db,"reserve_sales_team_customer_v1",[sale,buyer,operation,context]);
 const saved=await rpc<TeamCollection>(db,"read_sales_team_payment_v1",[sale,buyer]);
 return {operation,claim:()=>rpc<Dispatch>(db,"claim_sales_team_provider_operation_v1",[operation,scope,context,saved.setup!.customer_request])};
}
async function fulfilled(){
 await enableMonthlySharedFixture(db);await db.exec(controls);
 const f=await seedMonthlySharedCapture(db),receipt=await f.record();
 const result=await f.rpc<{purchaseId:string;recorded:boolean}>("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id]);
 const row=(await db.query<{v:Record<string,unknown>}>("select to_jsonb(p) v from purchases p where id=$1",[result.purchaseId])).rows[0].v;
 return {f,receipt,result,row};
}
test("installation is disabled and cannot enroll a new monthly provider operation",async()=>{
 expect(await monthlySharedReady(db)).toBe(false);const p=await customer();
 expect(await p.claim()).toMatchObject({status:"not_enabled"});
 expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1")).rows).toEqual([{n:0}]);
});
test("final dispatch holds on authority loss while unknown/bound original reconciliation survives",async()=>{
 const p=await customer();await enableMonthlySharedFixture(db);const claimed=await p.claim();expect(claimed.status).toBe("dispatch");
 await db.exec("update sales_team_monthly_shared_policy_v1 set enabled=false");
 await denied(()=>rpc(db,"assert_sales_team_provider_dispatch_v1",[p.operation,claimed.operation.lease_token]),/PROVIDER_DISPATCH_NO_LONGER_ADMITTED/);
 await rpc(db,"mark_sales_team_provider_unknown_v1",[p.operation,claimed.operation.lease_token]);
 expect(await p.claim()).toMatchObject({status:"reconciliation_required"});
 await rpc(db,"bind_sales_team_provider_operation_v1",[p.operation,"cus_original","req_reconciled",true]);
 expect(await p.claim()).toMatchObject({status:"bound"});
});
test("an actual confirmation reservation needs authority at claim and final pre-POST assertion",async()=>{
 await enableMonthlySharedFixture(db);await db.exec(controls);
 let staged:{contract:TeamPaymentContract;proof:TeamTokenProof}|undefined;
 await expect(seedTeamCapture(db,{paymentKind:"monthly",beforeApproval:async()=>{await db.query("update products set type='mentorship',membership_terms=$1",[{version:"monthly-mentorship-v1",minimumMonths:1,autoRenew:true}]);},beforeConfirmation:async(contract,proof)=>{
  staged={contract,proof};throw Error("PAUSED_FOR_CONFIRMATION_GATE_TEST");
 }})).rejects.toThrow("PAUSED_FOR_CONFIRMATION_GATE_TEST");
 const {contract:c,proof}=staged!,scope:TeamOperationScope={scopeId:c.saleId,saleId:c.saleId,creatorId:c.terms.creatorId,actorId:c.terms.buyerId,kind:"confirmation",scopeKey:"confirm:"+id(70),workerRunId:null};
 const operation=teamOperationId(scope),request=teamCaptureFixture(c).confirmation.request;
 await rpc(db,"reserve_sales_team_confirmation_v1",[c.saleId,c.terms.buyerId,id(70),operation,"token",proof,request]);
 const claim=()=>rpc<Dispatch>(db,"claim_sales_team_provider_operation_v1",[operation,scope,c.context,request]);
 await db.exec("update sales_team_monthly_shared_policy_v1 set enabled=false");expect(await claim()).toMatchObject({status:"not_enabled"});
 expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where id=$1",[operation])).rows).toEqual([{n:0}]);
 await enableMonthlySharedFixture(db);const dispatch=await claim();expect(dispatch.status).toBe("dispatch");
 await db.exec("update sales_team_monthly_shared_policy_v1 set enabled=false");
 await denied(()=>rpc(db,"assert_sales_team_provider_dispatch_v1",[operation,dispatch.operation.lease_token]),/PROVIDER_DISPATCH_NO_LONGER_ADMITTED/);
});
test("the pinned installed guard reproduces the blocker with no shared effects or lost receipt",async()=>{
 await enableMonthlySharedFixture(db);await db.exec(controls);const f=await seedMonthlySharedCapture(db),r=await f.record();
 await db.exec("update sales_team_monthly_shared_policy_v1 set enabled=false");
 await denied(()=>f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,r.id]),/Monthly offer requires its owned membership purchase/);
 for(const table of ["purchases","orders","sales_team_shared_receipts_v1"])expect((await db.query(`select count(*)::int n from ${table}`)).rows).toEqual([{n:0}]);
 expect((await db.query("select count(*)::int n from sales_team_receipts_v1")).rows).toEqual([{n:1}]);
 await enableMonthlySharedFixture(db);expect(await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,r.id])).toMatchObject({recorded:true});
});
test("verified same-receipt Library fulfillment is idempotent without legacy identity or entitlement flags",async()=>{
 const {f,receipt,result,row}=await fulfilled();expect(result.recorded).toBe(true);
 expect(row).toMatchObject({monthly_mentorship_id:null,access_granted:false,kind:"creatornet_team_v1"});
 expect(await f.rpc("read_sales_team_entitlement_v1",[result.purchaseId,f.buyer])).toMatchObject({allowed:true});
 expect(await f.rpc("read_sales_team_entitlement_v1",[result.purchaseId,id(11)])).toMatchObject({allowed:false});
 expect(await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id])).toMatchObject({recorded:false});
 expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:1}]);
});
test("every original identity field is required and fabricated purchases remain rejected",async()=>{
 const {row}=await fulfilled();
 const qualifies=async(value:Record<string,unknown>)=>(await db.query<{v:boolean}>("select creatornet_team_private.team_monthly_shared_purchase_v1($1) v",[value])).rows[0].v;
 expect(await qualifies(row)).toBe(true);
 for(const [field,value] of Object.entries({id:id(9999),sales_team_sale_id:id(9998),order_id:id(9997),buyer_id:id(11),buyer_user_id:id(11),creator_id:id(11),product_id:id(9997),post_id:id(9997),booking_id:id(9997),payment_intent_id:"pi_foreign",amount_cents:1,currency:"eur",access_granted:true,kind:"monthly_mentorship_v1",monthly_mentorship_id:id(9997),subscription_id:"sub_foreign"})){
  expect(await qualifies({...row,[field]:value})).toBe(false);
 }
 await denied(()=>db.query("insert into purchases select (jsonb_populate_record(null::public.purchases,$1)).*",[{...row,id:id(9999)}]),/Monthly offer requires its owned membership purchase/);
});
test("legitimate legacy monthly identity stays guarded and cannot be adopted as team history",async()=>{
 const {row}=await fulfilled();
 await db.query("insert into monthly_mentorship_agreements_v1(id,purchase_id,buyer_id,creator_id,product_id,post_id) values($1,$2,$3,$4,$5,$6)",[id(9000),id(9001),id(11),row.creator_id,row.product_id,row.post_id]);
 const legacy={...row,id:id(9001),buyer_id:id(11),buyer_user_id:id(11),sales_team_sale_id:null,monthly_mentorship_id:id(9000),kind:"monthly_mentorship_v1",status:"pending",paid_at:null,earnings_credited_at:null,earnings_credited_cents:0,paid_count:0,payment_intent_id:null,booking_id:null,order_id:null,subscription_id:null};
 await db.query("insert into purchases select (jsonb_populate_record(null::public.purchases,$1)).*",[legacy]);
 await denied(()=>db.query("update purchases set access_granted=true where id=$1",[legacy.id]),/Monthly service cannot use legacy ownership/);
 // The combined installed-trigger fixture rejects this mutation in the earlier
 // initial-close guard, before the original monthly guard can run.
 await denied(()=>db.query("update purchases set monthly_mentorship_id=$1 where id=$2",[id(9002),legacy.id]),/Initial close-out purchase identity differs/);
 const columns=Object.keys(row).sort();expect(columns.every(k=>/^[a-z_]+$/.test(k))).toBe(true);
 await denied(()=>db.query(`update purchases set (${columns.map(k=>'"'+k+'"').join(",")})=(select ${columns.map(k=>'v."'+k+'"').join(",")} from jsonb_populate_record(null::public.purchases,$1) v) where id=$2`,[row,legacy.id]),/ORIGINAL_TEAM_ACCOUNTING_CHANGED/);
 expect((await db.query("select id,monthly_mentorship_id from purchases where id=$1",[legacy.id])).rows).toEqual([{id:legacy.id,monthly_mentorship_id:legacy.monthly_mentorship_id}]);
});
test.each(["sales_team_purchase_guard_v1","zz_team_monthly_shared_fence_v1"])("disabling %s invalidates monthly authority",async trigger=>{
 await enableMonthlySharedFixture(db);expect(await monthlySharedReady(db)).toBe(true);
 await db.exec(`alter table purchases disable trigger ${trigger}`);expect(await monthlySharedReady(db)).toBe(false);
});
test("non-monthly fulfillment remains available with the compatibility policy disabled",async()=>{
 await db.exec(controls);const f=await seedTeamCapture(db),r=await f.record();
 expect(await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,r.id])).toMatchObject({recorded:true});
 expect(await monthlySharedReady(db)).toBe(false);
});
test("the exact legacy guard body and private privileges are preserved",async()=>{
 expect((await db.query("select encode(sha256(convert_to(pg_get_functiondef('public.guard_monthly_mentorship_purchase_v1()'::regprocedure),'UTF8')),'hex') digest")).rows).toEqual([{digest:installedMonthlyGuardSha256}]);
 for(const role of ["anon","authenticated","service_role"]){
  expect((await db.query("select has_function_privilege($1,'public.guard_monthly_mentorship_purchase_v1()','EXECUTE') allowed",[role])).rows).toEqual([{allowed:false}]);
 }
});
test.each(["anon","authenticated"])("%s cannot read policy or call private authority",async role=>{
 await db.exec(`set role ${role}`);
 await denied(()=>db.exec("select * from sales_team_monthly_shared_policy_v1"),/permission denied/);
 await denied(()=>monthlySharedReady(db),/permission denied/);
});
test("service role cannot enable policy or change its digest",async()=>{
 await db.exec("set role service_role");
 await denied(()=>enableMonthlySharedFixture(db),/permission denied/);
});

type Lifecycle=Awaited<ReturnType<typeof lifecycle>>;
async function lifecycle(kind:"installments"|"monthly"){
 await enableMonthlySharedFixture(db);await db.exec(controls+";update sales_team_controls_v1 set later_collection_enabled=true,refund_review_enabled=true");
 await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 const f=await (kind==="monthly"?seedMonthlySharedCapture(db):seedTeamCapture(db)),first=await f.record();
 const original=await f.rpc<{purchaseId:string}>("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,first.id]),h=sharedLifecycleFixture(db,f);
 const identity=async()=>(await db.query("select p.id,p.order_id,p.payment_intent_id,p.monthly_mentorship_id,p.fixed_service_consent_id,p.kind,p.access_granted,d.* from purchases p join purchase_deliveries d on d.purchase_id=p.id where p.id=$1",[original.purchaseId])).rows;
 const frozen=await identity(),receipts=[String(first.id)],obligations=[f.contract.obligationId];
 const milestoneIdentity=async()=>(await db.query("select id,entity_key,occurred_at,post_id,creator_id,user_id from discover_events_v1 where entity_key=$1",["purchase:"+original.purchaseId])).rows;
 const frozenMilestone=await milestoneIdentity();
 const anchor=Number((await db.query<{s:number}>("select extract(epoch from anchor_at) s from sales_team_payment_runtime_v1 where sale_id=$1",[f.sale])).rows[0].s);
 for(const period of [2,3]){
  const offset=membershipMonthBoundary(anchor,period-1)*1000-realNow()+1000;
  jest.spyOn(Date,"now").mockImplementation(()=>realNow()+offset);await advanceClock(Math.floor(offset));
  const later=await h.later();receipts.push(later.receiptId);obligations.push(later.obligationId);
  await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,later.receiptId]);
 }
 return {f,h,receipts,obligations,purchaseId:original.purchaseId,identity,frozen,milestoneIdentity,frozenMilestone};
}
async function state(s:Lifecycle,earnings:number,commission:number[],discover:number,allowed=true){
 expect(await s.identity()).toEqual(s.frozen);
 expect(await s.milestoneIdentity()).toEqual(s.frozenMilestone);
 expect((await db.query("select count(*)::int purchases from purchases")).rows).toEqual([{purchases:1}]);
 expect((await db.query("select count(*)::int receipts,count(distinct order_id)::int orders,count(distinct ledger_id)::int ledgers from sales_team_shared_receipts_v1")).rows).toEqual([{receipts:3,orders:3,ledgers:3}]);
 expect((await db.query("select total_earnings_cents::int earnings from profiles where id=$1",[s.f.contract.terms.creatorId])).rows).toEqual([{earnings}]);
 expect((await db.query("select earnings_credited_cents::int earnings,paid_count from purchases")).rows).toEqual([{earnings,paid_count:3}]);
 expect((await db.query<{earned:number}>("select c.earned_cents::int earned from sales_team_commission_balances_v1 c join sales_team_receipts_v1 r on r.id=c.receipt_id join sales_team_payment_obligations_v1 o on o.id=r.obligation_id order by o.period_number")).rows.map(r=>r.earned)).toEqual(commission);
 expect((await db.query("select sum(booked_net_cents)::int earnings from sales_team_shared_receipts_v1")).rows).toEqual([{earnings}]);
 expect((await db.query("select sum(creator_net_cents)::int earnings from payment_fee_ledger")).rows).toEqual([{earnings}]);
 const milestone=(await db.query("select amount_cents::int amount,valid from discover_events_v1 where entity_key=$1",["purchase:"+s.purchaseId])).rows;
 expect(milestone).toEqual([{amount:discover,valid:discover>0}]);
 expect((await db.query("select count(*)::int n from discover_events_v1")).rows).toEqual([{n:1}]);
 expect((await db.query("select purchase_count from posts where id=$1",[s.f.contract.terms.postId])).rows).toEqual([{purchase_count:discover===0?0:1}]);
 expect(await s.f.rpc("read_sales_team_entitlement_v1",[s.purchaseId,s.f.buyer])).toMatchObject({allowed});
}
const initial={installments:{earnings:7420,commission:[333,334,333],gross:10001},monthly:{earnings:25022,commission:[1000,0,0],gross:30003}};
test.each(["installments","monthly"] as const)("combined %s later receipts preserve Library identity and count every cent once",async kind=>{
 const s=await lifecycle(kind),expected=initial[kind];await state(s,expected.earnings,expected.commission,expected.gross);
 const before=(await db.query("select * from sales_team_financial_ledger_v1 order by id")).rows;
 await db.exec("set role service_role");
 for(let i=0;i<3;i++){
  await recordTeamCapture(s.h.c,s.f.sale,s.f.buyer,s.obligations[i]);
  expect(await s.f.rpc("fulfill_sales_team_receipt_v1",[s.f.sale,s.f.buyer,s.receipts[i]])).toMatchObject({recorded:false,purchaseId:s.purchaseId});
 }
 expect((await db.query("select * from sales_team_financial_ledger_v1 order by id")).rows).toEqual(before);
 await state(s,expected.earnings,expected.commission,expected.gross);
 const ledger=(await db.query<{id:string}>("select id from payment_fee_ledger limit 1")).rows[0].id;
 for(const [name,args] of [["credit_purchase_earnings",[s.purchaseId,1]],["reverse_purchase_earnings",[s.purchaseId]],["credit_payment_fee_ledger_earnings",[ledger]],["apply_purchase_refund_earnings",[s.purchaseId,1]],["apply_payment_fee_ledger_refund",[ledger,1]]] as const){
  await denied(()=>s.f.rpc(name,[...args]),/TEAM_EARNINGS_REQUIRE_OWN_ACCOUNTING|TEAM_FINANCIAL_RECONCILIATION_REQUIRED/);
 }
 await state(s,expected.earnings,expected.commission,expected.gross);
});
function auxiliary(s:Lifecycle,key:string,owner:string,kind:string,amount:number){
 const stamp=Math.floor(Date.now()/1000);
 s.h.objects.set(key,{id:key,object:"balance_transaction",source:owner,type:kind.startsWith("dispute")?"adjustment":kind,reporting_category:kind,currency:"usd",exchange_rate:null,amount,fee:0,net:amount,created:stamp,available_on:stamp,status:"available",fee_details:[]});
}
async function refund(s:Lifecycle,period:number,amount:number,n:number){
 const chargeId=period===1?"ch_original":`ch_combined${period}`,paymentIntentId=period===1?"pi_original":`pi_combined${period}`,key=`re_combined${n}`,balance=`txn_refund${n}`;
 const charge=s.h.objects.get(chargeId) as {amount:number;amount_refunded:number;refunded:boolean};charge.amount_refunded+=amount;charge.refunded=charge.amount_refunded===charge.amount;
 const r={id:key,object:"refund",charge:chargeId,payment_intent:paymentIntentId,currency:"usd",amount,status:"succeeded",created:Math.floor(Date.now()/1000),balance_transaction:balance,failure_balance_transaction:null,transfer_reversal:null,source_transfer_reversal:null};
 s.h.refunds.push(r);s.h.objects.set(key,r);auxiliary(s,balance,key,"refund",-amount);
 const receiptId=s.receipts[period-1];expect(await inspectTeamReceiptFinancials(s.h.c,receiptId,id(29))).toMatchObject({held:true});
 const revision=(await db.query<{v:number}>("select observation_revision v from sales_team_receipts_v1 where id=$1",[receiptId])).rows[0].v;
 await reviewTeamRefundResponsibility(s.h.c,{actorId:id(29),receiptId,requestId:id(800+n),expectedRevision:revision,refundId:key,responsibility:"creator",reasonCode:"creator_discretionary"});
 expect(await inspectTeamReceiptFinancials(s.h.c,receiptId,id(29))).toMatchObject({held:false});
}
test.each(["installments","monthly"] as const)("combined %s partial then full refunds preserve cumulative accounting and one Discover milestone",async kind=>{
 const s=await lifecycle(kind),gross=kind==="installments"?[3333,3333,3335]:[10001,10001,10001];
 await refund(s,2,1000,1);await state(s,kind==="installments"?6640:24142,kind==="installments"?[333,234,333]:[1000,0,0],initial[kind].gross-1000);
 await refund(s,2,gross[1]-1000,2);await state(s,kind==="installments"?4947:16348,kind==="installments"?[333,0,334]:[1000,0,0],gross[0]+gross[2]);
 await refund(s,1,gross[0],3);await refund(s,3,gross[2],4);await state(s,0,[0,0,0],0,false);
 expect((await db.query("select status from purchases")).rows).toEqual([{status:"refunded"}]);
 expect((await db.query("select sum(team_creator_deficit_cents)::int deficit from payment_fee_ledger")).rows).toEqual([{deficit:381}]);
 const reads=s.h.raw.mock.calls.length;
 for(const receiptId of s.receipts){await inspectTeamReceiptFinancials(s.h.c,receiptId,id(29));await s.f.rpc("fulfill_sales_team_receipt_v1",[s.f.sale,s.f.buyer,receiptId]);}
 expect(s.h.raw.mock.calls.slice(reads).every(([method])=>method==="GET")).toBe(true);
 await state(s,0,[0,0,0],0,false);
});
test.each((["installments","monthly"] as const).flatMap(kind=>(["won","lost"] as const).map(outcome=>({kind,outcome}))))("combined $kind later dispute $outcome holds access and preserves original identities",async({kind,outcome})=>{
 const s=await lifecycle(kind),amount=kind==="installments"?3333:10001,key="du_combined2",receiptId=s.receipts[1];
 (s.h.objects.get("ch_combined2") as {disputed:boolean}).disputed=true;
 const dispute={id:key,object:"dispute",livemode:false,charge:"ch_combined2",payment_intent:"pi_combined2",currency:"usd",amount,status:"under_review",created:Math.floor(Date.now()/1000),balance_transactions:[{id:"txn_withdraw2"}]};
 s.h.disputes.push(dispute);auxiliary(s,"txn_withdraw2",key,"dispute",-amount);
 expect(await inspectTeamReceiptFinancials(s.h.c,receiptId,id(29))).toMatchObject({held:true});
 const expected=initial[kind];await state(s,expected.earnings,expected.commission,expected.gross,false);
 dispute.status=outcome;
 if(outcome==="won"){dispute.balance_transactions.push({id:"txn_restore2"});auxiliary(s,"txn_restore2",key,"dispute_reversal",amount);}
 expect(await inspectTeamReceiptFinancials(s.h.c,receiptId,id(29))).toMatchObject({held:false});
 await state(s,outcome==="won"?expected.earnings:kind==="installments"?4947:16348,outcome==="won"?expected.commission:kind==="installments"?[333,0,334]:[1000,0,0],outcome==="won"?expected.gross:expected.gross-amount,outcome==="won");
 if(outcome==="lost")expect((await db.query("select team_loss_subtotal_cents::int loss,refunded_amount_cents::int refund from payment_fee_ledger where sales_team_receipt_id=$1",[receiptId])).rows).toEqual([{loss:amount,refund:0}]);
 const before=(await db.query("select sum(booked_net_cents)::int n from sales_team_shared_receipts_v1")).rows;
 await inspectTeamReceiptFinancials(s.h.c,receiptId,id(29));expect((await db.query("select sum(booked_net_cents)::int n from sales_team_shared_receipts_v1")).rows).toEqual(before);
});

async function lost(s:Lifecycle,period:number,amount:number){
 const charge=period===1?"ch_original":`ch_combined${period}`,intent=period===1?"pi_original":`pi_combined${period}`,key=`du_loss${period}`,balance=`txn_loss${period}`;
 (s.h.objects.get(charge) as {disputed:boolean}).disputed=true;
 s.h.disputes.push({id:key,object:"dispute",livemode:false,charge,payment_intent:intent,currency:"usd",amount,status:"lost",created:Math.floor(Date.now()/1000),balance_transactions:[{id:balance}]});
 auxiliary(s,balance,key,"dispute",-amount);
 expect(await inspectTeamReceiptFinancials(s.h.c,s.receipts[period-1],id(29))).toMatchObject({held:false});
}
async function financialRows(){
 const result:Record<string,unknown>={};
 for(const table of ["purchases","orders","payment_fee_ledger","sales_team_receipts_v1","sales_team_commission_balances_v1","sales_team_creator_balances_v1","sales_team_shared_receipts_v1","profiles","posts"]){
  result[table]=(await db.query(`select to_jsonb(t) v from public.${table} t order by to_jsonb(t)::text`)).rows;
 }
 return result;
}
test.each(["installments","monthly"] as const)("F54 %s partial loss projects retained principal without financial writes or duplicate milestones",async kind=>{
 const s=await lifecycle(kind),earnings=kind==="installments"?6640:24142,commission=kind==="installments"?[333,234,333]:[1000,0,0];
 await lost(s,2,1000);await state(s,kind==="installments"?6640:24142,kind==="installments"?[333,234,333]:[1000,0,0],initial[kind].gross-1000,false);
 const before=await financialRows();
 const ledgers=(await db.query<{id:string}>("select id from payment_fee_ledger order by id")).rows;
 await db.exec("set role service_role");
 for(let repeat=0;repeat<2;repeat++)for(const ledger of ledgers)await db.query("select public.reconcile_discover_sale_v1($1)",[ledger.id]);
 expect(await financialRows()).toEqual(before);await state(s,earnings,commission,initial[kind].gross-1000,false);
});
test.each(["installments","monthly"] as const)("F54 %s all receipts lost invalidate the original milestone and decrease the post counter once",async kind=>{
 const s=await lifecycle(kind),gross=kind==="installments"?[3333,3333,3335]:[10001,10001,10001];
 for(const period of [1,2,3])await lost(s,period,gross[period-1]);
 await state(s,0,[0,0,0],0,false);
 const before=await financialRows();
 for(const ledger of (await db.query<{id:string}>("select id from payment_fee_ledger")).rows)await db.query("select public.reconcile_discover_sale_v1($1)",[ledger.id]);
 expect(await financialRows()).toEqual(before);await state(s,0,[0,0,0],0,false);
});
test.each((["installments","monthly"] as const).flatMap(kind=>[true,false].map(refundFirst=>({kind,refundFirst}))))("F54 $kind refund-first=$refundFirst subtracts the combined loss once",async({kind,refundFirst})=>{
 const s=await lifecycle(kind);
 if(refundFirst)await refund(s,2,1000,1);
 await lost(s,2,1500);
 if(!refundFirst)await refund(s,2,1000,1);
 expect((await db.query("select refunded_amount_cents::int refunded,team_loss_subtotal_cents::int loss from payment_fee_ledger where sales_team_receipt_id=$1",[s.receipts[1]])).rows).toEqual([{refunded:1000,loss:2500}]);
 await state(s,kind==="installments"?5470:22822,kind==="installments"?[333,84,333]:[1000,0,0],initial[kind].gross-2500,false);
});
test("F54 retains ordinary legacy refunds/disputes/nonpaid behavior and browser privilege boundaries",async()=>{
 const s=await lifecycle("installments"),purchase=id(9600),ledger=id(9601);
 await db.query("insert into purchases(id,buyer_id,buyer_user_id,creator_id,product_id,post_id,amount_cents,currency,status,access_granted) values($1,$2,$2,$3,$4,$5,1000,'usd','paid',true)",[purchase,id(11),id(1),id(21),s.f.contract.terms.postId]);
 await db.query("insert into payment_fee_ledger(id,creator_id,purchase_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version,status) values($1,$2,$3,1000,120,30,150,850,'usd','legacy','paid')",[ledger,id(1),purchase]);
 const projection=async()=>(await db.query("select amount_cents::int amount,valid from discover_events_v1 where entity_key=$1",["purchase:"+purchase])).rows;
 const identity=(await db.query("select id,occurred_at from discover_events_v1 where entity_key=$1",["purchase:"+purchase])).rows;
 expect(await projection()).toEqual([{amount:1000,valid:true}]);
 await db.query("update payment_fee_ledger set refunded_amount_cents=200,earnings_reversed_cents=170,platform_fee_refund_attribution_cents=24,processing_fee_refund_attribution_cents=6 where id=$1",[ledger]);expect(await projection()).toEqual([{amount:800,valid:true}]);
 await db.query("update payment_fee_ledger set disputed_amount_cents=1000 where id=$1",[ledger]);expect(await projection()).toEqual([{amount:0,valid:false}]);
 await db.query("update payment_fee_ledger set disputed_amount_cents=0,status='pending' where id=$1",[ledger]);expect(await projection()).toEqual([{amount:0,valid:false}]);
 await db.query("update payment_fee_ledger set status='paid' where id=$1",[ledger]);expect(await projection()).toEqual([{amount:800,valid:true}]);
 await db.query("update payment_fee_ledger set status='refunded',refunded_amount_cents=1000,earnings_reversed_cents=850,platform_fee_refund_attribution_cents=120,processing_fee_refund_attribution_cents=30 where id=$1",[ledger]);expect(await projection()).toEqual([{amount:0,valid:false}]);
 expect((await db.query("select id,occurred_at from discover_events_v1 where entity_key=$1",["purchase:"+purchase])).rows).toEqual(identity);
 for(const role of ["anon","authenticated"]){await db.exec(`set role ${role}`);await denied(()=>db.query("select public.reconcile_discover_sale_v1($1)",[ledger]),/permission denied/);await db.exec("reset role");}
 await db.exec("set role service_role");await db.query("select public.reconcile_discover_sale_v1($1)",[ledger]);expect(await projection()).toEqual([{amount:0,valid:false}]);
 expect(await s.milestoneIdentity()).toEqual(s.frozenMilestone);
});
test("F54 guards unknown dependencies and rolls back late failure while preserving owner, ACL, digests and dormant events",async()=>{
 const isolated=createLocalPostgres();
 try{
  await monthlySharedAccountingDatabase(isolated);await mirrorDiscoverSecurityFixture(isolated);
  await isolated.exec("insert into discover_events_v1(kind,entity_key,amount_cents,valid) values('purchase','dormant:fixture',123,true)");
  const inventory=async()=>(await isolated.query<{oid:number;proowner:number;proacl:string|null;prosecdef:boolean;proconfig:string[]|null;definition:string}>("select oid,proowner,proacl::text,prosecdef,proconfig,pg_get_functiondef(oid) definition from pg_proc where oid in ('public.reconcile_discover_sale_v1(uuid)'::regprocedure,'public.discover_ledger_changed_v1()'::regprocedure) order by oid")).rows;
  const digests=async()=>(await isolated.query("select creatornet_team_private.transfer_contract_digest_v1() transfer,creatornet_team_private.shared_cash_contract_digest_v1() shared,creatornet_team_private.retained_cash_contract_digest_v1() retained,creatornet_team_private.recovery_contract_digest_v1() recovery,creatornet_team_private.team_monthly_shared_contract_digest_v1() monthly")).rows;
  const before=await inventory(),contracts=await digests(),original=String(before.find(r=>String(r.definition).includes("FUNCTION public.reconcile_discover_sale_v1("))!.definition),candidate=readFileSync(discoverLossCandidate,"utf8");
  const faults:[string,()=>Promise<unknown>,RegExp][]=[
   ["body",()=>isolated.exec(original.replace("AS $function$","AS $function$\n-- unknown predecessor\n")),/TEAM_DISCOVER_LOSS_ROUTINE_DIFFERS/],
   ["public",()=>isolated.exec("grant execute on function public.reconcile_discover_sale_v1(uuid) to public"),/TEAM_DISCOVER_LOSS_PRIVILEGES_DIFFER/],
   ["disabled",()=>isolated.exec("alter table payment_fee_ledger disable trigger discover_ledger_changed_v1"),/TEAM_DISCOVER_LOSS_TRIGGER_DIFFERS/],
   ["deferred",()=>isolated.exec("drop trigger discover_ledger_changed_v1 on payment_fee_ledger;create constraint trigger discover_ledger_changed_v1 after insert or update on payment_fee_ledger deferrable initially deferred for each row execute function public.discover_ledger_changed_v1()"),/TEAM_DISCOVER_LOSS_TRIGGER_DIFFERS/],
   ["constraint",()=>isolated.exec("alter table payment_fee_ledger drop constraint sales_team_ledger_receipt_pair_v1"),/TEAM_DISCOVER_LOSS_CONSTRAINTS_DIFFER/],
   ["nullable",()=>isolated.exec("alter table payment_fee_ledger alter column team_loss_subtotal_cents drop not null"),/TEAM_DISCOVER_LOSS_COLUMNS_DIFFER/],
   ["late",async()=>{},/SYNTHETIC_F54_LATE_FAILURE/]
  ];
  for(const [fault,mutate,error] of faults){
   await isolated.exec("begin");await mutate();const sql=fault==="late"?candidate.replace("execute replacement;","execute replacement; raise exception 'SYNTHETIC_F54_LATE_FAILURE';"):candidate;
   await expect(isolated.exec(sql)).rejects.toThrow(error);await isolated.exec("rollback");expect(await inventory()).toEqual(before);expect(await digests()).toEqual(contracts);
  }
  await isolated.exec(candidate);const after=await inventory();
  expect(after.map(r=>[r.oid,r.proowner,r.proacl,r.prosecdef,r.proconfig])).toEqual(before.map(r=>[r.oid,r.proowner,r.proacl,r.prosecdef,r.proconfig]));
  expect(after.filter((r,i)=>r.definition!==before[i].definition)).toHaveLength(1);expect(await digests()).toEqual(contracts);
  expect((await isolated.query("select entity_key,amount_cents::int amount,valid from discover_events_v1")).rows).toEqual([{entity_key:"dormant:fixture",amount:123,valid:true}]);
  await expect(isolated.exec(candidate)).rejects.toThrow(/TEAM_DISCOVER_LOSS_ROUTINE_DIFFERS/);await isolated.exec("rollback");expect(await inventory()).toEqual(after);
 }finally{await isolated.close();}
},30000);
