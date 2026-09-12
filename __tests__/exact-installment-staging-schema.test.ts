/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { installExactMigrationsInMemory, installStagingStructuralBaseline } from "../test-support/staging-catalog-postgres";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";

declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const t = exactInstallmentFixture().terms;
jest.setTimeout(60000);
beforeAll(async () => {
  db = createLocalPostgres();
  await installStagingStructuralBaseline(db);
  // Adversarial local defaults, not a claim about hosted default ACLs: the new
  // migrations must revoke client grants even if future objects inherit them.
  await db.exec(`alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role`);
  await installExactMigrationsInMemory(db);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  // Transaction rollback retains the inspected baseline; only synthetic rows.
  await db.exec("begin");
  await db.query("insert into auth.users(id) values($1),($2)", [t.creatorId,t.buyerId]);
  await db.query("insert into profiles(id,stripe_account_id,stripe_onboarding_complete) values($1,'acct_fixture',true),($2,null,false)",
    [t.creatorId,t.buyerId]);
  await db.query(`insert into products(id,product_id,creator_id,type,title,is_active,price_cents,amount_cents,currency,
    discord_invite_url) values($1,'88888888-8888-4888-8888-888888888888',$2,'mentorship','Synthetic',true,199900,199900,'usd',
    'https://discord.gg/synthetic')`, [t.productId,t.creatorId]);
  await db.query("insert into posts(id,product_id,creator_id,user_id) values($1,$2,$3,$3)", [t.postId,t.productId,t.creatorId]);
  await db.query("insert into bookings(id,post_id,creator_id,buyer_id,status) values($1,$2,$3,$4,'booked')",
    [t.bookingId,t.postId,t.creatorId,t.buyerId]);
});
afterEach(async () => { await db.exec("rollback"); });
const reserve = async () => (await db.query<{id:string}>(
  "select reserve_exact_installment_checkout($1,$2,3,$3,$4,$5) id",
  [t.bookingId,t.creatorId,t.previewOrigin,JSON.stringify(t.firstPaymentFeeSchedule),JSON.stringify(t.renewalFeeSchedule)])).rows[0].id;
async function ready() {
  const id=await reserve();
  for(const [step,result] of [["customer","cus_fixture"],["product","prod_fixture"],
    ["subscription","sub_fixture"],["hold","sub_fixture"],["checkout","cs_test_fixture"]]) {
    await db.query("select claim_exact_installment_operation($1,$2,$3,$4)",[id,step,"a".repeat(64),t.buyerId]);
    await db.query("select complete_exact_installment_operation($1,$2,$3,$4)",[id,step,t.buyerId,result]);
  }
  await db.query("select bind_exact_installment_checkout($1,'cus_fixture','sub_fixture','cs_test_fixture')",[id]);
  await db.query("select seed_exact_installment_purchase($1)",[id]);
  return id;
}
async function published() {
  const id=await ready();
  const a=(await db.query<{purchase_id:string;expiry:number}>(`select purchase_id,
    floor(extract(epoch from created_at))::integer+86400 expiry from exact_installment_agreements where id=$1`,[id])).rows[0];
  await db.query("select publish_exact_installment_checkout($1,$2,'cs_test_fixture','sub_fixture',$3,$4,$5,$6)",
    [id,t.creatorId,a.purchase_id,"https://checkout.stripe.com/c/pay/cs_test_fixture",a.expiry,"a".repeat(64)]);
  return id;
}
async function paid(id:string) {
  await db.query("select record_exact_installment_first_receipt($1,'cs_test_fixture','pi_fixture1',66633,9958,now())",[id]);
  await db.query("select credit_exact_installment_receipt($1,1,'ch_fixture1','txn_fixture1',1962)",[id]);
  await db.query("select fulfill_exact_installment_first_payment($1)",[id]);
}

