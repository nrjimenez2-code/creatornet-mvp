/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installStagingStructuralBaseline, installExactMigrationsInMemory } from "../test-support/staging-catalog-postgres";
import manifest from "../test-support/exact-staging-bundle-manifest.json";
import { createExactContextReservationStore } from "../lib/installments/contextReservation";
import { createExactContextRuntime, type ExactContextRuntimeConfig } from "../lib/installments/contextRuntime";

declare const createLocalPostgres: () => PGlite;
jest.setTimeout(120000);
const sql = readFileSync(join(process.cwd(), "supabase/proposals/058-payment-context-reservations.sql"), "utf8");
const ids = {
  buyer: "11111111-1111-4111-8111-111111111111", creator: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444",
  booking: "55555555-5555-4555-8555-555555555555", payment: "66666666-6666-4666-8666-666666666666",
  otherBooking: "99999999-9999-4999-8999-999999999999",
};
const testContext = { version: "exact-payment-context-v1", mode: "test", platformAccountId: "acct_synthetic",
  supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa", siteOrigin: "https://synthetic.vercel.app" };
const liveContext = { ...testContext, mode: "live", siteOrigin: "https://synthetic.example", platformAccountId: "acct_otherSynthetic" };
const firstFee = { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-card" };
const renewalFee = { enabled: true, basisPoints: 360, fixedCents: 30, version: "synthetic-billing" };
type Reservation = { id: string; booking_id: string; context: typeof testContext;
  terms: Record<string, unknown>; status: string; created_at: string };

async function baseline() {
  const database = createLocalPostgres();
  await installStagingStructuralBaseline(database);
  // Faithful catalog structure; deliberately hostile NEW-object defaults prove
  // explicit revocation. This fixture does not claim to reproduce hosted auth.
  await database.exec(`alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  await installExactMigrationsInMemory(database);
  return database;
}
async function seed(database: PGlite) {
  await database.query("insert into auth.users(id) values($1),($2)", [ids.buyer, ids.creator]);
  await database.query(`insert into public.profiles(id,stripe_onboarding_complete,stripe_account_id)
    values($1,false,null),($2,true,'acct_syntheticDestination')`, [ids.buyer, ids.creator]);
  await database.query(`insert into public.products(id,creator_id,type,title,is_active,price_cents,amount_cents,currency)
    values($1,$2,'mentorship','Synthetic mentorship',true,199900,199900,'usd')`, [ids.product, ids.creator]);
  await database.query("insert into public.posts(id,product_id,creator_id,user_id) values($1,$2,$3,$3)", [ids.post, ids.product, ids.creator]);
  await database.query("insert into public.bookings(id,post_id,creator_id,buyer_id,status) values($1,$2,$3,$4,'booked')",
    [ids.booking, ids.post, ids.creator, ids.buyer]);
}
async function legacyRows(database: PGlite) {
  return (await database.query(`select 'booking' kind,to_jsonb(b) details from public.bookings b
    union all select 'payment',to_jsonb(p) from public.booking_payments p
    union all select 'purchase',to_jsonb(p) from public.purchases p
    union all select 'agreement',to_jsonb(a) from public.exact_installment_agreements a order by 1,2`)).rows;
}
async function oldFunctionCatalog(database: PGlite) {
  return (await database.query(`select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) body,p.proacl::text acl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname not in ('valid_exact_payment_context_v2','guard_exact_context_immutable_v2',
      'guard_legacy_payment_context_v2','reserve_exact_installment_context_v2','read_exact_installment_context_pin_v2') order by 1`)).rows;
}

describe("LOCAL ONLY separate non-issuable context reservation proposal", () => {
  let db: PGlite;
  beforeAll(async () => { db = await baseline(); await db.exec(sql); });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await db.exec("begin"); await seed(db); });
  afterEach(async () => { await db.exec("rollback"); });
  const pin = (context: unknown = testContext) => db.query(
    "insert into public.exact_installment_context_pin_v2(context) values($1::jsonb)", [JSON.stringify(context)]);
  async function asRole<T>(role: "service_role" | "anon" | "authenticated", action: () => Promise<T>) {
    await db.exec(`set local role ${role}`);
    try { return await action(); } finally { await db.exec("reset role").catch(() => undefined); }
  }
  async function denied(action: () => Promise<unknown>, message?: string | RegExp) {
    await db.exec("savepoint denied_case");
    try { await expect(action()).rejects.toThrow(message); }
    finally { await db.exec("rollback to savepoint denied_case; release savepoint denied_case"); }
  }
  async function reserve(context: unknown = testContext, actor = ids.creator, count = 3, fee: unknown = firstFee) {
    return asRole("service_role", async () => (await db.query<Reservation>(
      "select * from public.reserve_exact_installment_context_v2($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)",
      [ids.booking, actor, count, JSON.stringify(context), JSON.stringify(fee), JSON.stringify(renewalFee)])).rows[0]);
  }
  async function legacyPayment(status = "pending", booking = ids.booking) {
    return db.query(`insert into public.booking_payments(id,booking_id,product_id,buyer_id,closer_user_id,plan_type,status,currency,amount_total_cents)
      values($1,$2,$3,$4,$5,'full',$6::public.booking_payment_status,'usd',199900)`,
    [ids.payment, booking, ids.product, ids.buyer, ids.creator, status]);
  }
  async function oldReserve() {
    return asRole("service_role", () => db.query("select public.reserve_exact_installment_checkout($1,$2,3,$3,$4::jsonb,$5::jsonb)",
      [ids.booking, ids.creator, testContext.siteOrigin, JSON.stringify(firstFee), JSON.stringify(renewalFee)]));
  }

  test("pin read attestation refuses an empty pin without populating or promoting anything", async () => {
    const before = await legacyRows(db);
    await denied(() => asRole("service_role", () => db.query("select public.read_exact_installment_context_pin_v2()")), "owner-provisioned");
    expect((await db.query(`select (select count(*)::integer from public.exact_installment_context_pin_v2) pins,
      (select count(*)::integer from public.exact_installment_context_reservations_v2) reservations`)).rows)
      .toEqual([{ pins: 0, reservations: 0 }]);
    expect(await legacyRows(db)).toEqual(before);
  });

  test.each([testContext, liveContext])("pin read attestation reports only the $mode owner pin inside a READ ONLY transaction", async context => {
    await pin(context); const before = await legacyRows(db);
    await db.exec("set transaction read only");
    const result = await asRole("service_role", () => db.query<{ observation: unknown }>(
      "select public.read_exact_installment_context_pin_v2() observation"));
    const observation = JSON.parse(JSON.stringify(result.rows[0].observation)) as unknown;
    expect(observation).toEqual({ version: "exact-context-pin-observation-v1", context,
      status: "reserved_not_issuable", source: "owner_provisioned_database_pin" });
    expect((await db.query("select current_setting('transaction_read_only') mode")).rows).toEqual([{ mode: "on" }]);
    expect((await db.query("select count(*)::integer n from public.exact_installment_context_reservations_v2")).rows).toEqual([{ n: 0 }]);
    expect(await legacyRows(db)).toEqual(before);
  });

  test.each(["anon", "authenticated"] as const)("pin read attestation denies %s even with an owner pin", async role => {
    await pin();
    await denied(() => asRole(role, () => db.query("select public.read_exact_installment_context_pin_v2()")), "permission denied");
    await denied(() => asRole("service_role", () => db.query("select context from public.exact_installment_context_pin_v2")), "permission denied");
  });

  test("pin read attestation ignores user-set configuration and has only read-only catalog settings", async () => {
    await pin();
    const result = await asRole("service_role", async () => {
      await db.query("select set_config('app.supabase_project_ref',$1,true),set_config('request.jwt.claims',$2,true)",
        ["bbbbbbbbbbbbbbbbbbbb", JSON.stringify({ project_ref: "bbbbbbbbbbbbbbbbbbbb", mode: "live" })]);
      return db.query<{ observation: unknown }>("select public.read_exact_installment_context_pin_v2() observation");
    });
    expect(JSON.parse(JSON.stringify(result.rows[0].observation))).toEqual({ version: "exact-context-pin-observation-v1",
      context: testContext, status: "reserved_not_issuable", source: "owner_provisioned_database_pin" });
    expect((await db.query(`select prosecdef,provolatile,pronargs,proconfig,
      has_function_privilege('service_role',oid,'EXECUTE') service_exec,
      has_function_privilege('anon',oid,'EXECUTE') anon_exec,
      has_function_privilege('authenticated',oid,'EXECUTE') authenticated_exec,
      prosrc not ilike '%current_setting%' and prosrc not ilike '%set_config%' no_config_inference
      from pg_proc where oid='public.read_exact_installment_context_pin_v2()'::regprocedure`)).rows)
      .toEqual([{ prosecdef: true, provolatile: "s", pronargs: 0, proconfig: ["search_path=pg_catalog"],
        service_exec: true, anon_exec: false, authenticated_exec: false, no_config_inference: true }]);
  });

  test.each([testContext, liveContext])("owner-pinned $mode context reserves only an immutable draft; exact retry converges", async context => {
    const before = await legacyRows(db);
    await pin(context);
    const a = await reserve(context), b = await reserve(context);
    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual(["id", "booking_id", "context", "terms", "status", "created_at"].sort());
    expect(a.context).toEqual(context);
    expect(a.status).toBe("reserved_not_issuable");
    expect(a.terms).toEqual({ version: "exact-cents-context-v2", currency: "usd", bookingId: ids.booking,
      productId: ids.product, postId: ids.post, buyerId: ids.buyer, creatorId: ids.creator,
      destinationId: "acct_syntheticDestination", title: "Synthetic mentorship", totalCents: 199900, paymentCount: 3,
      firstPaymentFeeSchedule: firstFee, renewalFeeSchedule: renewalFee });
    expect(await legacyRows(db)).toEqual(before);
    expect((await db.query("select count(*)::integer n from public.exact_installment_context_reservations_v2")).rows).toEqual([{ n: 1 }]);
  });

  test.each([testContext, liveContext])("SQL-to-adapter $mode composed round-trip keeps all provider operations blocked", async context => {
    await pin(context);
    const before = await legacyRows(db);
    const evidence = { approvedContext: { ...context }, vercelEnvironment: context.mode === "test" ? "preview" : "production",
      stripeSecretKeyMode: context.mode, stripePublishableKeyMode: context.mode,
      observedPlatformAccountId: context.platformAccountId, observedSupabaseProjectRef: context.supabaseProjectRef,
      configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: context.siteOrigin };
    type Args = { p_booking_id: string; p_actor_id: string; p_count: number;
      p_context: unknown; p_first_fee: unknown; p_renewal_fee: unknown };
    let transportedRow: unknown;
    // Only this transport boundary is fake. The adapter runs its real code,
    // and its RPC runs the proposed SQL as service_role in this memory DB.
    const transport = { rpc: jest.fn((name: string, params: Args) => {
      expect(name).toBe("reserve_exact_installment_context_v2");
      return { single: async () => {
        const result = await asRole("service_role", () => db.query<Reservation>(
          "select * from public.reserve_exact_installment_context_v2($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)",
          [params.p_booking_id, params.p_actor_id, params.p_count, JSON.stringify(params.p_context),
            JSON.stringify(params.p_first_fee), JSON.stringify(params.p_renewal_fee)]));
        // PostgREST crosses a JSON boundary; native PGlite timestamps are not
        // manually replaced with hand-built data or canned fixture rows.
        transportedRow = JSON.parse(JSON.stringify(result.rows[0])) as unknown;
        return { data: transportedRow, error: null };
      } };
    }) };
    const store = createExactContextReservationStore({ admin: transport as unknown as SupabaseClient,
      context, contextEvidence: evidence });
    const saved = await store.reserve({ actorId: ids.creator, bookingId: ids.booking, paymentCount: 3,
      firstPaymentFeeSchedule: firstFee, renewalFeeSchedule: renewalFee });
    expect(transport.rpc).toHaveBeenCalledTimes(1);
    expect(transportedRow).toMatchObject({ id: saved.id, booking_id: ids.booking, context,
      terms: saved.terms, status: "reserved_not_issuable", created_at: expect.any(String) });
    expect(saved.context).toEqual(context);
    expect(saved.terms.version).toBe("exact-cents-context-v2");
    expect(saved.terms.totalCents).toBe(199900);
    expect(saved.terms.creatorId).toBe(ids.creator);
    expect(saved.providerOperationsAllowed).toBe(false);
    expect(saved.status).toBe("reserved_not_issuable");
    expect(Object.keys(store).sort()).toEqual(["load", "reserve"]);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(await legacyRows(db)).toEqual(before);
  });

  test("SQL-to-runtime blocked inspection uses actual SDK reads and never acknowledges or binds the event", async () => {
    await pin();
    const row = await reserve();
    const before = await legacyRows(db);
    const rowJson = JSON.parse(JSON.stringify(row)) as Reservation;
    const config: ExactContextRuntimeConfig = {
      approvedContext: { ...testContext, version: "exact-payment-context-v1", mode: "test" },
      vercelEnvironment: "preview", configuredSupabaseUrl: `https://${testContext.supabaseProjectRef}.supabase.co`,
      configuredSiteOrigin: testContext.siteOrigin, stripeSecretKey: "sk_test_SYNTHETICNOTACREDENTIAL",
      stripePublishableKeyMode: "test", supabaseServiceKey: "sb_secret_SYNTHETICNOTACREDENTIAL",
      expectedApiVersion: "2025-10-29.clover",
    };
    const eventId = "evt_LocalSqlRuntimeOnly";
    const event = { object: "event", id: eventId, api_version: config.expectedApiVersion, type: "charge.updated",
      created: Math.floor(Date.parse(rowJson.created_at) / 1000), livemode: false,
      data: { object: { object: "charge", id: "ch_LocalSqlRuntimeOnly", livemode: false,
        metadata: { installment_collection_version: "exact-cents-context-v2", installment_plan_id: row.id } } } };
    const paths: string[] = [];
    // The real SDKs execute normally. Only their trusted HTTP transport is
    // replaced; this function never calls global fetch or an external service.
    const trustedFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store" });
      expect(init?.body == null).toBe(true);
      const headers = new Headers(init?.headers);
      expect(headers.has("stripe-account")).toBe(false);
      expect(headers.has("stripe-context")).toBe(false);
      expect(headers.has("idempotency-key")).toBe(false);
      let body: unknown;
      if (url.origin === "https://api.stripe.com") {
        expect(url.search).toBe("");
        expect(headers.get("authorization")).toBe(`Bearer ${config.stripeSecretKey}`);
        expect(headers.get("stripe-version")).toBe(config.expectedApiVersion);
        if (url.pathname === "/v1/account") body = { object: "account", id: testContext.platformAccountId };
        else if (url.pathname === "/v1/balance") body = { object: "balance", livemode: false, available: [], pending: [] };
        else if (url.pathname === `/v1/events/${eventId}`) body = event;
        else throw Error("Unexpected synthetic Stripe path");
      } else {
        expect(url.origin).toBe(config.configuredSupabaseUrl);
        expect(headers.get("apikey")).toBe(config.supabaseServiceKey);
        expect(headers.get("authorization")).toBe(`Bearer ${config.supabaseServiceKey}`);
        expect(headers.get("accept-profile")).toBe("public");
        if (url.pathname === "/rest/v1/rpc/read_exact_installment_context_pin_v2") {
          expect(url.search).toBe("");
          body = (await asRole("service_role", () => db.query<{ observation: unknown }>(
            "select public.read_exact_installment_context_pin_v2() observation"))).rows[0].observation;
        } else if (url.pathname === "/rest/v1/exact_installment_context_reservations_v2") {
          expect([...url.searchParams.entries()]).toEqual([
            ["select", "id,booking_id,context,terms,status,created_at"], ["id", `eq.${row.id}`], ["terms->>creatorId", `eq.${ids.creator}`],
          ]);
          // Apply the SDK's actual id AND creator filters to the real SQL row,
          // not a hand-built response that ignores ownership or field selection.
          body = (await asRole("service_role", () => db.query<Reservation>(
            `select id,booking_id,context,terms,status,created_at from public.exact_installment_context_reservations_v2
              where id=$1 and terms->>'creatorId'=$2`,
            [url.searchParams.get("id")!.slice(3), url.searchParams.get("terms->>creatorId")!.slice(3)]))).rows;
        } else throw Error("Unexpected synthetic database path");
      }
      const bytes = JSON.stringify(body);
      const response = new Response(bytes, { status: 200, headers: { "content-type": "application/json", "request-id": "req_LocalSqlRuntimeOnly" } });
      Object.defineProperties(response, { url: { value: url.href }, redirected: { value: false },
        // Native Response is another Jest realm. Parse the same real JSON bytes
        // in this realm; no SDK methods or response contents are mocked away.
        json: { value: async () => JSON.parse(bytes) } });
      return response;
    };
    await db.exec("set transaction read only");
    const runtime = createExactContextRuntime(config, trustedFetch);
    const inspected = await runtime.inspectEvent(row.id, ids.creator, eventId);
    expect(inspected).toMatchObject({ protocol: "exact-cents-context-v2", candidateReservationId: row.id,
      context: testContext, eventId, disposition: "unbound_reservation", providerOperationsAllowed: false,
      accountingOperationsAllowed: false, mayAcknowledge: false });
    expect(paths).toEqual(["/v1/account", "/v1/balance", "/rest/v1/rpc/read_exact_installment_context_pin_v2",
      "/rest/v1/exact_installment_context_reservations_v2", `/v1/events/${eventId}`,
      "/v1/account", "/v1/balance", "/rest/v1/rpc/read_exact_installment_context_pin_v2"]);
    expect((await db.query("select current_setting('transaction_read_only') mode")).rows).toEqual([{ mode: "on" }]);
    expect((await db.query<Reservation>("select * from public.exact_installment_context_reservations_v2")).rows).toEqual([row]);
    expect(await legacyRows(db)).toEqual(before);
    expect(JSON.stringify(inspected)).not.toContain("SYNTHETICNOTACREDENTIAL");
  });

  test("installs without a pin; service cannot insert a pin or reserve against an unprovisioned or wrong context", async () => {
    await denied(() => reserve(), "owner-provisioned");
    await denied(() => asRole("service_role", () => pin()), "permission denied");
    await pin();
    for (const context of [{ ...testContext, platformAccountId: "acct_other" },
      { ...testContext, supabaseProjectRef: "bbbbbbbbbbbbbbbbbbbb" }, { ...testContext, siteOrigin: "https://other.vercel.app" }, liveContext]) {
      await denied(() => reserve(context), "owner-provisioned");
    }
    await denied(() => pin(liveContext), "duplicate key");
  });

  test.each([null, {}, { ...testContext, extra: true }, { ...testContext, mode: null },
    { ...testContext, platformAccountId: "acct_" }, { ...testContext, siteOrigin: "https://synthetic.vercel.app/" },
    { ...testContext, siteOrigin: "https://synthetic.vercel.app:443" }, { ...testContext, siteOrigin: "https://127.0.0.1" },
    { ...testContext, siteOrigin: "https://-synthetic.vercel.app" }, { ...testContext, mode: "live" },
    { ...testContext, siteOrigin: "https://synthetic.example" }, { ...testContext, siteOrigin: "https://synthetic..vercel.app" },
  ])("malformed context %j cannot be provisioned or reserved", async context => {
    await denied(() => pin(context));
    await pin();
    await denied(() => reserve(context));
  });

  test("owner/booking/product/destination checks precede reservation; no browser money is accepted", async () => {
    await pin();
    await denied(() => reserve(testContext, ids.buyer), "Owned unpaid");
    for (const mutation of ["update bookings set status='completed'", "update bookings set buyer_id=creator_id",
      "update products set is_active=false", "update products set currency='eur'", "update products set title=' '",
      "update posts set creator_id='11111111-1111-4111-8111-111111111111'",
      "update profiles set stripe_onboarding_complete=false where id='22222222-2222-4222-8222-222222222222'"]) {
      await db.exec("savepoint state_case");
      await db.exec(mutation);
      await denied(() => reserve());
      await db.exec("rollback to savepoint state_case; release savepoint state_case");
    }
    await denied(() => reserve(testContext, ids.creator, 1), "Invalid context");
    await denied(() => reserve(testContext, ids.creator, 25), "Invalid context");
    await denied(() => reserve(testContext, ids.creator, 3, { ...firstFee, totalCents: 1 }), "fee snapshot");
    await denied(() => reserve(testContext, ids.creator, 3, { ...firstFee, basisPoints: 10000 }), "Fee exceeds");
    await denied(() => reserve(testContext, ids.creator, 3, { ...firstFee, enabled: "true" }), "fee snapshot");
    await denied(() => reserve(testContext, ids.creator, 3, { ...firstFee, fixedCents: 0.1 }), "fee snapshot");
  });

  test("a changed repeat never mutates the draft or adopts altered source terms", async () => {
    await pin(); const a = await reserve();
    await denied(() => reserve(testContext, ids.creator, 4), "reservation differs");
    await denied(() => reserve(testContext, ids.creator, 3, { ...firstFee, basisPoints: 300 }), "reservation differs");
    await db.exec("update products set amount_cents=200000");
    await denied(() => reserve(), "reservation differs");
    expect((await db.query<Reservation>("select * from public.exact_installment_context_reservations_v2")).rows).toEqual([a]);
  });

  test.each(["pending", "link_sent", "completed", "canceled", "refunded"])("never adopts legacy %s payment evidence", async status => {
    await pin(); await legacyPayment(status); const before = await legacyRows(db);
    await denied(() => reserve(), "cannot be adopted");
    expect(await legacyRows(db)).toEqual(before);
  });

  test.each(["pending", "paid", "refunded"])("never adopts a prior %s purchase", async status => {
    await pin();
    await db.query(`insert into public.purchases(id,buyer_id,creator_id,post_id,product_id,status,currency)
      values(gen_random_uuid(),$1,$2,$3,$4,$5,'usd')`, [ids.buyer, ids.creator, ids.post, ids.product, status]);
    const before = await legacyRows(db);
    await denied(() => reserve(), "purchase cannot be adopted");
    expect(await legacyRows(db)).toEqual(before);
  });

  test("v2-first blocks direct legacy INSERT and the existing v1 reservation RPC without creating legacy rows", async () => {
    await pin(); const a = await reserve(); const before = await legacyRows(db);
    await denied(() => legacyPayment(), "non-issuable context protocol");
    await denied(() => oldReserve(), "non-issuable context protocol");
    await denied(() => asRole("service_role", () => db.query(
      "select public.claim_exact_installment_operation($1,'customer',repeat('a',64),gen_random_uuid())", [a.id])), "not preparing");
    await denied(() => asRole("service_role", () => db.query(
      "select public.create_exact_installment_agreement(gen_random_uuid(),$1,$2,$3::jsonb)",
      [a.id, ids.creator, JSON.stringify(a.terms)])), "booking payment missing");
    expect(await legacyRows(db)).toEqual(before);
  });

  test("v1-first remains functional and blocks v2; unchanged legacy updates remain functional", async () => {
    await pin(); await oldReserve(); const before = await legacyRows(db);
    await denied(() => reserve(), "cannot be adopted");
    expect(await legacyRows(db)).toEqual(before);
    await db.exec("update public.booking_payments set status='link_sent'");
    expect((await db.query("select status from public.booking_payments")).rows).toEqual([{ status: "link_sent" }]);
  });

  test("an unrelated legacy row cannot be reassigned onto a v2-reserved booking", async () => {
    await db.query("insert into public.bookings(id,post_id,creator_id,buyer_id,status) values($1,$2,$3,$4,'booked')",
      [ids.otherBooking, ids.post, ids.creator, ids.buyer]);
    await legacyPayment("pending", ids.otherBooking); await pin(); await reserve();
    await denied(() => db.query("update booking_payments set booking_id=$1 where id=$2", [ids.booking, ids.payment]), "non-issuable context protocol");
  });

  test("pins and reservations cannot update, delete or truncate even through an owner mistake", async () => {
    await pin(); await reserve();
    for (const table of ["exact_installment_context_pin_v2", "exact_installment_context_reservations_v2"]) {
      for (const action of [`update public.${table} set context=context`, `delete from public.${table}`, `truncate public.${table} cascade`]) {
        await denied(() => db.exec(action), "immutable");
      }
    }
    await denied(() => db.exec("update public.exact_installment_context_reservations_v2 set status='active'"), "immutable");
  });

  test("effective ACLs deny every runtime direct write and hide the private pin; only service can read drafts/execute reserve", async () => {
    await pin(); await reserve();
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      for (const table of ["exact_installment_context_pin_v2", "exact_installment_context_reservations_v2"]) {
        for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
          expect((await db.query("select has_table_privilege($1,$2,$3) allowed", [role, `public.${table}`, privilege])).rows).toEqual([{ allowed: false }]);
        }
        expect((await db.query("select has_column_privilege($1,$2,'context','UPDATE') allowed", [role, `public.${table}`])).rows).toEqual([{ allowed: false }]);
        if (role !== "service_role" || table.includes("pin")) {
          await denied(() => asRole(role, () => db.query(`select * from public.${table}`)), "permission denied");
        }
        await denied(() => asRole(role, () => db.exec(`delete from public.${table}`)), "permission denied");
      }
      if (role !== "service_role") await denied(() => asRole(role, () => db.query(
        "select public.reserve_exact_installment_context_v2($1,$2,3,$3::jsonb,$4::jsonb,$5::jsonb)",
        [ids.booking, ids.creator, JSON.stringify(testContext), JSON.stringify(firstFee), JSON.stringify(renewalFee)])), "permission denied");
    }
    expect((await asRole("service_role", () => db.query("select status from public.exact_installment_context_reservations_v2"))).rows)
      .toEqual([{ status: "reserved_not_issuable" }]);
  });
});

