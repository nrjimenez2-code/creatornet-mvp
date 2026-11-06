import type { SupabaseClient } from "@supabase/supabase-js";
const mockContext = { apiVersion: "2025-10-29.clover", mode: "test", stripeAccountId: "acct_fixture",
  supabaseProjectRef: "nwqfofezfzljhxolkycz", siteOrigin: "https://fixture.vercel.app" };
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => mockContext }));
import { readMembershipAdminPage } from "@/lib/membershipAdmin";
const env = Object.fromEntries(["ADMIN", "LEDGER_SCHEMA", "WORKER_SCHEMA", "LIFECYCLE_SCHEMA", "PAYOFF_SCHEMA", "MANAGEMENT_SCHEMA"]
  .map(name => [`CREATOR_MONTHLY_MENTORSHIPS_${name}_READY`, "true"]));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n = 1) => ({ id: id(n), title: "Mentorship", payment_context: mockContext, monthly_price_cents: 10000,
  covered_months: 1, minimum_months: 3, auto_renew: true, billing_worker_status: "retry_required",
  billing_next_attempt_at: "infinity", billing_last_attempt_at: null, billing_lease_until: null,
  billing_review_at: "2026-09-21T00:00:00Z", financial_hold_at: null, payoff_hold_at: null,
  renewal_stopped_at: null, debit_revoked_at: "2026-09-21T00:00:00Z", secret: "must-not-leak" });
function database(agreements: unknown[] = [row()], exits: unknown[] = [], error: unknown = null) {
  const builder = (data: unknown[], queryError: unknown = null) => {
    const q = { select: jest.fn(), contains: jest.fn(), order: jest.fn(), limit: jest.fn(), gt: jest.fn(), in: jest.fn(),
      returns: jest.fn().mockResolvedValue({ data, error: queryError }) };
    [q.select, q.contains, q.order, q.limit, q.gt, q.in].forEach(fn => fn.mockReturnValue(q));
    return q;
  };
  const agreementsQuery = builder(agreements, error), exitsQuery = builder(exits);
  const from = jest.fn((table: string) => table === "monthly_mentorship_agreements_v1" ? agreementsQuery : exitsQuery);
  return { admin: { from } as unknown as SupabaseClient, from, agreementsQuery, exitsQuery };
}
test("review scopes both queries and omits private provider data while retaining holds", async () => {
  const db = database([row()], [{ id: id(90), agreement_id: id(1), kind: "revoke_debits", status: "review_required",
    provider_worker_status: "provider_review_required", provider_next_attempt_at: "infinity", requested_at: "2026-09-21T00:00:00Z",
    provider_last_attempt_at: null, provider_proof: "private-proof" }]);
  const result = await readMembershipAdminPage(db.admin, null, env);
  expect(db.agreementsQuery.contains).toHaveBeenCalledWith("terms", { paymentContext: mockContext });
  expect(db.exitsQuery.in).toHaveBeenCalledWith("agreement_id", [id(1)]);
  expect(result.memberships[0].holds).toEqual(["Billing review", "Automatic debits revoked"]);
  expect(result.memberships[0].exits[0].status).toBe("review_required");
  expect(JSON.stringify(result)).not.toMatch(/must-not-leak|private-proof|payment_context/);
});
test("pagination uses a stable bounded cursor without skipping the extra record", async () => {
  const db = database(Array.from({ length: 26 }, (_, i) => row(i + 2)));
  const result = await readMembershipAdminPage(db.admin, id(1), env);
  expect(db.agreementsQuery.gt).toHaveBeenCalledWith("id", id(1));
  expect(db.agreementsQuery.limit).toHaveBeenCalledWith(26);
  expect(result.memberships).toHaveLength(25);
  expect(result.nextCursor).toBe(id(26));
  expect(db.exitsQuery.in.mock.calls[0][1]).not.toContain(id(27));
});
test.each(["not-an-id", "x),or(id.gt.0)"])("rejects invalid cursor %s before database access", async cursor => {
  const db = database();
  await expect(readMembershipAdminPage(db.admin, cursor, env)).rejects.toThrow();
  expect(db.from).not.toHaveBeenCalled();
});
test("disabled review never reads finance tables", async () => {
  const db = database();
  await expect(readMembershipAdminPage(db.admin, null, {})).rejects.toThrow();
  expect(db.from).not.toHaveBeenCalled();
});
test("a query error cannot masquerade as an empty healthy queue", async () => {
  const db = database([], [], { message: "private database error" });
  await expect(readMembershipAdminPage(db.admin, null, env)).rejects.toThrow("Monthly review query failed");
});
test("wrong-context records fail closed even if the query unexpectedly returns them", async () => {
  const db = database([{ ...row(), payment_context: { ...mockContext, mode: "live" } }]);
  await expect(readMembershipAdminPage(db.admin, null, env)).rejects.toThrow("context differs");
  expect(db.exitsQuery.returns).not.toHaveBeenCalled();
});
test("an exit belonging to another agreement is never exposed", async () => {
  const db = database([row()], [{ id: id(90), agreement_id: id(2) }]);
  await expect(readMembershipAdminPage(db.admin, null, env)).rejects.toThrow("exits query failed");
});
test("an empty page does not query unscoped exits", async () => {
  const db = database([]);
  expect((await readMembershipAdminPage(db.admin, null, env)).memberships).toEqual([]);
  expect(db.from).toHaveBeenCalledTimes(1);
});
