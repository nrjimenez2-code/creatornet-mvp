/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";
import type Stripe from "stripe";
import {dispatchExactInstallmentEventSandbox,type ExactEventBindingStore} from "../lib/installments/eventBridge";
import type {ExactAgreement} from "../lib/installments/agreementStore";
import {exactActivationDates,type ExactActivationStore,type ActivationClaim} from "../lib/installments/activation";
import {installmentMonthBoundary} from "../lib/installments/checkoutPreparation";
import type {ExactReceiptCreditStore} from "../lib/installments/receiptCredit";

declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const f = exactInstallmentFixture(), t = f.terms, plan = f.agreement.id;
jest.setTimeout(60000);
beforeAll(async () => {
  db = createLocalPostgres();
  // In-memory PostgreSQL only. Include the actual relevant nonnull/unique/FK
  // constraints; this still is not a hosted-schema or multi-worker test.
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table profiles(id uuid primary key, stripe_account_id text, stripe_onboarding_complete boolean,
      total_earnings_cents bigint not null default 0);
    create table products(id uuid primary key, product_id uuid unique, creator_id uuid references profiles,
      type text not null, title text not null, is_active boolean not null, discord_invite_url text, whop_listing_url text,
      amount_cents bigint, currency text);
    create table posts(id uuid primary key,product_id uuid references products,creator_id uuid references profiles);
    create table bookings(id uuid primary key, creator_id uuid, buyer_id uuid, post_id uuid references posts, status text);
    create table booking_payments(id uuid primary key, booking_id uuid references bookings, buyer_id uuid, product_id uuid references products,
      plan_type text,status text,currency char(3),installment_months integer,amount_total_cents bigint,
      stripe_checkout_session_id text unique,stripe_subscription_id text,stripe_payment_intent_id text,
      link_url text,updated_at timestamptz,completed_at timestamptz,created_at timestamptz,link_sent_at timestamptz,
      closer_user_id uuid,installment_amount_cents bigint,platform_fee_cents bigint,processing_fee_cents bigint,
      total_creator_deduction_cents bigint,creator_net_cents bigint,fee_schedule_version text);
    create unique index one_live_booking_payment on booking_payments(booking_id) where status in ('pending','link_sent','completed');
    create table purchases(id uuid primary key,buyer_id uuid,buyer_user_id uuid,creator_id uuid,post_id uuid not null references posts,
      product_id uuid references products,booking_id uuid,session_id text unique,subscription_id text,payment_intent_id text unique,
      target_months integer,currency text not null,paid_count integer,access_granted boolean not null,
      status text not null,is_refund boolean not null,is_suspect boolean not null,
      earnings_credited_at timestamptz,earnings_credited_cents integer,amount_cents integer,
      platform_fee_cents bigint,processing_fee_cents bigint,total_creator_deduction_cents bigint,creator_net_cents bigint,
      fee_schedule_version text,plan_months integer,plan_amount_cents integer,product_type text,kind text,title text,
      fulfillment text check(fulfillment in ('discord','whop')),fulfillment_url text,fulfillment_payload jsonb,
      first_access_at timestamptz,paid_at timestamptz,created_at timestamptz,unique(buyer_id,post_id));
    create unique index buyer_product on purchases(buyer_id,product_id) where product_id is not null;
    create table payment_fee_ledger(id uuid primary key default gen_random_uuid(), creator_id uuid,purchase_id uuid references purchases,
      booking_payment_id uuid,stripe_payment_intent_id text unique,stripe_invoice_id text unique,
      stripe_checkout_session_id text unique,stripe_charge_id text,stripe_balance_transaction_id text,
      gross_amount_cents bigint,platform_fee_cents bigint,processing_fee_cents bigint,total_creator_deduction_cents bigint,
      creator_net_cents bigint,actual_stripe_fee_cents bigint,processing_fee_variance_cents bigint,
      refunded_amount_cents bigint default 0,earnings_reversed_cents bigint default 0,
      platform_fee_refund_attribution_cents bigint default 0,processing_fee_refund_attribution_cents bigint default 0,
      refund_allocation_rounding_cents bigint default 0,currency text,fee_schedule_version text,status text,
      dispute_status text,stripe_dispute_id text,disputed_amount_cents bigint,earnings_credited_at timestamptz,updated_at timestamptz default now());
    create table payment_refund_state(stripe_payment_intent_id text primary key,stripe_charge_id text,charge_amount_cents bigint,
      refunded_amount_cents bigint,updated_at timestamptz default now());
    create table payment_dispute_state(stripe_dispute_id text primary key,stripe_payment_intent_id text not null,
      stripe_charge_id text not null,disputed_amount_cents bigint not null check(disputed_amount_cents>=0),
      currency text not null,status text not null,stripe_event_created bigint not null,
      created_at timestamptz not null default now(),updated_at timestamptz not null default now());
    create table refund_operations(stripe_payment_intent_id text,status text,stripe_refund_id text);
    alter table profiles add column role text not null default 'user';
    -- Relevant 021 refund-claim fields/constraints for the 045 admission RPC.
    alter table refund_operations add column id uuid primary key default gen_random_uuid(),
      add column payment_fee_ledger_id uuid references payment_fee_ledger,
      add column creator_id uuid references profiles,
      add column initiated_by uuid references profiles,
      add column processing_token uuid, add column processing_claimed_at timestamptz;
  `);
  const old = readFileSync(join(process.cwd(), "supabase/schema/019-creator-processing-fees.sql"), "utf8");
  const refund = old.match(/create or replace function public\.apply_payment_fee_ledger_refund\([\s\S]*?\$\$;/g);
  if (refund?.length !== 1) throw new Error("Expected existing refund RPC");
  await db.exec(refund[0]);
  const refundState=old.match(/create or replace function public\.record_payment_refund_state\([\s\S]*?\$\$;/g);
  if(refundState?.length!==1) throw new Error("Expected existing refund-state RPC");
  await db.exec(refundState[0]);
  const disputeState=old.match(/create or replace function public\.record_payment_dispute_state\([\s\S]*?\$\$;/g);
  if(disputeState?.length!==1) throw new Error("Expected existing dispute-state RPC");
  await db.exec(disputeState[0]);
  for (const file of ["040-exact-installment-agreements.sql", "041-exact-installment-receipt-credit.sql",
    "042-exact-installment-activation.sql", "043-exact-installment-invoice-claims.sql", "044-exact-installment-purchase-lifecycle.sql",
    "045-exact-installment-collection-holds.sql","046-exact-installment-refund-events.sql","047-exact-installment-billing-stops.sql",
    "048-exact-installment-lifecycle-events.sql","049-exact-installment-payment-recovery.sql",
    "050-exact-installment-stop-request-identity.sql","051-exact-installment-card-setup.sql","052-exact-installment-payment-confirmation.sql",
    "053-exact-installment-retry-admission.sql","054-exact-installment-payment-intent-version.sql",
    "055-exact-installment-bank-verification.sql","056-exact-installment-future-card-consent.sql",
    "057-exact-installment-checkout-publication.sql"]) {
    await db.exec(readFileSync(join(process.cwd(), "supabase/schema", file), "utf8"));
  }
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`truncate exact_installment_resolved_card_holds,exact_installment_invoice_cards,exact_installment_future_card_choices,exact_installment_retry_admissions,exact_installment_payment_confirmations,exact_installment_card_setups,exact_installment_payment_recoveries,exact_installment_lifecycle_observations,exact_installment_billing_stops,exact_installment_collection_holds,exact_installment_invoice_claims,exact_installment_periods,exact_installment_activations,
    exact_installment_receipts,exact_installment_operations,exact_installment_agreements,payment_fee_ledger,
    payment_refund_state,payment_dispute_state,refund_operations,purchases,booking_payments,bookings,posts,products,profiles;`);
  await db.query("insert into profiles(id,stripe_account_id,stripe_onboarding_complete,total_earnings_cents) values($1,'acct_fixture',true,0)", [t.creatorId]);
  await db.query(`insert into products(id,product_id,creator_id,type,title,is_active,discord_invite_url,whop_listing_url,amount_cents,currency)
    values($1,'88888888-8888-4888-8888-888888888888',$2,'mentorship','Synthetic',true,'https://discord.gg/synthetic',null,199900,'usd')`, [t.productId,t.creatorId]);
  await db.query("insert into posts values($1,$2,$3)", [t.postId,t.productId,t.creatorId]);
  await db.query("insert into bookings values($1,$2,$3,$4,'booked')", [t.bookingId,t.creatorId,t.buyerId,t.postId]);
  await db.query(`insert into booking_payments(id,booking_id,buyer_id,product_id,plan_type,status,currency,installment_months,amount_total_cents)
    values($1,$2,$3,$4,'installment','pending','usd',3,199900)`, [t.bookingPaymentId,t.bookingId,t.buyerId,t.productId]);
  await db.query("select create_exact_installment_agreement($1,$2,$3,$4)", [plan,t.bookingPaymentId,t.creatorId,JSON.stringify(t)]);
  for (const [step,result] of [["customer","cus_fixture"],["product","prod_fixture"],["subscription","sub_fixture"],
    ["hold","sub_fixture"],["checkout","cs_test_fixture"]]) {
    await db.query("select claim_exact_installment_operation($1,$2,$3,$4)", [plan,step,"a".repeat(64),t.buyerId]);
    await db.query("select complete_exact_installment_operation($1,$2,$3,$4)", [plan,step,t.buyerId,result]);
  }
  await db.query("select bind_exact_installment_checkout($1,'cus_fixture','sub_fixture','cs_test_fixture')", [plan]);
});
const seed = async () => (await db.query<{id:string}>("select seed_exact_installment_purchase($1) id",[plan])).rows[0].id;
const fulfill = () => db.query("select fulfill_exact_installment_first_payment($1)",[plan]);
async function firstPaid() {
  const id = await seed();
  await db.query(`select record_exact_installment_first_receipt($1,'cs_test_fixture','pi_fixture1',66633,9958,now())`,[plan]);
  await db.query("select credit_exact_installment_receipt($1,1,'ch_fixture1','txn_fixture1',1962)",[plan]);
  return id;
}
const row = async (table:string) => (await db.query<Record<string,unknown>>(`select * from ${table}`)).rows[0];

test("concurrent Checkout and charge.updated converge through actual receipt, ledger, fulfillment and held activation SQL",async()=>{
  const s=exactInstallmentFixture();s.paid();const purchaseId=await seed();
  const now=(await db.query<{seconds:number}>("select floor(extract(epoch from now()))::integer seconds")).rows[0].seconds;
  const createdAt=now-120;s.charge.created=now-60;
  // Fresh synthetic fixture only; not a production clock or historical evidence edit.
  await db.query("update exact_installment_agreements set created_at=to_timestamp($1) where id=$2",[createdAt,plan]);
  const load=async():Promise<ExactAgreement>=>{
    const a=await row("exact_installment_agreements");
    return {...s.agreement,createdAt,status:a.status as ExactAgreement["status"],sessionId:s.session.id,
      customerId:s.customer.id,subscriptionId:s.subscription.id};
  };
  s.store.load.mockImplementation(load);
  s.store.recordFirstReceipt.mockImplementation(async(id,r)=>(await db.query<{recorded:boolean}>(
    "select record_exact_installment_first_receipt($1,$2,$3,$4,$5,to_timestamp($6)) recorded",
    [id,r.sessionId,r.paymentIntentId,r.amountCents,r.applicationFeeCents,r.paidAt])).rows[0].recorded);
  const binding=async()=>({agreementId:plan,purchaseId,sessionId:s.session.id,subscriptionId:s.subscription.id,
    customerId:s.customer.id,status:(await load()).status,previewOrigin:t.previewOrigin});
  const bindings:ExactEventBindingStore={bySession:async id=>id===s.session.id?binding():null,bySubscription:async()=>null,
    byIntent:async id=>(await db.query("select agreement_id from exact_installment_receipts where stripe_payment_intent_id=$1",[id])).rows.length?binding():null};
  const credits:boolean[]=[];
  const creditStore:ExactReceiptCreditStore={
    bindPurchase:async(id,pid)=>{await db.query("select bind_exact_installment_purchase($1,$2)",[id,pid]);},
    recordRefundEvidence:async(pi,ch,gross,refunded)=>{await db.query("select record_payment_refund_state($1,$2,$3,$4)",[pi,ch,gross,refunded]);},
    credit:async(id,a)=>{
      const result=(await db.query<{credited:boolean}>("select credit_exact_installment_receipt($1,$2,$3,$4,$5) credited",
        [id,a.paymentNumber,a.chargeId,a.balanceTransactionId,a.actualStripeFeeCents])).rows[0].credited;
      credits.push(result);return result;
    },reconcileDispute:async pi=>{await db.query("select reconcile_exact_installment_dispute_audit($1)",[pi]);},
  };
  const activationStore:ExactActivationStore={claim:async(id,pm,item,token)=>(await db.query<{result:ActivationClaim}>(
    "select claim_exact_installment_activation($1,$2,$3,$4) result",[id,pm,item,token])).rows[0].result,
    complete:async(id,token)=>{await db.query("select complete_exact_installment_activation($1,$2)",[id,token]);}};
  const sub=s.subscription;
  Object.assign(sub,{cancel_at_period_end:false,trial_end:createdAt+48*3600,
    cancel_at:installmentMonthBoundary(createdAt+48*3600,2),billing_cycle_anchor:createdAt+48*3600,
    pause_collection:{behavior:"keep_as_draft",resumes_at:null}});
  Object.assign(sub.items.data[0],{id:"si_fixture",subscription:sub.id});
  Object.assign(sub.items.data[0].price,{billing_scheme:"per_unit"});
  Object.assign(sub.items.data[0].price.recurring!,{usage_type:"licensed"});
  const update=jest.fn(async(_id:string,p:Stripe.SubscriptionUpdateParams,o:Stripe.RequestOptions)=>{
    expect(o.idempotencyKey).toBe(`exact-cents-held-v1:${plan}:activate-first-paid-v1`);
    expect(p.pause_collection).toEqual({behavior:"keep_as_draft"});expect(p.proration_behavior).toBe("none");
    Object.assign(sub,{trial_end:p.trial_end,billing_cycle_anchor:p.trial_end,cancel_at:p.cancel_at,
      default_payment_method:p.default_payment_method,metadata:{...sub.metadata,...p.metadata as Stripe.Metadata}});
    return sub;
  });
  const mocks={...s.mocks,subscriptions:{...s.mocks.subscriptions,update},
    paymentMethods:{retrieve:jest.fn(async()=>({id:"pm_fixture",livemode:false,type:"card",customer:s.customer.id}))},
    balanceTransactions:{retrieve:jest.fn(async()=>({id:"txn_fixture",source:s.charge.id,type:"charge",
      amount:66633,currency:"usd",fee:1962,net:64671}))},
    invoices:{list:jest.fn(async()=>({has_more:false,data:[]})),create:jest.fn(),pay:jest.fn()},
    paymentIntents:{...s.mocks.paymentIntents,create:jest.fn(),confirm:jest.fn()}};
  const event=(type:string,id:string)=>({id,type,livemode:false,data:{object:type==="charge.updated"?s.charge:s.session}} as Stripe.Event);
  const args={...s.args,now:()=>now,stripe:mocks as unknown as Stripe,bindings,creditStore,activationStore,
    env:{...s.env,CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true",CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT:"false"},
    lifecycleStore:{seed:jest.fn(),fulfillFirst:async()=>{await fulfill();}},
    invoiceStore:{claim:jest.fn(),prepareDispatch:jest.fn(),admitDispatch:jest.fn(),recordReceipt:jest.fn(),
      completeAgreement:jest.fn(),priorPayments:jest.fn()},
    refundStore:{creditedReceipt:jest.fn(),hold:jest.fn(),apply:jest.fn(),confirmAdminDelivery:jest.fn()},
    lifecycleEventStore:{read:jest.fn(),hold:jest.fn(),observe:jest.fn(),dispute:jest.fn()},
    recoveryStore:{begin:jest.fn(),finish:jest.fn(),has:jest.fn()}};
  const checkout=event("checkout.session.completed","evt_checkout"),charge=event("charge.updated","evt_charge");
  const results=await Promise.allSettled([dispatchExactInstallmentEventSandbox({...args,verifiedEvent:checkout}),
    dispatchExactInstallmentEventSandbox({...args,verifiedEvent:charge})]);
  expect(results.some(r=>r.status==="fulfilled")).toBe(true);
  for(const r of results)if(r.status==="rejected")expect(String(r.reason)).toContain("busy");
  await dispatchExactInstallmentEventSandbox({...args,verifiedEvent:charge});
  await dispatchExactInstallmentEventSandbox({...args,verifiedEvent:checkout});
  expect(credits.filter(Boolean)).toHaveLength(1);
  expect((await db.query("select * from exact_installment_receipts")).rows).toHaveLength(1);
  expect((await db.query("select * from payment_fee_ledger")).rows).toHaveLength(1);
  expect(await row("purchases")).toMatchObject({paid_count:1,access_granted:true,status:"active",
    fulfillment:"discord",fulfillment_url:"https://discord.gg/synthetic"});
  expect(Number((await row("profiles")).total_earnings_cents)).toBe(56675);
  expect(await row("booking_payments")).toMatchObject({status:"completed"});
  expect(await row("exact_installment_agreements")).toMatchObject({status:"active"});
  expect(await row("exact_installment_activations")).toMatchObject({status:"complete"});
  expect((await db.query("select payment_number from exact_installment_periods order by payment_number")).rows)
    .toEqual([{payment_number:2},{payment_number:3}]);
  expect(sub.trial_end).toBe(exactActivationDates(s.charge.created,3).firstRenewalAt);
  expect(sub.pause_collection).toEqual({behavior:"keep_as_draft",resumes_at:null});expect(update).toHaveBeenCalledTimes(1);
  expect(mocks.invoices.create).not.toHaveBeenCalled();expect(mocks.invoices.pay).not.toHaveBeenCalled();
  expect(mocks.paymentIntents.create).not.toHaveBeenCalled();expect(mocks.paymentIntents.confirm).not.toHaveBeenCalled();
  expect(mocks.subscriptions.create).not.toHaveBeenCalled();expect(mocks.checkout.sessions.create).not.toHaveBeenCalled();
  // Promise interleaving in a single PGlite backend, not a hosted multi-worker proof.
});

describe("057 prospective checkout reservation/publication", () => {
  // Replace only this test's fresh in-memory fixture. No hosted data is used.
  const fresh = async () => {
    await db.exec("delete from exact_installment_operations; delete from exact_installment_agreements; delete from booking_payments;");
  };
  const reserve = (who=t.creatorId,count=3,first:unknown=t.firstPaymentFeeSchedule) => db.query<{id:string}>(
    "select reserve_exact_installment_checkout($1,$2,$3,$4,$5,$6) id",[t.bookingId,who,count,t.previewOrigin,
      JSON.stringify(first),JSON.stringify(t.renewalFeeSchedule)]);
  const publication = async (overrides: Record<string,unknown>={}) => {
    const a=await row("exact_installment_agreements");
    const args={plan:a.id,actor:t.creatorId,session:"cs_test_fixture",subscription:"sub_fixture",purchase:a.purchase_id,
      url:"https://checkout.stripe.com/c/pay/cs_test_fixture#synthetic",expiry:Math.floor(new Date(String(a.created_at)).getTime()/1000)+86400,
      hash:"a".repeat(64),...overrides};
    return db.query<{result:{url:string;reused:boolean;payment:Record<string,unknown>}}>(
      "select publish_exact_installment_checkout($1,$2,$3,$4,$5,$6,$7,$8) result",Object.values(args));
  };
  const ready = async () => {
    await fresh(); const id=(await reserve()).rows[0].id;
    for(const [step,result] of [["customer","cus_fixture"],["product","prod_fixture"],["subscription","sub_fixture"],
      ["hold","sub_fixture"],["checkout","cs_test_fixture"]]) {
      await db.query("select claim_exact_installment_operation($1,$2,$3,$4)",[id,step,"a".repeat(64),t.buyerId]);
      await db.query("select complete_exact_installment_operation($1,$2,$3,$4)",[id,step,t.buyerId,result]);
    }
    await db.query("select bind_exact_installment_checkout($1,'cus_fixture','sub_fixture','cs_test_fixture')",[id]);
    await db.query("select seed_exact_installment_purchase($1)",[id]);
    return id;
  };
  test("reserves real booking identities/price and first fee atomically; exact repeat reuses the row",async()=>{
    await fresh(); const id=(await reserve()).rows[0].id;
    expect((await reserve()).rows[0].id).toBe(id);
    expect((await db.query("select * from booking_payments")).rows).toHaveLength(1);
    expect(await row("booking_payments")).toMatchObject({booking_id:t.bookingId,amount_total_cents:199900,
      installment_amount_cents:66633,platform_fee_cents:7996,processing_fee_cents:1962,total_creator_deduction_cents:9958,
      creator_net_cents:56675,fee_schedule_version:"synthetic-card",installment_collection_version:"exact-cents-held-v1",
      status:"pending",link_url:null});
    expect((await row("exact_installment_agreements")).terms).toMatchObject({title:"Synthetic",buyerId:t.buyerId,creatorId:t.creatorId});
    expect((await db.query("select * from purchases")).rows).toHaveLength(0);
  });
  test.each([1,25,0,2.5])("invalid count %s cannot leave an orphan reservation",async(count)=>{
    await fresh(); await expect(reserve(t.creatorId,count)).rejects.toThrow();
    expect((await db.query("select * from booking_payments")).rows).toHaveLength(0);
  });
  test.each([null,{...t.firstPaymentFeeSchedule,basisPoints:-1},{...t.firstPaymentFeeSchedule,fixedCents:1000000}])(
    "invalid fee schedule rolls back the payment row",async(first)=>{
      await fresh(); await expect(reserve(t.creatorId,3,first)).rejects.toThrow();
      expect((await db.query("select * from booking_payments")).rows).toHaveLength(0);
    });
  test("foreign creator cannot reserve and an old payment cannot be adopted",async()=>{
    await expect(reserve(t.buyerId)).rejects.toThrow();
    await db.exec("delete from exact_installment_operations; delete from exact_installment_agreements;");
    await expect(reserve()).rejects.toThrow("cannot be converted");
    expect((await row("booking_payments")).installment_collection_version).toBeNull();
  });
  test.each([
    "update products set amount_cents=199901", "update products set currency='eur'", "update products set is_active=false",
    "update profiles set stripe_account_id='acct_changed'", "update profiles set stripe_onboarding_complete=false",
    "update bookings set status='completed'",
  ])("changed source cannot rewrite reserved terms: %s",async(sql)=>{
    await fresh(); await reserve(); const saved=(await row("exact_installment_agreements")).terms;
    await db.exec(sql); await expect(reserve()).rejects.toThrow();
    expect((await row("exact_installment_agreements")).terms).toEqual(saved);
  });
  test("a changed count cannot replace a reservation",async()=>{
    await fresh(); await reserve(); await expect(reserve(t.creatorId,4)).rejects.toThrow("terms changed");
  });
  test("publishes only seeded unpaid checkout, reuses its exact link, grants no access/earnings",async()=>{
    await ready(); const first=(await publication()).rows[0].result;
    expect(first.reused).toBe(false);
    expect(first.payment).toMatchObject({status:"link_sent",link_url:first.url});
    const sent=first.payment.link_sent_at;
    expect((await publication()).rows[0].result).toMatchObject({reused:true,payment:{link_sent_at:sent}});
    expect(await row("purchases")).toMatchObject({status:"pending",access_granted:false,paid_count:0});
    expect((await row("profiles")).total_earnings_cents).toBe(0);
    expect((await db.query("select * from payment_fee_ledger")).rows).toHaveLength(0);
  });
  test.each([
    {actor:t.buyerId},{session:"cs_test_other"},{subscription:"sub_other"},{purchase:t.buyerId},{hash:"b".repeat(64)},
    {url:"https://checkout.stripe.com.evil.invalid/c/pay/cs_test_fixture"},
    {url:"https://checkout.stripe.com/c/pay/cs_test_other"},{expiry:1},
  ])("rejects mismatched publication binding %j",async(overrides)=>{
    await ready(); await expect(publication(overrides)).rejects.toThrow();
    expect((await row("booking_payments")).link_url).toBeNull();
  });
  test.each([
    "update purchases set access_granted=true", "update purchases set is_suspect=true", "update purchases set is_refund=true",
    "update purchases set paid_count=1", "update products set amount_cents=10", "update profiles set stripe_account_id='acct_changed'",
  ])("rejects changed unpaid/source state: %s",async(sql)=>{
    await ready(); await db.exec(sql); await expect(publication()).rejects.toThrow();
    expect((await row("booking_payments")).link_url).toBeNull();
  });
  test("a stop hold wins before publication",async()=>{
    const id=await ready(); await db.query("insert into profiles(id,role) values($1,'admin')",[t.buyerId]);
    await db.query("select hold_exact_installment_for_cancellation($1,$2,$3)",[id,t.bookingId,t.buyerId]);
    await expect(publication()).rejects.toThrow();
    expect((await row("booking_payments")).link_url).toBeNull();
  });
  test("first-payment estimate and prospective marker cannot change or adopt old rows",async()=>{
    await expect(db.exec("update booking_payments set installment_collection_version='exact-cents-held-v1'"))
      .rejects.toThrow("cannot be converted");
    await ready();
    for(const sql of ["update booking_payments set installment_collection_version=null",
      "update booking_payments set processing_fee_cents=0","update booking_payments set installment_amount_cents=1"]) {
      await expect(db.exec(sql)).rejects.toThrow("immutable");
    }
    expect((await publication()).rows[0].result.payment.processing_fee_cents).toBe(1962);
  });
  test("reserve and publish RPCs are private to service_role",async()=>{
    for(const name of ["reserve_exact_installment_checkout","publish_exact_installment_checkout"]) {
      const r=(await db.query<{anon:boolean;authenticated:boolean;service:boolean}>(`select
        has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,
        has_function_privilege('service_role',oid,'EXECUTE') service from pg_proc where proname=$1`,[name])).rows[0];
      expect(r).toEqual({anon:false,authenticated:false,service:true});
    }
  });
});

// 045 ordered-interleaving tests use real PostgreSQL RPCs with synthetic local
// records. PGlite is single-connection: this is NOT hosted concurrency proof.
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const refundId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const adminActor = () => db.query("insert into profiles(id,role) values($1,'admin') on conflict(id) do nothing",[actor]);
const cancelHold = (request=requestId, who=actor) => db.query<{id:string}>(
  "select hold_exact_installment_for_cancellation($1,$2,$3) id",[plan,request,who]);
test("050 stale tabs cannot insert a second stop request; original identity remains retryable",async()=>{
  await adminActor(); await cancelHold();
  await expect(cancelHold(t.buyerId)).rejects.toThrow("identity changed");
  await cancelHold();
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(1);
  expect(await row("exact_installment_collection_holds")).toMatchObject({request_id:requestId,requested_by:actor});
});
const refundAdmission = (token=t.buyerId) => db.query<{result:string}>(
  "select admit_exact_installment_admin_refund($1,$2) result",[refundId,token]);
async function refundReservation(pi="pi_fixture1") {
  await adminActor();
  await db.query(`insert into refund_operations(id,stripe_payment_intent_id,status,payment_fee_ledger_id,
    creator_id,initiated_by,processing_token,processing_claimed_at)
    select $1,$2,'pending',id,creator_id,$3,$4,now() from payment_fee_ledger where stripe_payment_intent_id=$2`,
  [refundId,pi,actor,t.buyerId]);
}
async function renewalReady() {
  await firstPaid(); await fulfill();
  await db.query("select claim_exact_installment_activation($1,'pm_fixture','si_fixture',$2)",[plan,t.buyerId]);
  await db.query("select complete_exact_installment_activation($1,$2)",[plan,t.buyerId]);
  await db.exec("update exact_installment_periods set due_at=floor(extract(epoch from now()))-60 where payment_number=2");
}
const claimRenewal = () => db.query<{result:{status:string}}>(`select claim_exact_installment_invoice($1,'in_renewal2','sub_fixture',
  due_at,period_end,$2) result from exact_installment_periods where agreement_id=$1 and payment_number=2`,[plan,t.buyerId]);
const prepareRenewal = () => db.query("select prepare_exact_installment_dispatch($1,'in_renewal2','pi_fixture2',$2)",[plan,t.buyerId]);
const admitRenewal = () => db.query("select admit_exact_installment_dispatch($1,'in_renewal2',$2)",[plan,t.buyerId]);
const recordRenewalReceipt = () => db.query(`select record_exact_installment_renewal_receipt($1,'in_renewal2','pi_fixture2',66633,10425,
  date_trunc('second',dispatch_started_at)) from exact_installment_invoice_claims where agreement_id=$1`,[plan]);
const creditRenewal = () => db.query("select credit_exact_installment_receipt($1,2,'ch_fixture2','txn_fixture2',2429)",[plan]);

const claimStop=(who=actor,token=t.buyerId,request=requestId)=>db.query<{result:string}>(
  "select claim_exact_installment_billing_stop($1,$2,$3,$4) result",[plan,request,who,token]);
const assertStop=(token=t.buyerId)=>db.query("select assert_exact_installment_billing_stop($1,$2,$3,$4)",[plan,requestId,actor,token]);
const completeStop=(checkout="expired",pi:string|null=null,subscription="sub_fixture",token=t.buyerId)=>db.query(
  `select complete_exact_installment_billing_stop($1,$2,$3,$4,$5,'cs_test_fixture',floor(extract(epoch from now()))::bigint,$6,$7)`,
  [plan,requestId,actor,token,subscription,checkout,pi]);

type ObservationRead={revision:number;basis:Record<string,unknown>};
const readObservation=async(object="du_fixture")=>(await db.query<{result:ObservationRead}>(
  "select read_exact_installment_lifecycle($1,$2) result",[plan,object])).rows[0].result;
const lifecycleHold=(event="evt_fixture",object="du_fixture",pi:string|null="pi_fixture1")=>db.query(
  "select hold_exact_installment_lifecycle_event($1,$2,$3,$4)",[plan,event,object,pi]);
const observeSubscription=async(read:ObservationRead,disposition="expected_held_schedule",event="evt_fixture")=>(await db.query<{result:boolean}>(
  "select finish_exact_installment_lifecycle($1,$2,'sub_fixture',$3,$4,$5,$6) result",
  [plan,event,read.revision,JSON.stringify(read.basis),disposition,JSON.stringify({status:"active"})])).rows[0].result;
const applyDispute=async(read:ObservationRead,status="needs_response",event="evt_fixture",dispute="du_fixture",created=100,amount=1000)=>(
  await db.query<{result:string}>(`select apply_exact_installment_dispute_event($1,$2,$3,$4,$5,
    'pi_fixture1','ch_fixture1',66633,$6,$7,$8) result`,[plan,event,dispute,read.revision,JSON.stringify(read.basis),amount,status,created])).rows[0].result;

const admittedRenewal=async()=>{await renewalReady();await claimRenewal();await prepareRenewal();await admitRenewal();};
const beginRecovery=async()=>(await db.query<{result:ObservationRead&{dispatchStartedAt:number}}>(
  "select begin_exact_installment_recovery($1,'in_renewal2') result",[plan])).rows[0].result;
const recoveryEvidence={invoiceStatus:"open",paymentStatus:"requires_action",amountReceived:0,amountCapturable:0,canceledAt:null,voidedAt:null};
const finishRecovery=async(read:ObservationRead,outcome="action_required",event="evt_recovery",evidence:Record<string,unknown>=recoveryEvidence)=>(
  await db.query<{result:boolean}>(`select finish_exact_installment_recovery($1,'in_renewal2','pi_fixture2',$2,$3,$4,$5,$6) result`,
  [plan,read.revision,JSON.stringify(read.basis),outcome,event,JSON.stringify(evidence)])).rows[0].result;
const terminalRecovery=async()=>{
  const r=await beginRecovery();return finishRecovery(r,"terminal_unpaid","evt_terminal",{invoiceStatus:"void",paymentStatus:"canceled",
    amountReceived:0,amountCapturable:0,canceledAt:r.dispatchStartedAt,voidedAt:r.dispatchStartedAt});
};

const cardRequest="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const reserveCard=(request=cardRequest,buyer=t.buyerId,version="replacement-card-setup-v1")=>db.query(
  "select * from reserve_exact_card_setup($1,$2,'in_renewal2',$3,$4)",[request,plan,buyer,version]);
const currentCard=(buyer=t.buyerId)=>db.query("select * from read_current_exact_card_setup($1,$2)",[cardRequest,buyer]);
const bindCard=(session="cs_test_cardsetup")=>db.query("select bind_exact_card_setup($1,$2,$3)",[cardRequest,t.buyerId,session]);
const verifyCard=(session="cs_test_cardsetup",setup="seti_cardsetup",pm="pm_replacement")=>db.query(
  "select verify_exact_card_setup($1,$2,$3,$4,$5)",[cardRequest,t.buyerId,session,setup,pm]);
async function declinedCardSetup() {
  await admittedRenewal();const r=await beginRecovery();
  await finishRecovery(r,"payment_method_required","evt_decline",{...recoveryEvidence,paymentStatus:"requires_payment_method"});
}

const paymentQuoteId="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const quotePayment=(id=paymentQuoteId,buyer=t.buyerId)=>db.query("select * from quote_exact_installment_retry($1,$2,$3)",[id,cardRequest,buyer]);
const confirmPayment=(id=paymentQuoteId,buyer=t.buyerId,version="single-invoice-retry-v1")=>db.query(
  "select * from confirm_exact_installment_retry($1,$2,$3)",[id,buyer,version]);
const buyerView=async(buyer=t.buyerId)=>(await db.query<{result:Record<string,unknown>}>(
  "select read_exact_buyer_recovery($1,$2) result",[plan,buyer])).rows[0].result;
const readyPaymentQuote=async()=>{await declinedCardSetup();await reserveCard();await bindCard();await verifyCard();};

const retryReady=async()=>{await readyPaymentQuote();
  await db.query("select * from quote_exact_installment_retry($1,$2,$3,'single-invoice-pay-now-v1')",[paymentQuoteId,cardRequest,t.buyerId]);
  await confirmPayment(paymentQuoteId,t.buyerId,"single-invoice-pay-now-v1");};
const admitRetry=async(buyer=t.buyerId)=>(await db.query<{result:boolean}>(
  "select admit_exact_installment_retry($1,$2) result",[paymentQuoteId,buyer])).rows[0].result;
const retryReceipt=()=>db.query(`select record_exact_installment_retry_receipt($1,'in_renewal2','pi_fixture2',66633,10425,
  date_trunc('second',admitted_at)) result from exact_installment_retry_admissions where confirmation_id=$1`,[paymentQuoteId]);

const futureQuote=()=>db.query("select * from quote_exact_installment_future_card($1,$2,$3)",[paymentQuoteId,cardRequest,t.buyerId]);
const futureConfirm=(accepted=true,buyer=t.buyerId)=>db.query("select * from confirm_exact_installment_future_card($1,$2,$3,'same-plan-remaining-card-v1')",
  [paymentQuoteId,buyer,accepted]);
const claimThird=()=>db.query<{result:{status:string;authorization:Record<string,unknown>}}>(`select claim_exact_installment_invoice($1,'in_renewal3','sub_fixture',
  due_at,period_end,$2) result from exact_installment_periods where agreement_id=$1 and payment_number=3`,[plan,t.buyerId]);
async function futureReady(accepted=true,dueSoon=false){
  await admittedRenewal();
  if(dueSoon) {
    // Synthetic short period set BEFORE card setup and consent. Wait for its
    // real boundary, rather than rewriting the saved schedule after consent.
    await db.exec("update exact_installment_periods set period_end=floor(extract(epoch from now()))+3 where payment_number=2");
    await db.exec("update exact_installment_periods set due_at=(select period_end from exact_installment_periods where payment_number=2) where payment_number=3");
  }
  const r=await beginRecovery();await finishRecovery(r,"payment_method_required","evt_decline",{...recoveryEvidence,paymentStatus:"requires_payment_method"});
  await reserveCard();await bindCard();await verifyCard();await futureQuote();await futureConfirm(accepted);
}
async function futurePaid(accepted=true){
  await futureReady(accepted,true);await admitRetry();await retryReceipt();await creditRenewal();
  const due=Number((await db.query<{due_at:number}>("select due_at from exact_installment_periods where payment_number=3")).rows[0].due_at);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,due*1000-Date.now()+30)));
}

test.each([true,false])("056 consent is separate, immutable, atomic and does not admit payment: %s",async(accepted)=>{
  await futureReady(accepted);const q=await row("exact_installment_payment_confirmations"),c=await row("exact_installment_future_card_choices");
  expect(q).toMatchObject({future_card_option:true,future_card_accepted:accepted,consent_version:"single-invoice-pay-now-v1"});
  expect(c).toMatchObject({accepted,confirmation_id:paymentQuoteId,agreement_id:plan,first_payment_number:3});
  const {FUTURE_CARD_CONSENT_TEXT}=await import("../lib/installments/buyerRecoveryView");
  expect(c.consent_text).toBe(FUTURE_CARD_CONSENT_TEXT);
  expect(await buyerView()).toMatchObject({futureCardAccepted:accepted});
  expect((await db.query("select * from exact_installment_retry_admissions")).rows).toHaveLength(0);
  expect((await db.query("select * from exact_installment_invoice_cards")).rows).toHaveLength(0);
  await futureConfirm(accepted);expect(await row("exact_installment_future_card_choices")).toEqual(c);
  await expect(futureConfirm(!accepted)).rejects.toThrow("cannot change");
  expect(await row("exact_installment_payment_confirmations")).toEqual(q);
});
test("056 old reviewed/confirmed intents cannot acquire future consent",async()=>{
  await retryReady();await expect(futureQuote()).rejects.toThrow();await expect(futureConfirm()).rejects.toThrow("not reviewed");
  expect((await db.query("select * from exact_installment_future_card_choices")).rows).toHaveLength(0);
});
test("056 a future review cannot bypass the separate choice through old confirmation RPC",async()=>{
  await readyPaymentQuote();await futureQuote();await confirmPayment(paymentQuoteId,t.buyerId,"single-invoice-pay-now-v1");
  await expect(admitRetry()).rejects.toThrow("decision not recorded");await expect(futureConfirm()).rejects.toThrow("cannot change");
});
test.each(["wrong buyer","changed schedule","expired","other hold"])("056 %s cannot record new consent",async(problem)=>{
  await readyPaymentQuote();await futureQuote();
  if(problem==="changed schedule")await db.exec("update exact_installment_periods set due_at=due_at+1 where payment_number=3");
  if(problem==="expired")await db.exec("update exact_installment_payment_confirmations set expires_at=floor(extract(epoch from now()))");
  if(problem==="other hold"){await adminActor();await cancelHold();}
  await expect(futureConfirm(true,problem==="wrong buyer"?actor:t.buyerId)).rejects.toThrow();
  expect((await row("exact_installment_payment_confirmations")).confirmed_at).toBeNull();
  expect((await db.query("select * from exact_installment_future_card_choices")).rows).toHaveLength(0);
});
test.each(["no admission","not paid","not credited"])("056 %s cannot switch the future card or release the hold",async(problem)=>{
  await futureReady();if(problem!=="no admission")await admitRetry();if(problem==="not credited")await retryReceipt();
  const hold=await row("exact_installment_collection_holds");await expect(claimThird()).rejects.toThrow("not credited");
  expect(await row("exact_installment_collection_holds")).toEqual(hold);
  expect((await db.query("select * from exact_installment_resolved_card_holds")).rows).toHaveLength(0);
});
test("056 consented paid retry binds only next scheduled invoice; defaults, agreement and earlier claim stay unchanged",async()=>{
  await futurePaid();const a=await row("exact_installment_agreements"),activation=await row("exact_installment_activations"),
    original=await row("exact_installment_invoice_claims"),hold=await row("exact_installment_collection_holds"),periods=(await db.query("select * from exact_installment_periods order by payment_number")).rows;
  const result=(await claimThird()).rows[0].result;
  expect(result).toMatchObject({status:"prepare",authorization:{paymentNumber:3,totalCents:199900,paymentMethodId:"pm_replacement",
    defaultPaymentMethodId:"pm_fixture",cardAuthorizationId:paymentQuoteId}});
  expect(await row("exact_installment_agreements")).toEqual(a);expect(await row("exact_installment_activations")).toEqual(activation);
  expect((await db.query("select * from exact_installment_invoice_claims where payment_number=2")).rows[0]).toEqual(original);
  expect((await db.query("select * from exact_installment_periods order by payment_number")).rows).toEqual(periods);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(0);
  const archived=await row("exact_installment_resolved_card_holds"),snapshot=archived.hold_snapshot as Record<string,unknown>;
  expect(archived).toMatchObject({hold_id:hold.id,confirmation_id:paymentQuoteId});
  expect({...snapshot,created_at:new Date(snapshot.created_at as string).toISOString()}).toEqual(JSON.parse(JSON.stringify(hold)));
  const binding=await row("exact_installment_invoice_cards");expect((await claimThird()).rows[0].result.status).toBe("busy");
  await db.exec("update exact_installment_invoice_claims set lease_until=now()-interval '1 second' where payment_number=3");
  expect((await claimThird()).rows[0].result.authorization).toEqual(result.authorization);
  expect(await row("exact_installment_invoice_cards")).toEqual(binding);
  expect((await claimRenewal()).rows[0].result).toMatchObject({authorization:{paymentNumber:2,paymentMethodId:"pm_fixture"}});
});
test("056 unchecked still permits one invoice retry, but never releases future collection",async()=>{
  await futurePaid(false);const hold=await row("exact_installment_collection_holds");
  await expect(claimThird()).rejects.toThrow("held for review");expect(await row("exact_installment_collection_holds")).toEqual(hold);
  expect((await db.query("select * from exact_installment_invoice_cards")).rows).toHaveLength(0);
});
test("056 a later hold/refund cannot rewrite the admitted future card or prevent receipt reconciliation",async()=>{
  await futurePaid();const original=(await claimThird()).rows[0].result.authorization;
  await db.query("select prepare_exact_installment_dispatch($1,'in_renewal3','pi_fixture3',$2)",[plan,t.buyerId]);
  await db.query("select admit_exact_installment_dispatch($1,'in_renewal3',$2)",[plan,t.buyerId]);
  await adminActor();await cancelHold();await db.exec("update payment_fee_ledger set refunded_amount_cents=1,status='refunded' where stripe_payment_intent_id='pi_fixture2'");
  expect((await claimThird()).rows[0].result).toMatchObject({status:"reconcile",authorization:original,paymentIntentId:"pi_fixture3"});
  expect((await db.query("select * from exact_installment_collection_holds where reason='cancellation_review'")).rows).toHaveLength(1);
  await expect(db.query("select admit_exact_installment_dispatch($1,'in_renewal3',$2)",[plan,t.buyerId])).rejects.toThrow();
});
test.each(["cancellation","refund","dispute","purchase","schedule"])("056 %s still blocks new collection and rolls back hold archival",async(problem)=>{
  await futurePaid();
  if(problem==="cancellation"){await adminActor();await cancelHold();}
  if(problem==="refund")await db.exec("update payment_fee_ledger set refunded_amount_cents=1 where stripe_payment_intent_id='pi_fixture1'");
  if(problem==="dispute")await db.exec("update payment_fee_ledger set dispute_status='lost' where stripe_payment_intent_id='pi_fixture1'");
  if(problem==="purchase")await db.exec("update purchases set access_granted=false");
  if(problem==="schedule")await db.exec("update exact_installment_periods set period_end=period_end+1 where payment_number=3");
  const holds=(await db.query("select * from exact_installment_collection_holds order by id")).rows;
  await expect(claimThird()).rejects.toThrow();
  expect((await db.query("select * from exact_installment_collection_holds order by id")).rows).toEqual(holds);
  expect((await db.query("select * from exact_installment_resolved_card_holds")).rows).toHaveLength(0);
  expect((await db.query("select * from exact_installment_invoice_cards")).rows).toHaveLength(0);
});
test.each(["anon","authenticated","service_role"])("056 %s cannot mutate evidence or call the bypass helpers",async(role)=>{
  for(const fn of ["claim_exact_installment_invoice_original(uuid,text,text,bigint,bigint,uuid)","admit_exact_installment_retry_original(uuid,uuid)"])
    expect((await db.query<{ok:boolean}>("select has_function_privilege($1,$2,'EXECUTE') ok",[role,fn])).rows[0].ok).toBe(false);
  for(const table of ["exact_installment_future_card_choices","exact_installment_invoice_cards","exact_installment_resolved_card_holds"])
    expect((await db.query<{ok:boolean}>("select has_table_privilege($1,$2,'INSERT,UPDATE,DELETE') ok",[role,table])).rows[0].ok).toBe(false);
  expect((await db.query<{ok:boolean}>("select has_function_privilege($1,'confirm_exact_installment_future_card(uuid,uuid,boolean,text)','EXECUTE') ok",[role])).rows[0].ok).toBe(role==="service_role");
});

test("054 existing record-only confirmation cannot become chargeable later",async()=>{
  await readyPaymentQuote();await quotePayment();await confirmPayment();
  await expect(admitRetry()).rejects.toThrow("fresh confirmed payment required");
  await expect(confirmPayment(paymentQuoteId,t.buyerId,"single-invoice-pay-now-v1")).rejects.toThrow("execution mode changed");
  await expect(db.query("select * from quote_exact_installment_retry($1,$2,$3,'single-invoice-pay-now-v1')",
    [paymentQuoteId,cardRequest,t.buyerId])).rejects.toThrow("binding changed");
  expect(await row("exact_installment_payment_confirmations")).toMatchObject({consent_version:"single-invoice-retry-v1"});
  expect((await db.query("select * from exact_installment_retry_admissions")).rows).toHaveLength(0);
});
test("054 a pay-now quote cannot be read or confirmed under old record-only wording",async()=>{
  await retryReady();await expect(quotePayment()).rejects.toThrow("binding changed");
  await expect(confirmPayment()).rejects.toThrow("execution mode changed");
  expect(await admitRetry()).toBe(true);
});
test.each([null,"unknown"])("054 invalid execution version %s cannot create a review",async(version)=>{
  await readyPaymentQuote();
  await expect(db.query("select * from quote_exact_installment_retry($1,$2,$3,$4)",[paymentQuoteId,cardRequest,t.buyerId,version])).rejects.toThrow();
  expect((await db.query("select * from exact_installment_payment_confirmations")).rows).toHaveLength(0);
});

const bankContext=async(action=true,buyer=t.buyerId)=>(await db.query<{result:Record<string,unknown>}>(
  "select read_exact_installment_bank_context($1,'in_renewal2',$2,$3) result",[plan,buyer,action])).rows[0].result;
const bankReady=async(retry=true)=>{
  if(retry){await retryReady();await admitRetry();}else await admittedRenewal();
  await finishRecovery(await beginRecovery(),"action_required","evt_bank");
};
test.each([false,true])("055 bank context keeps original claim, holds, ledgers and defaults immutable, retry=%s",async(retry)=>{
  await bankReady(retry);
  const tables=["exact_installment_invoice_claims","exact_installment_activations","exact_installment_collection_holds",
    "payment_fee_ledger","purchases","exact_installment_payment_recoveries"];
  const before=await Promise.all(tables.map(row));
  const context=await bankContext();expect(context).toMatchObject({status:"reconcile",buyerId:t.buyerId,paymentIntentId:"pi_fixture2",
    paymentMethodId:retry?"pm_replacement":"pm_fixture",retryId:retry?paymentQuoteId:null});
  expect(context.authorization).toEqual(expect.objectContaining({paymentMethodId:"pm_fixture",invoiceId:"in_renewal2"}));
  expect(await bankContext()).toEqual(context);expect(await Promise.all(tables.map(row))).toEqual(before);
  expect((await db.query("select * from exact_installment_retry_admissions")).rows).toHaveLength(retry?1:0);
});
test.each(["wrong buyer","not observed","stop","refund hold","subscription hold","receipt","suspect","access removed","wrong count",
  "wrong currency","booking canceled","payment canceled","prior refund","prior reversal","prior mismatch","refund mirror","dispute mirror",
  "pending refund","inactive","wrong card binding","old consent","unconfirmed","expired admission","no activation"])
("055 bank action rejects %s without changing admission",async(problem)=>{
  await bankReady();const before=await row("exact_installment_retry_admissions");
  if(problem==="not observed")await db.exec("update exact_installment_payment_recoveries set outcome='payment_method_required'");
  if(problem==="stop"){await adminActor();await cancelHold();}
  if(problem==="refund hold"){await refundReservation();await refundAdmission();}
  if(problem==="subscription hold")await lifecycleHold("evt_bankhold","sub_fixture",null);
  if(problem==="receipt")await recordRenewalReceipt();
  if(problem==="suspect")await db.exec("update purchases set is_suspect=true");
  if(problem==="access removed")await db.exec("update purchases set access_granted=false");
  if(problem==="wrong count")await db.exec("update purchases set paid_count=2");
  if(problem==="wrong currency")await db.exec("update purchases set currency='eur'");
  if(problem==="booking canceled")await db.exec("update bookings set status='canceled'");
  if(problem==="payment canceled")await db.exec("update booking_payments set status='canceled'");
  if(problem==="prior refund")await db.exec("update payment_fee_ledger set refunded_amount_cents=1");
  if(problem==="prior reversal")await db.exec("update payment_fee_ledger set earnings_reversed_cents=1");
  if(problem==="prior mismatch")await db.exec("update payment_fee_ledger set stripe_payment_intent_id='pi_other'");
  if(problem==="refund mirror")await db.exec("insert into payment_refund_state(stripe_payment_intent_id,refunded_amount_cents) values('pi_fixture1',1)");
  if(problem==="dispute mirror")await db.exec(`insert into payment_dispute_state(stripe_dispute_id,stripe_payment_intent_id,stripe_charge_id,
    disputed_amount_cents,currency,status,stripe_event_created) values('du_bank','pi_fixture1','ch_fixture1',1,'usd','needs_response',1)`);
  if(problem==="pending refund")await refundReservation();
  if(problem==="inactive")await db.exec("update exact_installment_agreements set status='review_required'");
  if(problem==="wrong card binding")await db.exec("update exact_installment_payment_confirmations set replacement_payment_method_id='pm_other'");
  if(problem==="old consent")await db.exec("update exact_installment_payment_confirmations set consent_version='single-invoice-retry-v1'");
  if(problem==="unconfirmed")await db.exec("update exact_installment_payment_confirmations set confirmed_at=null");
  if(problem==="expired admission")await db.exec("update exact_installment_payment_confirmations set expires_at=floor(extract(epoch from now()))-1");
  if(problem==="no activation")await db.exec("update exact_installment_activations set status='running',activated_at=null");
  await expect(bankContext(true,problem==="wrong buyer"?actor:t.buyerId)).rejects.toThrow();
  expect(await row("exact_installment_retry_admissions")).toEqual(before);
});
test("055 receipt-only context remains readable after a racing stop, but never opens a challenge",async()=>{
  await bankReady();await adminActor();await cancelHold();
  await expect(bankContext()).rejects.toThrow();expect(await bankContext(false)).toMatchObject({retryId:paymentQuoteId});
  expect((await retryReceipt()).rows[0]).toEqual({result:true});await creditRenewal();
  expect(await bankContext(false)).toMatchObject({paymentIntentId:"pi_fixture2"});
  await expect(bankContext()).rejects.toThrow();
});
test.each(["anon","authenticated"])("055 %s cannot read a bank capability even with known IDs",async(role)=>{
  await bankReady();await db.exec(`set role ${role}`);
  try {await expect(bankContext()).rejects.toThrow();await expect(bankContext(false)).rejects.toThrow();}
  finally{await db.exec("reset role");}
});
test("055 unadmitted or merely prepared claims never yield bank context",async()=>{
  await renewalReady();await claimRenewal();await prepareRenewal();
  await expect(bankContext()).rejects.toThrow();await expect(bankContext(false)).rejects.toThrow();
});

test("053 one confirmed retry consumes exactly one admission without altering original evidence/holds",async()=>{
  await retryReady();const tables=["exact_installment_invoice_claims","exact_installment_activations","exact_installment_collection_holds",
    "exact_installment_payment_confirmations","payment_fee_ledger","purchases"];
  const before=await Promise.all(tables.map(row));
  expect(await admitRetry()).toBe(true);const admission=await row("exact_installment_retry_admissions");
  expect(await admitRetry()).toBe(false);expect(await row("exact_installment_retry_admissions")).toEqual(admission);
  expect(await Promise.all(tables.map(row))).toEqual(before);
  await expect(db.query("select assert_exact_installment_renewal_ready($1,2)",[plan])).rejects.toThrow("held for review");
  expect((await db.query<{result:boolean}>("select exact_installment_stop_is_quiescent($1) result",[plan])).rows[0].result).toBe(false);
});
test.each(["wrong buyer","unconfirmed","expired","cancellation","refund hold","subscription hold","paid receipt","suspect","access removed",
  "wrong purchase subscription","wrong purchase session","wrong count","wrong currency","booking canceled","payment canceled",
  "prior ledger refunded","prior earnings reversed","prior ledger mismatch","prior refund mirror","prior dispute mirror","pending refund",
  "inactive agreement","stale setup","wrong replacement","activation incomplete"])("053 %s blocks a fresh retry",async(problem)=>{
  await retryReady();
  if(problem==="unconfirmed") await db.exec("update exact_installment_payment_confirmations set confirmed_at=null");
  if(problem==="expired") await db.exec("update exact_installment_payment_confirmations set expires_at=floor(extract(epoch from now()))-1");
  if(problem==="cancellation") {await adminActor();await cancelHold();}
  if(problem==="refund hold") {await refundReservation();await refundAdmission();}
  if(problem==="subscription hold") await lifecycleHold("evt_hold","sub_fixture",null);
  if(problem==="paid receipt") await recordRenewalReceipt();
  if(problem==="suspect") await db.exec("update purchases set is_suspect=true");
  if(problem==="access removed") await db.exec("update purchases set access_granted=false");
  if(problem==="wrong purchase subscription") await db.exec("update purchases set subscription_id='sub_other'");
  if(problem==="wrong purchase session") await db.exec("update purchases set session_id='cs_test_other'");
  if(problem==="wrong count") await db.exec("update purchases set paid_count=2");
  if(problem==="wrong currency") await db.exec("update purchases set currency='eur'");
  if(problem==="booking canceled") await db.exec("update bookings set status='canceled'");
  if(problem==="payment canceled") await db.exec("update booking_payments set status='canceled'");
  if(problem==="prior ledger refunded") await db.exec("update payment_fee_ledger set refunded_amount_cents=1");
  if(problem==="prior earnings reversed") await db.exec("update payment_fee_ledger set earnings_reversed_cents=1");
  if(problem==="prior ledger mismatch") await db.exec("update payment_fee_ledger set stripe_payment_intent_id='pi_other'");
  if(problem==="prior refund mirror") await db.exec("insert into payment_refund_state(stripe_payment_intent_id,refunded_amount_cents) values('pi_fixture1',1)");
  if(problem==="prior dispute mirror") await db.exec(`insert into payment_dispute_state(stripe_dispute_id,stripe_payment_intent_id,stripe_charge_id,
    disputed_amount_cents,currency,status,stripe_event_created) values('du_retry','pi_fixture1','ch_fixture1',1,'usd','needs_response',1)`);
  if(problem==="pending refund") await refundReservation();
  if(problem==="inactive agreement") await db.exec("update exact_installment_agreements set status='review_required'");
  if(problem==="stale setup") await db.exec("update exact_installment_card_setups set expires_at=floor(extract(epoch from now()))-1");
  if(problem==="wrong replacement") await db.exec("update exact_installment_payment_confirmations set replacement_payment_method_id='pm_other'");
  if(problem==="activation incomplete") await db.exec("update exact_installment_activations set status='running',activated_at=null");
  await expect(admitRetry(problem==="wrong buyer"?actor:t.buyerId)).rejects.toThrow();
  expect((await db.query("select * from exact_installment_retry_admissions")).rows).toHaveLength(0);
});
test("053 consumed admission never reopens after later cancellation or quote expiry",async()=>{
  await retryReady();expect(await admitRetry()).toBe(true);await adminActor();await cancelHold();
  await db.exec("update exact_installment_payment_confirmations set expires_at=floor(extract(epoch from now()))-1");
  expect(await admitRetry()).toBe(false);
});
test("053 pre-admission observation cannot overwrite the new attempt's recovery state",async()=>{
  await retryReady();const old=await beginRecovery();await admitRetry();
  expect(await finishRecovery(old,"payment_method_required","evt_old",{...recoveryEvidence,paymentStatus:"requires_payment_method"})).toBe(false);
});
test("053 admitted retry receipt credits once, retains the hold and accounts after a racing stop",async()=>{
  await retryReady();await admitRetry();await adminActor();await cancelHold();
  expect((await retryReceipt()).rows[0]).toEqual({result:true});await creditRenewal();
  expect((await retryReceipt()).rows[0]).toEqual({result:false});await creditRenewal();
  expect(await row("purchases")).toMatchObject({paid_count:2});
  expect((await db.query("select * from exact_installment_receipts")).rows).toHaveLength(2);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(2);
});
test.each(["no admission","wrong invoice","wrong PI","wrong amount","wrong fee","predates admission","future charge"])
("053 retry receipt rejects %s",async(problem)=>{
  await retryReady();if(problem!=="no admission") await admitRetry();
  const when=problem==="predates admission"?"now()-interval '10 seconds'":problem==="future charge"?"now()+interval '10 seconds'":"now()";
  await expect(db.query(`select record_exact_installment_retry_receipt($1,$2,$3,$4,$5,${when})`,
    [paymentQuoteId,problem==="wrong invoice"?"in_other":"in_renewal2",problem==="wrong PI"?"pi_other":"pi_fixture2",
      problem==="wrong amount"?66634:66633,problem==="wrong fee"?10424:10425])).rejects.toThrow();
  expect((await db.query("select * from exact_installment_receipts")).rows).toHaveLength(1);
});
test.each(["anon","authenticated","service_role"])("053 %s cannot rewrite or reset retry admission",async(role)=>{
  await retryReady();await admitRetry();await db.exec(`set role ${role}`);
  try {
    await expect(db.exec("delete from exact_installment_retry_admissions")).rejects.toThrow();
    await expect(db.exec("update exact_installment_retry_admissions set admitted_at=now()")).rejects.toThrow();
    await expect(db.exec(`insert into exact_installment_retry_admissions select * from exact_installment_retry_admissions`)).rejects.toThrow();
    if(role!=="service_role") await expect(admitRetry()).rejects.toThrow();
  } finally {await db.exec("reset role");}
});
test("052 payment review derives exact cents and confirmation never changes financial records",async()=>{
  await readyPaymentQuote();
  const tables=["exact_installment_invoice_claims","exact_installment_activations","exact_installment_collection_holds","payment_fee_ledger","purchases"];
  const before=await Promise.all(tables.map(row));
  await quotePayment();const saved=await row("exact_installment_payment_confirmations");
  expect(saved).toMatchObject({id:paymentQuoteId,amount_cents:66633,application_fee_cents:10425,confirmed_at:null,
    buyer_id:t.buyerId,replacement_payment_method_id:"pm_replacement",original_payment_intent_id:"pi_fixture2",
    authorization_snapshot:expect.objectContaining({paymentMethodId:"pm_fixture",paymentNumber:2})});
  await quotePayment();expect(await row("exact_installment_payment_confirmations")).toEqual(saved);
  await confirmPayment();const confirmed=await row("exact_installment_payment_confirmations");
  expect(confirmed.confirmed_at).not.toBeNull();await confirmPayment();
  expect(await row("exact_installment_payment_confirmations")).toEqual(confirmed);
  expect(await Promise.all(tables.map(row))).toEqual(before);
  expect(await buyerView()).toMatchObject({setupEligible:false,confirmedQuoteId:paymentQuoteId});
});
test.each(["foreign buyer","unverified card","expired setup","stop hold","paid invoice","ended period"])
("052 %s blocks a new payment review",async(problem)=>{
  await readyPaymentQuote();
  if(problem==="unverified card") await db.exec("update exact_installment_card_setups set verified_at=null,stripe_setup_intent_id=null,replacement_payment_method_id=null");
  if(problem==="expired setup") await db.exec("update exact_installment_card_setups set expires_at=floor(extract(epoch from now()))-1");
  if(problem==="stop hold") {await adminActor();await cancelHold();}
  if(problem==="paid invoice") await recordRenewalReceipt();
  if(problem==="ended period") await db.exec("update exact_installment_periods set period_end=floor(extract(epoch from now()))-1 where payment_number=2");
  await expect(quotePayment(paymentQuoteId,problem==="foreign buyer"?actor:t.buyerId)).rejects.toThrow();
  expect((await db.query("select * from exact_installment_payment_confirmations")).rows).toHaveLength(0);
});
test.each(["foreign buyer","unknown version","expired quote","stop after review","payment after review","changed snapshot"])
("052 %s blocks confirmation without a financial mutation",async(problem)=>{
  await readyPaymentQuote();await quotePayment();
  if(problem==="expired quote") await db.exec("update exact_installment_payment_confirmations set expires_at=floor(extract(epoch from now()))-1");
  if(problem==="stop after review") {await adminActor();await cancelHold();}
  if(problem==="payment after review") await recordRenewalReceipt();
  if(problem==="changed snapshot") await db.exec("update exact_installment_payment_confirmations set amount_cents=66634");
  await expect(confirmPayment(paymentQuoteId,problem==="foreign buyer"?actor:t.buyerId,problem==="unknown version"?"unknown":"single-invoice-retry-v1")).rejects.toThrow();
  expect((await row("exact_installment_payment_confirmations")).confirmed_at).toBeNull();
});
test("052 two open reviews permit only one confirmed retry for the invoice",async()=>{
  await readyPaymentQuote();await quotePayment();await quotePayment(requestId);await confirmPayment();
  await expect(confirmPayment(requestId)).rejects.toThrow("confirmation already exists");
  expect((await db.query("select * from exact_installment_payment_confirmations where confirmed_at is not null")).rows).toHaveLength(1);
});
test("052 expired quote replay does not extend its five-minute window",async()=>{
  await readyPaymentQuote();await quotePayment();
  await db.exec("update exact_installment_payment_confirmations set expires_at=floor(extract(epoch from now()))-1");
  const before=await row("exact_installment_payment_confirmations");
  await expect(quotePayment()).rejects.toThrow("review expired");expect(await row("exact_installment_payment_confirmations")).toEqual(before);
});
test("052 owner view is allowlisted and respects hold/verified state",async()=>{
  await declinedCardSetup();
  expect(await buyerView()).toEqual({agreementId:plan,title:t.title,totalCents:199900,paymentCount:3,paymentNumber:2,amountCents:66633,
    outcome:"payment_method_required",observedAt:expect.any(String),setupRequestId:null,setupState:"not_started",setupEligible:true,confirmedQuoteId:null});
  await expect(buyerView(actor)).rejects.toThrow("unavailable");
  await reserveCard();await bindCard();await verifyCard();expect(await buyerView()).toMatchObject({setupState:"verified",setupEligible:true});
  await adminActor();await cancelHold();expect(await buyerView()).toMatchObject({setupState:"verified",setupEligible:false});
});
test("052 roles cannot forge consent or read another buyer through a public RPC",async()=>{
  await readyPaymentQuote();await quotePayment();
  for(const role of ["anon","authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await expect(buyerView()).rejects.toThrow("permission denied");await expect(quotePayment()).rejects.toThrow("permission denied");
      await expect(confirmPayment()).rejects.toThrow("permission denied");
      await expect(db.query("select * from exact_installment_payment_confirmations")).rejects.toThrow("permission denied");
    } finally {await db.exec("reset role");}
  }
  await db.exec("set role service_role");
  try {await expect(db.exec("update exact_installment_payment_confirmations set confirmed_at=now()")).rejects.toThrow("permission denied");}
  finally {await db.exec("reset role");}
});

test("051 card reservation derives the original binding and records versioned buyer consent only",async()=>{
  await declinedCardSetup();
  const before=await row("exact_installment_invoice_claims"),holds=await row("exact_installment_collection_holds"),p=await row("purchases"),ledger=await row("payment_fee_ledger");
  await reserveCard();await reserveCard();
  const saved=await row("exact_installment_card_setups");
  expect((await db.query("select * from exact_installment_card_setups")).rows).toHaveLength(1);
  expect(saved).toMatchObject({id:cardRequest,agreement_id:plan,buyer_id:t.buyerId,stripe_invoice_id:"in_renewal2",
    original_payment_intent_id:"pi_fixture2",consent_version:"replacement-card-setup-v1",stripe_checkout_session_id:null,verified_at:null,
    authorization_snapshot:expect.objectContaining({paymentMethodId:"pm_fixture",totalCents:199900,paymentNumber:2})});
  expect(await row("exact_installment_invoice_claims")).toEqual(before);expect(await row("exact_installment_collection_holds")).toEqual(holds);
  expect(await row("purchases")).toEqual(p);expect(await row("payment_fee_ledger")).toEqual(ledger);
});

test.each(["wrong buyer","wrong version","no decline","pending authentication","already paid","stop hold","dispute hold","ended period"])
("051 %s cannot reserve a card setup",async(problem)=>{
  await declinedCardSetup();
  if(problem==="no decline") await db.exec("update exact_installment_payment_recoveries set outcome='review_required'");
  if(problem==="pending authentication") await db.exec("update exact_installment_payment_recoveries set outcome='action_required'");
  if(problem==="already paid") await recordRenewalReceipt();
  if(problem==="stop hold") {await adminActor();await cancelHold();}
  if(problem==="dispute hold") await lifecycleHold();
  if(problem==="ended period") await db.exec("update exact_installment_periods set period_end=floor(extract(epoch from now()))-1 where payment_number=2");
  await expect(reserveCard(cardRequest,problem==="wrong buyer"?actor:t.buyerId,problem==="wrong version"?"unknown":"replacement-card-setup-v1")).rejects.toThrow();
  expect((await db.query("select * from exact_installment_card_setups")).rows).toHaveLength(0);
});

test("051 stale tabs cannot allocate another setup for the same original invoice",async()=>{
  await declinedCardSetup();await reserveCard();
  await expect(reserveCard(requestId)).rejects.toThrow("request identity changed");
  expect((await db.query("select * from exact_installment_card_setups")).rows).toHaveLength(1);
});

test("051 verified card evidence is idempotent and never changes the invoice authorization, ledger or collection hold",async()=>{
  await declinedCardSetup();await reserveCard();await bindCard();
  const claim=await row("exact_installment_invoice_claims"),activation=await row("exact_installment_activations"),holds=await row("exact_installment_collection_holds"),ledger=await row("payment_fee_ledger");
  await verifyCard();const saved=await row("exact_installment_card_setups");await verifyCard();
  expect(await row("exact_installment_card_setups")).toEqual(saved);
  expect(saved).toMatchObject({stripe_checkout_session_id:"cs_test_cardsetup",stripe_setup_intent_id:"seti_cardsetup",
    replacement_payment_method_id:"pm_replacement",verified_at:expect.anything()});
  expect(await row("exact_installment_invoice_claims")).toEqual(claim);expect(await row("exact_installment_activations")).toEqual(activation);
  expect(await row("exact_installment_collection_holds")).toEqual(holds);expect(await row("payment_fee_ledger")).toEqual(ledger);
  await expect(verifyCard(undefined,undefined,"pm_other")).rejects.toThrow("result differs");
  await expect(bindCard("cs_test_other")).rejects.toThrow("session differs");
});

test.each(["missing session","foreign session","foreign buyer","expired","stop after bind","payment after bind"])
("051 %s prevents result adoption",async(problem)=>{
  await declinedCardSetup();await reserveCard();if(problem!=="missing session") await bindCard();
  if(problem==="foreign buyer") {await expect(currentCard(actor)).rejects.toThrow("unavailable");return;}
  if(problem==="expired") await db.exec("update exact_installment_card_setups set expires_at=floor(extract(epoch from now()))-1");
  if(problem==="stop after bind") {await adminActor();await cancelHold();}
  if(problem==="payment after bind") await recordRenewalReceipt();
  await expect(verifyCard(problem==="foreign session"?"cs_test_other":"cs_test_cardsetup")).rejects.toThrow();
  expect(await row("exact_installment_card_setups")).toMatchObject({stripe_setup_intent_id:null,replacement_payment_method_id:null,verified_at:null});
});

test("051 authenticated and anonymous database roles cannot read or mutate card setup evidence",async()=>{
  await declinedCardSetup();await reserveCard();
  for(const role of ["anon","authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await expect(currentCard()).rejects.toThrow("permission denied");
      await expect(db.query("select * from exact_installment_card_setups")).rejects.toThrow("permission denied");
      await expect(bindCard()).rejects.toThrow("permission denied");
    } finally {await db.exec("reset role");}
  }
  await db.exec("set role service_role");
  try {await expect(db.exec("update exact_installment_card_setups set replacement_payment_method_id='pm_other'")).rejects.toThrow("permission denied");}
  finally {await db.exec("reset role");}
});

test("049 recovery cannot invent an admission or adopt a merely prepared invoice",async()=>{
  await renewalReady();await expect(beginRecovery()).rejects.toThrow("original admitted payment");
  await claimRenewal();await prepareRenewal();await expect(beginRecovery()).rejects.toThrow("original admitted payment");
  expect((await db.query("select * from exact_installment_payment_recoveries")).rows).toHaveLength(0);
});

test("049 admitted failure persists one hold and leaves money, access and original dispatch unchanged",async()=>{
  await admittedRenewal();const p=await row("purchases"),l=await row("payment_fee_ledger"),c=await row("exact_installment_invoice_claims");
  await beginRecovery();const read=await beginRecovery();expect(await finishRecovery(read)).toBe(true);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(1);
  expect(await row("purchases")).toEqual(p);expect(await row("payment_fee_ledger")).toEqual(l);
  expect(await row("exact_installment_invoice_claims")).toEqual(c);
  await db.exec("update exact_installment_invoice_claims set lease_until=now()-interval '3 days'");
  expect((await claimRenewal()).rows[0].result.status).toBe("reconcile");
  await expect(admitRenewal()).rejects.toThrow("claim lost");
});

test("049 canceled PI is not enough: only verified void+canceled zero-money evidence is terminal",async()=>{
  await admittedRenewal();const read=await beginRecovery();
  for(const partial of [{},{invoiceStatus:"void"},{paymentStatus:"canceled"},{...recoveryEvidence,paymentStatus:"canceled"}]) {
    await expect(finishRecovery(read,"terminal_unpaid",undefined,partial)).rejects.toThrow("terminal unpaid evidence missing");
  }
  expect((await row("exact_installment_payment_recoveries")).revision).toBe(0);
  expect(await terminalRecovery()).toBe(true);
});

test.each(["before admission","future","received money","capturable funds"])("049 terminal evidence rejects %s",async(problem)=>{
  await admittedRenewal();const r=await beginRecovery();
  const evidence={invoiceStatus:"void",paymentStatus:"canceled",amountReceived:0,amountCapturable:0,
    canceledAt:r.dispatchStartedAt,voidedAt:r.dispatchStartedAt};
  if(problem==="before admission") evidence.canceledAt--;
  if(problem==="future") evidence.voidedAt+=3600;
  if(problem==="received money") evidence.amountReceived=1;
  if(problem==="capturable funds") evidence.amountCapturable=1;
  await expect(finishRecovery(r,"terminal_unpaid",undefined,evidence)).rejects.toThrow("terminal unpaid evidence missing");
});

test("049 stale same-invoice recovery cannot overwrite newer customer-verification status",async()=>{
  await admittedRenewal();const stale=await beginRecovery();await finishRecovery(stale);
  expect(await finishRecovery(stale,"payment_method_required",undefined,{...recoveryEvidence,paymentStatus:"requires_payment_method"})).toBe(false);
  expect((await row("exact_installment_payment_recoveries")).outcome).toBe("action_required");
});

test("049 late actual receipt is accounted once after a failure; stale failure cannot overwrite it",async()=>{
  await admittedRenewal();const stale=await beginRecovery();await finishRecovery(stale);
  await recordRenewalReceipt();const paid={invoiceStatus:"paid",paymentStatus:"succeeded",amountReceived:66633,amountCapturable:0};
  await expect(finishRecovery(await beginRecovery(),"paid_accounted",undefined,paid)).rejects.toThrow("not accounted");
  await creditRenewal();expect(await finishRecovery(stale)).toBe(false);
  expect(await finishRecovery(await beginRecovery(),"paid_accounted",undefined,paid)).toBe(true);
  await recordRenewalReceipt();await creditRenewal();
  expect((await row("purchases")).paid_count).toBe(2);
  expect((await db.query("select * from payment_fee_ledger")).rows).toHaveLength(2);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(1);
  expect(await finishRecovery(await beginRecovery())).toBe(false);
});

test("049 receipt arriving between failure read and save invalidates that observation even before credit",async()=>{
  await admittedRenewal();const read=await beginRecovery();await recordRenewalReceipt();
  expect(await finishRecovery(read)).toBe(false);
  await expect(finishRecovery(await beginRecovery())).rejects.toThrow("conflicts with receipt");
});

test("049 terminal proof permits separately approved stop and refund, but never retries or grants a debt waiver",async()=>{
  await admittedRenewal();await adminActor();await refundReservation();
  const p=await row("purchases"),l=await row("payment_fee_ledger");
  expect((await claimStop()).rows[0].result).toBe("reconciliation_required");
  expect((await refundAdmission()).rows[0].result).toBe("reconciliation_required");
  await terminalRecovery();
  expect((await claimStop()).rows[0].result).toBe("ready");
  expect((await refundAdmission()).rows[0].result).toBe("held");
  await completeStop("complete","pi_fixture1");
  expect(await row("purchases")).toEqual(p);expect(await row("payment_fee_ledger")).toEqual(l);
  expect((await row("exact_installment_invoice_claims")).status).toBe("dispatching");
  expect((await claimRenewal()).rows[0].result.status).toBe("reconcile");
});

test.each(["action_required","payment_method_required","payment_pending","review_required"])
("049 %s observation never releases stop/refund safety checks",async(outcome)=>{
  await admittedRenewal();await adminActor();await refundReservation();
  const evidence={...recoveryEvidence,paymentStatus:outcome==="payment_method_required"?"requires_payment_method":
    outcome==="payment_pending"?"processing":"requires_action"};
  await finishRecovery(await beginRecovery(),outcome,undefined,evidence);
  expect((await claimStop()).rows[0].result).toBe("reconciliation_required");
  expect((await refundAdmission()).rows[0].result).toBe("reconciliation_required");
});

test("049 terminal outcome cannot be silently reopened by a delayed event",async()=>{
  await admittedRenewal();await terminalRecovery();expect(await finishRecovery(await beginRecovery())).toBe(false);
  expect((await row("exact_installment_payment_recoveries")).outcome).toBe("terminal_unpaid");
});

test("049 recovery retains no arbitrary provider fields or error messages",async()=>{
  await admittedRenewal();await finishRecovery(await beginRecovery(),undefined,undefined,{...recoveryEvidence,
    client_secret:"not-a-real-secret",hosted_invoice_url:"https://example.invalid/private",error:"provider-private"});
  const evidence=(await row("exact_installment_payment_recoveries")).evidence as Record<string,unknown>;
  expect(Object.keys(evidence).sort()).toEqual(Object.keys(recoveryEvidence).sort());
});

test.each(["anon","authenticated","service_role"])("049 %s cannot mutate records or call pre-recovery refund bypass",async(role)=>{
  const result=await db.query<{write:boolean;helper:boolean;begin:boolean;refund:boolean}>(`select
    has_table_privilege($1,'exact_installment_payment_recoveries','INSERT,UPDATE,DELETE') as write,
    has_function_privilege($1,'admit_exact_installment_admin_refund_before_recovery(uuid,uuid)','EXECUTE') as helper,
    has_function_privilege($1,'begin_exact_installment_recovery(uuid,text)','EXECUTE') as begin,
    has_function_privilege($1,'admit_exact_installment_admin_refund(uuid,uuid)','EXECUTE') as refund`,[role]);
  expect(result.rows[0]).toEqual({write:false,helper:false,begin:role==="service_role",refund:role==="service_role"});
  for(const signature of ["exact_installment_recovery_basis(uuid,text)","exact_installment_recovery_is_terminal(uuid,text,text)",
    "exact_installment_stop_is_quiescent(uuid)"]) {
    const r=await db.query<{ok:boolean}>("select has_function_privilege($1,$2,'EXECUTE') ok",[role,signature]);
    expect(r.rows[0].ok).toBe(false);
  }
  const finish=await db.query<{ok:boolean}>("select has_function_privilege($1,'finish_exact_installment_recovery(uuid,text,text,bigint,jsonb,text,text,jsonb)','EXECUTE') ok",[role]);
  expect(finish.rows[0].ok).toBe(role==="service_role");
});

test("048 dispute audit fences renewals but does not debit earnings, remove access, or change installment counts",async()=>{
  await renewalReady();const purchase=await row("purchases"),profile=await row("profiles"),agreement=await row("exact_installment_agreements");
  const ledger=await row("payment_fee_ledger"),read=await readObservation();
  expect(read).toMatchObject({revision:0,basis:{agreementStatus:"active",activationStatus:"complete",stopStatus:null}});
  expect(await applyDispute(read)).toBe("lifecycle_observed");
  expect(await row("purchases")).toEqual(purchase);expect(await row("profiles")).toEqual(profile);
  expect(await row("exact_installment_agreements")).toEqual(agreement);
  const afterLedger=await row("payment_fee_ledger");
  expect(afterLedger).toEqual({...ledger,stripe_dispute_id:"du_fixture",disputed_amount_cents:1000,
    dispute_status:"needs_response",updated_at:afterLedger.updated_at});
  expect(Number.isFinite((afterLedger.updated_at as Date).getTime())).toBe(true);
  expect(await row("exact_installment_collection_holds")).toMatchObject({reason:"verified_dispute",stripe_object_id:"du_fixture"});
  await expect(claimRenewal()).rejects.toThrow("held for review");
});

test("048 repeated observation is audit-idempotent and never repeats a financial change",async()=>{
  await firstPaid();const profile=await row("profiles"),purchase=await row("purchases");
  await applyDispute(await readObservation());await applyDispute(await readObservation());
  expect((await readObservation()).revision).toBe(2);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(1);
  expect((await db.query("select * from payment_dispute_state")).rows).toHaveLength(1);
  expect(await row("profiles")).toEqual(profile);expect(await row("purchases")).toEqual(purchase);
});

test("048 stale worker cannot overwrite a newer dispute observation",async()=>{
  await firstPaid();const stale=await readObservation();
  expect(await applyDispute(stale,"under_review","evt_new",undefined,200)).toBe("lifecycle_observed");
  expect(await applyDispute(stale,"needs_response","evt_old",undefined,100)).toBe("reconciliation_required");
  expect((await row("payment_dispute_state")).status).toBe("under_review");
  expect((await readObservation()).revision).toBe(1);
  // Retry means a NEW current Stripe read, not reusing the old event status.
  expect(await applyDispute(await readObservation(),"won","evt_old",undefined,100)).toBe("lifecycle_observed");
  expect(await row("payment_dispute_state")).toMatchObject({status:"won",stripe_event_created:200});
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(2);
});

test.each(["won","lost","prevented"])("048 a conflicting observation cannot silently reopen terminal %s",async(status)=>{
  await firstPaid();await applyDispute(await readObservation(),status);
  const before=await row("payment_dispute_state"),ledger=await row("payment_fee_ledger");
  expect(await applyDispute(await readObservation(),"needs_response","evt_conflict",undefined,200)).toBe("lifecycle_review_recorded");
  expect(await row("payment_dispute_state")).toEqual(before);expect(await row("payment_fee_ledger")).toEqual(ledger);
  expect(await row("exact_installment_lifecycle_observations")).toMatchObject({disposition:"review_required"});
});

test("048 resolving another dispute cannot hide an unresolved dispute on the same payment",async()=>{
  await firstPaid();await applyDispute(await readObservation(),"needs_response");
  await applyDispute(await readObservation("du_other"),"won","evt_other","du_other",200);
  // A replayed first-payment handler must preserve the same unresolved priority.
  await db.query("select reconcile_exact_installment_dispute_audit('pi_fixture1')");
  expect(await row("payment_fee_ledger")).toMatchObject({stripe_dispute_id:"du_fixture",dispute_status:"needs_response"});
  expect((await db.query("select * from payment_dispute_state")).rows).toHaveLength(2);
});

test("048 records partial or FX-adjusted disputed amount without allocating the difference",async()=>{
  await firstPaid();const profile=await row("profiles");
  await applyDispute(await readObservation(),"needs_response",undefined,undefined,100,70000);
  expect((await row("payment_dispute_state")).disputed_amount_cents).toBe(70000);
  expect(await row("profiles")).toEqual(profile);
});

test("048 no-dispute receipt mirror is a no-op and refuses a missing receipt",async()=>{
  await firstPaid();const l=await row("payment_fee_ledger"),p=await row("profiles");
  await db.query("select reconcile_exact_installment_dispute_audit('pi_fixture1')");
  expect(await row("payment_fee_ledger")).toEqual(l);expect(await row("profiles")).toEqual(p);
  await expect(db.query("select reconcile_exact_installment_dispute_audit('pi_unknown')")).rejects.toThrow("not credited");
});

test("048 mirror refuses existing dispute state with mismatched charge identity",async()=>{
  await firstPaid();await applyDispute(await readObservation());
  await db.exec("update payment_dispute_state set stripe_charge_id='ch_other'");
  await expect(db.query("select reconcile_exact_installment_dispute_audit('pi_fixture1')")).rejects.toThrow("mirror identity differs");
});

test("048 first-payment dispute uses its immutable ledger after a second installment",async()=>{
  await renewalReady();await claimRenewal();await prepareRenewal();await admitRenewal();await recordRenewalReceipt();await creditRenewal();
  const newer=(await db.query("select * from payment_fee_ledger where stripe_payment_intent_id='pi_fixture2'")).rows[0];
  const purchase=await row("purchases");await applyDispute(await readObservation());
  expect((await db.query("select * from payment_fee_ledger where stripe_payment_intent_id='pi_fixture2'")).rows[0]).toEqual(newer);
  expect(await row("purchases")).toEqual(purchase);
});

test("048 an early uncredited dispute holds activation but permits recording the original captured payment",async()=>{
  await seed();await db.query("select record_exact_installment_first_receipt($1,'cs_test_fixture','pi_fixture1',66633,9958,now())",[plan]);
  await lifecycleHold();await expect(applyDispute(await readObservation())).rejects.toThrow("not credited");
  await db.query("select credit_exact_installment_receipt($1,1,'ch_fixture1','txn_fixture1',1962)",[plan]);
  await expect(db.query("select claim_exact_installment_activation($1,'pm_fixture','si_fixture',$2)",[plan,t.buyerId])).rejects.toThrow("held for review");
  expect(await applyDispute(await readObservation())).toBe("lifecycle_observed");
  expect((await row("purchases")).paid_count).toBe(1);
});

test.each(["update payment_fee_ledger set stripe_charge_id='ch_other'","update payment_fee_ledger set gross_amount_cents=1",
  "update payment_fee_ledger set currency='eur'","update payment_fee_ledger set total_creator_deduction_cents=1"])
("048 rejects mismatched ledger evidence: %s",async(sql)=>{
  await firstPaid();await lifecycleHold();await db.exec(sql);
  await expect(applyDispute(await readObservation())).rejects.toThrow("ledger differs");
  expect((await db.query("select * from payment_dispute_state")).rows).toHaveLength(0);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(1);
});

test("048 rejects a known dispute reattached to another payment",async()=>{
  await firstPaid();await db.exec(`insert into payment_dispute_state(stripe_dispute_id,stripe_payment_intent_id,stripe_charge_id,
    disputed_amount_cents,currency,status,stripe_event_created) values('du_fixture','pi_other','ch_other',100,'usd','needs_response',1)`);
  await expect(applyDispute(await readObservation())).rejects.toThrow("prior dispute identity differs");
});

test("048 subscription review requires a persisted hold and never changes money or access",async()=>{
  await renewalReady();const p=await row("purchases"),l=await row("payment_fee_ledger"),a=await row("exact_installment_agreements");
  const read=await readObservation("sub_fixture");
  await expect(observeSubscription(read,"review_required")).rejects.toThrow("hold missing");
  await lifecycleHold("evt_fixture","sub_fixture",null);
  expect(await observeSubscription(read,"review_required")).toBe(true);
  expect(await row("purchases")).toEqual(p);expect(await row("payment_fee_ledger")).toEqual(l);
  expect(await row("exact_installment_agreements")).toEqual(a);
  await expect(claimRenewal()).rejects.toThrow("held for review");
});

test("048 ordinary held subscription observation adds no unnecessary collection hold",async()=>{
  const read=await readObservation("sub_fixture");expect(await observeSubscription(read)).toBe(true);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(0);
  expect(await observeSubscription(read)).toBe(false);
});

test("048 changed local activation between Stripe read and save requires fresh reconciliation",async()=>{
  await firstPaid();const read=await readObservation("sub_fixture");
  await db.query("select claim_exact_installment_activation($1,'pm_fixture','si_fixture',$2)",[plan,t.buyerId]);
  expect(await observeSubscription(read)).toBe(false);
  const running=await readObservation("sub_fixture");
  await db.query("select complete_exact_installment_activation($1,$2)",[plan,t.buyerId]);
  expect(await observeSubscription(running)).toBe(false);
  expect(await observeSubscription(await readObservation("sub_fixture"))).toBe(true);
});

test("048 billing stop completion invalidates a concurrent old subscription read",async()=>{
  await adminActor();await claimStop();const read=await readObservation("sub_fixture");await completeStop();
  expect(await observeSubscription(read)).toBe(false);
  const finished=await readObservation("sub_fixture");expect(finished.basis.stopStatus).toBe("complete");
  expect(await observeSubscription(finished,"billing_stop_observed")).toBe(true);
});

test("048 event identity cannot be rebound and an unknown payment cannot hold another agreement",async()=>{
  await firstPaid();await lifecycleHold();
  await expect(lifecycleHold("evt_fixture","sub_fixture",null)).rejects.toThrow("event identity differs");
  await expect(lifecycleHold("evt_unknown","du_other","pi_unknown")).rejects.toThrow("payment binding missing");
  await expect(lifecycleHold("evt_other","sub_other",null)).rejects.toThrow("subscription hold identity differs");
});

test.each(["anon","authenticated","service_role"])("048 %s cannot directly modify observations or execute the internal basis helper",async(role)=>{
  const result=await db.query<{write:boolean;read:boolean;helper:boolean;observe:boolean}>(`select
    has_table_privilege($1,'exact_installment_lifecycle_observations','INSERT,UPDATE,DELETE') as write,
    has_table_privilege($1,'exact_installment_lifecycle_observations','SELECT') as read,
    has_function_privilege($1,'exact_installment_lifecycle_basis(uuid)','EXECUTE') as helper,
    has_function_privilege($1,'finish_exact_installment_lifecycle(uuid,text,text,bigint,jsonb,text,jsonb)','EXECUTE') as observe`,[role]);
  expect(result.rows[0]).toEqual({write:false,read:role==="service_role",helper:false,observe:role==="service_role"});
  for(const signature of ["read_exact_installment_lifecycle(uuid,text)","hold_exact_installment_lifecycle_event(uuid,text,text,text)",
    "reconcile_exact_installment_dispute_audit(text)","apply_exact_installment_dispute_event(uuid,text,text,bigint,jsonb,text,text,bigint,bigint,text,bigint)"]) {
    const access=await db.query<{allowed:boolean}>("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature]);
    expect(access.rows[0].allowed).toBe(role==="service_role");
  }
});

test("047 unpaid stop persists verified terminal state but does not touch original financial/access/booking data",async()=>{
  await seed();await adminActor();const before=await row("purchases");
  expect((await claimStop()).rows[0].result).toBe("ready");
  await assertStop();await completeStop();
  expect((await row("exact_installment_billing_stops")).status).toBe("complete");
  expect((await claimStop()).rows[0].result).toBe("complete");
  expect((await row("exact_installment_agreements")).status).toBe("awaiting_first");
  expect((await row("bookings")).status).toBe("booked");expect(await row("purchases")).toEqual(before);
  expect((await db.query("select * from payment_fee_ledger")).rows).toHaveLength(0);
});
test("047 paid stop retains access and outstanding count, and permanently blocks new renewal admission",async()=>{
  await renewalReady();await adminActor();const p=await row("purchases"),l=await row("payment_fee_ledger");
  expect((await claimStop()).rows[0].result).toBe("ready");await completeStop("complete","pi_fixture1");
  expect(await row("purchases")).toEqual(p);expect(await row("payment_fee_ledger")).toEqual(l);
  expect((await row("exact_installment_agreements")).status).toBe("active");
  await expect(claimRenewal()).rejects.toThrow("held for review");
});
test("047 hold before activation blocks a new activation without undoing the first receipt",async()=>{
  await firstPaid();await adminActor();expect((await claimStop()).rows[0].result).toBe("ready");
  await expect(db.query("select claim_exact_installment_activation($1,'pm_fixture','si_fixture',$2)",[plan,t.buyerId]))
    .rejects.toThrow("new activation held for review");
  expect((await row("purchases")).paid_count).toBe(1);
  await completeStop("complete","pi_fixture1");
});
test("047 activation admitted before stop may finish, and stop waits even when its lease is old",async()=>{
  await firstPaid();await fulfill();await adminActor();
  await db.query("select claim_exact_installment_activation($1,'pm_fixture','si_fixture',$2)",[plan,t.buyerId]);
  expect((await claimStop()).rows[0].result).toBe("reconciliation_required");
  expect((await row("exact_installment_collection_holds")).reason).toBe("cancellation_review");
  await db.exec("update exact_installment_activations set lease_until=now()-interval '1 minute'");
  expect((await claimStop()).rows[0].result).toBe("reconciliation_required");
  await db.query("select claim_exact_installment_activation($1,'pm_fixture','si_fixture',$2)",[plan,t.buyerId]);
  await db.query("select complete_exact_installment_activation($1,$2)",[plan,t.buyerId]);
  expect((await claimStop()).rows[0].result).toBe("ready");await completeStop("complete","pi_fixture1");
});
test("047 in-flight dispatch requires original receipt and credit before stop can complete",async()=>{
  await renewalReady();await claimRenewal();await prepareRenewal();await admitRenewal();await adminActor();
  expect((await claimStop()).rows[0].result).toBe("reconciliation_required");
  await db.exec("update exact_installment_invoice_claims set lease_until=now()-interval '2 days'");
  expect((await claimStop()).rows[0].result).toBe("reconciliation_required");
  await recordRenewalReceipt();expect((await claimStop()).rows[0].result).toBe("reconciliation_required");
  await creditRenewal();expect((await claimStop()).rows[0].result).toBe("ready");
  await completeStop("complete","pi_fixture1");expect((await row("purchases")).paid_count).toBe(2);
});
test.each(["preparing","prepared"])("047 stops new admissions but waits on a live %s worker",async(status)=>{
  await renewalReady();await claimRenewal();if(status==="prepared") await prepareRenewal();await adminActor();
  expect((await claimStop()).rows[0].result).toBe("reconciliation_required");
  await expect(status==="prepared"?admitRenewal():prepareRenewal()).rejects.toThrow("held for review");
  await db.exec("update exact_installment_invoice_claims set lease_until=now()-interval '1 minute'");
  expect((await claimStop()).rows[0].result).toBe("ready");
  await completeStop("complete","pi_fixture1");
});
test("047 uncredited first receipt prevents completion until accounting reconciles",async()=>{
  await seed();await adminActor();await db.query(`select record_exact_installment_first_receipt($1,'cs_test_fixture','pi_fixture1',66633,9958,now())`,[plan]);
  expect((await claimStop()).rows[0].result).toBe("reconciliation_required");
  await db.query("select credit_exact_installment_receipt($1,1,'ch_fixture1','txn_fixture1',1962)",[plan]);
  expect((await claimStop()).rows[0].result).toBe("ready");await completeStop("complete","pi_fixture1");
});
test("047 a busy stop cannot be stolen; expired worker cannot complete after replacement",async()=>{
  await adminActor();expect((await claimStop()).rows[0].result).toBe("ready");
  expect((await claimStop(actor,t.creatorId)).rows[0].result).toBe("busy");
  await db.exec("update exact_installment_billing_stops set lease_until=now()-interval '1 minute'");
  await expect(assertStop()).rejects.toThrow("authorization lost");
  expect((await claimStop(actor,t.creatorId)).rows[0].result).toBe("ready");
  await expect(completeStop()).rejects.toThrow("authorization lost");
  await completeStop("expired",null,"sub_fixture",t.creatorId);
});
test("047 only a currently verified admin can claim and finish the same request",async()=>{
  await expect(claimStop(t.creatorId)).rejects.toThrow("administrator");
  await adminActor();await claimStop();await db.query("update profiles set role='user' where id=$1",[actor]);
  await expect(completeStop()).rejects.toThrow("authorization lost");
});
test("047 duplicate agreement stop request cannot replace the original approval",async()=>{
  await adminActor();await claimStop();
  await expect(claimStop(actor,t.buyerId,t.bookingId)).rejects.toThrow("identity changed");
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(1);
});
test.each([
  ["wrong subscription","expired",null,"sub_other"],
  ["unaccounted complete","complete","pi_unpaid","sub_fixture"],
  ["expired with PI","expired","pi_fixture1","sub_fixture"],
  ["nonterminal Checkout","open",null,"sub_fixture"],
] as const)("047 completion refuses %s",async(_name,status,pi,subscription)=>{
  await adminActor();await claimStop();await expect(completeStop(status,pi,subscription)).rejects.toThrow();
  expect((await row("exact_installment_billing_stops")).status).toBe("running");
});
test("047 expired Checkout cannot conflict with an accounted payment",async()=>{
  await firstPaid();await adminActor();await claimStop();await expect(completeStop()).rejects.toThrow("conflicts with receipts");
});
test("047 service role has narrow RPC access but cannot directly write or bypass the hold",async()=>{
  const result=await db.query<{read:boolean;write:boolean;helper:boolean;claim:boolean;anon:boolean}>(`select
    has_table_privilege('service_role','exact_installment_billing_stops','SELECT') read,
    has_table_privilege('service_role','exact_installment_billing_stops','UPDATE') write,
    has_function_privilege('service_role','exact_installment_stop_is_quiescent(uuid)','EXECUTE') helper,
    has_function_privilege('service_role','claim_exact_installment_billing_stop(uuid,uuid,uuid,uuid)','EXECUTE') claim,
    has_function_privilege('authenticated','claim_exact_installment_billing_stop(uuid,uuid,uuid,uuid)','EXECUTE') anon`);
  expect(result.rows[0]).toEqual({read:true,write:false,helper:false,claim:true,anon:false});
});

test("045 cancellation hold is durable/idempotent without canceling debt, access, Stripe or the booking",async()=>{
  await renewalReady(); await adminActor();
  const before=await row("purchases");
  const first=await cancelHold(); expect((await cancelHold()).rows).toEqual(first.rows);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(1);
  expect(await row("purchases")).toEqual(before);
  expect((await row("exact_installment_agreements")).status).toBe("active");
  expect((await row("bookings")).status).toBe("completed");
  await expect(claimRenewal()).rejects.toThrow("held for review");
});
test.each(["before prepare","before dispatch"])("045 hold %s blocks the next admission step",async(stage)=>{
  await renewalReady(); await claimRenewal(); if(stage==="before dispatch") await prepareRenewal();
  await adminActor(); await cancelHold();
  await expect(stage==="before prepare"?prepareRenewal():admitRenewal()).rejects.toThrow("held for review");
  expect((await row("exact_installment_invoice_claims")).dispatch_started_at).toBeNull();
});
test("045 first installment refund is recognized without an invoice ID or the purchase's latest PI",async()=>{
  await renewalReady(); await claimRenewal(); await prepareRenewal(); await admitRenewal();
  await recordRenewalReceipt(); await creditRenewal(); await refundReservation();
  expect((await row("purchases")).payment_intent_id).toBe("pi_fixture2");
  expect((await db.query<{stripe_invoice_id:string|null}>("select stripe_invoice_id from payment_fee_ledger where stripe_payment_intent_id='pi_fixture1'")).rows[0].stripe_invoice_id).toBeNull();
  expect((await refundAdmission()).rows[0].result).toBe("held");
  expect((await refundAdmission()).rows[0].result).toBe("held");
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(1);
});
test("045 admitted charge waits for receipt AND accounting; a late success may reconcile under the hold",async()=>{
  await renewalReady(); await claimRenewal(); await prepareRenewal(); await admitRenewal(); await refundReservation();
  expect((await refundAdmission()).rows[0].result).toBe("reconciliation_required");
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(1);
  await recordRenewalReceipt();
  expect((await refundAdmission()).rows[0].result).toBe("reconciliation_required");
  await creditRenewal();
  expect((await refundAdmission()).rows[0].result).toBe("held");
  expect((await row("purchases")).paid_count).toBe(2);
  await creditRenewal(); expect((await row("purchases")).paid_count).toBe(2);
});
test.each(["dispatching","review_required"])("045 aged %s dispatch never becomes refundable merely because its lease expired",async(status)=>{
  await renewalReady(); await claimRenewal(); await prepareRenewal(); await admitRenewal(); await refundReservation();
  await db.query("update exact_installment_invoice_claims set status=$1,lease_until=now()-interval '2 days'",[status]);
  expect((await refundAdmission()).rows[0].result).toBe("reconciliation_required");
});
test("045 a refund admitted before dispatch blocks that charge and survives later failed refund state",async()=>{
  await renewalReady(); await claimRenewal(); await prepareRenewal(); await refundReservation();
  expect((await refundAdmission()).rows[0].result).toBe("held");
  await db.exec("update refund_operations set status='failed',processing_token=null");
  await expect(admitRenewal()).rejects.toThrow("held for review");
});
test.each(["wrong token","expired claim","non-admin","wrong creator","wrong ledger"])("045 rejects %s without creating a refund hold",async(problem)=>{
  await renewalReady(); await refundReservation();
  if(problem==="expired claim") await db.exec("update refund_operations set processing_claimed_at=now()-interval '6 minutes'");
  if(problem==="non-admin") await db.query("update profiles set role='user' where id=$1",[actor]);
  if(problem==="wrong creator") await db.query("update refund_operations set creator_id=$1",[actor]);
  if(problem==="wrong ledger") await db.exec("update refund_operations set payment_fee_ledger_id=null");
  await expect(refundAdmission(problem==="wrong token"?actor:t.buyerId)).rejects.toThrow();
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(0);
});
test("045 unmatched exact receipt fails closed instead of treating the purchase as legacy",async()=>{
  await renewalReady(); await refundReservation();
  await db.exec("update refund_operations set stripe_payment_intent_id='pi_unmatched'");
  await expect(refundAdmission()).rejects.toThrow("receipt requires reconciliation");
});
test("045 unrelated legacy refund remains not applicable and creates no hold",async()=>{
  await adminActor();
  await db.query(`insert into refund_operations(id,stripe_payment_intent_id,status,initiated_by,processing_token,processing_claimed_at)
    values($1,'pi_legacy','pending',$2,$3,now())`,[refundId,actor,t.buyerId]);
  expect((await refundAdmission()).rows[0].result).toBe("not_applicable");
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(0);
});
test("045 cannot reuse a cancellation request for a different administrator",async()=>{
  await adminActor(); await cancelHold(); await db.query("update profiles set role='admin' where id=$1",[t.creatorId]);
  await expect(cancelHold(requestId,t.creatorId)).rejects.toThrow("request changed");
});
test("045 creator/non-admin cannot authorize a cancellation hold",async()=>{
  await expect(cancelHold(requestId,t.creatorId)).rejects.toThrow("administrator required");
});
test.each(["anon","authenticated","service_role"])("045 %s cannot bypass hold admission or alter private hold rows",async(role)=>{
  for(const signature of ["assert_exact_installment_renewal_ready(uuid,integer)"]) {
    expect((await db.query<{ok:boolean}>("select has_function_privilege($1,$2,'EXECUTE') ok",[role,signature])).rows[0].ok).toBe(false);
  }
  for(const privilege of ["INSERT","UPDATE","DELETE"]) {
    expect((await db.query<{ok:boolean}>("select has_table_privilege($1,'exact_installment_collection_holds',$2) ok",[role,privilege])).rows[0].ok).toBe(false);
  }
  for(const signature of ["hold_exact_installment_for_cancellation(uuid,uuid,uuid)","admit_exact_installment_admin_refund(uuid,uuid)"]) {
    expect((await db.query<{ok:boolean}>("select has_function_privilege($1,$2,'EXECUTE') ok",[role,signature])).rows[0].ok).toBe(role==="service_role");
  }
});

const applyRefundEvent=(amount=10000,event="evt_refundfixture",pi="pi_fixture1",charge="ch_fixture1")=>db.query<{total:number}>(
  "select apply_exact_installment_refund_event($1,$2,$3,$4,66633,$5) total",[plan,event,pi,charge,amount]);
test("046 duplicate/out-of-order first refunds reverse once without touching access, balance paid count or delivery",async()=>{
  await renewalReady();const before=await row("purchases");
  expect((await applyRefundEvent()).rows[0].total).toBe(10000);
  expect((await applyRefundEvent()).rows[0].total).toBe(10000);
  expect((await applyRefundEvent(5000,"evt_older")).rows[0].total).toBe(10000);
  const expected=56675-Math.round(56675*10000/66633);
  expect((await row("profiles")).total_earnings_cents).toBe(expected);
  expect(await row("purchases")).toEqual(before);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(2);
  expect((await row("exact_installment_collection_holds"))).toMatchObject({reason:"verified_refund",requested_by:null,refund_operation_id:null});
  await expect(claimRenewal()).rejects.toThrow("held for review");
});
test("046 full refund to first payment after a later installment touches only that ledger",async()=>{
  await renewalReady();await claimRenewal();await prepareRenewal();await admitRenewal();await recordRenewalReceipt();await creditRenewal();
  const before=await row("purchases");
  await applyRefundEvent(66633);await applyRefundEvent(66633);
  expect((await row("profiles")).total_earnings_cents).toBe(56208);
  expect(await row("purchases")).toEqual(before);
  expect((await db.query<{status:string}>("select status from payment_fee_ledger where stripe_payment_intent_id='pi_fixture1'")).rows[0].status).toBe("refunded");
  expect((await db.query<{status:string}>("select status from payment_fee_ledger where stripe_payment_intent_id='pi_fixture2'")).rows[0].status).toBe("paid");
});
test("046 unknown/uncredited receipt is not accepted and cannot create accounting or access",async()=>{
  await seed();
  await expect(applyRefundEvent()).rejects.toThrow("not credited yet");
  expect((await row("purchases")).access_granted).toBe(false);
  expect((await db.query("select * from payment_fee_ledger")).rows).toHaveLength(0);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(0);
});
test("046 pending/failed refund observation installs only a hold, with no accounting or access changes",async()=>{
  await renewalReady();const before=await row("purchases");
  await db.query("select hold_exact_installment_refund_event($1,'evt_pending','pi_fixture1','ch_fixture1',66633)",[plan]);
  expect((await db.query("select * from payment_refund_state")).rows).toHaveLength(0);
  expect((await row("profiles")).total_earnings_cents).toBe(56675);
  expect(await row("purchases")).toEqual(before);await expect(claimRenewal()).rejects.toThrow("held for review");
});
test.each([0,-1,66634])("046 invalid refund %i rolls back entirely",async(amount)=>{
  await firstPaid();await expect(applyRefundEvent(amount)).rejects.toThrow("invalid exact refund evidence");
  expect((await row("profiles")).total_earnings_cents).toBe(56675);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(0);
});
test("046 a previous mismatched refund mirror rolls back both hold and accounting",async()=>{
  await firstPaid();await db.exec("insert into payment_refund_state(stripe_payment_intent_id,stripe_charge_id,charge_amount_cents,refunded_amount_cents) values('pi_fixture1','ch_other',66633,1)");
  await expect(applyRefundEvent()).rejects.toThrow("prior refund identity mismatch");
  expect((await row("profiles")).total_earnings_cents).toBe(56675);
  expect((await db.query("select * from exact_installment_collection_holds")).rows).toHaveLength(0);
});
test("046 an already-admitted charge can still reconcile after an external refund hold",async()=>{
  await renewalReady();await claimRenewal();await prepareRenewal();await admitRenewal();await applyRefundEvent();
  await recordRenewalReceipt();await creditRenewal();
  expect((await row("purchases")).paid_count).toBe(2);
  expect((await row("exact_installment_invoice_claims")).status).toBe("paid");
});
test("046 reusing an event for a different installment fails without reversing it",async()=>{
  await renewalReady();await claimRenewal();await prepareRenewal();await admitRenewal();await recordRenewalReceipt();await creditRenewal();
  await applyRefundEvent();const before=await row("profiles");
  await expect(applyRefundEvent(10000,"evt_refundfixture","pi_fixture2","ch_fixture2")).rejects.toThrow("event identity changed");
  expect(await row("profiles")).toEqual(before);
});
test.each(["canceled","review_required","complete"])("046 refund on %s agreement preserves its closed/held status",async(status)=>{
  await firstPaid();await db.query("update exact_installment_agreements set status=$1",[status]);
  await applyRefundEvent();expect((await row("exact_installment_agreements")).status).toBe(status);
});
test.each(["anon","authenticated","service_role"])("046 %s RPC permission is least-privilege",async(role)=>{
  expect((await db.query<{ok:boolean}>("select has_function_privilege($1,'apply_exact_installment_refund_event(uuid,text,text,text,bigint,bigint)','EXECUTE') ok",[role])).rows[0].ok).toBe(role==="service_role");
  expect((await db.query<{ok:boolean}>("select has_function_privilege($1,'hold_exact_installment_refund_event(uuid,text,text,text,bigint)','EXECUTE') ok",[role])).rows[0].ok).toBe(role==="service_role");
});

test("seeds a new pending purchase and reserves identities without access, earnings or a public link",async()=>{
  const id=await seed();
  expect(await row("purchases")).toMatchObject({id,buyer_id:t.buyerId,buyer_user_id:t.buyerId,creator_id:t.creatorId,
    product_id:t.productId,post_id:t.postId,session_id:"cs_test_fixture",subscription_id:"sub_fixture",
    status:"pending",paid_count:0,access_granted:false,is_refund:false,is_suspect:false,target_months:3,
    amount_cents:66633,plan_amount_cents:66633,kind:"installment",fulfillment_url:null,earnings_credited_at:null});
  expect(await row("booking_payments")).toMatchObject({status:"pending",link_url:null,stripe_checkout_session_id:"cs_test_fixture",stripe_subscription_id:"sub_fixture"});
  expect((await row("profiles")).total_earnings_cents).toBe(0);
});
test("lost seed response reuses one purchase and never replaces it",async()=>{
  const id=await seed();expect(await seed()).toBe(id);
  expect((await db.query("select id from purchases")).rows).toHaveLength(1);
});
test.each(["pending","paid","refunded"])("does not adopt an earlier %s buyer purchase",async(status)=>{
  await db.query(`insert into purchases(id,buyer_id,post_id,product_id,currency,status,access_granted,is_refund,is_suspect)
    values(gen_random_uuid(),$1,$2,$3,'usd',$4,false,false,false)`,[t.buyerId,t.postId,t.productId,status]);
  await expect(seed()).rejects.toThrow("already has a purchase");
  expect((await row("exact_installment_agreements")).purchase_id).toBeNull();
  expect((await row("purchases")).status).toBe(status);
});
test("bind-only purchase is not mislabeled as a freshly seeded purchase",async()=>{
  const id=await seed();await db.exec("update exact_installment_agreements set purchase_seeded_at=null");
  await expect(seed()).rejects.toThrow("not adoption");expect((await row("purchases")).id).toBe(id);
});
test.each(["canceled","completed"])("cannot seed a %s booking",async(status)=>{
  await db.query("update bookings set status=$1",[status]);await expect(seed()).rejects.toThrow("booking changed");
  expect((await db.query("select id from purchases")).rows).toHaveLength(0);
});
test.each(["update products set is_active=false","update products set creator_id=null","update posts set product_id=null"])("seed rejects changed product linkage: %s",async(sql)=>{
  await db.exec(sql);await expect(seed()).rejects.toThrow("ownership mismatch");
});
test("cannot seed after receipt recording (webhook ordering requires explicit review)",async()=>{
  await db.query("select record_exact_installment_first_receipt($1,'cs_test_fixture','pi_fixture1',66633,9958,now())",[plan]);
  await expect(seed()).rejects.toThrow("precede payment evidence");
});
test.each(["stripe_checkout_session_id='cs_test_other'","stripe_subscription_id='sub_other'","amount_total_cents=99",
  "installment_months=4","buyer_id=null","currency='eur'","link_url='https://checkout.stripe.com/synthetic'"])("reserved booking blocks competing legacy mutation: %s",async(update)=>{
  await expect(db.exec(`update booking_payments set ${update}`)).rejects.toThrow("reserved");
});
test("a booking without an exact agreement retains its existing update behavior",async()=>{
  await db.query("insert into booking_payments(id,status) values($1,'pending')",[t.creatorId]);
  await expect(db.query("update booking_payments set stripe_checkout_session_id='cs_test_legacy' where id=$1",[t.creatorId])).resolves.toBeDefined();
});
test("fulfillment requires the credited first receipt, not merely a pending purchase",async()=>{
  await seed();await expect(fulfill()).rejects.toThrow("first credit required");
  expect((await row("bookings")).status).toBe("booked");
});
test("first paid installment completes the sales booking, not the whole balance, and attaches delivery once",async()=>{
  await firstPaid();await fulfill();const p=await row("purchases");
  expect(p).toMatchObject({status:"active",paid_count:1,access_granted:true,fulfillment:"discord",
    fulfillment_url:"https://discord.gg/synthetic",first_access_at:null,earnings_credited_at:null});
  expect((await row("booking_payments"))).toMatchObject({status:"completed",stripe_payment_intent_id:"pi_fixture1"});
  expect((await row("bookings")).status).toBe("completed");
  expect((await row("exact_installment_agreements")).first_fulfilled_at).not.toBeNull();
  await db.exec("update products set discord_invite_url='https://discord.gg/changed'");await fulfill();
  expect((await row("purchases")).fulfillment_url).toBe(p.fulfillment_url);
  expect((await row("profiles")).total_earnings_cents).toBe(56675);
});
test("supports Whop delivery using row ID even when public product ID is different",async()=>{
  await db.exec("update products set discord_invite_url=null,whop_listing_url='https://whop.com/synthetic'");
  await firstPaid();await fulfill();expect(await row("purchases")).toMatchObject({fulfillment:"whop",fulfillment_url:"https://whop.com/synthetic"});
});
test("native video access needs no fabricated external delivery link",async()=>{
  await db.exec("update products set type='video',discord_invite_url=null");await firstPaid();await fulfill();
  expect(await row("purchases")).toMatchObject({access_granted:true,fulfillment:null,fulfillment_url:null,first_access_at:null});
});
test.each(["javascript:alert(1)","https://example.test/has space"])("invalid delivery URL rolls back booking completion: %s",async(url)=>{
  await firstPaid();await db.query("update products set discord_invite_url=$1",[url]);
  await expect(fulfill()).rejects.toThrow("URL requires review");expect((await row("bookings")).status).toBe("booked");
});
test.each(["update purchases set status='refunded'","update purchases set is_refund=true","update purchases set is_suspect=true",
  "update purchases set access_granted=false","update purchases set subscription_id='sub_other'",
  "update payment_fee_ledger set refunded_amount_cents=1",`insert into payment_dispute_state(stripe_dispute_id,stripe_payment_intent_id,
    stripe_charge_id,disputed_amount_cents,currency,status,stripe_event_created) values('du_fixture','pi_fixture1','ch_fixture1',100,'usd','needs_response',1)`,
  "insert into refund_operations(stripe_payment_intent_id,status,stripe_refund_id) values('pi_fixture1','processing',null)"])("does not deliver after closed, conflicting or refund/dispute state: %s",async(sql)=>{
  await firstPaid();await db.exec(sql);await expect(fulfill()).rejects.toThrow("first credit required");
  expect((await row("bookings")).status).toBe("booked");
});
test("does not overwrite unexpected delivery supplied by another handler",async()=>{
  await firstPaid();await db.exec("update purchases set fulfillment_url='https://example.test/old'");
  await expect(fulfill()).rejects.toThrow("do not overwrite");
});
test.each(["anon","authenticated"])("%s cannot execute private lifecycle functions",async(role)=>{
  for(const name of ["seed_exact_installment_purchase","fulfill_exact_installment_first_payment"]) {
    const result=await db.query<{ok:boolean}>("select has_function_privilege($1,$2,'EXECUTE') ok",[role,`${name}(uuid)`]);
    expect(result.rows[0].ok).toBe(false);
  }
});
