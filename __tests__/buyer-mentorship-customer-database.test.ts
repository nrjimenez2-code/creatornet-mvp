/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = { version: "exact-payment-context-v1", mode: "test", platformAccountId: "acct_test",
  supabaseProjectRef: "abcdefghijklmnopqrst", siteOrigin: "https://fixture.vercel.app" };
const metadata = { creatornet_installment_version: "buyer-mentorship-installments-v1", creatornet_installment_reservation_id: id(1),
  creatornet_installment_request_id: id(2), buyer_id: id(3), creator_id: id(4), product_id: id(5), post_id: id(6),
  terms_fingerprint: "a".repeat(64), operation_kind: "customer.create", payment_mode: "test", platform_account_id: "acct_test",
  supabase_project_ref: context.supabaseProjectRef, site_origin: context.siteOrigin };
type Operation = { reservation_id: string; request: { metadata: typeof metadata }; idempotency_key: string;
  lease_token: string; lease_until: string | null; first_dispatch_at: string; customer_id: string | null; provider_request_id: string | null; bound_at: string | null };
type Claim = { status: string; operation: Operation; dispatch_before?: string };
async function claim(buyer = id(3), ctx = context): Promise<Claim> {
  return (await db.query<{ result: Claim }>("select claim_buyer_mentorship_customer_v1($1,$2,$3) result", [id(2), buyer, ctx])).rows[0].result;
}
async function bind(c: Claim, changed: Record<string, unknown> = {}, token = c.operation.lease_token) {
  const customer = { id: "cus_fixture", object: "customer", created: Math.floor(Date.parse(c.operation.first_dispatch_at) / 1000),
    livemode: false, metadata, test_clock: null, ...changed };
  return (await db.query<{ result: Operation }>("select bind_buyer_mentorship_customer_v1($1,$2,$3,$4,$5,$6) result",
    [id(2), id(3), context, token, customer, "req_fixture"])).rows[0].result;
}
beforeAll(async () => {
  db = createLocalPostgres();
  // The service role mirrors hosted BYPASSRLS but has SELECT-only access to
  // accepted reservations. Customer RPCs must not require parent UPDATE grants.
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table buyer_mentorship_installment_reservations_v1(id uuid primary key,request_id uuid unique,buyer_id uuid,
      creator_id uuid,product_id uuid,post_id uuid,context jsonb,fingerprint text,status text);
    alter table buyer_mentorship_installment_reservations_v1 enable row level security;
    grant select on buyer_mentorship_installment_reservations_v1 to service_role;`);
  await db.exec(readFileSync("supabase/migrations/20260921021558_buyer_mentorship_customer_operations.sql", "utf8"));
});
beforeEach(async () => {
  await db.exec("begin");
  await db.query("insert into buyer_mentorship_installment_reservations_v1 values($1,$2,$3,$4,$5,$6,$7,$8,'reserved')",
    [id(1), id(2), id(3), id(4), id(5), id(6), context, "a".repeat(64)]);
  await db.exec("set local role service_role");
});
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db.close(); });
test("first claim persists original metadata/key before allowing dispatch and a concurrent claim is busy", async () => {
  const c = await claim(); expect(c.status).toBe("dispatch"); expect(c.operation.request).toEqual({ metadata });
  expect(c.operation.request.metadata).not.toHaveProperty("booking_id");
  expect(Date.parse(c.dispatch_before!) - Date.parse(c.operation.first_dispatch_at)).toBeLessThanOrEqual(30000);
  const second = await claim(); expect(second.status).toBe("busy"); expect(second.operation).toEqual(c.operation);
});
test("expired lease retries the same operation and key, not a replacement customer request", async () => {
  const first = await claim();
  await db.exec("update buyer_mentorship_customer_operations_v1 set lease_until=now()-interval '1 second'");
  const second = await claim(); expect(second.status).toBe("dispatch");
  expect(second.operation.idempotency_key).toBe(first.operation.idempotency_key);
  expect(second.operation.request).toEqual(first.operation.request);
  expect(second.operation.first_dispatch_at).toBe(first.operation.first_dispatch_at);
  expect(second.operation.lease_token).not.toBe(first.operation.lease_token);
});
test("old uncertain operations require review before the provider idempotency retention boundary", async () => {
  await db.query("insert into buyer_mentorship_customer_operations_v1(reservation_id,request,first_dispatch_at) values($1,$2,now()-interval '23 hours')", [id(1), { metadata }]);
  expect((await claim()).status).toBe("review_required");
});
test("verified original customer binds once and subsequent claims return its identity", async () => {
  const c = await claim(); const bound = await bind(c);
  expect(bound.customer_id).toBe("cus_fixture"); expect(bound.lease_until).toBeNull();
  expect((await claim()).status).toBe("bound"); expect(await bind(c)).toEqual(bound);
});
test.each([{ metadata: { ...metadata, buyer_id: id(9) } }, { livemode: true }, { test_clock: "clock_other" },
  { deleted: true }, { object: "payment_intent" }, { id: "cus_wrong-id" }, { created: 1 }])("binding rejects foreign or invalid provider proof %p", async changed => {
  const c = await claim(); await expect(bind(c, changed)).rejects.toThrow("original provider proof");
});
test("stale lease token cannot bind after another worker claims the operation", async () => {
  const old = await claim(); await db.exec("update buyer_mentorship_customer_operations_v1 set lease_until=now()-interval '1 second'");
  await claim(); await expect(bind(old)).rejects.toThrow("original provider proof");
});
test("foreign buyer cannot claim accepted reservation", async () => {
  await expect(claim(id(9))).rejects.toThrow("Owned customer reservation unavailable");
});
test("foreign payment context cannot claim accepted reservation", async () => {
  await expect(claim(id(3), { ...context, platformAccountId: "acct_other" })).rejects.toThrow("Owned customer reservation unavailable");
});
test.each(["request='{}'", "idempotency_key='replacement'", "first_dispatch_at=now()-interval '2 days'"])("original operation field is immutable: %s", async update => {
  await claim(); await expect(db.exec(`update buyer_mentorship_customer_operations_v1 set ${update}`)).rejects.toThrow("immutable");
});
test("bound customer cannot be replaced", async () => {
  const c = await claim(); await bind(c);
  await expect(bind(c, { id: "cus_other" })).rejects.toThrow("different object");
});
test("public roles cannot execute customer operations and functions do not bypass RLS", async () => {
  const result = await db.query(`select prosecdef,has_function_privilege('anon',oid,'execute') anon,
    has_function_privilege('authenticated',oid,'execute') authenticated from pg_proc
    where oid='public.claim_buyer_mentorship_customer_v1(uuid,uuid,jsonb)'::regprocedure`);
  expect(result.rows).toEqual([{ prosecdef: false, anon: false, authenticated: false }]);
  expect((await db.query("select has_table_privilege('service_role','buyer_mentorship_installment_reservations_v1','UPDATE') writable")).rows)
    .toEqual([{ writable: false }]);
});
