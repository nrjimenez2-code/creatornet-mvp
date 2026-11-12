/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {teamSharedDatabase} from "@/test-support/sales-team-shared-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>;
const denied=async(fn:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied");try{await expect(fn()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied");}};
beforeAll(async()=>{db=await teamSharedDatabase(createLocalPostgres());},30000);
beforeEach(async()=>{await db.exec("begin;update sales_team_controls_v1 set fulfillment_enabled=true");f=await seedTeamCapture(db);});afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
const fulfill=async()=>{const receipt=await f.record();return f.rpc<{purchaseId:string;recorded:boolean}>("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id]);};
test("a paid receipt creates one shared Library purchase, frozen delivery and post-commission ledger",async()=>{
 const result=await fulfill();expect(result.recorded).toBe(true);expect((await fulfill()).recorded).toBe(false);
 expect((await db.query<Record<string,unknown>>("select count(*)::int n from purchases")).rows).toEqual([{n:1}]);expect((await db.query<Record<string,unknown>>("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{n:1}]);
 const ledger=(await db.query<Record<string,unknown>>("select * from payment_fee_ledger")).rows[0];expect([ledger.platform_fee_cents,ledger.processing_fee_cents,ledger.team_commission_cents,ledger.creator_net_cents].map(Number)).toEqual([400,127,333,2473]);
 expect((await db.query<Record<string,unknown>>("select total_earnings_cents from profiles where id=$1",[id(1)])).rows.map(r=>Number(r.total_earnings_cents))).toEqual([2473]);
 expect((await f.rpc<{allowed:boolean}>("read_sales_team_entitlement_v1",[result.purchaseId,f.buyer])).allowed).toBe(true);
 expect((await db.query<Record<string,unknown>>("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
 expect((await db.query<Record<string,unknown>>("select purchase_count from posts")).rows).toEqual([{purchase_count:1}]);
});
test("accepted delivery remains frozen after current links, public price and product revision change",async()=>{
 await db.exec("update products set deliver_url='https://fixture.invalid/changed',price_cents=90000");const result=await fulfill();
 expect((await db.query<Record<string,unknown>>("select s.links from checkout_delivery_snapshots s join purchase_deliveries d on d.order_id=s.order_id where d.purchase_id=$1",[result.purchaseId])).rows).toEqual([{links:[{label:"Content",url:"https://fixture.invalid/original-course"}]}]);
});
test("legacy earnings/refund helpers cannot credit or reverse the new protocol a second time",async()=>{
 const result=await fulfill(),ledger=(await db.query<{id:string}>("select id from payment_fee_ledger")).rows[0].id;
 await denied(()=>f.rpc("credit_purchase_earnings",[result.purchaseId,9999]),/TEAM_EARNINGS/);await denied(()=>f.rpc("credit_payment_fee_ledger_earnings",[ledger]),/TEAM_EARNINGS/);
 await denied(()=>f.rpc("reverse_purchase_earnings",[result.purchaseId]),/TEAM_FINANCIAL/);await denied(()=>f.rpc("apply_purchase_refund_earnings",[result.purchaseId,100]),/TEAM_FINANCIAL/);
 await denied(()=>f.rpc("apply_payment_fee_ledger_refund",[ledger,100]),/TEAM_FINANCIAL/);
});
test("late actual cost differences update only the creator's booked delta and keep reserves separate",async()=>{
 const pending=f.capture();pending.receipt={...pending.receipt,balanceTransactionId:null,processingCostCents:null,availableOn:null};pending.readback.balanceRequestId=null;
 const receipt=await f.rpc("record_verified_sales_team_capture_v1",[f.sale,f.buyer,f.contract.obligationId,f.confirmationId,pending]);
 await f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id]);f.base.balance.fee=100;f.base.balance.net=f.base.balance.amount-100;f.base.balance.fee_details[0].amount=100;
 await fulfill();await fulfill();expect((await db.query<Record<string,unknown>>("select total_earnings_cents from profiles where id=$1",[id(1)])).rows.map(r=>Number(r.total_earnings_cents))).toEqual([2500]);
 expect((await db.query<Record<string,unknown>>("select processing_fee_cents,team_processing_reserve_cents,processing_fee_variance_cents from payment_fee_ledger")).rows.map(r=>Object.values(r).map(Number))).toEqual([[100,0,0]]);
});
test("verified refund reconciliation updates shared proceeds and access without a duplicate legacy reversal",async()=>{
 const result=await fulfill(),receipt=(await f.record()) as {id:string;observation_revision:number};
 const proof={context:f.contract.context,chargeId:"ch_original",paymentIntentId:"pi_original",refundedCents:3333,totalLossCents:3333,disputeHold:false,reviewHold:false,platformFeeReturnedCents:400,platformProcessingCostCreditCents:0};
 await f.rpc("reconcile_sales_team_receipt_v1",[receipt.id,receipt.observation_revision,"refund_fixture",3333,3333,false,false,127,"txn_original",f.base.balance.available_on?new Date(f.base.balance.available_on*1000).toISOString():null,proof]);
 expect((await db.query<Record<string,unknown>>("select total_earnings_cents from profiles where id=$1",[id(1)])).rows.map(r=>Number(r.total_earnings_cents))).toEqual([0]);
 expect((await db.query<Record<string,unknown>>("select team_commission_cents,team_creator_deficit_cents,refunded_amount_cents from payment_fee_ledger")).rows.map(r=>Object.values(r).map(Number))).toEqual([[0,127,3333]]);
 expect((await f.rpc<{allowed:boolean}>("read_sales_team_entitlement_v1",[result.purchaseId,f.buyer])).allowed).toBe(false);expect((await db.query<Record<string,unknown>>("select purchase_count from posts")).rows).toEqual([{purchase_count:0}]);
});
test("unverified, foreign and disabled first fulfillment cannot create access",async()=>{
 await denied(()=>f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,id(90)]),/VERIFIED_TEAM_FULFILLMENT_REQUIRED/);
 const receipt=await f.record();await denied(()=>f.rpc("fulfill_sales_team_receipt_v1",[f.sale,id(11),receipt.id]),/OWNED_SALE_REQUIRED/);
 await db.exec("update sales_team_controls_v1 set fulfillment_enabled=false");await denied(()=>f.rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id]),/TEAM_FULFILLMENT_HELD/);
});
test("paid entitlement survives closer departure and Stop, while a recorded dispute hold denies delivery",async()=>{
 const result=await fulfill();await db.exec("update sales_team_memberships_v1 set status='removed';update sales_team_payment_runtime_v1 set stop_requested_at=clock_timestamp()");
 expect((await f.rpc<{allowed:boolean}>("read_sales_team_entitlement_v1",[result.purchaseId,f.buyer])).allowed).toBe(true);
 await db.exec("update sales_team_receipts_v1 set dispute_hold=true");expect((await f.rpc<{allowed:boolean}>("read_sales_team_entitlement_v1",[result.purchaseId,f.buyer])).allowed).toBe(false);
});
test("timed installments cannot become permanent by setting the legacy access flag",async()=>{
 const result=await fulfill();await denied(()=>db.query<Record<string,unknown>>("update purchases set access_granted=true where id=$1",[result.purchaseId]),/ORIGINAL_TEAM_PURCHASE_CHANGED/);
 await db.exec("update sales_team_payment_runtime_v1 set anchor_at=clock_timestamp()-interval '2 months'");expect((await f.rpc<{allowed:boolean}>("read_sales_team_entitlement_v1",[result.purchaseId,f.buyer])).allowed).toBe(false);
 expect((await f.rpc<{applicable:boolean;allowed:boolean}>("read_sales_team_entitlement_v1",[result.purchaseId,id(11)]))).toEqual({applicable:false,allowed:false,maxAgeSeconds:0});
});
test("the original legacy split constraint is retained for non-team rows",async()=>{
 await denied(()=>db.exec(`insert into payment_fee_ledger(creator_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version) values('${id(1)}',1000,120,30,151,849,'usd','legacy')`),/payment_fee_ledger_split_check/);
 await db.exec(`insert into payment_fee_ledger(creator_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version) values('${id(1)}',1000,120,30,150,850,'usd','legacy')`);
});
test("ordinary legacy earnings retain their original once-only behavior",async()=>{
 await db.query<Record<string,unknown>>("insert into purchases(id,buyer_id,buyer_user_id,creator_id,product_id,post_id,amount_cents,currency,status,access_granted) values($1,$2,$2,$3,$4,$5,1000,'usd','paid',true)",[id(90),id(11),id(1),id(21),f.contract.terms.postId]);
 expect(await f.rpc<boolean>("credit_purchase_earnings",[id(90),850])).toBe(true);expect(await f.rpc<boolean>("credit_purchase_earnings",[id(90),850])).toBe(false);
 expect(await f.rpc<boolean>("reverse_purchase_earnings",[id(90)])).toBe(true);expect(await f.rpc<boolean>("reverse_purchase_earnings",[id(90)])).toBe(false);
});
test("shared team financial history cannot be deleted through legacy cleanup rights",async()=>{
 const result=await fulfill();await db.exec("grant delete on purchases,orders to service_role");
 await denied(()=>db.query<Record<string,unknown>>("delete from purchases where id=$1",[result.purchaseId]),/TEAM_SHARED_HISTORY_IMMUTABLE/);
 await denied(()=>db.exec("delete from orders where sales_team_sale_id is not null"),/TEAM_SHARED_HISTORY_IMMUTABLE/);
 await denied(()=>db.exec("delete from payment_fee_ledger where sales_team_sale_id is not null"),/TEAM_SHARED_HISTORY_IMMUTABLE/);
});
test("private shared bindings and entitlements are denied to browser roles",async()=>{
 const result=await fulfill();await db.exec("set local role authenticated");await denied(()=>db.query<Record<string,unknown>>("select * from sales_team_purchase_bindings_v1"),/permission denied/);
 await denied(()=>f.rpc("read_sales_team_entitlement_v1",[result.purchaseId,f.buyer]),/permission denied/);
});
