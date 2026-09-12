/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";

declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const f = exactInstallmentFixture();
const t = f.terms;
const plan = f.agreement.id;
const purchase = "99999999-9999-4999-8999-999999999999";
jest.setTimeout(60000);

beforeAll(async () => {
  db = createLocalPostgres();
  // Minimal prerequisite model; real SQL bodies, no hosted database or Stripe.
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table profiles(id uuid primary key, stripe_account_id text, stripe_onboarding_complete boolean,
      total_earnings_cents bigint not null default 0);
    create table bookings(id uuid primary key, creator_id uuid, buyer_id uuid, post_id uuid, status text);
    create table booking_payments(id uuid primary key, booking_id uuid, buyer_id uuid, product_id uuid,
      plan_type text, status text, currency text, installment_months integer, amount_total_cents bigint,
      stripe_checkout_session_id text, stripe_subscription_id text, link_url text);
    create table purchases(id uuid primary key, buyer_id uuid, creator_id uuid, post_id uuid, product_id uuid,
      booking_id uuid, session_id text unique, subscription_id text, payment_intent_id text unique,
      target_months integer, currency text, paid_count integer default 0, access_granted boolean default false,
      status text, earnings_credited_at timestamptz, earnings_credited_cents integer,
      amount_cents integer, platform_fee_cents bigint, processing_fee_cents bigint,
      total_creator_deduction_cents bigint, creator_net_cents bigint, fee_schedule_version text);
    create table payment_fee_ledger(id uuid primary key default gen_random_uuid(), creator_id uuid, purchase_id uuid,
      booking_payment_id uuid, stripe_payment_intent_id text unique, stripe_invoice_id text unique,
      stripe_checkout_session_id text unique, stripe_charge_id text, stripe_balance_transaction_id text,
      gross_amount_cents bigint, platform_fee_cents bigint, processing_fee_cents bigint,
      total_creator_deduction_cents bigint, creator_net_cents bigint, actual_stripe_fee_cents bigint,
      processing_fee_variance_cents bigint, refunded_amount_cents bigint default 0,
      earnings_reversed_cents bigint default 0, platform_fee_refund_attribution_cents bigint default 0,
      processing_fee_refund_attribution_cents bigint default 0, refund_allocation_rounding_cents bigint default 0,
      currency text, fee_schedule_version text, status text, dispute_status text, earnings_credited_at timestamptz,
      updated_at timestamptz default now());
    create table payment_refund_state(stripe_payment_intent_id text primary key, stripe_charge_id text,
      charge_amount_cents bigint, refunded_amount_cents bigint);
    create table payment_dispute_state(stripe_payment_intent_id text, status text);
    create table refund_operations(stripe_payment_intent_id text, status text, stripe_refund_id text);
  `);
  const existing = readFileSync(join(process.cwd(), "supabase/schema/019-creator-processing-fees.sql"), "utf8");
  const definition = existing.match(/create or replace function public\.apply_payment_fee_ledger_refund\([\s\S]*?\$\$;/g);
  if (definition?.length !== 1) throw new Error("Expected the exact existing ledger refund RPC definition");
  await db.exec(definition[0]);
  for (const file of ["040-exact-installment-agreements.sql", "041-exact-installment-receipt-credit.sql",
    "042-exact-installment-activation.sql", "043-exact-installment-invoice-claims.sql"]) {
    await db.exec(readFileSync(join(process.cwd(), "supabase/schema", file), "utf8"));
  }
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`truncate exact_installment_invoice_claims, exact_installment_periods, exact_installment_activations,
    exact_installment_receipts, exact_installment_operations, exact_installment_agreements,
    payment_fee_ledger, payment_refund_state, payment_dispute_state, refund_operations,
    purchases, booking_payments, bookings, profiles;`);
  await db.query("insert into profiles values($1,'acct_fixture',true,0)", [t.creatorId]);
  await db.query("insert into bookings values($1,$2,$3,$4,'booked')", [t.bookingId, t.creatorId, t.buyerId, t.postId]);
  await db.query(`insert into booking_payments(id,booking_id,buyer_id,product_id,plan_type,status,currency,installment_months,amount_total_cents)
    values($1,$2,$3,$4,'installment','pending','usd',3,199900)`, [t.bookingPaymentId, t.bookingId, t.buyerId, t.productId]);
  await db.query("select public.create_exact_installment_agreement($1,$2,$3,$4)", [plan, t.bookingPaymentId, t.creatorId, JSON.stringify(t)]);
  for (const [step, result] of [["customer", "cus_fixture"], ["product", "prod_fixture"], ["subscription", "sub_fixture"],
    ["hold", "sub_fixture"], ["checkout", "cs_test_fixture"]]) {
    await db.query("select public.claim_exact_installment_operation($1,$2,$3,$4)", [plan, step, "a".repeat(64), t.buyerId]);
    await db.query("select public.complete_exact_installment_operation($1,$2,$3,$4)", [plan, step, t.buyerId, result]);
  }
  await db.query("select public.bind_exact_installment_checkout($1,'cus_fixture','sub_fixture','cs_test_fixture')", [plan]);
  await db.query(`insert into purchases(id,buyer_id,creator_id,post_id,product_id,booking_id,session_id,
    subscription_id,target_months,currency,status) values($1,$2,$3,$4,$5,$6,'cs_test_fixture','sub_fixture',3,'usd','processing')`,
  [purchase, t.buyerId, t.creatorId, t.postId, t.productId, t.bookingId]);
});
const bind = () => db.query("select public.bind_exact_installment_purchase($1,$2)", [plan, purchase]);
async function ready() {
  await bind();
  await db.query("select public.record_exact_installment_first_receipt($1,'cs_test_fixture','pi_fixture1',66633,9958,'2100-01-01')", [plan]);
}
async function credit(number = 1, actual = 1962) {
  return (await db.query<{ credited: boolean }>("select public.credit_exact_installment_receipt($1,$2,$3,$4,$5) as credited",
    [plan, number, `ch_fixture${number}`, `txn_fixture${number}`, actual])).rows[0].credited;
}
async function stats() {
  return (await db.query<{ earnings: number; paid_count: number; access_granted: boolean;
    status: string; ledgers: number; counted: number }>(`select total_earnings_cents::integer as earnings, paid_count, access_granted, p.status,
    (select count(*)::integer from payment_fee_ledger) as ledgers,
    (select count(*)::integer from exact_installment_receipts where counted_at is not null) as counted
    from profiles join purchases p on p.creator_id=profiles.id`)).rows[0];
}
async function refund(amount: number, number = 1) {
  return db.query(`select public.apply_payment_fee_ledger_refund(id,$1) from payment_fee_ledger where stripe_payment_intent_id=$2`,
    [amount, `pi_fixture${number}`]);
}
async function knownRefund(amount: number) {
  await db.query("insert into payment_refund_state values('pi_fixture1','ch_fixture1',66633,$1)", [amount]);
}
async function renewalFixture(number: number) {
  // Synthetic, local-only future activation/paid-receipt state. These direct
  // inserts are NOT a claimed implementation of activation or invoice capture.
  await db.exec("update exact_installment_agreements set status='active'");
  await db.query(`insert into exact_installment_receipts(agreement_id,payment_number,stripe_payment_intent_id,
    stripe_invoice_id,amount_cents,application_fee_cents,paid_at) values($1,$2,$3,$4,$5,10425,'2100-01-01')`,
  [plan, number, `pi_fixture${number}`, `in_fixture${number}`, number === 3 ? 66634 : 66633]);
}

test("one atomic first ledger/earning/count; retries do not activate collection or credit twice", async () => {
  await ready(); expect(await credit()).toBe(true); expect(await credit()).toBe(false);
  expect(await stats()).toEqual({ earnings: 56675, paid_count: 1, access_granted: true, status: "active", ledgers: 1, counted: 1 });
  expect((await db.query("select status from exact_installment_agreements")).rows).toEqual([{ status: "awaiting_first" }]);
  const ledger = (await db.query("select stripe_invoice_id, actual_stripe_fee_cents::integer as actual from payment_fee_ledger")).rows[0];
  expect(ledger).toEqual({ stripe_invoice_id: null, actual: 1962 });
});
test.each(["buyer_id", "creator_id", "post_id", "product_id", "booking_id"])("binding rejects different %s", async (field) => {
  await db.query(`update purchases set ${field}=$1`, [purchase]);
  await expect(bind()).rejects.toThrow("mismatch");
});
test.each(["session_id", "subscription_id", "currency"])("binding rejects different %s", async (field) => {
  await db.query(`update purchases set ${field}='other'`);
  await expect(bind()).rejects.toThrow("mismatch");
});
test("binding refuses a preexisting paid purchase and supports exact replay", async () => {
  await db.exec("update purchases set paid_count=1");
  await expect(bind()).rejects.toThrow("existing paid");
  await db.exec("update purchases set paid_count=0");
  await bind(); await bind();
});
test("missing receipt or unbound purchase cannot mint a ledger", async () => {
  await expect(credit()).rejects.toThrow("purchase not ready");
  await bind(); await expect(credit()).rejects.toThrow("receipt missing");
  expect((await db.query("select * from payment_fee_ledger")).rows).toHaveLength(0);
});
test.each([0, 4, -1])("payment number %i is rejected", async (number) => {
  await ready(); await expect(credit(number)).rejects.toThrow("invalid exact receipt");
});
test("wrong fee, gross or credited outside this receipt leaves evidence unchanged", async () => {
  await ready(); await credit();
  await db.exec("update exact_installment_receipts set ledger_id=null,counted_at=null");
  await expect(credit()).rejects.toThrow("credited outside");
  await db.exec("update payment_fee_ledger set processing_fee_cents=1");
  await expect(credit()).rejects.toThrow("economics mismatch");
  expect((await stats()).earnings).toBe(56675);
});
test("an existing ledger audit conflict is not overwritten", async () => {
  await ready(); await credit();
  await expect(credit(1, 1)).rejects.toThrow("audit evidence differs");
  expect((await stats()).earnings).toBe(56675);
});
test.each(["refunded", "canceled", "failed", "expired"])("a %s purchase cannot be restored by a late success", async (status) => {
  await ready(); await db.query("update purchases set status=$1,access_granted=false", [status]);
  await expect(credit()).rejects.toThrow("not eligible");
  expect(await stats()).toMatchObject({ earnings: 0, paid_count: 0, access_granted: false, status, ledgers: 0, counted: 0 });
});
test.each([10000, 66633])("refund before credit (%i) credits only remaining net using the existing refund RPC", async (amount) => {
  await ready(); await knownRefund(amount);
  expect(await credit()).toBe(true);
  const expected = 56675 - Math.round(56675 * amount / 66633);
  expect((await stats()).earnings).toBe(expected);
  await refund(amount); expect(await credit()).toBe(false);
  expect(await stats()).toMatchObject({ earnings: expected, paid_count: 1, counted: 1 });
});
test("refund after credit and decreasing/duplicate refund deliveries do not debit twice", async () => {
  await ready(); await credit(); await refund(10000); await refund(10000); await refund(5000);
  expect((await stats()).earnings).toBe(56675 - Math.round(56675 * 10000 / 66633));
  await refund(66633); await refund(66633); expect(await credit()).toBe(false);
  expect(await stats()).toMatchObject({ earnings: 0, paid_count: 1, counted: 1 });
});
test("receipt replay reconciles a newly recorded refund without another payment count or credit", async () => {
  await ready(); await credit(); await knownRefund(10000);
  expect(await credit()).toBe(false);
  const expected = 56675 - Math.round(56675 * 10000 / 66633);
  expect(await stats()).toMatchObject({ earnings: expected, paid_count: 1, counted: 1 });
  expect(await credit()).toBe(false);
  expect((await stats()).earnings).toBe(expected);
  await db.exec("update payment_refund_state set refunded_amount_cents=66633");
  expect(await credit()).toBe(false);
  expect(await stats()).toMatchObject({ earnings: 0, paid_count: 1, counted: 1 });
});
test("wrong earlier refund identity rolls back insertion, count and earnings", async () => {
  await ready(); await knownRefund(10000);
  await db.exec("update payment_refund_state set stripe_charge_id='ch_other'");
  await expect(credit()).rejects.toThrow("refund evidence identity");
  expect(await stats()).toMatchObject({ ledgers: 0, earnings: 0, paid_count: 0, counted: 0 });
});
test("three distinct receipts count once each and preserve final-cent economics", async () => {
  await ready(); await credit(); await renewalFixture(2); await renewalFixture(3);
  await expect(credit(3, 2429)).rejects.toThrow("prior installment");
  expect(await credit(2, 2429)).toBe(true); expect(await credit(3, 2429)).toBe(true);
  expect(await credit(1)).toBe(false); expect(await credit(2, 2429)).toBe(false); expect(await credit(3, 2429)).toBe(false);
  expect(await stats()).toEqual({ earnings: 169092, paid_count: 3, access_granted: true, status: "complete", ledgers: 3, counted: 3 });
  expect((await db.query("select sum(gross_amount_cents)::integer as gross from payment_fee_ledger")).rows).toEqual([{ gross: 199900 }]);
});
test("out-of-sync purchase count and missing activation prevent the next credit", async () => {
  await ready(); await credit(); await renewalFixture(2);
  await db.exec("update exact_installment_agreements set status='awaiting_first'");
  await expect(credit(2, 2429)).rejects.toThrow("prior installment");
  await db.exec("update exact_installment_agreements set status='active'; update purchases set paid_count=2");
  await expect(credit(2, 2429)).rejects.toThrow("prior installment");
  expect((await stats()).ledgers).toBe(1);
});
test.each(["anon", "authenticated"])("%s cannot bind or credit private receipts", async (role) => {
  await ready(); await db.exec(`set role ${role}`);
  try { await expect(bind()).rejects.toThrow("permission denied"); await expect(credit()).rejects.toThrow("permission denied"); }
  finally { await db.exec("reset role"); }
});

async function activationReady() {
  await ready();
  await db.exec(`update exact_installment_agreements set created_at=date_trunc('second',now())-interval '2 seconds';
    update exact_installment_receipts set paid_at=date_trunc('second',now())-interval '1 second';`);
  await credit();
}
async function claimActivation(token = t.buyerId, pm = "pm_fixture", item = "si_fixture") {
  return (await db.query<{ result: { status: string; authorization: Record<string,string|number> } }>(
    "select public.claim_exact_installment_activation($1,$2,$3,$4) as result", [plan,pm,item,token])).rows[0].result;
}
const completeActivation = (token = t.buyerId) => db.query(
  "select public.complete_exact_installment_activation($1,$2)", [plan,token]);
test("activation requires a counted first receipt, then binds exactly N-1 expected periods", async () => {
  await expect(claimActivation()).rejects.toThrow("credited first");
  await activationReady();
  const first = await claimActivation(); expect(first.status).toBe("new");
  expect((await claimActivation()).status).toBe("busy");
  await completeActivation();
  const replay = await claimActivation(); expect(replay).toEqual({ ...first, status: "complete" });
  await expect(completeActivation()).rejects.toThrow("claim lost");
  const rows = (await db.query<{ payment_number:number; due_at: number; period_end:number; amount:number; fee:number }>(
    `select payment_number,due_at::float8,period_end::float8,amount_cents::integer as amount,
      application_fee_cents::integer as fee from exact_installment_periods order by payment_number`)).rows;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ payment_number:2,due_at:first.authorization.firstRenewalAt,amount:66633,fee:10425 });
  expect(rows[1]).toMatchObject({ payment_number:3,due_at:rows[0].period_end,period_end:first.authorization.cancelAt,amount:66634,fee:10425 });
  expect((await stats()).paid_count).toBe(1); // Period expectations are NOT paid receipts.
});
test("an activation lease can be reclaimed, but its stale completion token is fenced", async () => {
  await activationReady(); await claimActivation();
  await db.exec("update exact_installment_activations set lease_until=now()-interval '1 second'");
  expect((await claimActivation(t.creatorId)).status).toBe("new");
  await expect(completeActivation()).rejects.toThrow("claim lost");
  await completeActivation(t.creatorId);
});
test("aged ambiguous activation requires review, not a new Stripe mutation", async () => {
  await activationReady(); await claimActivation();
  await db.exec("update exact_installment_activations set first_started_at=now()-interval '21 hours'");
  expect((await claimActivation()).status).toBe("review_required");
  expect((await db.query("select status from exact_installment_agreements")).rows).toEqual([{status:"review_required"}]);
});
test.each(["pm", "item"])("activation %s is immutable across retry", async (field) => {
  await activationReady(); await claimActivation();
  await expect(claimActivation(t.buyerId,field === "pm" ? "pm_other" : "pm_fixture",
    field === "item" ? "si_other" : "si_fixture")).rejects.toThrow("parameters changed");
});
test.each(["canceled", "refunded", "failed"])("a %s purchase stops monthly activation", async (status) => {
  await activationReady(); await db.query("update purchases set status=$1",[status]);
  await expect(claimActivation()).rejects.toThrow("purchase not ready");
});
test.each(["refund state", "dispute state", "pending refund", "completed refund", "failed external refund", "booking canceled"])
  ("activation stops for %s without creating expected periods", async (condition) => {
    await activationReady();
    if (condition === "refund state") await knownRefund(10000);
    if (condition === "dispute state") await db.exec("insert into payment_dispute_state values('pi_fixture1','needs_response')");
    if (condition === "pending refund") await db.exec("insert into refund_operations values('pi_fixture1','pending',null)");
    if (condition === "completed refund") await db.exec("insert into refund_operations values('pi_fixture1','completed','re_fixture')");
    if (condition === "failed external refund") await db.exec("insert into refund_operations values('pi_fixture1','failed','re_fixture')");
    if (condition === "booking canceled") await db.exec("update bookings set status='canceled'");
    await expect(claimActivation()).rejects.toThrow("reconciliation required");
    expect((await db.query("select * from exact_installment_periods")).rows).toHaveLength(0);
  });
test("a won dispute and a failed refund without an external refund do not fabricate a debt cancellation", async () => {
  await activationReady();
  await db.exec("insert into payment_dispute_state values('pi_fixture1','won'); insert into refund_operations values('pi_fixture1','failed',null)");
  expect((await claimActivation()).status).toBe("new");
});
test.each(["bookings", "booking_payments"])("unknown %s status fails closed during activation", async (table) => {
  await activationReady(); await db.exec(`update ${table} set status='unknown'`);
  await expect(claimActivation()).rejects.toThrow("reconciliation required");
});
test("refund/cancellation after claim is rechecked before committing activation", async () => {
  await activationReady(); await claimActivation(); await knownRefund(10000);
  await expect(completeActivation()).rejects.toThrow("reconciliation required");
  expect((await db.query("select * from exact_installment_periods")).rows).toHaveLength(0);
  expect((await db.query("select status from exact_installment_agreements")).rows).toEqual([{status:"awaiting_first"}]);
});
test("a future-dated receipt or expired bootstrap cannot activate", async () => {
  await ready(); await credit();
  await expect(claimActivation()).rejects.toThrow("credited first");
  await db.exec(`update exact_installment_receipts set paid_at=now()-interval '1 second';
    update exact_installment_agreements set created_at=now()-interval '49 hours';`);
  await expect(claimActivation()).rejects.toThrow("window expired");
});
test.each(["UTC", "America/Phoenix", "Asia/Tokyo"])("calendar arithmetic is invariant under database timezone %s", async (zone) => {
  await db.query("select set_config('TimeZone',$1,false)",[zone]);
  try {
    const anchor = Date.parse("2027-01-31T23:45:06Z")/1000;
    const r = (await db.query<{ renewal:number; next:number }>(`select exact_installment_month($1,1)::float8 as renewal,
      exact_installment_month(exact_installment_month($1,1),1)::float8 as next`,[anchor])).rows[0];
    expect(new Date(r.renewal*1000).toISOString()).toBe("2027-02-28T23:45:06.000Z");
    expect(new Date(r.next*1000).toISOString()).toBe("2027-03-28T23:45:06.000Z");
  } finally { await db.exec("set timezone='UTC'"); }
});
test.each(["anon", "authenticated"])("%s cannot activate or read private card/schedule records", async (role) => {
  await activationReady(); await claimActivation(); await db.exec(`set role ${role}`);
  try {
    await expect(claimActivation()).rejects.toThrow("permission denied");
    await expect(completeActivation()).rejects.toThrow("permission denied");
    await expect(db.query("select * from exact_installment_activations")).rejects.toThrow("permission denied");
    await expect(db.query("select * from exact_installment_periods")).rejects.toThrow("permission denied");
  } finally { await db.exec("reset role"); }
});

// Synthetic passage of time in the isolated database, not a hosted schedule edit.
async function invoiceReady() {
  await activationReady(); await claimActivation(); await completeActivation();
  await db.exec(`update exact_installment_periods set due_at=floor(extract(epoch from now()))-60
    where payment_number=2`);
}
async function invoiceClaim(invoice = "in_renewal2", token = t.buyerId, number = 2) {
  return (await db.query<{ result: { status:string; authorization:Record<string,unknown>; paymentIntentId?:string } }>(
    `select claim_exact_installment_invoice($1,$2,'sub_fixture',due_at,period_end,$3) as result
     from exact_installment_periods where agreement_id=$1 and payment_number=$4`,[plan,invoice,token,number])).rows[0].result;
}
const preparedInvoice = (pi="pi_fixture2",token=t.buyerId) => db.query(
  "select prepare_exact_installment_dispatch($1,'in_renewal2',$2,$3)",[plan,pi,token]);
const admitInvoice = (token=t.buyerId) => db.query(
  "select admit_exact_installment_dispatch($1,'in_renewal2',$2)",[plan,token]);
const recordRenewal = () => db.query(`select record_exact_installment_renewal_receipt($1,'in_renewal2',
  'pi_fixture2',66633,10425,date_trunc('second',dispatch_started_at)) as recorded
  from exact_installment_invoice_claims where agreement_id=$1`,[plan]);

test("one period binds one invoice, derives exact fees/card/dates and permits only one dispatch",async()=>{
  await invoiceReady();
  const c=await invoiceClaim();
  expect(c.status).toBe("prepare");
  expect(c.authorization).toMatchObject({planId:plan,paymentNumber:2,totalCents:199900,
    paymentCount:3,invoiceId:"in_renewal2",paymentMethodId:"pm_fixture",destinationId:"acct_fixture"});
  expect((await invoiceClaim()).status).toBe("busy");
  await expect(invoiceClaim("in_competing")).rejects.toThrow("already bound");
  await expect(admitInvoice()).rejects.toThrow("claim lost");
  await preparedInvoice(); await admitInvoice();
  expect((await stats()).paid_count).toBe(1);
  expect(await invoiceClaim()).toMatchObject({status:"reconcile",paymentIntentId:"pi_fixture2"});
  await expect(admitInvoice()).rejects.toThrow("claim lost");
  await db.exec("update exact_installment_invoice_claims set lease_until=now()-interval '1 day',first_started_at=now()-interval '2 days'");
  expect((await invoiceClaim()).status).toBe("reconcile");
});

test("renewal succeeded receipt/credit are independently idempotent and do not double earnings",async()=>{
  await invoiceReady(); await invoiceClaim(); await preparedInvoice(); await admitInvoice();
  expect((await recordRenewal()).rows[0]).toEqual({recorded:true});
  expect((await recordRenewal()).rows[0]).toEqual({recorded:false});
  expect((await stats()).paid_count).toBe(1);
  expect(await credit(2)).toBe(true); expect(await credit(2)).toBe(false);
  expect((await stats())).toMatchObject({paid_count:2,counted:2,ledgers:2,earnings:112883});
  expect((await invoiceClaim()).status).toBe("reconcile");
});

test("renewal receipt cannot be fabricated before dispatch or with a changed amount/PI/date",async()=>{
  await invoiceReady(); await invoiceClaim(); await preparedInvoice();
  await expect(recordRenewal()).rejects.toThrow("no admitted");
  await admitInvoice();
  await expect(db.query(`select record_exact_installment_renewal_receipt($1,'in_renewal2','pi_other',66633,10425,now())`,[plan]))
    .rejects.toThrow("no admitted");
  for(const [amount,fee,at] of [[66634,10425,"now()"],[66633,1,"now()"],[66633,10425,"now()+interval '1 day'"],
    [66633,10425,"now()-interval '1 day'"]] as const) {
    await expect(db.query(`select record_exact_installment_renewal_receipt($1,'in_renewal2','pi_fixture2',$2,$3,${at})`,
      [plan,amount,fee])).rejects.toThrow("evidence mismatch");
  }
  await recordRenewal();
  await expect(db.query(`select record_exact_installment_renewal_receipt($1,'in_renewal2','pi_fixture2',66633,10425,now())`,[plan]))
    .rejects.toThrow("receipt changed");
});

test("stale preparation is fenced and ambiguous old preparations do not get fresh Stripe mutations",async()=>{
  await invoiceReady(); await invoiceClaim(); await preparedInvoice();
  await db.exec("update exact_installment_invoice_claims set lease_until=now()-interval '1 second'");
  expect((await invoiceClaim("in_renewal2",t.creatorId)).status).toBe("prepare");
  await expect(preparedInvoice()).rejects.toThrow("claim lost");
  await expect(preparedInvoice("pi_other",t.creatorId)).rejects.toThrow("PaymentIntent changed");
  await db.exec("update exact_installment_invoice_claims set first_started_at=now()-interval '21 hours'");
  expect((await invoiceClaim()).status).toBe("reconcile");
  await expect(admitInvoice(t.creatorId)).rejects.toThrow("claim lost");
});

test.each(["future","expired","wrong subscription","unknown period","missing first credit"])
  ("renewal admission rejects %s",async(reason)=>{
    await invoiceReady();
    if(reason==="future") await db.exec("update exact_installment_periods set due_at=floor(extract(epoch from now()))+60 where payment_number=2");
    if(reason==="expired") await db.exec("update exact_installment_periods set period_end=floor(extract(epoch from now()))-1 where payment_number=2");
    if(reason==="missing first credit") await db.exec("update exact_installment_receipts set ledger_id=null,counted_at=null");
    if(reason==="wrong subscription") {
      await expect(db.query(`select claim_exact_installment_invoice($1,'in_test','sub_other',due_at,period_end,$2)
        from exact_installment_periods where payment_number=2`,[plan,t.buyerId])).rejects.toThrow("subscription mismatch");
    } else if(reason==="unknown period") {
      await expect(db.query(`select claim_exact_installment_invoice($1,'in_test','sub_fixture',due_at+1,period_end,$2)
        from exact_installment_periods where payment_number=2`,[plan,t.buyerId])).rejects.toThrow("no matching");
    } else await expect(invoiceClaim()).rejects.toThrow();
    expect((await db.query("select * from exact_installment_invoice_claims")).rows).toHaveLength(0);
  });

test.each(["refund","dispute","pending refund","canceled purchase","canceled booking","unknown payment"])
  ("rechecks %s immediately before dispatch, without treating preparation as payment",async(reason)=>{
    await invoiceReady(); await invoiceClaim(); await preparedInvoice();
    if(reason==="refund") await knownRefund(100);
    if(reason==="dispute") await db.exec("insert into payment_dispute_state values('pi_fixture1','needs_response')");
    if(reason==="pending refund") await db.exec("insert into refund_operations values('pi_fixture1','pending',null)");
    if(reason==="canceled purchase") await db.exec("update purchases set status='canceled'");
    if(reason==="canceled booking") await db.exec("update bookings set status='canceled'");
    if(reason==="unknown payment") await db.exec("update booking_payments set status='unknown'");
    await expect(admitInvoice()).rejects.toThrow();
    expect((await db.query("select status from exact_installment_invoice_claims")).rows).toEqual([{status:"prepared"}]);
    expect((await stats()).paid_count).toBe(1);
  });

test.each(["anon","authenticated","service_role"])("%s cannot directly mutate invoice claims",async(role)=>{
  await invoiceReady(); await invoiceClaim(); await db.exec(`set role ${role}`);
  try {
    await expect(db.exec("update exact_installment_invoice_claims set status='paid'")).rejects.toThrow("permission denied");
    if(role!=="service_role") {
      await expect(invoiceClaim()).rejects.toThrow("permission denied");
      await expect(preparedInvoice()).rejects.toThrow("permission denied");
      await expect(admitInvoice()).rejects.toThrow("permission denied");
      await expect(recordRenewal()).rejects.toThrow("permission denied");
    }
  } finally { await db.exec("reset role"); }
});

test("final exact receipt completes the agreement only after all three unique credits",async()=>{
  await invoiceReady();
  await expect(db.query("select complete_exact_installment_agreement($1)",[plan])).rejects.toThrow("all exact");
  await invoiceClaim(); await preparedInvoice(); await admitInvoice(); await recordRenewal(); await credit(2);
  // Synthetic next-period passage, retaining the exact 66634/10425 final money.
  await db.exec("update exact_installment_periods set due_at=floor(extract(epoch from now()))-1 where payment_number=3");
  expect((await invoiceClaim("in_renewal3",t.buyerId,3)).authorization).toMatchObject({paymentNumber:3});
  await db.query("select prepare_exact_installment_dispatch($1,'in_renewal3','pi_fixture3',$2)",[plan,t.buyerId]);
  await db.query("select admit_exact_installment_dispatch($1,'in_renewal3',$2)",[plan,t.buyerId]);
  await db.query(`select record_exact_installment_renewal_receipt($1,'in_renewal3','pi_fixture3',66634,10425,
    date_trunc('second',dispatch_started_at)) from exact_installment_invoice_claims where payment_number=3`,[plan]);
  await expect(db.query("select complete_exact_installment_agreement($1)",[plan])).rejects.toThrow("all exact");
  await credit(3);
  await db.query("select complete_exact_installment_agreement($1)",[plan]);
  await db.query("select complete_exact_installment_agreement($1)",[plan]);
  expect((await db.query("select status from exact_installment_agreements")).rows).toEqual([{status:"complete"}]);
  expect((await stats())).toMatchObject({paid_count:3,counted:3,ledgers:3,earnings:169092,status:"complete"});
  expect((await invoiceClaim("in_renewal3",t.buyerId,3)).status).toBe("reconcile");
});

test("a delayed paid receipt cannot reopen a canceled purchase or grant access",async()=>{
  await invoiceReady();await invoiceClaim();await preparedInvoice();await admitInvoice();
  await db.exec("update purchases set status='canceled',access_granted=false");
  expect((await recordRenewal()).rows[0]).toEqual({recorded:true}); // Keep external evidence.
  await expect(credit(2)).rejects.toThrow("not eligible");
  expect((await stats())).toMatchObject({paid_count:1,access_granted:false,status:"canceled",earnings:56675});
});