describe("LOCAL ONLY forward proposal migration safety", () => {
  let db: PGlite;
  beforeAll(async () => { db = await baseline(); });
  afterAll(async () => { await db?.close(); });
  afterEach(async () => { await db.exec("rollback"); });

  test("installed canonical sources are byte-normalized unchanged and the proposal is outside their inventory", () => {
    for (const [name, expected] of manifest.sources) {
      const source = readFileSync(join(process.cwd(), "supabase/schema", name), "utf8").replace(/\r\n/g, "\n");
      expect(createHash("sha256").update(source).digest("hex")).toBe(expected);
    }
    expect(sql).not.toMatch(/create\s+or\s+replace|alter\s+function|update\s+public\.(?:purchases|booking_payments|exact_installment_agreements)\b/i);
  });
  test("a late assertion failure rolls new objects and the added legacy trigger back, preserving old rows/functions", async () => {
    await db.exec("begin"); await seed(db);
    const before = await legacyRows(db), functions = await oldFunctionCatalog(db);
    const poisoned = sql.replace("-- These assertions execute before the ONLY COMMIT.",
      "grant insert(context) on public.exact_installment_context_pin_v2 to authenticated;\n-- These assertions execute before the ONLY COMMIT.");
    // Strip the proposal's outer BEGIN/COMMIT only for this synthetic rollback
    // fixture, which deliberately retains its seeded rows in an outer savepoint.
    const body = poisoned.slice(poisoned.indexOf("begin;" ) + 6, poisoned.lastIndexOf("commit;"));
    await db.exec("savepoint proposal_case");
    await expect(db.exec(body)).rejects.toThrow("column ACL differs");
    await db.exec("rollback to savepoint proposal_case");
    expect(await legacyRows(db)).toEqual(before); expect(await oldFunctionCatalog(db)).toEqual(functions);
    expect((await db.query("select to_regclass('public.exact_installment_context_pin_v2') value")).rows).toEqual([{ value: null }]);
    expect((await db.query("select count(*)::integer n from pg_trigger where tgname='legacy_payment_context_v2'")).rows).toEqual([{ n: 0 }]);
  });
  test("missing 057 marker, collisions and repeat installation fail before overwriting anything", async () => {
    const preflight = sql.slice(sql.indexOf("do $context_v2_preflight$"), sql.indexOf("-- Structural validation"));
    for (const drift of [
      "alter table public.booking_payments drop constraint booking_payments_installment_collection_version_check",
      "create type public._exact_installment_context_reservations_v2 as (synthetic integer)",
      "create function public.reserve_exact_installment_context_v2() returns integer language sql as 'select 1'",
      "create table public.exact_installment_context_pin_v2(synthetic integer)",
    ]) {
      await db.exec(`begin; ${drift}`);
      await expect(db.exec(preflight)).rejects.toThrow(/prerequisite|collision/);
      await db.exec("rollback");
    }
    await db.exec("begin");
    const body = sql.slice(sql.indexOf("begin;") + 6, sql.lastIndexOf("commit;"));
    await db.exec(body); const functions = await oldFunctionCatalog(db);
    await db.exec("savepoint replay_case");
    await expect(db.exec(preflight)).rejects.toThrow("collision");
    await db.exec("rollback to savepoint replay_case");
    expect(await oldFunctionCatalog(db)).toEqual(functions);
  });
  test("pin read attestation overload collision is refused before installation", async () => {
    const preflight = sql.slice(sql.indexOf("do $context_v2_preflight$"), sql.indexOf("-- Structural validation"));
    await db.exec("begin; create function public.read_exact_installment_context_pin_v2(integer) returns integer language sql as 'select 1'");
    const before = await oldFunctionCatalog(db);
    await expect(db.exec(preflight)).rejects.toThrow("collision");
    await db.exec("rollback");
    expect(await oldFunctionCatalog(db)).toEqual(before);
    expect((await db.query("select to_regclass('public.exact_installment_context_pin_v2') value")).rows).toEqual([{ value: null }]);
  });
  test("REPEATABLE READ admission is explicitly rejected, not mistaken for a fresh cross-table lock proof", async () => {
    await db.exec("begin");
    const body = sql.slice(sql.indexOf("begin;") + 6, sql.lastIndexOf("commit;"));
    await db.exec(body); await db.exec("commit");
    await db.exec("begin isolation level repeatable read");
    await expect(db.query("select public.reserve_exact_installment_context_v2($1,$2,3,$3::jsonb,$4::jsonb,$5::jsonb)",
      [ids.booking, ids.creator, JSON.stringify(testContext), JSON.stringify(firstFee), JSON.stringify(renewalFee)]))
      .rejects.toThrow("Invalid context reservation");
    await db.exec("rollback; begin isolation level repeatable read");
    await expect(db.query(`insert into public.booking_payments(id,booking_id,plan_type,status,currency)
      values($1,$2,'full','pending','usd')`, [ids.payment, ids.booking])).rejects.toThrow("READ COMMITTED");
  });
});