test("all eighteen migrations install on the inspected types, defaults, FKs, indexes and triggers",async()=>{
  const rows=(await db.query<{plan_type:string;status:string}>(`select pg_typeof(plan_type)::text plan_type,
    pg_typeof(status)::text status from booking_payments limit 1`)).rows;
  expect(rows).toEqual([]);
  await reserve();
  expect((await db.query(`select pg_typeof(plan_type)::text plan_type,pg_typeof(status)::text status from booking_payments`)).rows)
    .toEqual([{plan_type:"booking_payment_plan",status:"booking_payment_status"}]);
});
test("reservation satisfies all real required fields and cannot mutate old rows on replay",async()=>{
  const id=await reserve(); expect(await reserve()).toBe(id);
  const b=(await db.query<Record<string,unknown>>("select * from booking_payments")).rows[0];
  expect(b).toMatchObject({closer_user_id:t.creatorId,product_id:t.productId,buyer_id:t.buyerId,
    plan_type:"installment",status:"pending",amount_total_cents:199900,installment_amount_cents:66633,
    processing_fee_cents:1962,total_creator_deduction_cents:9958,installment_collection_version:"exact-cents-held-v1"});
  expect(b.created_at).not.toBeNull(); expect(b.updated_at).not.toBeNull();
});
test("real purchase trigger retains canonical IDs and does not substitute the public product alias",async()=>{
  await ready();
  expect((await db.query("select post_id,product_id,status,access_granted,paid_count from purchases")).rows)
    .toEqual([{post_id:t.postId,product_id:t.productId,status:"pending",access_granted:false,paid_count:0}]);
});
test("publication and first payment satisfy real constraints and credit/fulfill exactly once",async()=>{
  const id=await published(); await paid(id); await paid(id);
  expect((await db.query("select status,paid_count,access_granted,fulfillment,fulfillment_url from purchases")).rows)
    .toEqual([{status:"active",paid_count:1,access_granted:true,fulfillment:"discord",fulfillment_url:"https://discord.gg/synthetic"}]);
  expect((await db.query("select status from booking_payments")).rows).toEqual([{status:"completed"}]);
  expect((await db.query("select total_earnings_cents from profiles where id=$1",[t.creatorId])).rows)
    .toEqual([{total_earnings_cents:56675}]);
  expect((await db.query("select gross_amount_cents,total_creator_deduction_cents,creator_net_cents,status from payment_fee_ledger")).rows)
    .toEqual([{gross_amount_cents:66633,total_creator_deduction_cents:9958,creator_net_cents:56675,status:"paid"}]);
});
test("new exact functions remain server-only even with permissive existing default EXECUTE",async()=>{
  const r=(await db.query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and proname like '%exact_installment%' and
    (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))`)).rows;
  expect(r).toEqual([]);
  expect((await db.query(`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and relname like 'exact_installment_%' and
    (not relrowsecurity or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') or
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE'))`)).rows).toEqual([]);
});

test("internal-only helpers do not inherit direct service-role EXECUTE",async()=>{
  for (const signature of ["public.exact_installment_month(bigint,integer)",
    "public.assert_exact_installment_activation_ready(uuid)",
    "public.guard_exact_installment_booking_binding()"]) {
    expect((await db.query<{allowed:boolean}>(
      "select has_function_privilege('service_role',$1,'EXECUTE') allowed",[signature])).rows[0].allowed).toBe(false);
  }
});
test("monthly and final-cent receipts satisfy the actual ledger/purchase constraints",async()=>{
  const id=await published(); await paid(id);
  await db.query("select claim_exact_installment_activation($1,'pm_fixture','si_fixture',$2)",[id,t.buyerId]);
  await db.query("select complete_exact_installment_activation($1,$2)",[id,t.buyerId]);
  for(const number of [2,3]) {
    // Only fast-forward this in-memory fixture's due time. This is structural
    // compatibility coverage, NOT a Stripe test-clock or hosted collection test.
    await db.query("update exact_installment_periods set due_at=floor(extract(epoch from now()))-60+$2 where agreement_id=$1 and payment_number=$2",[id,number]);
    const invoice=`in_fixture${number}`,pi=`pi_fixture${number}`;
    await db.query(`select claim_exact_installment_invoice($1,$2,'sub_fixture',due_at,period_end,$3)
      from exact_installment_periods where agreement_id=$1 and payment_number=$4`,[id,invoice,t.buyerId,number]);
    await db.query("select prepare_exact_installment_dispatch($1,$2,$3,$4)",[id,invoice,pi,t.buyerId]);
    await db.query("select admit_exact_installment_dispatch($1,$2,$3)",[id,invoice,t.buyerId]);
    const gross=number===3?66634:66633;
    for(let repeat=0;repeat<2;repeat++) {
      await db.query(`select record_exact_installment_renewal_receipt($1,$2,$3,$4,10425,
        date_trunc('second',dispatch_started_at)) from exact_installment_invoice_claims
        where agreement_id=$1 and payment_number=$5`,[id,invoice,pi,gross,number]);
      await db.query("select credit_exact_installment_receipt($1,$2,$3,$4,2429)",[id,number,`ch_fixture${number}`,`txn_fixture${number}`]);
    }
  }
  await db.query("select complete_exact_installment_agreement($1)",[id]);
  expect((await db.query("select status,paid_count from purchases")).rows).toEqual([{status:"complete",paid_count:3}]);
  expect((await db.query("select sum(gross_amount_cents)::bigint gross,sum(creator_net_cents)::bigint net from payment_fee_ledger")).rows)
    .toEqual([{gross:199900,net:169092}]);
  expect((await db.query("select total_earnings_cents from profiles where id=$1",[t.creatorId])).rows)
    .toEqual([{total_earnings_cents:169092}]);
});
