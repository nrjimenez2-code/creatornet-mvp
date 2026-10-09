/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { buyerFirstCaptureFixture,buyerManualFirstCaptureFixture } from "../test-support/buyer-mentorship-receipt-fixture";
import { inspectBuyerMentorshipFirstCapture,inspectBuyerMentorshipManualFirstCapture } from "../lib/mentorshipInstallmentReceipt";
import { buyerMentorshipActivationParams } from "../lib/mentorshipInstallmentActivation";
import {heldInvoicePreparationRequests,type BuyerHeldInvoiceAuthorization} from "../lib/installments/heldInvoice";
import {calculateInstallmentPlan} from "../lib/installmentPlan";
import {parseBuyerMentorshipAdminPage} from "../lib/mentorshipInstallmentAdmin";
import {exactCardSetupParams,CARD_SETUP_CONSENT_TEXT} from "../lib/installments/cardRecovery";
declare const createLocalPostgres: () => PGlite;
let db: PGlite, f: ReturnType<typeof buyerFirstCaptureFixture>, proof: ReturnType<typeof inspectBuyerMentorshipFirstCapture>;
const migration = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8");
async function leaseBuyerWork(collect=true,context=f.context,limit=2) {
  return (await db.query<{result:any}>("select lease_buyer_mentorship_work_v1($1,$2,$3) result",[context,collect,limit])).rows[0].result;
}
async function finishBuyerWork(token:string,status="accounted",context=f.context) {
  return (await db.query<{result:boolean}>("select finish_buyer_mentorship_work_v1($1,$2,$3,$4) result",[f.reservation.id,token,context,status])).rows[0].result;
}
async function buyerWorkSummary() {
  return (await db.query<{result:any}>("select read_buyer_mentorship_work_summary_v1($1) result",[f.context])).rows[0].result;
}
async function record(p = proof, buyer = f.reservation.buyerId) {
  return (await db.query<{ result: any }>("select record_buyer_mentorship_first_receipt_v1($1,$2,$3,$4) result",
    [f.reservation.requestId, buyer, f.context, p])).rows[0].result;
}
beforeAll(async () => {
  db = createLocalPostgres();
  // Representative existing columns; real new migrations and money/calendar SQL.
  // Full installed-schema compatibility remains a separate release requirement.
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table profiles(id uuid primary key,total_earnings_cents bigint);
    create table buyer_mentorship_installment_reservations_v1(id uuid primary key,request_id uuid unique,buyer_id uuid,
      creator_id uuid,product_id uuid,post_id uuid,context jsonb,fingerprint text,status text,terms jsonb,destination_id text);
    create table purchases(id uuid primary key,buyer_id uuid,buyer_user_id uuid,creator_id uuid,product_id uuid,post_id uuid,
      booking_id uuid,amount_cents bigint,currency text,status text,kind text,product_type text,title text,access_granted boolean,
      session_id text,subscription_id text,payment_intent_id text,paid_at timestamptz,earnings_credited_at timestamptz,
      earnings_credited_cents bigint,paid_count integer default 0,target_months integer,
      is_refund boolean default false,is_suspect boolean default false);
    create table refund_operations(stripe_payment_intent_id text,status text);
    create table orders(id uuid primary key); create table booking_payments(id uuid primary key);
    grant select,insert,update on all tables in schema public to service_role;`);
  const ledgerSchema = readFileSync("supabase/schema/019-creator-processing-fees.sql", "utf8");
  for (const table of ["payment_fee_ledger", "payment_refund_state", "payment_dispute_state"]) {
    const start = ledgerSchema.indexOf(`create table if not exists public.${table} (`);
    await db.exec(ledgerSchema.slice(start, ledgerSchema.indexOf(";", start) + 1));
  }
  await db.exec("grant select,insert,update on payment_fee_ledger,payment_refund_state,payment_dispute_state to service_role");
  for(const name of ["record_payment_refund_state","apply_payment_fee_ledger_refund","record_payment_dispute_state"]) {
    const start=ledgerSchema.indexOf(`create or replace function public.${name}(`);
    await db.exec(ledgerSchema.slice(start,ledgerSchema.indexOf("$$;",start)+3));
  }
  for (const [file, name] of [["078-monthly-mentorship-receipts", "valid_monthly_fee_snapshot_v1"], ["096-independent-fixed-service", "fixed_service_end_v1"]]) {
    const source = readFileSync(`supabase/proposals/${file}.sql`, "utf8");
    const start = source.indexOf(`create function public.${name}(`);
    await db.exec(source.slice(start, source.indexOf("$$;", start) + 3));
  }
  await db.exec(migration("20260921021558_buyer_mentorship_customer_operations"));
  await db.exec(migration("20260921030153_buyer_mentorship_bootstrap_operations"));
  await db.exec(migration("20260921033556_buyer_mentorship_first_receipt"));
  await db.exec(migration("20260921035228_buyer_mentorship_access"));
  await db.exec(migration("20260921040331_buyer_mentorship_activation_operations"));
  await db.exec(migration("20260921041501_buyer_mentorship_collection_periods"));
  await db.exec(migration("20260921042530_buyer_mentorship_invoice_claims"));
  await db.exec(migration("20260921043012_buyer_mentorship_invoice_operations"));
  await db.exec(migration("20260921043812_buyer_mentorship_payment_admission"));
  await db.exec(migration("20260921045709_buyer_mentorship_later_receipts"));
  await db.exec(migration("20260921050829_buyer_mentorship_collection_controls"));
  await db.exec(migration("20260921052151_buyer_mentorship_refund_reconciliation"));
  await db.exec(migration("20260921053445_buyer_mentorship_refund_before_receipt"));
  await db.exec(migration("20260921054642_buyer_mentorship_dispute_observation"));
  await db.exec(migration("20260921055838_buyer_mentorship_dispute_before_receipt"));
  await db.exec(migration("20260921060534_buyer_mentorship_payment_recovery"));
  await db.exec(migration("20260921061517_buyer_mentorship_bank_verification"));
  await db.exec(migration("20260921064855_buyer_mentorship_recovery_action_context"));
  await db.exec(migration("20260921065213_buyer_mentorship_card_setup_requests"));
  await db.exec(migration("20260921065605_buyer_mentorship_card_setup_operations"));
  await db.exec(migration("20260921070644_buyer_mentorship_saved_card_proof"));
  await db.exec(migration("20260921072210_buyer_mentorship_retry_quotes"));
  await db.exec(migration("20260921072624_buyer_mentorship_retry_admission"));
  await db.exec(migration("20260921072937_buyer_mentorship_retry_receipts"));
  await db.exec(migration("20260921074803_buyer_mentorship_retry_recovery_revision"));
  await db.exec(migration("20260921080205_buyer_mentorship_future_card_authorization"));
  await db.exec(migration("20260921081114_buyer_mentorship_invoice_card_binding"));
  await db.exec(migration("20260921081929_buyer_mentorship_card_recovery_context"));
  await db.exec(migration("20260921082333_buyer_mentorship_future_collection_release"));
  await db.exec(migration("20260921155703_buyer_mentorship_worker"));
  await db.exec(migration("20260921160843_buyer_mentorship_admin_review"));
  await db.exec(migration("20260921164832_buyer_mentorship_recovery_hold_owner"));
  // Structural source dependencies; their immutable claim/phase functions are
  // exercised separately by server-payment-intent-database.test.ts.
  await db.exec(`alter table buyer_mentorship_installment_reservations_v1 add column attempt_id uuid,add column released_at timestamptz;
    create table server_payment_protocols_v1(attempt_id uuid,reservation_id uuid,buyer_id uuid,product_id uuid,context jsonb,kind text,protocol text);
    create table server_payment_intent_operations_v1(attempt_id uuid,payment_intent_id text,contract jsonb,bound_at timestamptz,first_dispatch_at timestamptz);
    create table server_payment_confirmations_v1(operation_id uuid,attempt_id uuid,phase integer,payment_intent_id text,latest_observation jsonb);
    create table server_payment_stops_v1(attempt_id uuid primary key,requested_at timestamptz default clock_timestamp());
    grant select on server_payment_stops_v1 to service_role;
    grant select on server_payment_protocols_v1,server_payment_intent_operations_v1,server_payment_confirmations_v1 to service_role;`);
  await db.exec(migration("20260921184216_buyer_manual_first_receipt"));
});
// PostgreSQL evaluates real clock_timestamp(); keep normal admission fixtures
// current while elapsed-window cases below continue to pass explicit old dates.
async function seed(fixture = buyerFirstCaptureFixture(36,Math.floor(Date.now()/1000)-60)) {
  f = fixture; proof = inspectBuyerMentorshipFirstCapture(f);
  const r = f.reservation;
  await db.exec("begin");
  await db.query("insert into profiles values($1,100)", [r.terms.creatorId]);
  await db.query("insert into buyer_mentorship_installment_reservations_v1 values($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10,$11,null)",
    [r.id,r.requestId,r.buyerId,r.terms.creatorId,r.productId,r.postId,f.context,r.fingerprint,r.terms,r.destinationId,r.attemptId]);
  await db.query("insert into buyer_mentorship_customer_operations_v1(reservation_id,request,first_dispatch_at,customer_id,provider_request_id,bound_at) values($1,'{}',$2,$3,'req_fixture',$2)",
    [r.id,f.firstDispatchAt,f.customer.id]);
  await db.query("insert into buyer_mentorship_bootstraps_v1 values($1,$2,$3)", [r.id,f.customer.id,f.dependencies.anchorSeconds]);
  for (const [step, result] of [["product.create","prod_owned"],["subscription.create","sub_owned"],["subscription.hold","sub_owned"],["checkout.create",f.sessionId]]) {
    await db.query("insert into buyer_mentorship_bootstrap_operations_v1(reservation_id,step,request,first_dispatch_at,result_id,provider_request_id,bound_at) values($1,$2,$3,$4,$5,'req_fixture',$4)",
      [r.id,step,step === "checkout.create" ? f.originalRequest : {},f.firstDispatchAt,result]);
  }
  await db.exec("set local role service_role");
}
beforeEach(async () => { await seed(); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db.close(); });

async function manualSource(){
  const m=buyerManualFirstCaptureFixture(36,f.dependencies.anchorSeconds);proof=inspectBuyerMentorshipManualFirstCapture(m);
  await db.exec("reset role");
  await db.query("delete from buyer_mentorship_bootstrap_operations_v1 where reservation_id=$1 and step='checkout.create'",[f.reservation.id]);
  await db.query("insert into server_payment_protocols_v1 values($1,$2,$3,$4,$5,'first_installment','creatornet-us-manual-confirmation-v1')",
    [f.reservation.attemptId,f.reservation.id,f.reservation.buyerId,f.reservation.productId,f.context]);
  await db.query("insert into server_payment_intent_operations_v1 values($1,'pi_owned',$2,$3,$3)",
    [f.reservation.attemptId,m.manual.contract,f.firstDispatchAt]);
  await db.query("insert into server_payment_confirmations_v1 values($1,$2,1,'pi_owned',$3)",
    [m.manual.confirmationOperationId,f.reservation.attemptId,{status:"succeeded",paymentIntentId:"pi_owned",chargeId:"ch_owned",paymentMethodId:"pm_owned"}]);
  await db.exec("set local role service_role");return m;
}
test("manual first capture uses one existing receipt/ledger/earnings path with no fabricated session and correct access",async()=>{
  await manualSource();const first=await record();expect(first.recorded).toBe(true);expect((await record()).recorded).toBe(false);
  expect((await db.query("select session_id,access_granted from purchases")).rows).toEqual([{session_id:null,access_granted:false}]);
  expect((await db.query("select stripe_checkout_session_id,creator_net_cents from payment_fee_ledger")).rows)
    .toEqual([{stripe_checkout_session_id:null,creator_net_cents:2806}]);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2906}]);
  const access=(await db.query<{result:any}>("select read_buyer_mentorship_entitlement_v1($1,$2) result",[first.purchaseId,f.reservation.buyerId])).rows[0].result;
  expect(access).toMatchObject({allowed:true,financialAccess:true,serviceEndAt:proof.serviceEndsAt});
  expect((await db.query("select count(*)::integer n from buyer_mentorship_first_receipts_v1")).rows[0]).toEqual({n:1});
});
test.each(["unbound","foreign intent","missing confirmation","unpaid confirmation","wrong card","foreign charge","newer phase","released","fake session","unknown hosted"])
("manual receipt rejects %s source",async issue=>{
  await manualSource();await db.exec("reset role");
  if(issue==="unbound")await db.exec("update server_payment_intent_operations_v1 set bound_at=null");
  if(issue==="foreign intent")await db.exec("update server_payment_intent_operations_v1 set payment_intent_id='pi_other'");
  if(issue==="missing confirmation")await db.exec("delete from server_payment_confirmations_v1");
  if(issue==="unpaid confirmation")await db.exec("update server_payment_confirmations_v1 set latest_observation=jsonb_set(latest_observation,'{status}','\"requires_action\"')");
  if(issue==="wrong card")await db.exec("update server_payment_confirmations_v1 set latest_observation=jsonb_set(latest_observation,'{paymentMethodId}','\"pm_other\"')");
  if(issue==="foreign charge")await db.exec("update server_payment_confirmations_v1 set latest_observation=jsonb_set(latest_observation,'{chargeId}','\"ch_other\"')");
  if(issue==="newer phase")await db.exec("insert into server_payment_confirmations_v1 select gen_random_uuid(),attempt_id,2,payment_intent_id,latest_observation from server_payment_confirmations_v1");
  if(issue==="released")await db.exec("update buyer_mentorship_installment_reservations_v1 set released_at=clock_timestamp()");
  if(issue==="fake session")proof={...proof,checkoutSessionId:"cs_test_fake"};
  if(issue==="unknown hosted")await db.query("insert into buyer_mentorship_bootstrap_operations_v1(reservation_id,step,request) values($1,'checkout.create','{}')",[f.reservation.id]);
  await db.exec("set local role service_role");await expect(record()).rejects.toThrow();
});
test("manual capture refund reuses atomic cumulative reversal and denies access",async()=>{
  await manualSource();const first=await record();const reversal=await applyRefund(1000);
  expect(reversal).toMatchObject({cumulativeRefundedCents:1000,reversedCents:842});
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2064}]);
  expect((await db.query<{result:any}>("select read_buyer_mentorship_entitlement_v1($1,$2) result",[first.purchaseId,f.reservation.buyerId])).rows[0].result.allowed).toBe(false);
});

async function stopManualPayment(){
  await db.exec("reset role");
  await db.query("insert into server_payment_stops_v1(attempt_id) values($1) on conflict do nothing",[f.reservation.attemptId]);
  await db.exec("set local role service_role");
}
test("manual stop before late capture preserves one receipt but prevents activation",async()=>{
  await manualSource();await stopManualPayment();expect((await record()).recorded).toBe(true);
  expect((await record()).recorded).toBe(false);
  await expect(claimActivation()).rejects.toThrow("Manual purchase stop");
});
test("manual activation admitted before stop can record original completion but cannot enable collection",async()=>{
  await manualSource();await record();const a=await claimActivation();await stopManualPayment();
  expect((await completeActivation(a.operation.lease_token)).status).toBe("complete");
  await expect(enableCollection()).rejects.toThrow("Manual purchase stop");
});
test("manual stop prevents a new lease for an unresolved activation",async()=>{
  await manualSource();await record();await claimActivation();
  await db.exec("update buyer_mentorship_activation_operations_v1 set lease_until=now()-interval '1 second'");
  await stopManualPayment();await expect(claimActivation()).rejects.toThrow("Manual purchase stop");
});
test("manual stop after enablement holds collection without revoking debt or duplicating accounting",async()=>{
  await manualSource();await record();const a=await claimActivation();await completeActivation(a.operation.lease_token);await enableCollection();
  await stopManualPayment();await stopManualPayment();
  expect((await db.query("select collection_hold_at is not null held,debit_revoked_at is null debit_unchanged,paid_count from buyer_mentorship_billing_state_v1")).rows)
    .toEqual([{held:true,debit_unchanged:true,paid_count:1}]);
  expect((await record()).recorded).toBe(false);expect((await applyRefund(1000)).cumulativeRefundedCents).toBe(1000);
  await expect(enableCollection()).rejects.toThrow();
});

async function adminBuyerPage(cursor:string|null=null,context=f.context,limit=25) {
  const result=(await db.query<{result:any}>("select read_buyer_mentorship_admin_page_v1($1,$2,$3) result",[context,cursor,limit])).rows[0].result;
  // PGlite runs outside Jest's VM. Match the real HTTP JSON boundary so strict
  // context equality compares local JSON objects, not cross-realm prototypes.
  return JSON.parse(JSON.stringify(result));
}
test("admin projection reads real saved terms, separate service duration and worker backlog without financial mutations",async()=>{
  await syntheticDuePeriod();const [w]=await leaseBuyerWork();await finishBuyerWork(w.lease_token,"review_required");
  const raw=await adminBuyerPage(),page=parseBuyerMentorshipAdminPage(raw,f.context,null);
  expect(page).toMatchObject({pending:1,attention:1,plans:[{id:f.reservation.id,requestId:f.reservation.requestId,
    amountCents:10001,paymentCount:3,paidCount:1,serviceMonths:36,workerStatus:"review_required",dueAction:"collect"}]});
  expect(raw.rows[0]).not.toHaveProperty("terms");expect(raw.rows[0]).not.toHaveProperty("proof");
  expect(raw.rows[0]).not.toHaveProperty("payment_intent_id");expect(raw.rows[0]).not.toHaveProperty("buyer_id");
  expect((await db.query("select count(*)::integer n from buyer_mentorship_payment_admissions_v1")).rows[0]).toEqual({n:0});
});
test("admin later empty page retains full-context backlog totals",async()=>{
  await syntheticDuePeriod();const result=await adminBuyerPage(f.reservation.id);
  expect(result.rows).toEqual([]);expect(result.backlog).toEqual(await buyerWorkSummary());expect(result.oldestDueAt).toBeGreaterThan(0);
});
test("admin context isolation covers both records and aggregate",async()=>{
  await syntheticDuePeriod();expect(await adminBuyerPage(null,{...f.context,platformAccountId:"acct_other"})).toMatchObject({rows:[],backlog:{pending:0,attention:0},oldestDueAt:null});
});
test("admin latest recovery retains original invoice and saved outcome after debit stop",async()=>{
  const e=await paymentEvidence();await admitPayment(e);await revokeDebit();const snapshot=await beginPaymentRecovery();await finishPaymentRecovery(snapshot);
  const page=parseBuyerMentorshipAdminPage(await adminBuyerPage(),f.context,null);
  expect(page.plans[0]).toMatchObject({recoveryInvoice:"in_due",recoveryNumber:2,recoveryOutcome:"action_required",dueAction:"recover"});
  expect(page.plans[0].holds).toContain("Automatic debits revoked");
});
test("admin excludes uncharged reservations from the billed plan list",async()=>{expect((await adminBuyerPage()).rows).toEqual([]);});
test.each(["anon","authenticated"])("%s cannot read buyer admin data",async role=>{
  await db.exec(`set local role ${role}`);await expect(adminBuyerPage()).rejects.toThrow("permission denied");
});
test.each([0,26])("admin rejects unbounded or invalid page size %s",async limit=>{await expect(adminBuyerPage(null,f.context,limit)).rejects.toThrow("request differs");});

test("worker only leases due owned original periods, and overlapping invocations cannot lease twice",async()=>{
  await syntheticDuePeriod();
  const first=await leaseBuyerWork();expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({reservation_id:f.reservation.id,request_id:f.reservation.requestId,buyer_id:f.reservation.buyerId,action:"collect",invoice_id:null});
  expect(await leaseBuyerWork()).toEqual([]);
  expect((await db.query("select count(*)::integer n from buyer_mentorship_payment_admissions_v1")).rows[0]).toEqual({n:0});
});
test("worker recovery gate does not admit new collection",async()=>{
  await syntheticDuePeriod();expect(await leaseBuyerWork(false)).toEqual([]);
  expect((await buyerWorkSummary()).attention).toBe(1);
});
test("worker cannot select another exact context",async()=>{
  await syntheticDuePeriod();expect(await leaseBuyerWork(true,{...f.context,platformAccountId:"acct_other"})).toEqual([]);
});
test("worker does not select future periods",async()=>{
  await record();const a=await claimActivation();await completeActivation(a.operation.lease_token);await initializePeriods();
  expect(await leaseBuyerWork()).toEqual([]);expect(await buyerWorkSummary()).toEqual({pending:0,attention:0});
});
test.each(["collection_hold_at","financial_hold_at"])("worker treats %s as review, not collection",async column=>{
  await syntheticDuePeriod();await db.exec(`reset role;update buyer_mentorship_billing_state_v1 set ${column}=now();set local role service_role`);
  expect((await leaseBuyerWork())[0].action).toBe("review");
});
test("worker never collects a revoked unadmitted period",async()=>{
  await syntheticDuePeriod();await revokeDebit();expect(await leaseBuyerWork()).toEqual([]);
});
test("debit revocation after orchestration lease still blocks original invoice admission",async()=>{
  const invoice=await syntheticDuePeriod();expect((await leaseBuyerWork())[0].action).toBe("collect");
  await revokeDebit();await expect(claimInvoice(invoice)).rejects.toThrow("collection state");
});
test("worker never skips an expired unpaid period for a later collection",async()=>{
  await syntheticDuePeriod(90);const rows=await leaseBuyerWork();expect(rows).toHaveLength(1);expect(rows[0].action).toBe("review");
});
test("worker recovers the original admitted invoice after hold and debit revocation with fresh collection disabled",async()=>{
  const e=await paymentEvidence();await admitPayment(e);await revokeDebit();await beginPaymentRecovery();
  const rows=await leaseBuyerWork(false);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({action:"recover",invoice_id:"in_due"});
});
test("worker completion rejects foreign context, foreign token and expired lease; takeover changes only orchestration token",async()=>{
  await syntheticDuePeriod();const [first]=await leaseBuyerWork();
  expect(await finishBuyerWork("10000000-0000-4000-8000-000000000099")).toBe(false);
  expect(await finishBuyerWork(first.lease_token,"accounted",{...f.context,platformAccountId:"acct_other"})).toBe(false);
  await db.exec("update buyer_mentorship_worker_v1 set lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second'");
  expect(await finishBuyerWork(first.lease_token)).toBe(false);
  const [second]=await leaseBuyerWork();expect(second.lease_token).not.toBe(first.lease_token);
  expect(await finishBuyerWork(first.lease_token)).toBe(false);expect(await finishBuyerWork(second.lease_token)).toBe(true);
});
test("worker review remains visible while retry backoff returns no jobs",async()=>{
  await syntheticDuePeriod();const [work]=await leaseBuyerWork();expect(await finishBuyerWork(work.lease_token,"review_required")).toBe(true);
  expect(await leaseBuyerWork()).toEqual([]);expect(await buyerWorkSummary()).toEqual({pending:1,attention:1});
});
test("worker lease grants no reservation mutation privilege",async()=>{
  await syntheticDuePeriod();await db.exec("reset role;revoke update on buyer_mentorship_installment_reservations_v1 from service_role;set local role service_role");
  expect(await leaseBuyerWork()).toHaveLength(1);
});
test.each(["anon","authenticated"])("%s cannot execute worker selection",async role=>{
  await syntheticDuePeriod();await db.exec(`set local role ${role}`);await expect(leaseBuyerWork()).rejects.toThrow("permission denied");
});
test.each([0,3])("worker rejects batch limit %s",async limit=>{await expect(leaseBuyerWork(true,f.context,limit)).rejects.toThrow("request differs");});

test("one atomic credit, duplicate delivery returns original identities, collection stays held", async () => {
  const first = await record(); expect(first.recorded).toBe(true);
  expect(await record()).toEqual({ ...first, recorded: false });
  await db.exec("set constraints all immediate");
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2906}]);
  expect((await db.query("select count(*)::integer count from payment_fee_ledger")).rows).toEqual([{count:1}]);
  expect((await db.query("select amount_cents::integer amount,access_granted,paid_count from purchases")).rows)
    .toEqual([{amount:10001,access_granted:false,paid_count:0}]);
  expect((await db.query("select paid_count,collection_hold_at is not null held,service_end_at::text ending from buyer_mentorship_billing_state_v1")).rows)
    .toEqual([{paid_count:1,held:true,ending:String(proof.serviceEndsAt)}]);
});
test.each(["amountCents","buyerId","destinationId","termsFingerprint","checkoutSessionId","nextPaymentAt","serviceEndsAt"])("rejects altered %s", async field => {
  await expect(record({ ...proof, [field]: typeof (proof as any)[field] === "number" ? 1 : "different" })).rejects.toThrow();
});
test("rejects foreign buyer", async () => {
  await expect(record(proof,"10000000-0000-4000-8000-000000000099")).rejects.toThrow("Owned");
});
test("rejects caller-priced fee changes", async () => {
  await expect(record({...proof,fees:{...proof.fees,platformFeeCents:0}})).rejects.toThrow("economics");
});
test.each(["refund","dispute"])("prior %s observation blocks credit", async kind => {
  if (kind === "refund") await db.exec("insert into payment_refund_state(stripe_payment_intent_id,stripe_charge_id,charge_amount_cents,refunded_amount_cents) values('pi_owned','ch_owned',3333,1)");
  else await db.exec("insert into payment_dispute_state(stripe_dispute_id,stripe_payment_intent_id,stripe_charge_id,disputed_amount_cents,currency,status,stripe_event_created) values('dp_fixture','pi_owned','ch_owned',3333,'usd','needs_response',1)");
  await expect(record()).rejects.toThrow("Prior financial observation");
});
test("cannot grant legacy permanent access after receipt", async () => {
  await record(); await expect(db.exec("update purchases set access_granted=true")).rejects.toThrow("legacy accounting");
});
test("a late failure rolls back receipt, ledger and purchase together", async () => {
  await db.exec("reset role; alter table profiles add constraint synthetic_credit_limit check(total_earnings_cents<=100); set local role service_role; savepoint attempt");
  await expect(record()).rejects.toThrow("synthetic_credit_limit");
  await db.exec("rollback to savepoint attempt");
  for (const table of ["purchases","payment_fee_ledger","buyer_mentorship_first_receipts_v1","buyer_mentorship_billing_state_v1"]) {
    expect((await db.query(`select count(*)::integer count from ${table}`)).rows).toEqual([{count:0}]);
  }
});
test("receipt RPC uses invoker rights and public roles cannot execute or rewrite evidence", async () => {
  expect((await db.query(`select prosecdef,has_function_privilege('anon',oid,'execute') anon,
    has_function_privilege('authenticated',oid,'execute') authenticated from pg_proc where proname='record_buyer_mentorship_first_receipt_v1'`)).rows)
    .toEqual([{prosecdef:false,anon:false,authenticated:false}]);
  expect((await db.query("select has_table_privilege('service_role','buyer_mentorship_first_receipts_v1','UPDATE') writable")).rows)
    .toEqual([{writable:false}]);
});

async function access(purchaseId: string, buyer = f.reservation.buyerId) {
  return (await db.query<{result:any}>("select read_buyer_mentorship_entitlement_v1($1,$2) result",[purchaseId,buyer])).rows[0].result;
}
test("owned receipt grants service independently of three-payment count and collection hold", async () => {
  const saved=await record(), result=await access(saved.purchaseId);
  expect(result).toMatchObject({applicable:true,allowed:true,maxAgeSeconds:3600,serviceEndAt:proof.serviceEndsAt});
  expect(await access(saved.purchaseId,"10000000-0000-4000-8000-000000000099"))
    .toEqual({applicable:false,allowed:false,maxAgeSeconds:0});
});
test.each(["refund observation","dispute observation","pending refund","financial hold","suspect purchase"])("%s denies paid service", async kind => {
  const saved=await record();
  if(kind==="refund observation") await db.exec("insert into payment_refund_state(stripe_payment_intent_id,stripe_charge_id,charge_amount_cents,refunded_amount_cents) values('pi_owned','ch_owned',3333,1)");
  if(kind==="dispute observation") await db.exec("insert into payment_dispute_state(stripe_dispute_id,stripe_payment_intent_id,stripe_charge_id,disputed_amount_cents,currency,status,stripe_event_created) values('dp_fixture','pi_owned','ch_owned',3333,'usd','needs_response',1)");
  if(kind==="pending refund") await db.exec("insert into refund_operations values('pi_owned','pending')");
  if(kind==="financial hold") await db.exec("reset role; update buyer_mentorship_billing_state_v1 set financial_hold_at=now(); set local role service_role");
  if(kind==="suspect purchase") await db.exec("update purchases set is_suspect=true");
  expect(await access(saved.purchaseId)).toMatchObject({applicable:true,allowed:false,maxAgeSeconds:0});
});
test("one-month service expires even when a three-month payment schedule remains", async () => {
  await db.exec("rollback");
  await seed(buyerFirstCaptureFixture(1,Math.floor(Date.now()/1000)-45*86400));
  const saved=await record();
  expect(await access(saved.purchaseId)).toMatchObject({applicable:true,financialAccess:true,allowed:false,maxAgeSeconds:0});
});
function activationRequest(){return {apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/subscriptions/sub_owned",
  params:buyerMentorshipActivationParams(proof.paidAt,f.reservation.terms.paymentCount,proof.paymentMethodId)};}
async function claimActivation(request=activationRequest(),item="si_owned"){
  return (await db.query<{result:any}>("select claim_buyer_mentorship_activation_v1($1,$2,$3,$4,$5) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,item,request])).rows[0].result;
}
async function completeActivation(token:string,changes:Record<string,unknown>={}){
  const params=activationRequest().params;
  const sub={...f.data.subscription,...params,billing_cycle_anchor:params.trial_end,
    metadata:{...f.data.subscription.metadata,...params.metadata},...changes};
  return (await db.query<{result:any}>("select complete_buyer_mentorship_activation_v1($1,$2,$3,$4,$5,$6) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,token,sub,"req_activation"])).rows[0].result;
}
test("activation commits original parameters and key, then serializes retries",async()=>{
  await record();const first=await claimActivation();expect(first.status).toBe("dispatch");
  expect(first.operation.request).toEqual(activationRequest());expect((await claimActivation()).status).toBe("busy");
  await db.exec("update buyer_mentorship_activation_operations_v1 set lease_until=now()-interval '1 second'");
  const retry=await claimActivation();expect(retry.status).toBe("dispatch");
  expect(retry.operation.idempotency_key).toBe(first.operation.idempotency_key);
  expect(retry.operation.first_dispatch_at).toBe(first.operation.first_dispatch_at);
  expect(retry.operation.lease_token).not.toBe(first.operation.lease_token);
  await expect(completeActivation(first.operation.lease_token)).rejects.toThrow("original provider proof");
});
test("activation completion is idempotent and leaves collection held",async()=>{
  await record();const a=await claimActivation();const done=await completeActivation(a.operation.lease_token);
  expect(done.status).toBe("complete");expect(await completeActivation(a.operation.lease_token)).toEqual(done);
  expect(await claimActivation()).toEqual(done);
  expect((await db.query("select collection_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{held:true}]);
});
test("activation requires an existing receipt",async()=>{await expect(claimActivation()).rejects.toThrow("captured receipt");});
test("activation cannot change the captured card or money calendar",async()=>{
  await record();const request=activationRequest();request.params.default_payment_method="pm_other";
  await expect(claimActivation(request)).rejects.toThrow("captured terms");
});
test("activation request cannot be rewritten after dispatch",async()=>{
  await record();await claimActivation();await expect(db.exec("update buyer_mentorship_activation_operations_v1 set idempotency_key='replacement'")).rejects.toThrow("immutable");
});
test("elapsed activation window requires review and creates no replacement operation",async()=>{
  await db.exec("rollback");await seed(buyerFirstCaptureFixture(36,Math.floor(Date.now()/1000)-3*86400));await record();
  expect(await claimActivation()).toEqual({status:"review_required"});
  expect((await db.query("select count(*)::integer count from buyer_mentorship_activation_operations_v1")).rows).toEqual([{count:0}]);
});
test("financial observation after claim prevents completion",async()=>{
  await record();const a=await claimActivation();
  await db.exec("insert into payment_refund_state(stripe_payment_intent_id,stripe_charge_id,charge_amount_cents,refunded_amount_cents) values('pi_owned','ch_owned',3333,1)");
  await expect(completeActivation(a.operation.lease_token)).rejects.toThrow("original provider proof");
});
test.each([{pause_collection:null},{default_payment_method:"pm_other"},{billing_cycle_anchor:1},{status:"canceled"},{ended_at:1}])("activation proof %p cannot complete",async change=>{
  await record();const a=await claimActivation();await expect(completeActivation(a.operation.lease_token,change)).rejects.toThrow("original provider proof");
});
async function initializePeriods(){return (await db.query<{result:any}>("select initialize_buyer_mentorship_periods_v1($1,$2,$3) result",
  [f.reservation.requestId,f.reservation.buyerId,f.context])).rows[0].result;}
test("persisted collection calendar preserves final cents and is idempotent without debit admission",async()=>{
  await record();const a=await claimActivation();await completeActivation(a.operation.lease_token);
  const first=await initializePeriods();expect(first).toEqual({reservationId:f.reservation.id,periodCount:2,collectionAllowed:false});
  expect(await initializePeriods()).toEqual(first);
  const rows=(await db.query<{payment_number:number;amount:number;due:string;ending:string;invoice_id:string|null;admitted_at:string|null;counted_at:string|null}>("select payment_number,amount_cents::integer amount,due_at::text due,period_end::text ending,invoice_id,admitted_at,counted_at from buyer_mentorship_collection_periods_v1 order by payment_number")).rows;
  expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({payment_number:2,amount:3333,due:String(proof.nextPaymentAt),invoice_id:null,admitted_at:null,counted_at:null});
  expect(rows[1]).toMatchObject({payment_number:3,amount:3335,due:rows[0].ending,invoice_id:null,admitted_at:null,counted_at:null});
  expect(rows[1].ending).toBe(String(activationRequest().params.cancel_at));
});
test("period materialization cannot precede activation",async()=>{
  await record();await expect(initializePeriods()).rejects.toThrow("completed original activation");
});
test("period reader role cannot silently rewrite the original calendar",async()=>{
  await record();const a=await claimActivation();await completeActivation(a.operation.lease_token);await initializePeriods();
  await expect(db.exec("update buyer_mentorship_collection_periods_v1 set due_at=due_at+1")).rejects.toThrow("permission denied");
});

async function syntheticDuePeriod(daysAgo=45) {
  // Local fixture simulates an activation completed 45 days ago. It is not
  // hosted activation evidence and does not release any real collection hold.
  await db.exec("rollback");await seed(buyerFirstCaptureFixture(36,Math.floor(Date.now()/1000)-daysAgo*86400));await record();
  await db.exec("reset role");
  await db.query("insert into buyer_mentorship_activation_operations_v1(reservation_id,item_id,request,first_dispatch_at,completed_at,provider_request_id) values($1,'si_owned',$2,$3,$3,'req_synthetic')",
    [f.reservation.id,activationRequest(),new Date((proof.paidAt+10)*1000).toISOString()]);
  await db.exec("update buyer_mentorship_billing_state_v1 set collection_hold_at=null,collection_enabled_at=now()-interval '44 days';set local role service_role");
  await initializePeriods();
  const period=(await db.query<{due_at:number;period_end:number}>("select due_at::float8,period_end::float8 from buyer_mentorship_collection_periods_v1 where payment_number=2")).rows[0];
  return {object:"invoice",id:"in_due",livemode:false,customer:"cus_owned",parent:{subscription_details:{subscription:"sub_owned"}},currency:"usd",
    billing_reason:"subscription_cycle",status:"draft",auto_advance:false,amount_paid:0,attempted:false,attempt_count:0,
    lines:{has_more:false,data:[{period:{start:period.due_at,end:period.period_end},parent:{subscription_item_details:{subscription_item:"si_owned"}}}]}};
}
async function claimInvoice(invoice:object,number=2){return (await db.query<{result:any}>("select claim_buyer_mentorship_invoice_v1($1,$2,$3,$4,$5) result",
  [f.reservation.requestId,f.reservation.buyerId,f.context,number,invoice])).rows[0].result;}
test("due-period preparation binds original invoice and immutable buyer authorization without pay permission",async()=>{
  const inv=await syntheticDuePeriod(),first=await claimInvoice(inv);expect(first.status).toBe("claimed");expect(first.paymentAllowed).toBe(false);
  expect(first.claim.authorization_snapshot).toMatchObject({protocol:"buyer-mentorship-installments-v1",buyerReservationId:f.reservation.id,buyerRequestId:f.reservation.requestId,
    totalCents:10001,paymentNumber:2,invoiceId:"in_due",feeSchedule:f.reservation.terms.renewalFeeSchedule});
  expect(first.claim.authorization_snapshot).not.toHaveProperty("bookingPaymentId");
  expect((await claimInvoice(inv)).status).toBe("busy");
  await db.exec("update buyer_mentorship_invoice_claims_v1 set lease_until=now()-interval '1 second'");
  const retry=await claimInvoice(inv);expect(retry.status).toBe("claimed");
  expect(retry.claim.idempotency_prefix).toBe(first.claim.idempotency_prefix);expect(retry.claim.authorization_snapshot).toEqual(first.claim.authorization_snapshot);
  expect(retry.claim.lease_token).not.toBe(first.claim.lease_token);
});
test("a competing invoice cannot replace the period binding",async()=>{
  const inv=await syntheticDuePeriod();await claimInvoice(inv);await expect(claimInvoice({...inv,id:"in_other"})).rejects.toThrow("Original buyer invoice differs");
});
test.each(["collection","financial","debit"])("%s hold prevents invoice preparation",async hold=>{
  const inv=await syntheticDuePeriod();const column=hold==="collection"?"collection_hold_at":hold==="financial"?"financial_hold_at":"debit_revoked_at";
  await db.exec(`reset role;update buyer_mentorship_billing_state_v1 set ${column}=now();set local role service_role`);
  await expect(claimInvoice(inv)).rejects.toThrow("collection state");
});
test("cannot skip the earlier unpaid period",async()=>{
  const inv=await syntheticDuePeriod();await expect(claimInvoice(inv,3)).rejects.toThrow("collection state");
});
test.each([{customer:"cus_other"},{auto_advance:true},{attempt_count:1},{livemode:true}])("provider mismatch %p cannot bind",async change=>{
  const inv=await syntheticDuePeriod();await expect(claimInvoice({...inv,...change})).rejects.toThrow("provider identity");
});
test("original preparation key is immutable",async()=>{
  const inv=await syntheticDuePeriod();await claimInvoice(inv);await expect(db.exec("update buyer_mentorship_invoice_claims_v1 set idempotency_prefix='replacement'")).rejects.toThrow("immutable");
});
function invoiceRequests(claim:any){return heldInvoicePreparationRequests(claim.authorization_snapshot as BuyerHeldInvoiceAuthorization,{
  expectedLiveMode:false,collectionVersion:"buyer-mentorship-collection-v1",idempotencyPrefix:claim.idempotency_prefix,assertSubscription:()=>{},
  metadata:{creatornet_installment_version:"buyer-mentorship-installments-v1",terms_fingerprint:f.reservation.fingerprint,payment_mode:f.context.mode,
    platform_account_id:f.context.platformAccountId,supabase_project_ref:f.context.supabaseProjectRef,site_origin:f.context.siteOrigin}});}
async function prepareOperation(claim:any,step="configure",changed?:object,token=claim.lease_token){
  const requests=invoiceRequests(claim),params=changed??(step==="configure"?requests.configure:step==="finalize"?requests.finalize:requests.adjustment);
  const request={apiVersion:"2025-10-29.clover",method:"POST",path:`/v1/invoices/in_due${step==="finalize"?"/finalize":step==="final-cent"?"/add_lines":""}`,params};
  return (await db.query<{result:any}>("select prepare_buyer_mentorship_invoice_operation_v1($1,$2,$3,$4,$5,$6,$7) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,2,token,step,request])).rows[0].result;
}
test("SQL operation request equals existing shared preparer and retries preserve first body/key/time",async()=>{
  const inv=await syntheticDuePeriod(),{claim}=await claimInvoice(inv);
  const first=await prepareOperation(claim),retry=await prepareOperation(claim);
  expect(retry.operation).toEqual(first.operation);expect(first.paymentAllowed).toBe(false);
  expect(first.operation.request.params).toEqual(invoiceRequests(claim).configure);
  expect(first.operation.idempotency_key).toBe(`${claim.idempotency_prefix}:configure`);
  expect((await prepareOperation(claim,"finalize")).operation.request.params).toEqual({auto_advance:false});
});
test.each(["fees","destination","automatic advance"])("altered %s cannot be persisted for dispatch",async issue=>{
  const inv=await syntheticDuePeriod(),{claim}=await claimInvoice(inv),params:any={...invoiceRequests(claim).configure};
  if(issue==="fees")params.application_fee_amount=1;
  if(issue==="destination")params.transfer_data={destination:"acct_other"};
  if(issue==="automatic advance")params.auto_advance=true;
  await expect(prepareOperation(claim,"configure",params)).rejects.toThrow("original terms");
});
test("new financial hold between invoice claim and preparation blocks dispatch",async()=>{
  const inv=await syntheticDuePeriod(),{claim}=await claimInvoice(inv);
  await db.exec("reset role;update buyer_mentorship_billing_state_v1 set financial_hold_at=now();set local role service_role");
  await expect(prepareOperation(claim)).rejects.toThrow("admission");
});
test("stale parent token cannot prepare a step",async()=>{
  const inv=await syntheticDuePeriod(),{claim}=await claimInvoice(inv);
  await expect(prepareOperation(claim,"configure",undefined,"10000000-0000-4000-8000-000000000099")).rejects.toThrow("admission");
});
test("non-final period cannot add a residual adjustment",async()=>{
  const inv=await syntheticDuePeriod(),{claim}=await claimInvoice(inv);await expect(prepareOperation(claim,"final-cent")).rejects.toThrow("no final adjustment");
});
async function paymentEvidence(){
  const invoice=await syntheticDuePeriod(),{claim}=await claimInvoice(invoice);
  return {claim,invoice:{...invoice,status:"open",amount_due:3333,amount_remaining:3333,
    metadata:invoiceRequests(claim).configure.metadata},
    intent:{object:"payment_intent",id:"pi_due",livemode:false,customer:"cus_owned",currency:"usd",amount:3333,amount_received:0,
      latest_charge:null,status:"requires_payment_method",application_fee_amount:527,transfer_data:{destination:f.reservation.destinationId},payment_method_types:["card"]},
    method:{object:"payment_method",id:"pm_owned",customer:"cus_owned",livemode:false,type:"card",billing_details:{address:{country:"US"}}},
    link:{invoice:"in_due",is_default:true,livemode:false,currency:"usd",status:"open",amount_requested:3333,amount_paid:null,payment:{type:"payment_intent",payment_intent:"pi_due"}},
    request:{apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/invoices/in_due/pay",params:{payment_method:"pm_owned",off_session:true}}};
}
async function admitPayment(e:Awaited<ReturnType<typeof paymentEvidence>>){return (await db.query<{result:any}>("select admit_buyer_mentorship_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result",
  [f.reservation.requestId,f.reservation.buyerId,f.context,2,e.claim.lease_token,e.invoice,e.intent,e.method,e.link,e.request])).rows[0].result;}
test("only first admission permits one dispatch; repeats reconcile original request even after debit stop",async()=>{
  const e=await paymentEvidence(),first=await admitPayment(e);expect(first.status).toBe("dispatch_once");
  expect(first.admission.request).toEqual(e.request);expect(first.admission.payment_intent_id).toBe("pi_due");
  const repeat=await admitPayment(e);expect(repeat).toEqual({...first,status:"reconcile_admitted"});
  await db.exec("reset role;update buyer_mentorship_billing_state_v1 set debit_revoked_at=now();set local role service_role");
  expect(await admitPayment(e)).toEqual(repeat);
  expect((await db.query("select count(*)::integer count from buyer_mentorship_payment_admissions_v1")).rows).toEqual([{count:1}]);
});
test.each(["foreign card","non-US address","fee mismatch","wrong link","already attempted"])("%s cannot admit a debit",async issue=>{
  const e=await paymentEvidence();
  if(issue==="foreign card")e.method.customer="cus_other";
  if(issue==="non-US address")e.method.billing_details.address.country="CA";
  if(issue==="fee mismatch")e.intent.application_fee_amount=1;
  if(issue==="wrong link")e.link.payment.payment_intent="pi_other";
  if(issue==="already attempted")e.invoice.attempt_count=1;
  await expect(admitPayment(e)).rejects.toThrow("provider evidence");
});
test("stopping debit before admission prevents dispatch",async()=>{
  const e=await paymentEvidence();await db.exec("reset role;update buyer_mentorship_billing_state_v1 set debit_revoked_at=now();set local role service_role");
  await expect(admitPayment(e)).rejects.toThrow("admission requires review");
});
test("caller cannot change pay request to a different saved card",async()=>{
  const e=await paymentEvidence();e.request.params.payment_method="pm_other";await expect(admitPayment(e)).rejects.toThrow("request differs");
});
test("admitted requests cannot be overwritten by service role",async()=>{
  const e=await paymentEvidence();await admitPayment(e);await expect(db.exec("update buyer_mentorship_payment_admissions_v1 set request='{}'")).rejects.toThrow("permission denied");
});

async function laterCapture() {
  const evidence=await paymentEvidence();await admitPayment(evidence);
  const payment=calculateInstallmentPlan(f.reservation.terms.amountCents,f.reservation.terms.paymentCount,
    f.reservation.terms.renewalFeeSchedule,f.reservation.terms.firstPaymentFeeSchedule).payments[1];
  return {version:"buyer-mentorship-later-capture-v1",reservationId:f.reservation.id,requestId:f.reservation.requestId,
    buyerId:f.reservation.buyerId,creatorId:f.reservation.terms.creatorId,termsFingerprint:f.reservation.fingerprint,context:f.context,
    paymentNumber:2,invoiceId:"in_due",paymentIntentId:"pi_due",chargeId:"ch_due",balanceTransactionId:"txn_due",transferId:"tr_due",
    paymentMethodId:"pm_owned",customerId:"cus_owned",subscriptionId:"sub_owned",destinationId:f.reservation.destinationId,
    amountCents:payment.amountCents,fees:payment.fees,actualStripeFeeCents:127,paidAt:Math.floor(Date.now()/1000),buyerCountry:"US"};
}
async function recordLater(p:object,buyer=f.reservation.buyerId,context=f.context) {
  return (await db.query<{result:any}>("select record_buyer_mentorship_later_receipt_v1($1,$2,$3,$4) result",
    [f.reservation.requestId,buyer,context,p])).rows[0].result;
}
test("later receipt atomically credits once, advances the original calendar and preserves service expiry",async()=>{
  const p=await laterCapture(),first=await recordLater(p);
  expect(first).toMatchObject({recorded:true,reservationId:f.reservation.id,paymentNumber:2});
  expect(await recordLater(p)).toEqual({...first,recorded:false});await db.exec("set constraints all immediate");
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:5712}]);
  expect((await db.query("select count(*)::integer count from payment_fee_ledger")).rows).toEqual([{count:2}]);
  expect((await db.query("select paid_count,service_end_at::text ending,next_payment_at=(select due_at from buyer_mentorship_collection_periods_v1 where payment_number=3) correct_next from buyer_mentorship_billing_state_v1")).rows)
    .toEqual([{paid_count:2,ending:String(proof.serviceEndsAt),correct_next:true}]);
  expect((await db.query<{result:any}>("select read_buyer_mentorship_entitlement_v1($1,$2) result",[first.purchaseId,f.reservation.buyerId])).rows[0].result.allowed).toBe(true);
});
test("paid receipt before recovery preserves collection eligibility and duplicate recovery never inserts a hold",async()=>{
  const capture=await laterCapture();await recordLater(capture);
  const paid={invoiceStatus:"paid",paymentStatus:"succeeded",amountReceived:3333,amountCapturable:0,canceledAt:null,voidedAt:null};
  expect(await finishPaymentRecovery(await beginPaymentRecovery(),"paid_accounted",paid)).toBe(true);
  expect(await finishPaymentRecovery(await beginPaymentRecovery(),"paid_accounted",paid)).toBe(true);
  expect((await db.query("select paid_count,collection_hold_at is null unheld,next_payment_at=(select due_at from buyer_mentorship_collection_periods_v1 where payment_number=3) next_agreed from buyer_mentorship_billing_state_v1")).rows)
    .toEqual([{paid_count:2,unheld:true,next_agreed:true}]);
  expect((await db.query("select count(*)::integer n from buyer_mentorship_later_receipts_v1")).rows).toEqual([{n:1}]);
});
test.each(["recovery","operational","debit stop"])("paid-first recovery preserves an existing %s hold",async kind=>{
  const capture=await laterCapture();
  if(kind==="recovery")await beginPaymentRecovery();
  else {await db.exec("reset role;update buyer_mentorship_billing_state_v1 set collection_hold_at=now();set local role service_role");if(kind==="debit stop")await revokeDebit();}
  const before=(await db.query("select collection_hold_at from buyer_mentorship_billing_state_v1")).rows[0];
  await recordLater(capture);expect(await finishPaymentRecovery(await beginPaymentRecovery(),"paid_accounted",
    {invoiceStatus:"paid",paymentStatus:"succeeded",amountReceived:3333,amountCapturable:0,canceledAt:null,voidedAt:null})).toBe(true);
  expect((await db.query("select collection_hold_at from buyer_mentorship_billing_state_v1")).rows[0]).toEqual(before);
});
test("debit revocation and collection hold after admission do not erase captured money or authorize another debit",async()=>{
  const p=await laterCapture();await db.exec("reset role;update buyer_mentorship_billing_state_v1 set debit_revoked_at=now(),collection_hold_at=now();set local role service_role");
  expect((await recordLater(p)).recorded).toBe(true);
  expect((await db.query("select debit_revoked_at is not null stopped,collection_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{stopped:true,held:true}]);
  expect((await db.query("select count(*)::integer count from buyer_mentorship_payment_admissions_v1")).rows).toEqual([{count:1}]);
});
test.each(["paymentIntentId","invoiceId","paymentMethodId","amountCents","termsFingerprint","customerId","subscriptionId","paymentNumber","buyerCountry"])("later capture rejects changed %s",async key=>{
  const p:any=await laterCapture();p[key]=typeof p[key]==="number"?99:"other";await expect(recordLater(p)).rejects.toThrow();
});
test("later receipt rejects capture before admission",async()=>{
  const p=await laterCapture();p.paidAt-=120;await expect(recordLater(p)).rejects.toThrow("original admitted payment");
});
test("later receipt rollback includes creator credit and count when a late constraint fails",async()=>{
  const p=await laterCapture();await db.exec("reset role;alter table profiles add constraint fixture_credit_limit check(total_earnings_cents<5000);set local role service_role;savepoint failed_credit");
  await expect(recordLater(p)).rejects.toThrow("fixture_credit_limit");await db.exec("rollback to savepoint failed_credit");
  expect((await db.query("select count(*)::integer count from buyer_mentorship_later_receipts_v1")).rows).toEqual([{count:0}]);
  expect((await db.query("select paid_count from buyer_mentorship_billing_state_v1")).rows).toEqual([{paid_count:1}]);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2906}]);
});
test("out-of-order refund blocks clean later credit",async()=>{
  const p=await laterCapture();await db.exec("insert into payment_refund_state(stripe_payment_intent_id,stripe_charge_id,charge_amount_cents,refunded_amount_cents) values('pi_due','ch_due',3333,1)");
  await expect(recordLater(p)).rejects.toThrow("financial reconciliation");
});
test("later receipt cannot be replaced on duplicate delivery",async()=>{
  const p=await laterCapture();await recordLater(p);await expect(recordLater({...p,chargeId:"ch_other"})).rejects.toThrow("immutable");
});
test("service role cannot increment count or mark a period paid without receipt accounting",async()=>{
  await laterCapture();await db.exec("savepoint bad_count");
  await expect(db.exec("update buyer_mentorship_billing_state_v1 set paid_count=2,revision=revision+1")).rejects.toThrow("atomic original receipt");
  await db.exec("rollback to savepoint bad_count");
  await expect(db.exec("update buyer_mentorship_collection_periods_v1 set counted_at=now() where payment_number=2")).rejects.toThrow("original invoice/payment admission and receipt");
});

async function enableCollection(changes:Record<string,unknown>={}) {
  const params=activationRequest().params;
  return (await db.query<{result:any}>("select enable_buyer_mentorship_collection_v1($1,$2,$3,$4) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,{...f.data.subscription,...params,billing_cycle_anchor:params.trial_end,
      metadata:{...f.data.subscription.metadata,...params.metadata},...changes}])).rows[0].result;
}
async function revokeDebit(buyer=f.reservation.buyerId) {
  return (await db.query<{result:any}>("select revoke_buyer_mentorship_debit_v1($1,$2,$3) result",
    [f.reservation.requestId,buyer,f.context])).rows[0].result;
}
test("legitimate initial release requires completed activation and persists original periods once",async()=>{
  await record();const a=await claimActivation();await completeActivation(a.operation.lease_token);
  const enabled=await enableCollection();expect(enabled.status).toBe("collection_enabled");expect(await enableCollection()).toEqual(enabled);
  expect((await db.query("select collection_hold_at is null released,collection_enabled_at is not null recorded from buyer_mentorship_billing_state_v1")).rows).toEqual([{released:true,recorded:true}]);
  expect((await db.query("select count(*)::integer count from buyer_mentorship_collection_periods_v1")).rows).toEqual([{count:2}]);
  expect((await db.query("select count(*)::integer count from buyer_mentorship_payment_admissions_v1")).rows).toEqual([{count:0}]);
});
test("initial hold cannot release before original activation completes",async()=>{
  await record();await expect(enableCollection()).rejects.toThrow("activation proof");
});
test.each([{pause_collection:null},{default_payment_method:"pm_other"},{cancel_at:1},{customer:"cus_other"}])("changed provider %p prevents initial hold release",async change=>{
  await record();const a=await claimActivation();await completeActivation(a.operation.lease_token);await expect(enableCollection(change)).rejects.toThrow("activation proof");
});
test("replaying activation cannot release a new hold",async()=>{
  await record();const a=await claimActivation();await completeActivation(a.operation.lease_token);await enableCollection();
  await db.exec("update buyer_mentorship_billing_state_v1 set collection_hold_at=now()");
  await expect(enableCollection()).rejects.toThrow("held after activation");
});
test("debit stop is idempotent and prevents initial enablement",async()=>{
  await record();const a=await claimActivation();await completeActivation(a.operation.lease_token);
  const stopped=await revokeDebit();expect(stopped).toMatchObject({status:"new_debits_stopped",pending:[]});expect(await revokeDebit()).toEqual(stopped);
  await expect(enableCollection()).rejects.toThrow("activation proof");
});
test("stop before admission wins the same lock and denies dispatch",async()=>{
  const e=await paymentEvidence();expect((await revokeDebit()).status).toBe("new_debits_stopped");
  await expect(admitPayment(e)).rejects.toThrow("admission requires review");
});
test("admission before stop remains pending until its original capture is accounted",async()=>{
  const p=await laterCapture();const stopped=await revokeDebit();
  expect(stopped).toMatchObject({status:"admitted_payment_pending",pending:[{invoiceId:"in_due",paymentIntentId:"pi_due",paymentNumber:2}]});
  await recordLater(p);expect(await revokeDebit()).toEqual({...stopped,status:"new_debits_stopped",pending:[]});
});
test("revoked debit cannot be cleared directly",async()=>{
  await record();await revokeDebit();await expect(db.exec("update buyer_mentorship_billing_state_v1 set debit_revoked_at=null")).rejects.toThrow("cannot reopen");
});

async function refundReceipt(paymentIntentId="pi_owned") {
  return (await db.query<{result:any}>("select read_buyer_mentorship_credited_payment_v1($1,$2,$3,$4) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,paymentIntentId])).rows[0].result;
}
async function applyRefund(amount:number,pi="pi_owned",charge="ch_owned",event="evt_refund") {
  return (await db.query<{result:any}>("select apply_buyer_mentorship_refund_v1($1,$2,$3,$4,$5,$6,$7,$8) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,event,pi,charge,3333,amount])).rows[0].result;
}
test("first receipt refund reuses cumulative ledger reversal, preserves debt and denies access",async()=>{
  const receipt=await record();expect((await refundReceipt()).ledgerId).toBe(receipt.ledgerId);
  const applied=await applyRefund(1000);expect(applied).toMatchObject({cumulativeRefundedCents:1000,reversedCents:842});
  expect((await applyRefund(1000)).reversedCents).toBe(0);
  expect((await applyRefund(500,"pi_owned","ch_owned","evt_older")).cumulativeRefundedCents).toBe(1000);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2064}]);
  expect((await db.query("select paid_count,financial_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{paid_count:1,held:true}]);
  const access=(await db.query<{result:any}>("select read_buyer_mentorship_entitlement_v1($1,$2) result",[receipt.purchaseId,f.reservation.buyerId])).rows[0].result;
  expect(access.allowed).toBe(false);expect(access.financialAccess).toBe(false);
});
test("later refund reverses its original ledger once without touching other installments",async()=>{
  const p=await laterCapture();await recordLater(p);const before=await refundReceipt("pi_due");
  expect(before.invoiceId).toBe("in_due");expect((await applyRefund(3333,"pi_due","ch_due")).reversedCents).toBe(2806);
  expect((await applyRefund(3333,"pi_due","ch_due")).reversedCents).toBe(0);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2906}]);
  expect((await db.query("select paid_count from buyer_mentorship_billing_state_v1")).rows).toEqual([{paid_count:2}]);
  expect((await refundReceipt("pi_due")).ledgerId).toBe(before.ledgerId);
});
test("a refund event cannot change its original payment identity",async()=>{
  await record();await applyRefund(1000);await expect(applyRefund(1000,"pi_owned","ch_other")).rejects.toThrow("original payment binding");
});
test("foreign or uncredited payment cannot adopt refund accounting",async()=>{
  await record();expect(await refundReceipt("pi_other")).toBeNull();await expect(applyRefund(1,"pi_other","ch_other")).rejects.toThrow("original payment binding");
});
test("late refund failure rolls back observation, reversal and hold together",async()=>{
  await record();await db.exec("reset role;alter table profiles add constraint fixture_refund_floor check(total_earnings_cents>2000);set local role service_role;savepoint bad_refund");
  await expect(applyRefund(3333)).rejects.toThrow("fixture_refund_floor");await db.exec("rollback to savepoint bad_refund");
  expect((await db.query("select count(*)::integer count from payment_refund_state")).rows).toEqual([{count:0}]);
  expect((await db.query("select financial_hold_at from buyer_mentorship_billing_state_v1")).rows).toEqual([{financial_hold_at:null}]);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2906}]);
});

async function recoverRefundedCapture(p:object=proof,amount=1000,event="evt_early") {
  return (await db.query<{result:any}>("select record_buyer_mentorship_refunded_capture_v1($1,$2,$3,$4,$5,$6) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,p,event,amount])).rows[0].result;
}
test("refund before first receipt records capture and reversal atomically without activation",async()=>{
  const result=await recoverRefundedCapture();expect(result).toMatchObject({receiptRecorded:true,cumulativeRefundedCents:1000,reversedCents:842});
  expect((await recoverRefundedCapture()).receiptRecorded).toBe(false);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2064}]);
  expect((await db.query("select paid_count,financial_hold_at is not null held,collection_hold_at is not null collection_held from buyer_mentorship_billing_state_v1")).rows).toEqual([{paid_count:1,held:true,collection_held:true}]);
  expect((await db.query("select count(*)::integer count from buyer_mentorship_activation_operations_v1")).rows).toEqual([{count:0}]);
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
});
test("full refund before later receipt preserves the original period and net earnings",async()=>{
  const p=await laterCapture();expect(await recoverRefundedCapture(p,3333)).toMatchObject({receiptRecorded:true,reversedCents:2806});
  expect(await recoverRefundedCapture(p,3333)).toMatchObject({receiptRecorded:false,reversedCents:0});
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2906}]);
  expect((await db.query("select paid_count,financial_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{paid_count:2,held:true}]);
});
test("failure after first credit rolls back purchase, earnings, receipt and refund together",async()=>{
  await db.exec("reset role;alter table profiles add constraint fixture_recovery_floor check(total_earnings_cents>50);set local role service_role;savepoint bad_recovery");
  // A conflicting immutable event identity forces failure after original credit.
  await expect(recoverRefundedCapture(proof,3333,"invalid_event")).rejects.toThrow();
  await db.exec("rollback to savepoint bad_recovery");
  expect((await db.query("select count(*)::integer count from buyer_mentorship_first_receipts_v1")).rows).toEqual([{count:0}]);
  expect((await db.query("select count(*)::integer count from purchases")).rows).toEqual([{count:0}]);
  expect((await db.query("select count(*)::integer count from payment_fee_ledger")).rows).toEqual([{count:0}]);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:100}]);
});

async function holdDispute(event="evt_dispute",dispute="du_owned",pi="pi_owned",charge="ch_owned") {
  return (await db.query<{result:{revision:number;basis:unknown[]}}>("select hold_buyer_mentorship_dispute_v1($1,$2,$3,$4,$5,$6,$7) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,event,dispute,pi,charge])).rows[0].result;
}
async function applyDispute(revision:{revision:number;basis:unknown[]},status="needs_response",time=100,event="evt_dispute",dispute="du_owned",pi="pi_owned",charge="ch_owned") {
  return (await db.query<{result:string}>("select apply_buyer_mentorship_dispute_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,event,dispute,pi,charge,revision,1000,status,time])).rows[0].result;
}
test("owned dispute mirrors existing audit and holds access without debiting creator",async()=>{
  await record();const revision=await holdDispute();expect(await applyDispute(revision)).toBe("dispute_observed");
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2906}]);
  expect((await db.query("select dispute_status,disputed_amount_cents::integer amount from payment_fee_ledger")).rows).toEqual([{dispute_status:"needs_response",amount:1000}]);
  expect((await db.query("select financial_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{held:true}]);
});
test("competing stale dispute observation cannot overwrite current audit",async()=>{
  await record();const revision=await holdDispute();await applyDispute(revision,"under_review",200);
  expect(await applyDispute(revision,"needs_response",100)).toBe("reconciliation_required");
  expect((await db.query("select status from payment_dispute_state")).rows).toEqual([{status:"under_review"}]);
  const fresh=await holdDispute();expect(await applyDispute(fresh,"won",100)).toBe("dispute_observed");
  expect((await db.query("select status,stripe_event_created::integer watermark from payment_dispute_state")).rows).toEqual([{status:"won",watermark:200}]);
});
test("terminal dispute conflicts remain explicit review without restoring access or earnings",async()=>{
  await record();await applyDispute(await holdDispute(),"lost");
  expect(await applyDispute(await holdDispute(),"won",200)).toBe("dispute_review_recorded");
  expect((await db.query("select status from payment_dispute_state")).rows).toEqual([{status:"lost"}]);
  expect((await db.query("select disposition from buyer_mentorship_dispute_events_v1")).rows).toEqual([{disposition:"dispute_review_recorded"}]);
});
test("later dispute only updates the admitted installment ledger",async()=>{
  const p=await laterCapture();await recordLater(p);
  const revision=await holdDispute("evt_later","du_later","pi_due","ch_due");
  expect(await applyDispute(revision,"lost",100,"evt_later","du_later","pi_due","ch_due")).toBe("dispute_observed");
  expect((await db.query("select dispute_status from payment_fee_ledger where stripe_payment_intent_id='pi_owned'")).rows).toEqual([{dispute_status:null}]);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:5712}]);
});
test("foreign dispute event identity cannot be adopted",async()=>{
  await record();await holdDispute();await expect(holdDispute("evt_dispute","du_other")).rejects.toThrow("Original buyer dispute event differs");
});

test("concurrent shared dispute writer invalidates provider observation even without billing revision change",async()=>{
  await record();const snapshot=await holdDispute();
  await db.exec("select record_payment_dispute_state('du_owned','pi_owned','ch_owned',1000,'usd','under_review',300)");
  expect(await applyDispute(snapshot,"needs_response",100)).toBe("reconciliation_required");
  expect((await db.query("select status from payment_dispute_state")).rows).toEqual([{status:"under_review"}]);
});

async function recoverDisputedCapture(p:object=proof,status="needs_response") {
  return (await db.query<{result:string}>("select record_buyer_mentorship_disputed_capture_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,p,"evt_earlydispute","du_early",1000,status,100])).rows[0].result;
}
test("first dispute preceding receipt records audit and hold with original credit atomically",async()=>{
  expect(await recoverDisputedCapture()).toBe("dispute_observed");
  expect((await db.query("select dispute_status from payment_fee_ledger")).rows).toEqual([{dispute_status:"needs_response"}]);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2906}]);
  expect((await db.query("select financial_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{held:true}]);
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
  expect(await recoverDisputedCapture(proof,"won")).toBe("reconciliation_required");
  expect((await db.query("select status from payment_dispute_state")).rows).toEqual([{status:"needs_response"}]);
});
test("later dispute preceding receipt preserves original payment count and financial hold",async()=>{
  const p=await laterCapture();expect(await recoverDisputedCapture(p)).toBe("dispute_observed");
  expect((await db.query("select paid_count,financial_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{paid_count:2,held:true}]);
  expect((await db.query("select dispute_status from payment_fee_ledger where stripe_payment_intent_id='pi_due'")).rows).toEqual([{dispute_status:"needs_response"}]);
});
test("late dispute validation failure rolls back the newly created receipt and earnings",async()=>{
  await db.exec("savepoint invalid_dispute");await expect(recoverDisputedCapture(proof,"unknown")).rejects.toThrow("Invalid buyer dispute evidence");
  await db.exec("rollback to savepoint invalid_dispute");
  expect((await db.query("select count(*)::integer count from buyer_mentorship_first_receipts_v1")).rows).toEqual([{count:0}]);
  expect((await db.query("select count(*)::integer count from payment_fee_ledger")).rows).toEqual([{count:0}]);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:100}]);
});

async function beginPaymentRecovery() {
  return (await db.query<{result:any}>("select begin_buyer_mentorship_payment_recovery_v1($1,$2,$3,$4) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,"in_due"])).rows[0].result;
}
async function finishPaymentRecovery(snapshot:object,outcome="action_required",evidence:object={invoiceStatus:"open",paymentStatus:"requires_action",amountReceived:0,amountCapturable:0,canceledAt:null,voidedAt:null}) {
  return (await db.query<{result:boolean}>("select finish_buyer_mentorship_payment_recovery_v1($1,$2,$3,$4,$5,$6,$7,$8) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,"in_due",snapshot,outcome,evidence,"evt_recovery"])).rows[0].result;
}
test("unpaid recovery preserves admission and earnings while recording a held action",async()=>{
  await laterCapture();const snapshot=await beginPaymentRecovery();expect(await finishPaymentRecovery(snapshot)).toBe(true);
  expect((await db.query("select outcome from buyer_mentorship_payment_recoveries_v1")).rows).toEqual([{outcome:"action_required"}]);
  expect((await db.query("select paid_count,collection_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{paid_count:1,held:true}]);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:2906}]);
  expect((await db.query("select count(*)::integer count from buyer_mentorship_payment_admissions_v1")).rows).toEqual([{count:1}]);
});
test("competing recovery observation cannot overwrite newer action state",async()=>{
  await laterCapture();const snapshot=await beginPaymentRecovery();expect(await finishPaymentRecovery(snapshot)).toBe(true);
  expect(await finishPaymentRecovery(snapshot,"payment_pending")).toBe(false);
});
test("capture racing unpaid recovery forces a fresh snapshot and cannot regress to unpaid",async()=>{
  const p=await laterCapture(),snapshot=await beginPaymentRecovery();await recordLater(p);
  expect(await finishPaymentRecovery(snapshot)).toBe(false);
  await expect(finishPaymentRecovery(await beginPaymentRecovery())).rejects.toThrow("cannot replace captured");
});
test("paid recovery requires original receipt accounting, not a provider status string",async()=>{
  await laterCapture();const evidence={invoiceStatus:"paid",paymentStatus:"succeeded",amountReceived:3333,amountCapturable:0,canceledAt:null,voidedAt:null};
  await expect(finishPaymentRecovery(await beginPaymentRecovery(),"paid_accounted",evidence)).rejects.toThrow("accounted receipt");
});

async function readBank() {
  return (await db.query<{result:any}>("select read_buyer_mentorship_bank_context_v1($1,$2,$3,$4) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,"in_due"])).rows[0].result;
}
async function readCardContext(outcome:string|null="payment_method_required") {
  return (await db.query<{result:any}>("select read_buyer_mentorship_recovery_action_context_v1($1,$2,$3,$4,$5) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,"in_due",outcome])).rows[0].result;
}
const setupId="10000000-0000-4000-8000-000000000099";
async function reserveCard(id=setupId,consent:any={accepted:true,consentVersion:"replacement-card-setup-v1"},buyer=f.reservation.buyerId) {
  return (await db.query<{result:any}>("select reserve_buyer_mentorship_card_setup_v1($1,$2,$3,$4,$5,$6) result",
    [f.reservation.requestId,buyer,f.context,"in_due",id,consent])).rows[0].result;
}
async function declinedRecovery() {
  await laterCapture();await finishPaymentRecovery(await beginPaymentRecovery(),"payment_method_required",
    {invoiceStatus:"open",paymentStatus:"requires_payment_method",amountReceived:0,amountCapturable:0,canceledAt:null,voidedAt:null});
}
async function cardOperation(name:"admit"|"bind",value:any) {
  return (await db.query<{result:any}>(`select ${name}_buyer_mentorship_card_setup_v1($1,$2,$3,$4,$5) result`,
    [f.reservation.requestId,f.reservation.buyerId,f.context,setupId,value])).rows[0].result;
}
function setupSession(s:any) {
  return {...s.request.params,id:"cs_test_originalsetup",object:"checkout.session",livemode:false,status:"open",
    payment_status:"no_payment_required",payment_intent:null,subscription:null,invoice:null,amount_total:null,
    created:Math.floor(Date.parse(s.created_at)/1000)};
}
async function savedCardFixture() {
  await declinedRecovery();const {setup}=await reserveCard();await cardOperation("admit",setup.request);await cardOperation("bind",setupSession(setup));
  const basis=await readCardContext();
  const si={id:"seti_original",object:"setup_intent",status:"succeeded",livemode:false,customer:"cus_owned",metadata:setup.request.params.metadata,
    payment_method:"pm_replacement",usage:"off_session",on_behalf_of:null,payment_method_types:["card"],created:Math.floor(Date.parse(setup.created_at)/1000)};
  const pm={id:"pm_replacement",object:"payment_method",type:"card",livemode:false,customer:"cus_owned",billing_details:{address:{country:"US"}}};
  const save=async()=> (await db.query<{result:any}>("select record_buyer_mentorship_saved_card_v1($1,$2,$3,$4,$5,$6,$7,$8) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,setupId,basis,"cs_test_originalsetup",si,pm])).rows[0].result;
  return {basis,si,pm,save};
}
const quoteId="10000000-0000-4000-8000-000000000088";
async function quoteRetry(future=false) {
  return (await db.query<{result:any}>("select quote_buyer_mentorship_retry_v1($1,$2,$3,$4,$5,$6) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,setupId,quoteId,future])).rows[0].result;
}
async function confirmRetry(consent:any={accepted:true,consentVersion:"single-invoice-pay-now-v1"}) {
  return (await db.query<{result:any}>("select confirm_buyer_mentorship_retry_v1($1,$2,$3,$4,$5) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,quoteId,consent])).rows[0].result;
}
const retryRequest=()=>({apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/invoices/in_due/pay",params:{payment_method:"pm_replacement",off_session:false}});
async function admitRetry(basis:any,request:any=retryRequest()) {
  return (await db.query<{result:any}>("select admit_buyer_mentorship_retry_v1($1,$2,$3,$4,$5,$6) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,quoteId,basis,request])).rows[0].result;
}
test("retry admission permits exactly one dispatch and replays only reconcile even after stop",async()=>{
  const card=await savedCardFixture();await card.save();await quoteRetry();await confirmRetry();
  const first=await admitRetry(card.basis);expect(first).toMatchObject({status:"dispatch_once",admission:{payment_intent_id:"pi_due",payment_method_id:"pm_replacement",request:retryRequest()}});
  expect(await admitRetry(card.basis)).toEqual({...first,status:"reconcile_admitted"});
  await revokeDebit();expect(await admitRetry(card.basis)).toEqual({...first,status:"reconcile_admitted"});
  expect((await db.query("select count(*)::integer count from buyer_mentorship_retry_admissions_v1")).rows).toEqual([{count:1}]);
});
test("replacement capture uses the same atomic receipt/earnings path exactly once after stop",async()=>{
  const card=await savedCardFixture();await card.save();await quoteRetry();await confirmRetry();await admitRetry(card.basis);await revokeDebit();
  const proof=replacementProof();
  const first=await recordLater(proof);expect(first.recorded).toBe(true);expect((await recordLater(proof)).recorded).toBe(false);
  expect((await db.query("select total_earnings_cents::integer amount from profiles")).rows).toEqual([{amount:5712}]);
  expect((await db.query("select count(*)::integer count from buyer_mentorship_later_receipts_v1")).rows).toEqual([{count:1}]);
});
test("a saved replacement card without retry admission is never captured-payment authority",async()=>{
  const proof=await laterCapture();proof.paymentMethodId="pm_replacement";
  await expect(recordLater(proof)).rejects.toThrow("original admitted payment");
});
test.each(["missing consent","changed request","stopped","stale basis"])("retry admission rejects %s",async scenario=>{
  const card=await savedCardFixture();await card.save();await quoteRetry();if(scenario!=="missing consent")await confirmRetry();
  if(scenario==="stopped")await revokeDebit();
  if(scenario==="stale basis")card.basis.billing.revision++;
  const request=retryRequest();if(scenario==="changed request")request.params.off_session=true;
  await expect(admitRetry(card.basis,request)).rejects.toThrow();
});
test("retry review freezes original amount/card without allowing a charge; consent stays separate",async()=>{
  const card=await savedCardFixture();await card.save();const reviewed=await quoteRetry();
  expect(reviewed).toMatchObject({paymentAllowed:false,quote:{amount_cents:3333,original_payment_intent_id:"pi_due",replacement_payment_method_id:"pm_replacement",future_card_option:false}});
  expect(await quoteRetry()).toEqual(reviewed);
  const confirmed=await confirmRetry();expect(confirmed).toMatchObject({paymentAllowed:false,consent:{future_card_accepted:false}});
  expect(await confirmRetry()).toEqual(confirmed);
});
test("remaining-card authorization is an explicit independent choice on the reviewed schedule",async()=>{
  const card=await savedCardFixture();await card.save();const reviewed=await quoteRetry(true);
  expect(reviewed.quote.future_card_periods).toEqual([expect.objectContaining({paymentNumber:3,amountCents:3335})]);
  expect((await confirmRetry()).consent.future_card_accepted).toBe(false);
  await expect(confirmRetry({accepted:true,consentVersion:"single-invoice-pay-now-v1",futureCardConsentVersion:"same-plan-remaining-card-v1"})).rejects.toThrow("cannot change");
});
test.each(["no consent","unexpected field","unoffered future","stop","stale snapshot"])("retry consent refuses %s",async scenario=>{
  const card=await savedCardFixture();await card.save();await quoteRetry();
  let consent:any={accepted:true,consentVersion:"single-invoice-pay-now-v1"};
  if(scenario==="no consent")consent=null;
  if(scenario==="unexpected field")consent.amountCents=1;
  if(scenario==="unoffered future")consent.futureCardConsentVersion="same-plan-remaining-card-v1";
  if(scenario==="stop")await revokeDebit();
  if(scenario==="stale snapshot")await finishPaymentRecovery(await beginPaymentRecovery(),"payment_method_required",
    {invoiceStatus:"open",paymentStatus:"requires_payment_method",amountReceived:0,amountCapturable:0,canceledAt:null,voidedAt:null});
  await expect(confirmRetry(consent)).rejects.toThrow();
});
test("saved-card proof is durable and idempotent without authorizing payment",async()=>{
  const f=await savedCardFixture(),first=await f.save();
  expect(first).toMatchObject({status:"card_saved_payment_not_attempted",paymentAllowed:false,proof:{setup_intent_id:"seti_original",payment_method_id:"pm_replacement",billing_country:"US"}});
  expect(await f.save()).toEqual(first);
  f.si.payment_method=f.pm.id="pm_other";await expect(f.save()).rejects.toThrow("cannot change");
});
test.each(["non-US","foreign customer","incomplete setup","missing metadata","stop race","stale basis"])("saved-card proof rejects %s",async scenario=>{
  const f=await savedCardFixture();
  if(scenario==="non-US")f.pm.billing_details.address.country="CA";
  if(scenario==="foreign customer")f.pm.customer="cus_other";
  if(scenario==="incomplete setup")f.si.status="requires_action";
  if(scenario==="missing metadata")f.si.metadata={};
  if(scenario==="stop race")await revokeDebit();
  if(scenario==="stale basis")f.basis.billing.revision++;
  await expect(f.save()).rejects.toThrow();
});
test("setup retries retain original dispatch/key and immutable binding survives debit stop",async()=>{
  await declinedRecovery();const {setup}=await reserveCard();
  const first=await cardOperation("admit",setup.request),again=await cardOperation("admit",setup.request);
  expect(first.dispatchAllowed).toBe(true);expect(again.dispatch).toEqual(first.dispatch);expect(again.setup).toEqual(setup);
  await revokeDebit();const bound=await cardOperation("bind",setupSession(setup));
  expect(bound.binding.session_id).toBe("cs_test_originalsetup");expect(bound.paymentAllowed).toBe(false);
  expect(await cardOperation("bind",setupSession(setup))).toEqual(bound);
  expect((await cardOperation("admit",setup.request)).dispatchAllowed).toBe(false);
  await expect(cardOperation("bind",{...setupSession(setup),id:"cs_test_other"})).rejects.toThrow("cannot change");
});
test.each(["never admitted","wrong customer","payable","missing amount","wrong mode","changed metadata"])("setup binding rejects %s",async scenario=>{
  await declinedRecovery();const {setup}=await reserveCard();
  if(scenario!=="never admitted")await cardOperation("admit",setup.request);
  const session=setupSession(setup);
  if(scenario==="wrong customer")session.customer="cus_other";
  if(scenario==="payable")session.payment_intent="pi_other";
  if(scenario==="missing amount")delete session.amount_total;
  if(scenario==="wrong mode")session.livemode=true;
  if(scenario==="changed metadata")session.metadata={};
  await expect(cardOperation("bind",session)).rejects.toThrow();
});
test.each(["changed request","stopped debit"])("setup admission rejects %s",async scenario=>{
  await declinedRecovery();const {setup}=await reserveCard();
  if(scenario==="stopped debit")await revokeDebit();
  await expect(cardOperation("admit",scenario==="changed request"?{...setup.request,apiVersion:"other"}:setup.request)).rejects.toThrow();
});
test("buyer setup persists one original request matching shared provider parameters and consent",async()=>{
  await declinedRecovery();const result=await reserveCard(),s=result.setup;
  expect(result.paymentAllowed).toBe(false);expect(await reserveCard()).toEqual(result);
  expect(s.consent_text).toBe(CARD_SETUP_CONSENT_TEXT);
  const params=exactCardSetupParams({id:s.id,buyerId:s.buyer_id,buyerReservationId:s.reservation_id,buyerRequestId:f.reservation.requestId,
    invoiceId:s.invoice_id,originalPaymentIntentId:s.original_payment_intent_id,authorization:s.authorization_snapshot,
    createdAt:Math.floor(Date.parse(s.created_at)/1000),expiresAt:s.expires_at,sessionId:null,setupIntentId:null,paymentMethodId:null},f.context.siteOrigin);
  expect(s.request).toEqual({apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params});
  expect(s.idempotency_key).toBe(`cn-buyer-card-setup-v1:${setupId}`);
  await expect(reserveCard("10000000-0000-4000-8000-000000000098")).rejects.toThrow("original buyer card setup");
});
test.each(["no consent","foreign buyer","stopped debit","bank action"])("buyer setup reservation refuses %s",async scenario=>{
  if(scenario==="bank action"){await laterCapture();await finishPaymentRecovery(await beginPaymentRecovery());}
  else await declinedRecovery();
  if(scenario==="stopped debit")await revokeDebit();
  await expect(reserveCard(setupId,scenario==="no consent"?{accepted:false,consentVersion:"replacement-card-setup-v1"}:undefined,
    scenario==="foreign buyer"?"10000000-0000-4000-8000-000000000097":undefined)).rejects.toThrow();
});
test("replacement setup uses the same owned recovery context without authorizing bank authentication",async()=>{
  await laterCapture();await finishPaymentRecovery(await beginPaymentRecovery(),"payment_method_required",
    {invoiceStatus:"open",paymentStatus:"requires_payment_method",amountReceived:0,amountCapturable:0,canceledAt:null,voidedAt:null});
  expect(await readCardContext()).toMatchObject({paymentIntentId:"pi_due",paymentMethodId:"pm_owned",prior:[{paymentNumber:1,paymentIntentId:"pi_owned"}]});
  await db.exec("savepoint wrong_action");
  await expect(readBank()).rejects.toThrow("not authorized");
  await db.exec("rollback to savepoint wrong_action");
  await revokeDebit();await expect(readCardContext()).rejects.toThrow("not authorized");
});
test.each([null,"paid_accounted","processing"])("shared action context rejects unsupported outcome %s",async outcome=>{
  await expect(readCardContext(outcome)).rejects.toThrow("Unsupported buyer recovery action");
});
test("bank context requires recorded action state and returns the original card/history",async()=>{
  await laterCapture();await finishPaymentRecovery(await beginPaymentRecovery());const bound=await readBank();
  expect(bound).toMatchObject({paymentIntentId:"pi_due",paymentMethodId:"pm_owned",prior:[{paymentNumber:1,paymentIntentId:"pi_owned"}]});
  expect(bound.dependencies.customerId).toBe("cus_owned");expect(await readBank()).toEqual(bound);
});
test.each(["debit stop","financial hold","prior refund","missing recovery"])("bank context refuses %s",async problem=>{
  await laterCapture();if(problem!=="missing recovery")await finishPaymentRecovery(await beginPaymentRecovery());
  if(problem==="debit stop")await revokeDebit();
  if(problem==="financial hold")await db.exec("update buyer_mentorship_billing_state_v1 set financial_hold_at=now()");
  if(problem==="prior refund")await db.exec("insert into payment_refund_state(stripe_payment_intent_id,stripe_charge_id,charge_amount_cents,refunded_amount_cents) values('pi_owned','ch_owned',3333,1)");
  await expect(readBank()).rejects.toThrow("Buyer bank");
});

test("retry admission invalidates an older unpaid observation without releasing the collection hold",async()=>{
  const card=await savedCardFixture();await card.save();await quoteRetry();await confirmRetry();
  const before=await beginPaymentRecovery();
  await admitRetry(card.basis);
  expect(await finishPaymentRecovery(before)).toBe(false);
  const after=await beginPaymentRecovery();
  expect(after.revision).toBe(before.revision+1);
  expect(await finishPaymentRecovery(after)).toBe(true);
  const fresh=await beginPaymentRecovery();
  expect((await admitRetry(card.basis)).status).toBe("reconcile_admitted");
  expect(await beginPaymentRecovery()).toEqual(fresh);
  expect((await db.query("select paid_count,collection_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{paid_count:1,held:true}]);
});

function replacementProof() {
  const payment=calculateInstallmentPlan(f.reservation.terms.amountCents,3,f.reservation.terms.renewalFeeSchedule,f.reservation.terms.firstPaymentFeeSchedule).payments[1];
  const proof={version:"buyer-mentorship-later-capture-v1",reservationId:f.reservation.id,requestId:f.reservation.requestId,buyerId:f.reservation.buyerId,
    creatorId:f.reservation.terms.creatorId,termsFingerprint:f.reservation.fingerprint,context:f.context,paymentNumber:2,invoiceId:"in_due",paymentIntentId:"pi_due",
    chargeId:"ch_replacement",balanceTransactionId:"txn_replacement",transferId:"tr_replacement",paymentMethodId:"pm_replacement",customerId:"cus_owned",
    subscriptionId:"sub_owned",destinationId:f.reservation.destinationId,amountCents:3333,fees:payment.fees,actualStripeFeeCents:127,
    paidAt:Math.floor(Date.now()/1000),buyerCountry:"US"};
  return proof;
}

async function futureContext() {
  return (await db.query<{result:any}>("select read_buyer_mentorship_future_card_context_v1($1,$2,$3,$4) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,quoteId])).rows[0].result;
}
async function authorizeFuture(basis:unknown) {
  return (await db.query<{result:any}>("select authorize_buyer_mentorship_future_card_v1($1,$2,$3,$4,$5) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,quoteId,basis])).rows[0].result;
}
async function paidFutureFixture(accepted=true) {
  const card=await savedCardFixture();await card.save();await quoteRetry(true);
  await confirmRetry({accepted:true,consentVersion:"single-invoice-pay-now-v1",...(accepted?{futureCardConsentVersion:"same-plan-remaining-card-v1"}:{})});
  await admitRetry(card.basis);await recordLater(replacementProof());
}
test("future-card authorization requires paid consent and stays held on replay",async()=>{
  await paidFutureFixture();const basis=await futureContext();
  expect(basis).toMatchObject({paymentMethodId:"pm_replacement",originalDefaultPaymentMethodId:"pm_owned",afterPaymentNumber:2});
  const result=await authorizeFuture(basis);expect(result.status).toBe("authorized_held");expect(await authorizeFuture(basis)).toEqual(result);
  expect((await db.query("select count(*)::integer count from buyer_mentorship_future_card_authorizations_v1")).rows).toEqual([{count:1}]);
  expect((await db.query("select paid_count,collection_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{paid_count:2,held:true}]);
});
test("successful retry without separate future consent cannot authorize remaining debits",async()=>{
  await paidFutureFixture(false);await expect(futureContext()).rejects.toThrow("separate consent");
});
test("debit revocation invalidates future-card verification before authorization",async()=>{
  await paidFutureFixture();const basis=await futureContext();await revokeDebit();
  await expect(authorizeFuture(basis)).rejects.toThrow("clean paid state");
});
test("changed remaining schedule cannot inherit an older future-card consent",async()=>{
  await paidFutureFixture();await db.exec("reset role; update buyer_mentorship_retry_quotes_v1 set future_card_periods=jsonb_set(future_card_periods,'{0,dueAt}',to_jsonb((future_card_periods#>>'{0,dueAt}')::bigint+1)); set local role service_role");
  await expect(futureContext()).rejects.toThrow("remaining schedule changed");
});

test("future-card consent without accounted capture cannot authorize remaining payments",async()=>{
  const card=await savedCardFixture();await card.save();await quoteRetry(true);
  await confirmRetry({accepted:true,consentVersion:"single-invoice-pay-now-v1",futureCardConsentVersion:"same-plan-remaining-card-v1"});
  await admitRetry(card.basis);await expect(futureContext()).rejects.toThrow("clean paid state");
});
test("a financial hold cannot be cleared by authorizing a future card",async()=>{
  await paidFutureFixture();const basis=await futureContext();
  await db.exec("reset role; update buyer_mentorship_billing_state_v1 set financial_hold_at=now(); set local role service_role");
  await expect(authorizeFuture(basis)).rejects.toThrow("clean paid state");
});
test("future-card authorization rejects a changed verification snapshot",async()=>{
  await paidFutureFixture();const basis=await futureContext();basis.billing.revision++;
  await expect(authorizeFuture(basis)).rejects.toThrow("became stale");
});

test("new original-card claim pins an immutable card without future authority",async()=>{
  await claimInvoice(await syntheticDuePeriod());
  expect((await db.query("select invoice_id,payment_method_id,original_default_payment_method_id,authorization_quote_id from buyer_mentorship_invoice_cards_v1")).rows)
    .toEqual([{invoice_id:"in_due",payment_method_id:"pm_owned",original_default_payment_method_id:"pm_owned",authorization_quote_id:null}]);
  await expect(db.exec("update buyer_mentorship_invoice_cards_v1 set payment_method_id='pm_other'")).rejects.toThrow("permission denied");
});
test("future authorization binds only a newly inserted covered claim; previous claim keeps original card",async()=>{
  await paidFutureFixture();await authorizeFuture(await futureContext());
  // Direct local insertion tests card-binding semantics, not due-time admission
  // or release. Ordinary production claims retain their time/hold checks.
  const original=(await db.query<{authorization_snapshot:any}>("select authorization_snapshot from buyer_mentorship_invoice_claims_v1 where payment_number=2")).rows[0].authorization_snapshot;
  await db.query("insert into buyer_mentorship_invoice_claims_v1(reservation_id,payment_number,invoice_id,authorization_snapshot) values($1,3,'in_future',$2)",
    [f.reservation.id,{...original,paymentNumber:3,invoiceId:"in_future"}]);
  expect((await db.query("select payment_number,payment_method_id,authorization_quote_id from buyer_mentorship_invoice_cards_v1 order by payment_number")).rows)
    .toEqual([{payment_number:2,payment_method_id:"pm_owned",authorization_quote_id:null},{payment_number:3,payment_method_id:"pm_replacement",authorization_quote_id:quoteId}]);
  expect((await db.query("select collection_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{held:true}]);
});

test("recovery context preserves original default independently from its invoice card",async()=>{
  await declinedRecovery();const context=await readCardContext();
  expect(context).toMatchObject({paymentMethodId:"pm_owned",defaultPaymentMethodId:"pm_owned",cardAuthorizationId:null});
});

async function releaseFuture(basis:unknown) {
  return (await db.query<{result:any}>("select release_buyer_mentorship_future_collection_v1($1,$2,$3,$4,$5) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,quoteId,basis])).rows[0].result;
}
test("future collection release clears only the verified hold and is idempotent",async()=>{
  await paidFutureFixture();const basis=await futureContext();await authorizeFuture(basis);
  expect(await releaseFuture(basis)).toMatchObject({status:"collection_resumed",quoteId});
  expect(await releaseFuture(basis)).toMatchObject({status:"collection_resumed",quoteId});
  expect((await db.query("select paid_count,collection_hold_at is null released,revision from buyer_mentorship_billing_state_v1")).rows)
    .toEqual([{paid_count:2,released:true,revision:basis.billing.revision+1}]);
  expect((await db.query("select count(*)::integer count from buyer_mentorship_collection_releases_v1")).rows).toEqual([{count:1}]);
});
test.each(["stopped","financial hold","missing authorization","stale basis"])("future release rejects %s",async scenario=>{
  await paidFutureFixture();const basis=await futureContext();if(scenario!=="missing authorization")await authorizeFuture(basis);
  if(scenario==="stopped")await revokeDebit();
  if(scenario==="financial hold")await db.exec("update buyer_mentorship_billing_state_v1 set financial_hold_at=now()");
  if(scenario==="stale basis")basis.billing.revision++;
  await expect(releaseFuture(basis)).rejects.toThrow();
});
test("replaying a successful release cannot clear a newer operational hold",async()=>{
  await paidFutureFixture();const basis=await futureContext();await authorizeFuture(basis);await releaseFuture(basis);
  await db.exec("update buyer_mentorship_billing_state_v1 set collection_hold_at=now(),revision=revision+1");
  await expect(releaseFuture(basis)).rejects.toThrow("cannot reopen later state");
});
test("clearing a later hold directly still fails without its exact release record",async()=>{
  await paidFutureFixture();await expect(db.exec("update buyer_mentorship_billing_state_v1 set collection_hold_at=null,revision=revision+1"))
    .rejects.toThrow("cannot reopen stopped billing");
});

test("replaying recovery of a counted payment cannot impose another collection hold",async()=>{
  await paidFutureFixture();const basis=await futureContext();await authorizeFuture(basis);await releaseFuture(basis);
  const read=await beginPaymentRecovery();
  expect(await finishPaymentRecovery(read,"paid_accounted",{invoiceStatus:"paid",paymentStatus:"succeeded",amountReceived:3333,amountCapturable:0,canceledAt:null,voidedAt:null})).toBe(true);
  expect((await db.query("select collection_hold_at is null released from buyer_mentorship_billing_state_v1")).rows).toEqual([{released:true}]);
});

async function sameCardContext() {
  return (await db.query<{result:any}>("select read_buyer_mentorship_same_card_context_v1($1,$2,$3,$4) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,"in_due"])).rows[0].result;
}
async function releaseSameCard(basis:unknown) {
  return (await db.query<{result:any}>("select release_buyer_mentorship_same_card_v1($1,$2,$3,$4,$5) result",
    [f.reservation.requestId,f.reservation.buyerId,f.context,"in_due",basis])).rows[0].result;
}
async function paidOriginalHold() {
  const capture=await laterCapture();await beginPaymentRecovery();await recordLater(capture);return capture;
}
test("same-card release requires owned hold, accounted capture and preserves exact next period",async()=>{
  await paidOriginalHold();const basis=await sameCardContext();
  expect(basis).toMatchObject({status:"held",paymentMethodId:"pm_owned",cardAuthorizationId:null,afterPaymentNumber:2});
  const result=await releaseSameCard(basis);expect(result.status).toBe("collection_resumed");
  expect(await releaseSameCard(basis)).toEqual(result);
  expect((await db.query("select paid_count,collection_hold_at is null released,next_payment_at=(select due_at from buyer_mentorship_collection_periods_v1 where payment_number=3) exact_next from buyer_mentorship_billing_state_v1")).rows)
    .toEqual([{paid_count:2,released:true,exact_next:true}]);
  expect((await db.query("select count(*)::integer n from buyer_mentorship_same_card_releases_v1")).rows).toEqual([{n:1}]);
});
test("repeated begin retains exactly one hold owner and generation",async()=>{
  await laterCapture();const first=await beginPaymentRecovery();expect(await beginPaymentRecovery()).toEqual(first);
  expect((await db.query("select count(*)::integer n from buyer_mentorship_recovery_hold_owners_v1")).rows).toEqual([{n:1}]);
});
test("ordinary paid-before-begin never claims hold ownership",async()=>{
  const capture=await laterCapture();await recordLater(capture);await beginPaymentRecovery();
  expect((await db.query("select count(*)::integer n from buyer_mentorship_recovery_hold_owners_v1")).rows).toEqual([{n:0}]);
  expect(await sameCardContext()).toMatchObject({status:"not_held"});
});
test("an operational hold is never adopted by recovery",async()=>{
  const capture=await laterCapture();await db.exec("update buyer_mentorship_billing_state_v1 set collection_hold_at=clock_timestamp()");
  await beginPaymentRecovery();await recordLater(capture);
  expect((await db.query("select count(*)::integer n from buyer_mentorship_recovery_hold_owners_v1")).rows).toEqual([{n:0}]);
  await expect(sameCardContext()).rejects.toThrow("not eligible");
});
test.each(["new timestamp","same timestamp"])("%s rehold invalidates old ownership before release",async kind=>{
  await paidOriginalHold();const basis=await sameCardContext();
  await db.exec(`update buyer_mentorship_billing_state_v1 set collection_hold_at=${kind==="new timestamp"?"clock_timestamp()":"collection_hold_at"}`);
  await expect(releaseSameCard(basis)).rejects.toThrow("not eligible");
});
test("old successful release cannot clear later rehold",async()=>{
  await paidOriginalHold();const basis=await sameCardContext();await releaseSameCard(basis);
  await db.exec("update buyer_mentorship_billing_state_v1 set collection_hold_at=clock_timestamp(),revision=revision+1");
  await expect(releaseSameCard(basis)).rejects.toThrow("cannot reopen");
});
test.each(["debit stop","financial hold","prior refund","pending refund","dispute","stale revision","future claim"])("same-card release refuses %s without undoing accounting",async kind=>{
  await paidOriginalHold();const basis=await sameCardContext();
  if(kind==="debit stop")await revokeDebit();
  if(kind==="financial hold")await db.exec("update buyer_mentorship_billing_state_v1 set financial_hold_at=now()");
  if(kind==="prior refund")await db.exec("insert into payment_refund_state(stripe_payment_intent_id,stripe_charge_id,charge_amount_cents,refunded_amount_cents) values('pi_due','ch_due',3333,1)");
  if(kind==="pending refund")await db.exec("insert into refund_operations values('pi_due','pending')");
  if(kind==="dispute")await holdDispute("evt_later","du_later","pi_due","ch_due");
  if(kind==="stale revision")await db.exec("update buyer_mentorship_billing_state_v1 set revision=revision+1");
  if(kind==="future claim") {
    const original=(await db.query<{authorization_snapshot:any}>("select authorization_snapshot from buyer_mentorship_invoice_claims_v1 where payment_number=2")).rows[0].authorization_snapshot;
    await db.query("insert into buyer_mentorship_invoice_claims_v1(reservation_id,payment_number,invoice_id,authorization_snapshot) values($1,3,'in_future',$2)",[f.reservation.id,{...original,paymentNumber:3,invoiceId:"in_future"}]);
  }
  await db.exec("savepoint release_failure");await expect(releaseSameCard(basis)).rejects.toThrow();await db.exec("rollback to savepoint release_failure");
  expect((await db.query("select paid_count,collection_hold_at is not null held from buyer_mentorship_billing_state_v1")).rows).toEqual([{paid_count:2,held:true}]);
});
test("unaccounted provider success cannot authorize same-card release",async()=>{
  await laterCapture();await beginPaymentRecovery();await expect(sameCardContext()).rejects.toThrow("accounted original capture");
});
test("replacement retry cannot use original-card release even if it succeeds",async()=>{
  await paidFutureFixture();await expect(sameCardContext()).rejects.toThrow("original admitted card");
});
test.each(["anon","authenticated"])("%s cannot inspect or release same-card holds",async role=>{
  await paidOriginalHold();const basis=await sameCardContext();await db.exec(`set local role ${role}`);
  await expect(releaseSameCard(basis)).rejects.toThrow("permission denied");
});

test("counted held payment stays worker-visible before the next due date",async()=>{
  await paidOriginalHold();const rows=await leaseBuyerWork(false);
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({action:"recover",invoice_id:"in_due"});
  expect((await buyerWorkSummary()).pending).toBe(1);
});
test("lost release reply stays recoverable and exact original recovery clears worker attention",async()=>{
  await paidOriginalHold();const [first]=await leaseBuyerWork(false),basis=await sameCardContext();
  await releaseSameCard(basis);await finishBuyerWork(first.lease_token,"retry_required");
  expect((await buyerWorkSummary()).attention).toBe(1);
  await db.exec("update buyer_mentorship_worker_v1 set next_attempt_at=now()-interval '1 second'");
  const [second]=await leaseBuyerWork(false);expect(second.invoice_id).toBe("in_due");
  expect((await releaseSameCard(basis)).status).toBe("collection_resumed");
  await finishBuyerWork(second.lease_token,"accounted");
  expect(await buyerWorkSummary()).toEqual({pending:0,attention:0});
});
test("same-card release proof and hold update rollback together",async()=>{
  await paidOriginalHold();const basis=await sameCardContext();
  await db.exec("savepoint release_rollback");await releaseSameCard(basis);await db.exec("rollback to savepoint release_rollback");
  expect((await db.query("select count(*)::integer n from buyer_mentorship_same_card_releases_v1")).rows).toEqual([{n:0}]);
  expect(await sameCardContext()).toEqual(basis);
});
