/** @jest-environment ./test-support/search-postgres-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

declare const createSearchPostgres: () => PGlite;
let db: PGlite;
jest.setTimeout(90_000);

const tipper = "11111111-1111-4111-8111-111111111111";
const creator = "22222222-2222-4222-8222-222222222222";
const post = "33333333-3333-4333-8333-333333333333";
const tip = "44444444-4444-4444-8444-444444444444";
const requestKey = "55555555-5555-4555-8555-555555555555";

beforeAll(async () => {
  db = createSearchPostgres();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table profiles (
      id uuid primary key, username text, full_name text, avatar_url text, banned_at timestamptz,
      stripe_account_id text, stripe_onboarding_complete boolean, total_earnings_cents bigint default 0
    );
    create table posts (
      id uuid primary key, type text, creator_id uuid, product_id uuid, offering_id uuid, title text,
      content text, caption text, interests text[], topics text[], hashtags text[], created_at timestamptz default now(),
      video_url text, poster_url text, price_cents bigint, allow_booking boolean default false,
      booking_url text, premium_path text, cta_type text, fulfillment_url text, display_price text,
      booking_url_override text, likes_count integer, comments_count integer, shares_count integer,
      purchase_count integer, active boolean default true, hidden_at timestamptz, removed_at timestamptz
    );
    create table products (id uuid, product_id uuid, creator_id uuid, title text, description text, type text, price_cents bigint, amount_cents bigint, active boolean);
    create table offerings (id uuid, creator_id uuid, title text, type text, product_metadata jsonb, is_active boolean);
    create table payment_fee_ledger (
      id uuid primary key default gen_random_uuid(), creator_id uuid not null, purchase_id uuid, order_id uuid,
      booking_payment_id uuid, stripe_checkout_session_id text, stripe_payment_intent_id text,
      stripe_invoice_id text, stripe_charge_id text, stripe_balance_transaction_id text,
      gross_amount_cents bigint not null, platform_fee_cents bigint not null,
      processing_fee_cents bigint not null, total_creator_deduction_cents bigint not null,
      creator_net_cents bigint not null, actual_stripe_fee_cents bigint,
      processing_fee_variance_cents bigint, refunded_amount_cents bigint default 0,
      earnings_reversed_cents bigint default 0, disputed_amount_cents bigint default 0,
      dispute_status text, currency text not null, fee_schedule_version text not null,
      status text default 'paid', earnings_credited_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now()
    );
    create unique index payment_fee_ledger_checkout_session_uidx on payment_fee_ledger(stripe_checkout_session_id) where stripe_checkout_session_id is not null;
    create unique index payment_fee_ledger_payment_intent_uidx on payment_fee_ledger(stripe_payment_intent_id) where stripe_payment_intent_id is not null;
    grant select, insert, update on posts to authenticated;
  `);
  await db.exec(readFileSync("supabase/schema/060-video-tipping.sql", "utf8"));
  await db.exec(readFileSync("supabase/schema/061-video-tipping-checkout-idempotency.sql", "utf8"));
});

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec("truncate notifications, tip_dispute_recoveries, payment_fee_ledger, tips, posts, profiles cascade");
  await db.query("insert into profiles(id,username,total_earnings_cents) values ($1,'viewer',0),($2,'creator',0)", [tipper, creator]);
  await db.query("insert into posts(id,type,creator_id,title,video_url,allow_booking,active,tips_enabled) values ($1,'text',$2,'Free lesson','https://media.example.test/lesson.mp4',false,true,true)", [post, creator]);
});

async function createTip(id = tip, key = requestKey) {
  const checkoutParams = JSON.stringify({
    mode: "payment", ui_mode: "custom", client_reference_id: id,
    line_items: [{ price_data: { currency: "usd", unit_amount: 1000 } }],
    payment_intent_data: { application_fee_amount: 120, transfer_data: { destination: "acct_destination" } },
    metadata: { tip_id: id, checkout_terms_fingerprint: "terms-v1" },
    return_url: `https://creatornet.net/dashboard?postId=${post}&tipId=${id}`,
    expires_at: 1_800_000_000,
  });
  return db.query<{ result: string }>(`
    select (create_or_get_video_tip(
      $1,$2,$3,$4,$5,'terms-v1',1000,120,0,120,880,false,0,0,
      'platform-only-v1','usd','acct_destination',$6::jsonb
    )).id::text result`, [id, tipper, creator, post, key, checkoutParams]);
}

test("enforces tip-only posts and frozen fee arithmetic", async () => {
  await expect(db.query("update posts set price_cents=100 where id=$1", [post])).rejects.toThrow();
  await expect(db.query("update posts set allow_booking=null where id=$1", [post])).rejects.toThrow();
  await expect(db.query("update posts set video_url=null where id=$1", [post])).rejects.toThrow();
  await expect(db.query(`insert into tips(
    id,tipper_id,creator_id,post_id,client_request_key,terms_fingerprint,gross_amount_cents,
    platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,
    fee_schedule_version,currency,stripe_destination_account_id
  ) values(gen_random_uuid(),$1,$2,$3,gen_random_uuid(),'bad',1000,120,0,121,879,'v','usd','acct_x')`, [tipper, creator, post])).rejects.toThrow();
});

test("returns one winning attempt per request key but permits intentional repeat tips", async () => {
  const [first, second] = await Promise.all([createTip(), createTip("66666666-6666-4666-8666-666666666666")]);
  expect(first.rows[0].result).toBe(tip);
  expect(second.rows[0].result).toBe(tip);
  await createTip("77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888");
  const count = await db.query<{ count: number }>("select count(*)::int count from tips");
  expect(count.rows[0].count).toBe(2);
  const frozen = await db.query<{ params: { client_reference_id: string } }>(
    "select stripe_checkout_params params from tips where id=$1", [tip]);
  expect(frozen.rows[0].params.client_reference_id).toBe(tip);
});

test("finalizes, credits, and notifies exactly once and keeps refunds monotonic", async () => {
  await createTip();
  await db.query("select bind_video_tip_checkout($1,'cs_test_tip')", [tip]);
  const finalize = () => db.query("select finalize_video_tip($1,'cs_test_tip','pi_tip','ch_tip','txn_tip',30)", [tip]);
  await Promise.all([finalize(), finalize()]);
  const state = await db.query<{ earnings: number; ledgers: number; notices: number }>(`
    select (select total_earnings_cents::int from profiles where id=$1) earnings,
      (select count(*)::int from payment_fee_ledger where tip_id=$2) ledgers,
      (select count(*)::int from notifications where tip_id=$2) notices`, [creator, tip]);
  expect(state.rows[0]).toEqual({ earnings: 880, ledgers: 1, notices: 1 });
  await db.query("select apply_video_tip_refund($1,500)", [tip]);
  await db.query("select apply_video_tip_refund($1,100)", [tip]);
  const refunded = await db.query<{ amount: number }>("select refunded_amount_cents::int amount from tips where id=$1", [tip]);
  expect(refunded.rows[0].amount).toBe(500);
});

test("credits a verified payment before Stripe fee audit data arrives", async () => {
  await createTip();
  await db.query("select bind_video_tip_checkout($1,'cs_test_tip')", [tip]);
  await db.query("select finalize_video_tip($1,'cs_test_tip','pi_tip','ch_tip',null,null)", [tip]);
  const before = await db.query<{ earnings: number; fee: number | null }>(`
    select p.total_earnings_cents::int earnings, l.actual_stripe_fee_cents::int fee
    from profiles p cross join payment_fee_ledger l where p.id=$1 and l.tip_id=$2`, [creator, tip]);
  expect(before.rows[0]).toEqual({ earnings: 880, fee: null });
  await db.query("select finalize_video_tip($1,'cs_test_tip','pi_tip','ch_tip','txn_tip',30)", [tip]);
  const after = await db.query<{ earnings: number; fee: number; variance: number; notices: number }>(`
    select p.total_earnings_cents::int earnings, l.actual_stripe_fee_cents::int fee,
      l.processing_fee_variance_cents::int variance,
      (select count(*)::int from notifications where tip_id=$2) notices
    from profiles p cross join payment_fee_ledger l where p.id=$1 and l.tip_id=$2`, [creator, tip]);
  expect(after.rows[0]).toEqual({ earnings: 880, fee: 30, variance: -30, notices: 1 });
});

test("dispute recovery freezes the target, orders status, and accepts late provider success", async () => {
  await createTip();
  const record = (eventCreated: number, target: number, status = "under_review") => db.query<{ recorded: boolean }>(`
    select record_tip_dispute_recovery('dp_tip',$1,'pi_tip','ch_tip','tr_tip',500,$2,$3,$4) recorded`,
    [tip, eventCreated, target, status]);
  expect((await record(100, 400)).rows[0].recorded).toBe(true);
  expect((await record(101, 200, "won")).rows[0].recorded).toBe(true);
  const frozen = await db.query<{ amount: number }>(`
    select reversal_amount_cents::int amount from tip_dispute_recoveries where stripe_dispute_id='dp_tip'`);
  expect(frozen.rows[0].amount).toBe(400);
  const success = await db.query<{ recorded: boolean }>(`
    select record_tip_dispute_recovery_progress('dp_tip',100,'reversal','succeeded','trr_tip',null) recorded`);
  expect(success.rows[0].recorded).toBe(true);
  expect((await record(99, 100)).rows[0].recorded).toBe(false);
  const lateFailure = await db.query<{ recorded: boolean }>(`
    select record_tip_dispute_recovery_progress('dp_tip',99,'reversal','failed',null,'provider_error') recorded`);
  expect(lateFailure.rows[0].recorded).toBe(false);
  const state = await db.query<{ status: string; reversalId: string; tipStatus: string }>(`
    select r.reversal_status status, r.reversal_id "reversalId", t.dispute_status "tipStatus"
      from tip_dispute_recoveries r join tips t on t.id=r.tip_id
      where r.stripe_dispute_id='dp_tip'`);
  expect(state.rows[0]).toEqual({ status: "succeeded", reversalId: "trr_tip", tipStatus: "won" });
});

test("browser roles cannot read or mutate private financial tables", async () => {
  await createTip();
  const functionAccess = await db.query<{ allowed: boolean }>(`
    select has_function_privilege('authenticated', oid, 'EXECUTE') allowed
    from pg_proc where proname = 'create_or_get_video_tip'`);
  expect(functionAccess.rows).toEqual([{ allowed: false }]);
  await db.exec("set role authenticated");
  try {
    await expect(db.query("select * from tips")).rejects.toThrow(/permission denied/i);
    await expect(db.query("update tips set status='paid'")).rejects.toThrow(/permission denied/i);
  } finally {
    await db.exec("reset role");
  }
});

test("an authenticated post owner cannot bypass server tip admission", async () => {
  await db.query("update posts set tips_enabled=false where id=$1", [post]);
  await db.exec("set role authenticated");
  try {
    await expect(db.query("update posts set tips_enabled=true where id=$1", [post]))
      .rejects.toThrow(/tips_enabled must be changed through the server/i);
    await expect(db.query(`insert into posts(id,creator_id,video_url,tips_enabled)
      values(gen_random_uuid(),$1,'https://media.example.test/other.mp4',true)`, [creator]))
      .rejects.toThrow(/tips_enabled must be changed through the server/i);
  } finally {
    await db.exec("reset role");
  }
});
