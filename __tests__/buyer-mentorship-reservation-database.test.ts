/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mentorshipInstallmentQuote } from "@/lib/mentorshipInstallmentQuote";
import { productPurchaseTerms } from "@/lib/purchaseConsent";
import { reserveBuyerMentorshipInstallments } from "@/lib/mentorshipInstallmentReservation";
import type { SupabaseClient } from "@supabase/supabase-js";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = { version: "exact-payment-context-v1", mode: "test", platformAccountId: "acct_test", supabaseProjectRef: "abcdefghijklmnopqrst", siteOrigin: "https://synthetic-mentorship.vercel.app" };
const fees = { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-card" };
const product = { id: id(3), creator_id: id(2), type: "mentorship", title: "Mentorship", description: "", price_cents: 10001, currency: "usd", fixed_service_months: 10, installment_options: [3] };
const quote = mentorshipInstallmentQuote({ product, buyerId: id(1), postId: id(4), paymentCount: 3, firstPaymentFees: fees, renewalFees: fees });
async function reserve(terms: unknown = quote.terms, requestId = id(6), ctx = context) {
  const text = JSON.stringify(terms);
  return db.query("select * from reserve_buyer_mentorship_installments_v1($1,$2,$3,$4,$5,$6,$7)",
    [requestId, id(1), id(3), id(4), ctx, text, createHash("sha256").update(text).digest("hex")]);
}
async function full(post = id(4), consent: string | null = null) {
  return db.query(`insert into product_checkout_attempts(id,buyer_id,creator_id,product_id,post_id,purchase_identity,attempt_key,order_id,terms_fingerprint,purchase_consent_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,'full',$9)`, [id(10), id(1), id(2), id(3), post, `post:${post}`, id(11), id(12), consent]);
}
beforeAll(async () => {
  db = createLocalPostgres();
  // Focused structural fixture, not a full hosted migration or concurrency proof.
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table profiles(id uuid primary key, stripe_onboarding_complete boolean, stripe_account_id text);
    create table products(id uuid primary key,creator_id uuid,type text,active boolean,price_cents integer,amount_cents integer,
      membership_terms jsonb,currency text,title text,description text,fixed_service_months integer);
    create table posts(id uuid primary key,product_id uuid,creator_id uuid);
    create table purchases(buyer_id uuid,product_id uuid,post_id uuid);
    create table exact_installment_context_pin_v2(singleton boolean primary key,context jsonb unique);
    create table product_purchase_consents_v1(id uuid primary key,terms jsonb);
    create table product_checkout_attempts(id uuid primary key,buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid,
      purchase_identity text,attempt_key uuid,order_id uuid,terms_fingerprint text,purchase_consent_id uuid,
      unique(buyer_id,purchase_identity));`);
  const old = readFileSync("supabase/proposals/097-fixed-service-one-time.sql", "utf8");
  const guardStart = old.indexOf("create or replace function public.guard_fixed_service_one_time_v1()");
  const guard = old.slice(guardStart, old.indexOf("end $$;", guardStart) + 7);
  await db.exec(guard);
  await db.exec(`create trigger fixed_service_one_time_v1 before insert or update on product_checkout_attempts
    for each row execute function guard_fixed_service_one_time_v1();`);
  const service = readFileSync("supabase/proposals/096-independent-fixed-service.sql", "utf8");
  const start = service.indexOf("create function public.fixed_service_description_v1(");
  const end = service.indexOf("$$;", start) + 3;
  await db.exec(service.slice(start, end));
  for (const path of ["20260921011747_mentorship_installment_options.sql", "20260921012900_buyer_mentorship_installment_reservations.sql"])
    await db.exec(readFileSync(`supabase/migrations/${path}`, "utf8"));
  await db.exec(`create table buyer_mentorship_abandonment_holds_v1(reservation_id uuid primary key);
    create table buyer_mentorship_first_receipts_v1(reservation_id uuid primary key);
    create table buyer_mentorship_activation_operations_v1(reservation_id uuid primary key);
    create table buyer_mentorship_bootstrap_operations_v1(reservation_id uuid,step text,result_id text,bound_at timestamptz);`);
  await db.exec(readFileSync("supabase/migrations/20260921095550_buyer_mentorship_abandonment_proof.sql","utf8"));
  await db.exec(readFileSync("supabase/migrations/20260921095951_buyer_mentorship_abandonment_release.sql","utf8"));
  await db.exec(`create table buyer_mentorship_customer_operations_v1(reservation_id uuid primary key,bound_at timestamptz);
    create table buyer_mentorship_bootstraps_v1(reservation_id uuid primary key);
    alter table buyer_mentorship_abandonment_holds_v1 add column requested_at timestamptz default clock_timestamp();`);
  const holdSource=readFileSync("supabase/migrations/20260921094241_buyer_mentorship_abandonment_hold.sql","utf8");
  const holdStart=holdSource.indexOf("create function public.request_buyer_mentorship_abandonment_v1(");
  await db.exec(holdSource.slice(holdStart,holdSource.indexOf("end $$;",holdStart)+7));
  await db.exec(readFileSync("supabase/migrations/20260921101355_buyer_mentorship_unprepared_release.sql","utf8"));
});
beforeEach(async () => {
  await db.exec("begin");
  await db.query("insert into profiles values($1,false,null),($2,true,'acct_creator')", [id(1), id(2)]);
  await db.query("insert into products values($1,$2,'mentorship',true,10001,null,null,'usd','Mentorship','',10,'{3}')", [id(3), id(2)]);
  await db.query("insert into posts values($1,$2,$3),($4,$2,$3)", [id(4), id(3), id(2), id(5)]);
  await db.query("insert into exact_installment_context_pin_v2 values(true,$1)", [context]);
});
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db.close(); });
test("acceptance binds original attempt and deferred foreign keys; replay creates no purchase", async () => {
  const first = await reserve();
  await db.exec("set constraints all immediate");
  expect((await reserve()).rows).toEqual(first.rows);
  expect((await db.query("select checkout_kind from product_checkout_attempts")).rows).toEqual([{ checkout_kind: "installments" }]);
  expect((await db.query("select * from purchases")).rows).toEqual([]);
});
test("server adapter and actual SQL agree on accepted cents, service and original request replay", async () => {
  const admin = { rpc: (name: string, params: Record<string, unknown>) => {
    expect(name).toBe("reserve_buyer_mentorship_installments_v1");
    return { single: async () => {
      const result = await db.query("select * from reserve_buyer_mentorship_installments_v1($1,$2,$3,$4,$5,$6,$7)",
        [params.p_request_id, params.p_buyer_id, params.p_product_id, params.p_post_id, params.p_context, params.p_terms_text, params.p_fingerprint]);
      // Match PostgREST's JSON transport (PGlite exposes timestamps as Date).
      return { data: JSON.parse(JSON.stringify(result.rows[0])), error: null };
    } };
  } } as unknown as SupabaseClient;
  const args = { admin, product, buyerId: id(1), postId: id(4), paymentCount: 3, firstPaymentFees: fees, renewalFees: fees,
    requestId: id(6), context, origin: context.siteOrigin,
    acceptance: { accepted: true, version: quote.terms.version, fingerprint: quote.fingerprint },
    contextEvidence: { approvedContext: context, vercelEnvironment: "preview", stripeSecretKeyMode: "test", stripePublishableKeyMode: "test",
      observedPlatformAccountId: context.platformAccountId, observedSupabaseProjectRef: context.supabaseProjectRef,
      configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: context.siteOrigin } };
  const accepted = await reserveBuyerMentorshipInstallments(args);
  await db.exec("set constraints all immediate");
  expect(accepted.terms.payments.map(p => p.amountCents)).toEqual([3333, 3333, 3335]);
  expect(accepted.terms.serviceMonths).toBe(10);
  expect(accepted.providerOperationsAllowed).toBe(false);
  expect(await reserveBuyerMentorshipInstallments(args)).toEqual(accepted);
});
test("original replay survives catalog changes without creating new authorization", async () => {
  const first = await reserve();
  await db.exec("update products set title='Changed',active=false");
  expect((await reserve()).rows).toEqual(first.rows);
});
test("a new request cannot reserve a second attempt for the same buyer and offer", async () => {
  await reserve();
  await expect(reserve(quote.terms, id(8))).rejects.toThrow("requires reconciliation");
});
test("the same request cannot substitute different accepted terms", async () => {
  await reserve();
  await expect(reserve({ ...quote.terms, title: "Changed" })).rejects.toThrow("Original installment acceptance differs");
});
test.each(["update products set installment_options='{}'", "update products set active=false", "update profiles set stripe_onboarding_complete=false"])("revalidates availability before acceptance: %s", async sql => {
  await db.exec(sql);
  await expect(reserve()).rejects.toThrow();
});
test.each(["amount", "duration", "post", "schedule", "version", "fixed consent version", "fixed consent text", "missing fixed consent"])("rejects altered %s", async field => {
  const terms = { ...quote.terms };
  if (field === "amount") terms.amountCents++;
  if (field === "duration") terms.serviceMonths = 9;
  if (field === "post") terms.postId = id(5);
  if (field === "schedule") terms.payments = [{ number: 1, amountCents: 10001 }];
  if (field === "version") terms.installmentVersion = "other";
  if (field === "fixed consent version") terms.fixedPurchaseConsentVersion = "other";
  if (field === "fixed consent text") terms.fixedPurchaseConsentText = "Cancel anytime";
  if (field === "missing fixed consent") Reflect.deleteProperty(terms, "fixedPurchaseConsentText");
  await expect(reserve(terms)).rejects.toThrow();
});
test("rejects wrong context", async () => { await expect(reserve(quote.terms, id(6), { ...context, platformAccountId: "acct_other" })).rejects.toThrow("context differs"); });
test("installments prevent full checkout through another post for the same product", async () => {
  await reserve();
  await db.query("insert into product_purchase_consents_v1 values($1,$2)", [id(7), productPurchaseTerms(product, id(1), id(5)).terms]);
  await expect(full(id(5), id(7))).rejects.toThrow("accepted installment checkout");
});
test.each(["update product_checkout_attempts set attempt_key=gen_random_uuid()", "delete from product_checkout_attempts"])("full-payment path cannot mutate accepted installment: %s", async sql => {
  await reserve(); await expect(db.exec(sql)).rejects.toThrow("cannot be rotated or deleted");
});
test("full checkout first prevents installment reservation", async () => {
  await db.query("insert into product_purchase_consents_v1 values($1,$2)", [id(7), productPurchaseTerms(product, id(1), id(4)).terms]);
  await full(id(4), id(7));
  await expect(reserve()).rejects.toThrow("requires reconciliation");
});
test("full checkout still requires accepted service duration", async () => {
  await expect(full()).rejects.toThrow("Timed checkout requires");
});
test("public roles cannot reserve and service role cannot directly mutate accepted records", async () => {
  const signature = "public.reserve_buyer_mentorship_installments_v1(uuid,uuid,uuid,uuid,jsonb,text,text)";
  const result = await db.query(`select has_function_privilege('anon',$1,'execute') a,
    has_function_privilege('authenticated',$1,'execute') b,has_function_privilege('service_role',$1,'execute') s,
    has_table_privilege('service_role','buyer_mentorship_installment_reservations_v1','insert') i`, [signature]);
  expect(result.rows).toEqual([{ a: false, b: false, s: true, i: false }]);
});

async function stoppedReservation() {
  const r:any=(await reserve()).rows[0];
  await db.query("insert into buyer_mentorship_abandonment_holds_v1 values($1)",[r.id]);
  await db.query("insert into buyer_mentorship_bootstrap_operations_v1 values($1,'subscription.create','sub_owned',now()),($1,'checkout.create','cs_test_owned',now())",[r.id]);
  const proof={version:"buyer-unpaid-stop-v1",subscriptionId:"sub_owned",sessionId:"cs_test_owned",canceledAt:Math.floor(Date.now()/1000)-1,
    checkoutStatus:"expired",firstPaymentIntentId:null,observedAt:Math.floor(Date.now()/1000)};
  return {r,proof};
}
async function release(proof:object,buyer=id(1)) {
  return (await db.query<{result:any}>("select release_buyer_mentorship_abandonment_v1($1,$2,$3,$4) result",[id(6),buyer,context,proof])).rows[0].result;
}
test("release preserves original attempt and acceptance while permitting a new installment selection",async()=>{
  const {r,proof}=await stoppedReservation();const original=(await db.query<{value:unknown}>("select to_jsonb(a) value from product_checkout_attempts a")).rows[0].value;
  const saved=await release(proof);expect(saved.reservation_id).toBe(r.id);expect(saved.released_at).toBeTruthy();
  expect((await db.query("select original_attempt from buyer_mentorship_attempt_history_v1")).rows).toEqual([{original_attempt:original}]);
  expect((await db.query("select * from product_checkout_attempts")).rows).toEqual([]);
  const next:any=(await reserve(quote.terms,id(8))).rows[0];expect(next.id).not.toBe(r.id);
  expect((await reserve()).rows[0]).toMatchObject({id:r.id,fingerprint:r.fingerprint,attempt_id:r.attempt_id});
  expect((await db.query("select count(*)::int n from buyer_mentorship_attempt_history_v1")).rows).toEqual([{n:2}]);
  await db.exec("set constraints all immediate");
});
test("released installment can switch to full payment through existing consent path",async()=>{
  const {proof}=await stoppedReservation();await release(proof);
  await db.query("insert into product_purchase_consents_v1 values($1,$2)",[id(7),productPurchaseTerms(product,id(1),id(4)).terms]);
  await full(id(4),id(7));await db.exec("set constraints all immediate");
  expect((await db.query("select checkout_kind from product_checkout_attempts")).rows).toEqual([{checkout_kind:"full"}]);
});
test.each(["receipt","activation","purchase","foreign buyer","stale proof"])("release rejects %s and keeps the active lock",async issue=>{
  const {r,proof}=await stoppedReservation();
  if(issue==="receipt")await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[r.id]);
  if(issue==="activation")await db.query("insert into buyer_mentorship_activation_operations_v1 values($1)",[r.id]);
  if(issue==="purchase")await db.query("insert into purchases values($1,$2,$3)",[id(1),id(3),id(4)]);
  if(issue==="stale proof")proof.observedAt-=60;
  await expect(release(proof,issue==="foreign buyer"?id(9):id(1))).rejects.toThrow();
});
test("release replay never deletes a newer installment attempt",async()=>{
  const {proof}=await stoppedReservation();const first=await release(proof);const next:any=(await reserve(quote.terms,id(8))).rows[0];
  expect(await release(proof)).toEqual(first);
  expect((await db.query("select id from product_checkout_attempts")).rows).toEqual([{id:next.attempt_id}]);
});
test("historical late receipt prevents new installment acceptance",async()=>{
  const {r,proof}=await stoppedReservation();await release(proof);
  await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[r.id]);
  await expect(reserve(quote.terms,id(8))).rejects.toThrow("requires reconciliation");
});

async function releaseUnprepared(buyer=id(1)) {
  return (await db.query<{result:any}>("select release_buyer_mentorship_unprepared_v1($1,$2,$3) result",[id(6),buyer,context])).rows[0].result;
}
test("never-prepared selection releases without fabricating provider objects",async()=>{
  const original:any=(await reserve()).rows[0];const released=await releaseUnprepared();
  expect(released).toMatchObject({status:"released",reservation_id:original.id,request_id:id(6)});
  expect(await releaseUnprepared()).toEqual(released);
  for(const table of ["buyer_mentorship_customer_operations_v1","buyer_mentorship_bootstraps_v1","buyer_mentorship_bootstrap_operations_v1"])
    expect((await db.query(`select count(*)::int n from ${table}`)).rows).toEqual([{n:0}]);
  expect((await db.query("select proof->>'version' version from buyer_mentorship_abandonment_proofs_v1")).rows).toEqual([{version:"buyer-undispatched-stop-v1"}]);
  expect((await reserve(quote.terms,id(8))).rows[0]).toBeTruthy();await db.exec("set constraints all immediate");
});
test.each(["customer","bootstrap","operation"])("any recorded %s prevents no-provider release, including unbound uncertainty",async kind=>{
  const r:any=(await reserve()).rows[0];
  if(kind==="customer")await db.query("insert into buyer_mentorship_customer_operations_v1 values($1,null)",[r.id]);
  if(kind==="bootstrap")await db.query("insert into buyer_mentorship_bootstraps_v1 values($1)",[r.id]);
  if(kind==="operation")await db.query("insert into buyer_mentorship_bootstrap_operations_v1 values($1,'checkout.create',null,null)",[r.id]);
  expect(await releaseUnprepared()).toEqual({status:"prepared_or_uncertain"});
  expect((await db.query("select released_at from buyer_mentorship_installment_reservations_v1")).rows).toEqual([{released_at:null}]);
  expect((await db.query("select count(*)::int n from product_checkout_attempts")).rows).toEqual([{n:1}]);
});


test.each(["before request columns","before stop column"])("full-checkout columns preserve installment snapshot from %s",async generation=>{
 await db.exec("alter table product_checkout_attempts add column stripe_checkout_session_id text, add column status text default 'creating'");
 if(generation==="before stop column")await db.exec(readFileSync("supabase/migrations/20260921103742_product_checkout_original_request.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
 await reserve();
 await db.exec("set constraints all immediate");
 // The old archive intentionally lacks the new full-payment request columns.
 if(generation==="before request columns")await db.exec(readFileSync("supabase/migrations/20260921103742_product_checkout_original_request.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
 await db.exec(readFileSync("supabase/migrations/20260921144337_product_checkout_stop_intent.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
 const r=(await db.query<{id:string}>("select id from buyer_mentorship_installment_reservations_v1")).rows[0];
 const result=await db.query<{result:any}>("select release_buyer_mentorship_unprepared_v1($1,$2,$3) result",[id(6),id(1),context]);
 expect(result.rows[0].result.status).toBe("released");
 expect((await db.query("select * from product_checkout_attempts")).rows).toHaveLength(0);
 expect((await db.query("select * from buyer_mentorship_attempt_history_v1 where reservation_id=$1",[r.id])).rows).toHaveLength(1);
});

test("verified original full release permits real installment reservation and replay never touches the newer mode",async()=>{
 await db.exec(`alter table product_checkout_attempts add column stripe_checkout_session_id text,add column status text default 'creating';
 create table orders(id uuid primary key,buyer_id uuid,creator_id uuid,post_id uuid,status text,stripe_checkout_session_id text,stripe_payment_intent_id text,amount_cents bigint,currency text);
 alter table purchases add column id uuid primary key,add column creator_id uuid,add column order_id uuid,add column session_id text,add column payment_intent_id text,
 add column status text,add column amount_cents bigint,add column currency text,add column subscription_id text,add column access_granted boolean,
 add column earnings_credited_at timestamptz,add column is_refund boolean,add column is_suspect boolean,add column fixed_service_consent_id uuid;
 create table fixed_purchase_service_contracts_v1(purchase_id uuid primary key);
 create table payment_fee_ledger(id uuid primary key,order_id uuid,purchase_id uuid);
 create table refund_operations(id uuid primary key,order_id uuid,purchase_id uuid);`);
 const source=readFileSync("supabase/proposals/097-fixed-service-one-time.sql","utf8");
 for(const name of ["attach_fixed_service_consent_v1","bind_fixed_service_one_time_v1"]){
  const from=source.indexOf("create function public."+name);await db.exec(source.slice(from,source.indexOf("end $$;",from)+7));
 }
 for(const name of ["20260921103742_product_checkout_original_request.sql","20260921144337_product_checkout_stop_intent.sql",
  "20260921144757_product_checkout_stop_operations.sql","20260921145555_product_checkout_stop_proof.sql","20260921145930_product_checkout_verified_release.sql"])
  await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
 await db.query("insert into product_purchase_consents_v1 values($1,$2)",[id(7),productPurchaseTerms(product,id(1),id(4)).terms]);
 await db.query(`insert into product_checkout_attempts(id,buyer_id,creator_id,product_id,post_id,purchase_identity,attempt_key,order_id,terms_fingerprint,purchase_consent_id,checkout_kind,original_request_protocol)
  values($1,$2,$3,$4,$5,$6,$7,$8,'full',$9,'full','product-checkout-original-v1')`,[id(10),id(1),id(2),id(3),id(4),`post:${id(4)}`,id(11),id(12),id(7)]);
 const metadata={buyer_id:id(1),creator_id:id(2),product_id:id(3),order_id:id(12),checkout_attempt_key:id(11),checkout_terms_fingerprint:"full"};
 const original={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params:{mode:"payment",payment_method_types:["card"],metadata,payment_intent_data:{metadata},line_items:[{price_data:{unit_amount:10001,currency:"usd"},quantity:1}]}};
 await db.query("select claim_product_checkout_original_request_v1($1,$2,$3,$4,$5)",[id(10),id(1),id(11),context,original]);
 await db.exec("update product_checkout_attempts set status='open',stripe_checkout_session_id='cs_full_original',original_request_lease_until=now()-interval '1 second'");
 await db.query("select request_product_checkout_stop_v1($1,$2,$3,$4)",[id(10),id(1),id(11),context]);
 await db.query("insert into orders(id,buyer_id,creator_id,post_id,status,stripe_checkout_session_id,amount_cents,currency) values($1,$2,$3,$4,'created','cs_full_original',10001,'usd')",[id(12),id(1),id(2),id(4)]);
 await db.query("insert into purchases(id,buyer_id,creator_id,product_id,post_id,order_id,session_id,status,amount_cents,currency,access_granted) values($1,$2,$3,$4,$5,$6,'cs_full_original','pending',10001,'usd',false)",[id(13),id(1),id(2),id(3),id(4),id(12)]);
 await db.exec("savepoint before_switch");await expect(reserve()).rejects.toThrow("requires reconciliation");await db.exec("rollback to before_switch");
 const proof={version:"product-unpaid-stop-v1",sessionId:"cs_full_original",checkoutStatus:"expired",paymentStatus:"unpaid",amountCents:10001,currency:"usd",paymentIntent:null,observedAt:Math.floor(Date.now()/1000)};
 const release=()=>db.query("select release_product_checkout_stop_v1($1,$2,$3,$4,$5)",[id(10),id(1),id(11),context,proof]);
 await release();const selected:any=(await reserve()).rows[0];await db.exec("set constraints all immediate");
 expect(selected.terms).toEqual(quote.terms);expect(selected.attempt_id).not.toBe(id(10));
 expect((await db.query("select checkout_kind from product_checkout_attempts")).rows).toEqual([{checkout_kind:"installments"}]);
 await release();expect((await db.query("select id from product_checkout_attempts")).rows).toEqual([{id:selected.attempt_id}]);
 expect((await db.query("select original_attempt->>'stripe_checkout_session_id' session from product_checkout_releases_v1")).rows).toEqual([{session:"cs_full_original"}]);
});


async function installNonpayableRelease() {
 await db.exec("drop table buyer_mentorship_bootstrap_operations_v1; drop table buyer_mentorship_bootstraps_v1; drop table buyer_mentorship_customer_operations_v1;");
 for(const name of ["20260921021558_buyer_mentorship_customer_operations.sql","20260921030153_buyer_mentorship_bootstrap_operations.sql"])
  await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
 const hold=readFileSync("supabase/migrations/20260921094241_buyer_mentorship_abandonment_hold.sql","utf8");
 const start=hold.indexOf("create function public.guard_buyer_mentorship_abandonment_dispatch_v1()");
 const end=hold.indexOf("-- First receipts",start);
 await db.exec(hold.slice(start,end));
 await db.exec(readFileSync("supabase/migrations/20260921154143_buyer_mentorship_nonpayable_release.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
 await db.exec("create trigger guard_buyer_mentorship_abandonment_hold_v1 before insert on buyer_mentorship_abandonment_holds_v1 for each row execute function guard_buyer_mentorship_abandonment_hold_v1()");
}
async function boundNonpayable(productBound=false) {
 await installNonpayableRelease();const r:any=(await reserve()).rows[0];
 const c=(await db.query<{result:any}>("select claim_buyer_mentorship_customer_v1($1,$2,$3) result",[id(6),id(1),context])).rows[0].result;
 await db.query("select bind_buyer_mentorship_customer_v1($1,$2,$3,$4,$5,$6)",[id(6),id(1),context,c.operation.lease_token,
  {id:"cus_nonpayable",object:"customer",livemode:false,metadata:c.operation.request.metadata,created:Math.floor(Date.parse(c.operation.first_dispatch_at)/1000)},"req_customer"]);
 if(productBound) {
  const request={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/products",params:{name:"Mentorship installments",metadata:{...c.operation.request.metadata,operation_kind:"product.create"}}};
  const op=(await db.query<{result:any}>("select claim_buyer_mentorship_bootstrap_v1($1,$2,$3,$4,$5) result",[id(6),id(1),context,"product.create",request])).rows[0].result.operation;
  await db.query("select bind_buyer_mentorship_bootstrap_v1($1,$2,$3,$4,$5,$6,$7)",[id(6),id(1),context,"product.create",op.lease_token,
   {id:"prod_nonpayable",object:"product",livemode:false,metadata:request.params.metadata},"req_product"]);
 }
 return r;
}
async function releaseNonpayable(buyer=id(1),ctx=context) {
 return (await db.query<{result:any}>("select release_buyer_mentorship_nonpayable_v1($1,$2,$3) result",[id(6),buyer,ctx])).rows[0].result;
}

async function manualReleaseFixture(){
 await installNonpayableRelease();
 await db.exec(`alter role service_role bypassrls;
   alter table product_checkout_attempts add column status text default 'creating',add column stripe_checkout_session_id text,
     add column stripe_checkout_url text,add column original_request jsonb,add column original_request_protocol text,
     add column updated_at timestamptz default now();
   alter table product_purchase_consents_v1 add column accepted_at timestamptz default now();
   create table orders(id uuid,buyer_id uuid,creator_id uuid,post_id uuid,status text,currency text,amount_cents bigint,
     gross_amount bigint,platform_fee bigint,processing_fee bigint,total_creator_deduction bigint,creator_amount bigint,fee_schedule_version text);
   grant select,insert on buyer_mentorship_abandonment_holds_v1 to service_role;
   grant select on buyer_mentorship_first_receipts_v1,buyer_mentorship_activation_operations_v1 to service_role;`);
 for(const name of ["20260921171012_buyer_mentorship_partial_subscription_stop.sql","20260921173504_server_payment_protocol.sql",
   "20260921175109_server_payment_intent_operations.sql","20260921201913_server_payment_intent_cancellation.sql",
   "20260923002943_buyer_manual_payment_release.sql"])
   await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
 const r:any=(await reserve()).rows[0];
 const scope=[id(6),id(1),context];
 await db.query("select pin_installment_server_payment_v1($1,$2,$3)",scope);
 const customer=(await db.query<{result:any}>("select claim_buyer_mentorship_customer_v1($1,$2,$3) result",scope)).rows[0].result.operation;
 await db.query("select bind_buyer_mentorship_customer_v1($1,$2,$3,$4,$5,$6)",[...scope,customer.lease_token,
   {id:"cus_manual",object:"customer",livemode:false,metadata:customer.request.metadata,created:Math.floor(Date.parse(customer.first_dispatch_at)/1000)},"req_customer"]);
 await db.query("select begin_buyer_mentorship_bootstrap_v1($1,$2,$3)",scope);
 for(const step of ["product.create","subscription.create","subscription.hold"]){
   const params=step==="product.create"?{name:"Mentorship installments",metadata:{...customer.request.metadata,operation_kind:step}}:
     step==="subscription.create"?{customer:"cus_manual",items:[{price_data:{product:"prod_manual"}}],metadata:{...customer.request.metadata,operation_kind:step}}:
     {pause_collection:{behavior:"keep_as_draft"}};
   const request={apiVersion:"2025-10-29.clover",method:"POST",path:step==="product.create"?"/v1/products":
     step==="subscription.create"?"/v1/subscriptions":"/v1/subscriptions/sub_manual",params};
   const op=(await db.query<{result:any}>("select claim_buyer_mentorship_bootstrap_v1($1,$2,$3,$4,$5) result",[...scope,step,request])).rows[0].result.operation;
   await db.query("select bind_buyer_mentorship_bootstrap_v1($1,$2,$3,$4,$5,$6,$7)",[...scope,step,op.lease_token,
     {id:step==="product.create"?"prod_manual":"sub_manual",object:step==="product.create"?"product":"subscription",livemode:false,
       metadata:{...customer.request.metadata,operation_kind:step==="subscription.hold"?"subscription.create":step},
       ...(step==="subscription.hold"?{pause_collection:{behavior:"keep_as_draft"}}:{})},"req_original"]);
 }
 // Seed an already bound manual operation; contract admission/Stripe inspection
 // have separate real-migration tests. Here the original release path is real.
 await db.query(`insert into server_payment_intent_operations_v1(attempt_id,contract,request,payment_intent_id,provider_request_id,bound_at,lease_until)
   values($1,$2,'{}','pi_manual','req_manual',clock_timestamp(),clock_timestamp()-interval '1 second')`,[r.attempt_id,
   {kind:"first_installment",customerId:"cus_manual",sourceMetadata:{installment_subscription_id:"sub_manual"}}]);
 const terminal={version:"server-payment-intent-terminal-v1",paymentIntentId:"pi_manual",status:"canceled",amountReceived:0,
   amountCapturable:0,canceledAt:Math.floor(Date.now()/1000),chargeIds:[],observedAt:Math.floor(Date.now()/1000)};
 await db.query("select request_server_payment_stop_v1($1,$2,$3)",[r.attempt_id,id(1),context]);
 await db.query("select record_server_payment_terminal_v1($1,$2,$3,$4)",[r.attempt_id,id(1),context,terminal]);
 const source=(await db.query<{result:any}>("select read_buyer_mentorship_manual_stop_v1($1,$2,$3) result",scope)).rows[0].result;
 const proof={...source,version:"buyer-manual-payment-stop-v1",subscriptionId:"sub_manual",sessionId:null,checkoutStatus:"not_created",
   firstPaymentIntentId:null,canceledAt:Math.floor(Date.now()/1000),observedAt:Math.floor(Date.now()/1000)};
 return {r,proof,scope};
}
test("manual release reuses original archive and retains stop/proof through new selection and lost-response replay",async()=>{
 const {r,proof,scope}=await manualReleaseFixture();await db.exec("set local role service_role");
 await db.query("select request_buyer_mentorship_abandonment_v1($1,$2,$3)",scope);
 const released=(await db.query<{result:any}>("select release_buyer_mentorship_abandonment_v1($1,$2,$3,$4) result",[...scope,proof])).rows[0].result;
 expect(released).toMatchObject({reservation_id:r.id,request_id:id(6)});
 await db.exec("reset role");
 expect((await db.query("select * from product_checkout_attempts")).rows).toHaveLength(0);
 expect((await db.query("select * from server_payment_stops_v1")).rows).toHaveLength(1);
 const next:any=(await reserve(quote.terms,id(8))).rows[0];await db.exec("set local role service_role");
 expect((await db.query<{result:any}>("select read_buyer_mentorship_manual_release_v1($1,$2,$3) result",scope)).rows[0].result).toEqual(released);
 await db.exec("reset role");expect((await db.query("select id from product_checkout_attempts")).rows).toEqual([{id:next.attempt_id}]);
 await db.exec("set constraints all immediate");
});
test.each(["legacy proof","other intent","other subscription","extra field","stale","future","missing terminal","missing stop","receipt","activation","purchase","unknown original","buyer","context"])
("manual release refuses %s and preserves the active attempt",async issue=>{
 const {r,proof,scope}=await manualReleaseFixture();
 await db.query("select request_buyer_mentorship_abandonment_v1($1,$2,$3)",scope);
 if(issue==="legacy proof"){proof.version="buyer-partial-subscription-stop-v1";delete proof.manualPayment;}
 if(issue==="other intent")proof.manualPayment.paymentIntentId="pi_other";
 if(issue==="other subscription")proof.subscriptionId="sub_other";
 if(issue==="extra field")proof.additional=true;
 if(issue==="stale")proof.observedAt-=60;if(issue==="future")proof.observedAt+=60;
 if(issue==="missing terminal")await db.exec("delete from server_payment_intent_terminal_v1");
 if(issue==="missing stop")await db.exec("delete from server_payment_stops_v1");
 if(issue==="receipt")await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[r.id]);
 if(issue==="activation"){
   // Inject an incompatible historical activation; normal admission already
   // refuses it after the stop. Release must independently reject it too.
   await db.exec("alter table buyer_mentorship_activation_operations_v1 disable trigger guard_buyer_mentorship_abandonment_dispatch_v1");
   await db.query("insert into buyer_mentorship_activation_operations_v1 values($1)",[r.id]);
 }
 if(issue==="purchase")await db.query("insert into purchases values($1,$2,$3)",[id(1),id(3),id(4)]);
 if(issue==="unknown original")await db.exec("delete from server_payment_intent_operations_v1");
 if(issue==="buyer")scope[1]=id(9);if(issue==="context")scope[2]={...context,mode:"live"};
 await db.exec("savepoint refused");
 await expect(db.query("select release_buyer_mentorship_abandonment_v1($1,$2,$3,$4)",[...scope,proof])).rejects.toThrow();
 await db.exec("rollback to savepoint refused");
 expect((await db.query("select released_at from buyer_mentorship_installment_reservations_v1")).rows).toEqual([{released_at:null}]);
 expect((await db.query("select id from product_checkout_attempts")).rows).toEqual([{id:r.attempt_id}]);
});
test.each(["anon","authenticated"])("%s cannot read manual stop or archived release",async role=>{
 await manualReleaseFixture();await db.exec(`set local role ${role}`);
 await expect(db.query("select read_buyer_mentorship_manual_release_v1($1,$2,$3)",[id(6),id(1),context])).rejects.toThrow("permission denied");
});
test.each([false,true])("bound nonpayable preparation product=%s releases and retains original operations",async productBound=>{
 const r=await boundNonpayable(productBound);
 const customer=(await db.query("select * from buyer_mentorship_customer_operations_v1")).rows;
 const operations=(await db.query("select * from buyer_mentorship_bootstrap_operations_v1")).rows;
 const result=await releaseNonpayable();expect(result).toMatchObject({status:"released",reservation_id:r.id});
 expect((await db.query("select * from buyer_mentorship_customer_operations_v1")).rows).toEqual(customer);
 expect((await db.query("select * from buyer_mentorship_bootstrap_operations_v1")).rows).toEqual(operations);
 expect((await db.query("select proof->>'version' version from buyer_mentorship_abandonment_proofs_v1")).rows)
  .toEqual([{version:"buyer-nonpayable-preparation-stop-v1"}]);
 const next:any=(await reserve(quote.terms,id(8))).rows[0];expect(await releaseNonpayable()).toEqual(result);
 expect((await db.query("select id from product_checkout_attempts")).rows).toEqual([{id:next.attempt_id}]);
 await db.exec("set constraints all immediate");
});
test.each(["customer uncertain","product uncertain","subscription.create","subscription.hold","checkout.create","active customer lease"])(
 "nonpayable release refuses %s and retains the purchase lock",async issue=>{
  const r=await boundNonpayable(false);
  if(issue==="customer uncertain") {
   await db.exec("alter table buyer_mentorship_customer_operations_v1 disable trigger guard_buyer_mentorship_customer_operation_v1");
   await db.exec("update buyer_mentorship_customer_operations_v1 set customer_id=null,bound_at=null,provider_request_id=null");
  } else if(issue==="active customer lease") await db.exec("update buyer_mentorship_customer_operations_v1 set lease_until=now()+interval '1 minute'");
  else {
   await db.query("select begin_buyer_mentorship_bootstrap_v1($1,$2,$3)",[id(6),id(1),context]);
   await db.query("insert into buyer_mentorship_bootstrap_operations_v1(reservation_id,step,request) values($1,$2,'{}')",
    [r.id,issue==="product uncertain"?"product.create":issue]);
  }
  expect(await releaseNonpayable()).toEqual({status:"prepared_or_uncertain"});
  expect((await db.query("select released_at from buyer_mentorship_installment_reservations_v1")).rows).toEqual([{released_at:null}]);
 });
test.each(["receipt","activation","purchase","buyer","context"])("nonpayable release rejects %s",async issue=>{
 const r=await boundNonpayable();
 if(issue==="receipt")await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[r.id]);
 if(issue==="activation")await db.query("insert into buyer_mentorship_activation_operations_v1 values($1)",[r.id]);
 if(issue==="purchase")await db.query("insert into purchases values($1,$2,$3)",[id(1),id(3),id(4)]);
 await expect(releaseNonpayable(issue==="buyer"?id(9):id(1),issue==="context"?{...context,mode:"live"}:context)).rejects.toThrow();
});
test("nonpayable release stops delayed creation of the bootstrap anchor",async()=>{
 await boundNonpayable();await releaseNonpayable();
 await expect(db.query("select begin_buyer_mentorship_bootstrap_v1($1,$2,$3)",[id(6),id(1),context])).rejects.toThrow("stop requires reconciliation");
});
