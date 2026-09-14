/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const viewer = "11111111-1111-4111-8111-111111111111",
  creator = "22222222-2222-4222-8222-222222222222";
const post = "33333333-3333-4333-8333-333333333333",
  product = "44444444-4444-4444-8444-444444444444";
const purchase = "55555555-5555-4555-8555-555555555555",
  ledger = "66666666-6666-4666-8666-666666666666";
jest.setTimeout(90000);
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);insert into auth.users values('${viewer}'),('${creator}');
 create table profiles(id uuid primary key,interests jsonb,banned_at timestamptz);
 create table posts(id uuid primary key,creator_id uuid,interests text[],topics text[],product_id uuid,hidden_at timestamptz);
 create table likes(user_id uuid,post_id uuid,primary key(user_id,post_id));
 create table user_interest_scores(user_id uuid,category text,score int,updated_at timestamptz,primary key(user_id,category));
 create table purchases(id uuid primary key,buyer_user_id uuid,buyer_id uuid,post_id uuid,product_id uuid,booking_id uuid);
 create table products(id uuid primary key,product_id uuid,type text);
 create table bookings(id uuid primary key,post_id uuid,buyer_id uuid,creator_id uuid);
 create table booking_payments(id uuid primary key,booking_id uuid,product_id uuid);
 create table payment_fee_ledger(id uuid primary key,creator_id uuid,purchase_id uuid,booking_payment_id uuid,
 gross_amount_cents bigint,refunded_amount_cents bigint default 0,disputed_amount_cents bigint default 0,
 status text,currency text,created_at timestamptz default now());
 insert into profiles(id,interests) values('${viewer}',to_jsonb(array['Entrepreneurship'])),('${creator}',to_jsonb(array['Entrepreneurship']));
 insert into posts(id,creator_id,interests,topics,product_id) values('${post}','${creator}',array['Entrepreneurship'],array['ecommerce'],'${product}');
 insert into products values('${product}',null,'mentorship');
 insert into purchases values('${purchase}','${viewer}',null,'${post}','${product}',null);`);
  await db.exec(`create function public.get_feed_v3(p_tab text default 'discover',p_limit int default 20,p_offset int default 0)
 returns table(post_id uuid) language sql as 'select p.id from public.posts p where p.hidden_at is null order by p.id limit p_limit offset p_offset';`);
  for (const file of [
    "20260913004646_discover_taxonomy.sql",
    "20260913005126_discover_events_and_sessions.sql",
    "20260913010141_discover_verified_sales.sql",
    "20260913011108_discover_eligibility_and_measurement.sql",
  ])
    await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
});
afterAll(async () => {
  await db.close();
});
test("clients cannot fabricate commercial events or read other viewers", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role);
    try {
      await expect(
        db.query("select * from discover_events_v1"),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query("select * from discover_checkout_links_v1"),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query("select link_discover_identity_v1($1,$2)", [ledger, viewer]),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query("select public.reconcile_discover_sale_v1($1)", [ledger]),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query(
          "select public.confirm_discover_booking_v1($1,$2,$3,now(),now(),false)",
          [ledger, "calendly", "fake"],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec("reset role");
    }
  }
});
test("watch totals are monotonic, bounded by elapsed time, and immune to duplicate samples", async () => {
  const {
    rows: [session],
  } = await db.query<{
    id: string;
  }>(`insert into discover_sessions_v1(actor,user_id,tab,post_ids)
 values('user:${viewer}','${viewer}','discover',array['${post}'::uuid]) returning id`);
  expect(
    (
      await db.query<{ n: string }>(
        "select discover_watch_sample_v1($1,$2,0) n",
        [session.id, post],
      )
    ).rows[0].n,
  ).toBe("0");
  await db.exec(
    "update discover_watch_v1 set last_at=clock_timestamp()-interval '5 seconds'",
  );
  const sample = async (n: number) =>
    Number(
      (
        await db.query<{ n: string }>(
          "select discover_watch_sample_v1($1,$2,$3) n",
          [session.id, post, n],
        )
      ).rows[0].n,
    );
  const total = await sample(1000);
  expect(total).toBeGreaterThanOrEqual(5);
  expect(total).toBeLessThan(6);
  expect(await sample(1000)).toBe(total);
  expect(await sample(1)).toBe(total);
});
test("verified setup is not a scheduled call; scheduling retries count once and cancellation retracts intent", async () => {
  const {
    rows: [a],
  } = await db.query<{
    id: string;
  }>(`insert into discover_booking_attribution_v1(setup_session_id,user_id,creator_id,post_id)
 values('cs_setup','${viewer}','${creator}','${post}') returning id`);
  expect(
    (
      await db.query(
        "select count(*)::int n from discover_events_v1 where kind='booking_scheduled'",
      )
    ).rows[0],
  ).toEqual({ n: 0 });
  for (let i = 0; i < 2; i++)
    await db.query(
      "select confirm_discover_booking_v1($1,'calendly','booking-1','2026-09-12T10:00:00Z','2026-09-20T10:00:00Z',false)",
      [a.id],
    );
  expect(
    (
      await db.query(
        "select count(*)::int n from discover_events_v1 where kind='booking_scheduled' and valid",
      )
    ).rows[0],
  ).toEqual({ n: 1 });
  await db.query(
    "select confirm_discover_booking_v1($1,'calendly','booking-1','2026-09-12T11:00:00Z',null,true)",
    [a.id],
  );
  await db.query(
    "select confirm_discover_booking_v1($1,'calendly','booking-1','2026-09-12T10:00:00Z','2026-09-20T10:00:00Z',false)",
    [a.id],
  );
  expect(
    (
      await db.query(
        "select valid from discover_events_v1 where kind='booking_scheduled'",
      )
    ).rows[0],
  ).toEqual({ valid: false });
  await db.query(
    "select confirm_discover_booking_v1($1,'calendly','booking-2','2026-09-12T12:00:00Z','2026-09-21T10:00:00Z',false)",
    [a.id],
  );
  expect(
    (
      await db.query(
        "select count(*)::int n from discover_events_v1 where kind='booking_scheduled' and valid",
      )
    ).rows[0],
  ).toEqual({ n: 1 });
});
test("captured receipts count one purchase; installments add revenue; refunds retract sales", async () => {
  await db.query(
    `insert into payment_fee_ledger(id,creator_id,purchase_id,gross_amount_cents,status,currency)
 values($1,$2,$3,10000,'paid','usd')`,
    [ledger, creator, purchase],
  );
  await db.query(
    "update payment_fee_ledger set gross_amount_cents=10000 where id=$1",
    [ledger],
  );
  let rows = (
    await db.query<{ kind: string; amount_cents: string; valid: boolean }>(
      "select kind,amount_cents,valid from discover_events_v1 where kind in ('purchase','mentorship_purchase')",
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].amount_cents)).toBe(10000);
  await db.query(
    `insert into payment_fee_ledger(id,creator_id,purchase_id,gross_amount_cents,status,currency)
 values(gen_random_uuid(),$1,$2,5000,'paid','usd')`,
    [creator, purchase],
  );
  rows = (
    await db.query<{ kind: string; amount_cents: string; valid: boolean }>(
      "select amount_cents from discover_events_v1 where kind in ('purchase','mentorship_purchase')",
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].amount_cents)).toBe(15000);
  await db.exec(
    "update payment_fee_ledger set status='refunded',refunded_amount_cents=gross_amount_cents",
  );
  expect(
    (
      await db.query(
        "select valid,amount_cents::int from discover_events_v1 where kind in ('purchase','mentorship_purchase')",
      )
    ).rows,
  ).toEqual([{ valid: false, amount_cents: 0 }]);
});

test("like/unlike cycles preserve one event and never refresh its original timestamp", async () => {
  await db.query("insert into likes values($1,$2)", [viewer, post]);
  const first = (
    await db.query(
      "select occurred_at from discover_events_v1 where kind='like'",
    )
  ).rows[0];
  for (let i = 0; i < 5; i++) {
    await db.query("delete from likes where user_id=$1 and post_id=$2", [
      viewer,
      post,
    ]);
    await db.query("insert into likes values($1,$2)", [viewer, post]);
  }
  expect(
    (
      await db.query(
        "select occurred_at from discover_events_v1 where kind='like'",
      )
    ).rows,
  ).toEqual([first]);
  await db.query("delete from likes where user_id=$1 and post_id=$2", [
    viewer,
    post,
  ]);
  expect(
    (await db.query("select valid from discover_events_v1 where kind='like'"))
      .rows,
  ).toEqual([{ valid: false }]);
});
test("existing RPCs preserve their return shape and exclude banned creators", async () => {
  expect((await db.query("select * from get_feed_v3()")).rows).toEqual([
    { post_id: post },
  ]);
  await db.query("update profiles set banned_at=now() where id=$1", [creator]);
  expect((await db.query("select * from get_feed_v3()")).rows).toEqual([]);
  await db.query("update profiles set banned_at=null where id=$1", [creator]);
});
test("a later mentorship purchase credits the verified free-call video even when another post sells the product", async () => {
  const laterPost = "77777777-7777-4777-8777-777777777777",
    laterPurchase = "88888888-8888-4888-8888-888888888888";
  await db.query(
    "insert into posts(id,creator_id,interests,topics,product_id) values($1,$2,array['health & fitness'],'{}',$3)",
    [laterPost, creator, product],
  );
  await db.query(
    "insert into purchases(id,buyer_user_id,post_id,product_id) values($1,$2,$3,$4)",
    [laterPurchase, viewer, laterPost, product],
  );
  await db.query(
    "insert into payment_fee_ledger(id,creator_id,purchase_id,gross_amount_cents,status,currency) values(gen_random_uuid(),$1,$2,20000,'paid','usd')",
    [creator, laterPurchase],
  );
  expect(
    (
      await db.query(
        "select post_id,kind from discover_events_v1 where entity_key=$1",
        ["purchase:" + laterPurchase],
      )
    ).rows,
  ).toEqual([{ post_id: post, kind: "mentorship_purchase" }]);
});

test("removing a source post preserves attribution and subsequent refund reconciliation", async () => {
  await db.query("delete from posts where id=$1", [post]);
  expect(
    (await db.query("select post_id from discover_booking_attribution_v1"))
      .rows,
  ).toEqual([{ post_id: post }]);
  await db.exec(
    "update payment_fee_ledger set status='refunded',refunded_amount_cents=gross_amount_cents",
  );
  const rows = (
    await db.query<{ post_id: string; valid: boolean; amount_cents: number }>(
      "select post_id,valid,amount_cents::int from discover_events_v1 where kind in ('purchase','mentorship_purchase')",
    )
  ).rows;
  expect(rows.length).toBeGreaterThan(0);
  expect(
    rows.every(
      (row) =>
        row.post_id === post && row.valid === false && row.amount_cents === 0,
    ),
  ).toBe(true);
});

test("late purchase binding replaces the provisional booking-payment conversion", async () => {
  const booking = "99999999-9999-4999-8999-999999999991",
    payment = "99999999-9999-4999-8999-999999999992";
  const receipt = "99999999-9999-4999-8999-999999999993",
    order = "99999999-9999-4999-8999-999999999994";
  await db.query("insert into bookings values($1,$2,$3,$4)", [
    booking,
    post,
    viewer,
    creator,
  ]);
  await db.query("insert into booking_payments values($1,$2,$3)", [
    payment,
    booking,
    product,
  ]);
  await db.query(
    "insert into payment_fee_ledger(id,creator_id,booking_payment_id,gross_amount_cents,status,currency) values($1,$2,$3,1000,'paid','usd')",
    [receipt, creator, payment],
  );
  expect(
    (
      await db.query(
        "select count(*)::int n from discover_events_v1 where entity_key=$1",
        ["booking-payment:" + payment],
      )
    ).rows[0],
  ).toEqual({ n: 1 });
  await db.query(
    "insert into purchases(id,buyer_id,post_id,product_id,booking_id) values($1,$2,$3,$4,$5)",
    [order, viewer, post, product, booking],
  );
  await db.query("update payment_fee_ledger set purchase_id=$1 where id=$2", [
    order,
    receipt,
  ]);
  expect(
    (
      await db.query(
        "select entity_key,amount_cents::int from discover_events_v1 where entity_key in ($1,$2)",
        ["purchase:" + order, "booking-payment:" + payment],
      )
    ).rows,
  ).toEqual([{ entity_key: "purchase:" + order, amount_cents: 1000 }]);
});

test("anonymous history is claimed once, preserves sessions and repairs the sale cohort", async () => {
  const anonymous = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await db.query(
    "insert into discover_events_v1(actor,post_id,creator_id,kind,entity_key,audience,offer_type,occurred_at) values($1,$2,$3,'exposure','identity-exposure','ecommerce','free_call',now()-interval '1 hour')",
    ["anon:" + anonymous, post, creator],
  );
  await db.query(
    "insert into discover_sessions_v1(actor,tab,post_ids) values($1,'discover',array[$2::uuid])",
    ["anon:" + anonymous, post],
  );
  for (let attempt = 0; attempt < 2; attempt++)
    expect(
      (
        await db.query("select link_discover_identity_v1($1,$2) linked", [
          anonymous,
          viewer,
        ])
      ).rows[0],
    ).toEqual({ linked: true });
  expect(
    (
      await db.query("select link_discover_identity_v1($1,$2) linked", [
        anonymous,
        creator,
      ])
    ).rows[0],
  ).toEqual({ linked: false });
  expect(
    (
      await db.query(
        "select actor,user_id from discover_events_v1 where entity_key='identity-exposure'",
      )
    ).rows[0],
  ).toEqual({ actor: "user:" + viewer, user_id: viewer });
  expect(
    (
      await db.query(
        "select count(*)::int n from discover_sessions_v1 where actor=$1",
        ["anon:" + anonymous],
      )
    ).rows[0],
  ).toEqual({ n: 0 });
  expect(
    (
      await db.query(
        "select audience,offer_type from discover_events_v1 where entity_key='purchase:99999999-9999-4999-8999-999999999994'",
      )
    ).rows[0],
  ).toEqual({ audience: "ecommerce", offer_type: "free_call" });
});

test("database evidence counts unique exposed viewers and keeps topic cohorts separate", async () => {
  await db.query(
    "insert into discover_events_v1(actor,post_id,creator_id,kind,entity_key,audience) values($1,$2,$3,'exposure','repeated-exposure','ecommerce')",
    ["user:" + viewer, post, creator],
  );
  await db.query(
    "insert into discover_events_v1(actor,post_id,creator_id,kind,entity_key,audience) values('unexposed',$1,$2,'purchase','unexposed-sale','ecommerce')",
    [post, creator],
  );
  const summaries = (
    await db.query<{
      result: Array<{
        audience: string;
        exposures: number;
        sales: number;
        bookings: number;
        commercial: number;
      }>;
    }>("select discover_rank_evidence_v1(array[$1::uuid]) result", [post])
  ).rows[0].result;
  expect(summaries.find((row) => row.audience === "")).toMatchObject({
    exposures: 1,
    sales: 1,
    bookings: 1,
    commercial: 1,
  });
  expect(summaries.find((row) => row.audience === "ecommerce")).toMatchObject({
    exposures: 1,
    sales: 1,
    bookings: 0,
    commercial: 1,
  });
  await expect(
    db.query(
      "select discover_rank_evidence_v1(array_fill($1::uuid,array[201]))",
      [post],
    ),
  ).rejects.toThrow(/batch too large/i);
  await db.exec("set role authenticated");
  try {
    await expect(
      db.query("select discover_rank_evidence_v1(array[$1::uuid])", [post]),
    ).rejects.toThrow(/permission denied/i);
  } finally {
    await db.exec("reset role");
  }
});

test("new sessions prune bounded expired snapshots and watch rows without deleting conversion history", async () => {
  const laterPost = "77777777-7777-4777-8777-777777777777";
  await db.exec(
    "insert into discover_sessions_v1(actor,tab,post_ids) select 'prune-test','discover','{}'::uuid[] from generate_series(1,150)",
  );
  const oldest = (
    await db.query<{ id: string }>(
      "select id from discover_sessions_v1 where actor='prune-test' order by id limit 1",
    )
  ).rows[0].id;
  await db.query(
    "insert into discover_watch_v1(session_id,post_id) values($1,$2)",
    [oldest, laterPost],
  );
  await db.exec(
    "update discover_sessions_v1 set expires_at=now()-interval '1 day' where actor='prune-test'",
  );
  const before = (
    await db.query("select count(*)::int n from discover_events_v1")
  ).rows[0];
  await db.exec(
    "insert into discover_sessions_v1(actor,tab,post_ids) values('new-session','discover','{}')",
  );
  expect(
    (
      await db.query(
        "select count(*)::int n from discover_sessions_v1 where actor='prune-test'",
      )
    ).rows[0],
  ).toEqual({ n: 50 });
  expect(
    (
      await db.query(
        "select count(*)::int n from discover_watch_v1 where session_id=$1",
        [oldest],
      )
    ).rows[0],
  ).toEqual({ n: 0 });
  expect(
    (await db.query("select count(*)::int n from discover_events_v1")).rows[0],
  ).toEqual(before);
});

test("one bounded evidence batch returns more than 1000 cohort summaries without truncation", async () => {
  await db.exec(
    "create temporary table evidence_posts as select gen_random_uuid() id from generate_series(1,200)",
  );
  await db.query(
    "insert into discover_events_v1(actor,post_id,creator_id,kind,entity_key,audience) select 'scale-viewer-'||v.n,p.id,$1,'exposure',p.id::text||':'||v.n||':'||a.n,'audience-'||a.n from evidence_posts p cross join generate_series(1,3) v(n) cross join generate_series(1,8) a(n)",
    [creator],
  );
  const evidence = (
    await db.query<{ result: Array<{ audience: string; exposures: number }> }>(
      "select discover_rank_evidence_v1(array(select id from evidence_posts)) result",
    )
  ).rows[0].result;
  expect(evidence).toHaveLength(1800);
  expect(evidence.every((row) => row.exposures === 3)).toBe(true);
});
