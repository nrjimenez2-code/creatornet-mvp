/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const context = { mode: "test", stripeAccountId: "acct_fixture", apiVersion: "2025-10-29.clover",
  supabaseProjectRef: "nwqfofezfzljhxolkycz", siteOrigin: "https://fixture.vercel.app" };
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function snapshot() {
  return (await db.query<{ result: Record<string, any> }>("select read_monthly_mentorship_billing_backlog_v1($1) result", [context])).rows[0].result;
}
async function addAgreement(n = 1, ctx = context) {
  await db.query(`insert into monthly_mentorship_agreements_v1(id,buyer_id,creator_id,terms,covered_months,anchor_at,minimum_months,auto_renew,billing_next_attempt_at)
    values($1,$2,$3,$4,1,extract(epoch from now()-interval '2 months')::bigint,3,true,now()-interval '3 months')`,
    [id(n), id(90), id(91), { paymentContext: ctx }]);
}
async function addExit(n: number, agreement = 1, kind = "stop_renewal") {
  await db.query(`insert into monthly_mentorship_exit_requests_v1(id,agreement_id,kind,status,provider_next_attempt_at,requested_at)
    values($1,$2,$3,'requested',now()-interval '1 hour',now()-interval '1 hour')`, [id(n), id(agreement), kind]);
}
beforeAll(async () => {
  db = createLocalPostgres();
  // Focused structural baseline, no hosted state or production credentials.
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table monthly_mentorship_agreements_v1(id uuid primary key,buyer_id uuid,creator_id uuid,terms jsonb,covered_months integer,
      anchor_at bigint,minimum_months integer,auto_renew boolean,billing_next_attempt_at timestamptz,billing_lease_until timestamptz,
      billing_review_at timestamptz,payoff_hold_at timestamptz,financial_hold_at timestamptz,renewal_stopped_at timestamptz,
      debit_revoked_at timestamptz,billing_worker_status text,billing_work_token uuid,billing_last_attempt_at timestamptz);
    create table monthly_mentorship_operations_v1(agreement_id uuid,kind text,status text,scope_key text);
    create table monthly_mentorship_exit_requests_v1(id uuid primary key,agreement_id uuid,kind text,status text,
      provider_next_attempt_at timestamptz,provider_lease_until timestamptz,provider_worker_status text,requested_at timestamptz,
      provider_work_token uuid,provider_last_attempt_at timestamptz,provider_worker_attempts integer default 0);`);
  // Install the actual boundary and worker functions to compare eligibility.
  for (const [path, name] of [
    ["078-monthly-mentorship-receipts.sql", "create function public.monthly_mentorship_boundary_v1("],
    ["085-monthly-mentorship-lifecycle.sql", "create or replace function public.lease_monthly_mentorship_work_v1("],
    ["087-monthly-mentorship-management.sql", "create function public.lease_monthly_mentorship_exit_work_v1("],
  ]) {
    const text = readFileSync(`supabase/proposals/${path}`, "utf8"), start = text.indexOf(name);
    expect(start).toBeGreaterThanOrEqual(0);
    await db.exec(text.slice(start, text.indexOf("$$;", start) + 3));
  }
  await db.exec(readFileSync("supabase/migrations/20260921015419_mentorship_billing_backlog.sql", "utf8"));
});
beforeEach(async () => { await db.exec("begin"); await addAgreement(); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db.close(); });
test("global totals include all 30 agreements instead of only a 25-row page", async () => {
  for (let n = 2; n <= 30; n++) await addAgreement(n);
  const result = await snapshot();
  expect(result.agreementCount).toBe(30); expect(result.billingDueCount).toBe(30);
  expect(result.exitDueCount).toBe(0); expect(result.exitOldestDueAt).toBeNull();
});
test("strict context equality excludes foreign and extended-context records", async () => {
  await addAgreement(2, { ...context, mode: "live" });
  await db.query("insert into monthly_mentorship_agreements_v1(id,terms) values($1,$2)", [id(3), { paymentContext: { ...context, extra: "invalid" } }]);
  expect((await snapshot()).agreementCount).toBe(1);
});
test.each(["billing_review_at", "payoff_hold_at", "financial_hold_at", "renewal_stopped_at", "debit_revoked_at"])("%s excludes collection work", async field => {
  await db.exec(`update monthly_mentorship_agreements_v1 set ${field}=now()`);
  expect((await snapshot()).billingDueCount).toBe(0);
});
test("unfunded and future-leased agreements cannot inflate due work", async () => {
  await db.exec("update monthly_mentorship_agreements_v1 set covered_months=0");
  expect((await snapshot()).billingDueCount).toBe(0);
  await db.exec("update monthly_mentorship_agreements_v1 set covered_months=1,billing_lease_until=now()+interval '1 hour'");
  expect(await snapshot()).toMatchObject({ billingDueCount: 0, billingLeasedCount: 1 });
});
test("oldest activated renewal uses the later service boundary, not an obsolete poll date", async () => {
  await db.query("insert into monthly_mentorship_operations_v1 values($1,'activate','complete','initial')", [id(1)]);
  const result = await snapshot();
  const boundary = (await db.query<{ epoch: string }>("select monthly_mentorship_boundary_v1(anchor_at,covered_months)::text epoch from monthly_mentorship_agreements_v1")).rows[0].epoch;
  expect(Date.parse(result.billingOldestDueAt) / 1000).toBe(Number(boundary));
});
test("completed minimum without auto-renew is excluded after activation", async () => {
  await db.query("insert into monthly_mentorship_operations_v1 values($1,'activate','complete','initial')", [id(1)]);
  await db.exec("update monthly_mentorship_agreements_v1 set auto_renew=false,minimum_months=1");
  expect((await snapshot()).billingDueCount).toBe(0);
});
test("billing summary eligibility agrees with the actual leasing function and does not mutate leases", async () => {
  expect((await snapshot()).billingDueCount).toBe(1);
  const leased = (await db.query<{ work: unknown[] }>("select lease_monthly_mentorship_work_v1($1,6) work", [context])).rows[0].work;
  expect(leased).toHaveLength(1);
  expect(await snapshot()).toMatchObject({ billingDueCount: 0, billingLeasedCount: 1 });
});
test("a sibling active exit lease excludes the agreement's other due exit requests", async () => {
  await db.exec("update monthly_mentorship_agreements_v1 set renewal_stopped_at=now(),debit_revoked_at=now()");
  await addExit(40); await addExit(41, 1, "revoke_debits");
  expect((await snapshot()).exitDueCount).toBe(2);
  const leased = (await db.query<{ work: unknown[] }>("select lease_monthly_mentorship_exit_work_v1($1,6) work", [context])).rows[0].work;
  expect(leased).toHaveLength(1);
  expect(await snapshot()).toMatchObject({ exitDueCount: 0, exitLeasedCount: 1 });
});
test("completed provider stops are excluded from due/retry/review backlog", async () => {
  await db.exec("update monthly_mentorship_agreements_v1 set renewal_stopped_at=now()"); await addExit(40);
  await db.exec("update monthly_mentorship_exit_requests_v1 set status='provider_stopped',provider_worker_status='retry_required'");
  expect(await snapshot()).toMatchObject({ exitCount: 1, exitDueCount: 0, exitRetryCount: 0, exitReviewCount: 0 });
});
test("aggregate stays SECURITY INVOKER and inaccessible to public roles", async () => {
  const result = await db.query(`select prosecdef,has_function_privilege('anon',oid,'execute') anon,
    has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service
    from pg_proc where oid='public.read_monthly_mentorship_billing_backlog_v1(jsonb)'::regprocedure`);
  expect(result.rows).toEqual([{ prosecdef: false, anon: false, authenticated: false, service: true }]);
});
