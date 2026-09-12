import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BOOTSTRAP_STAGES, createMembershipCheckoutRecovery, membershipCheckoutRecoveryReady, type BootstrapKind, type BootstrapOperation } from "@/lib/membershipCheckoutRecovery";
import { checkoutRecoveryFixture } from "../test-support/membership-checkout-recovery-fixtures";
import { membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
function harness(paid = false, ageSeconds = 60) {
  const f = checkoutRecoveryFixture(paid, ageSeconds), env = { ...membershipTestEnv };
  let rows = f.ops, failSave = false;
  const response = <T,>(value: T) => Object.assign(value as T & object, { lastResponse: { apiVersion: context.apiVersion, requestId: "req_recovery" } });
  const rpc = jest.fn(async (name: string, params: Record<string, unknown>) => {
    if (failSave) return { data: null, error: Error("Synthetic private persistence detail") };
    if (name === "reconcile_monthly_mentorship_bootstrap_v1") {
      const op = rows.find(row => row.id === params.p_operation_id)!; op.status = "complete";
      op.provider_id = (params.p_proof as { objectId: string }).objectId; return { data: true, error: null };
    }
    if (name === "publish_monthly_mentorship_recovery_v1") {
      f.a.stripe_customer_id = f.ids.customer; f.a.stripe_subscription_id = f.ids.subscription; f.a.stripe_checkout_session_id = f.ids.checkout;
      f.a.revision++; return { data: true, error: null };
    }
    throw Error("Unexpected recovery RPC " + name);
  });
  type Query = { select: () => Query; eq: () => Query; in: () => Query; limit: () => Promise<{ data: BootstrapOperation[]; error: null }> };
  const query: Query = { select: () => query, eq: () => query, in: () => query, limit: async () => ({ data: rows.map(o => ({ ...o })), error: null }) };
  const from = jest.fn(() => query);
  const stripe = {
    customers: { search: jest.fn(async () => response({ data: [f.customer], has_more: false })), retrieve: jest.fn(async () => response(f.customer)), create: jest.fn() },
    products: { search: jest.fn(async () => response({ data: [f.product], has_more: false })), retrieve: jest.fn(async () => response(f.product)), create: jest.fn() },
    subscriptions: { list: jest.fn(async () => response({ data: [f.subscription], has_more: false })), retrieve: jest.fn(async () => response(f.subscription)), create: jest.fn(), update: jest.fn(), cancel: jest.fn() },
    checkout: { sessions: { list: jest.fn(async () => response({ data: [f.session], has_more: false })), retrieve: jest.fn(async () => response(f.session)), create: jest.fn() } },
  };
  const prepare = jest.fn(async () => ({ membershipId: f.a.id, url: "https://checkout.stripe.com/c/pay/original" }));
  const confirmFirst = jest.fn(async () => ({ membershipId: f.a.id, firstPaymentRecorded: true, accessGranted: true, paidThrough: "2026-10-01T00:00:00.000Z" }));
  const observeContext = jest.fn(async () => context), load = jest.fn(async () => ({ ...f.a }));
  const runtime = createMembershipCheckoutRecovery({ admin: { from, rpc } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe,
    context, env, load, observeContext, checked: async <T,>(value: Promise<Stripe.Response<T>>) => value, productId: async () => f.product.id }, { prepare, confirmFirst });
  const recover = () => runtime.reconcileFirstCheckout(f.a.id, f.a.buyer_id);
  const unresolved = (kind: BootstrapKind) => { const op = rows.find(row => row.kind === kind)!; op.status = "review_required"; op.provider_id = null; return op; };
  return { f, env, rows, rpc, from, stripe, prepare, confirmFirst, observeContext, load, runtime, recover, unresolved,
    response, setRows: (value: BootstrapOperation[]) => { rows = value; }, saveFailure: () => { failSave = true; } };
}
function noProviderWrites(h: ReturnType<typeof harness>) {
  for (const method of [h.stripe.customers.create, h.stripe.products.create, h.stripe.subscriptions.create,
    h.stripe.subscriptions.update, h.stripe.subscriptions.cancel, h.stripe.checkout.sessions.create]) expect(method).not.toHaveBeenCalled();
}
test.each(BOOTSTRAP_STAGES)("steps 1/8: a positively observed late %s result reconnects its original operation without new provider writes", async kind => {
  const h = harness(false, 21 * 3600), op = h.unresolved(kind), accepted = h.f.a.accepted_at, original = op.dispatched_at;
  expect(await h.recover()).toMatchObject({ membershipId: h.f.a.id, status: "checkout_open", canResume: true, completedStages: 5, firstPaymentRecorded: false });
  expect(h.rpc).toHaveBeenCalledWith("reconcile_monthly_mentorship_bootstrap_v1", expect.objectContaining({ p_operation_id: op.id,
    p_buyer_id: h.f.a.buyer_id, p_request: h.f.requests[kind], p_context: context,
    p_proof: expect.objectContaining({ objectId: h.f.ids[kind], kind, operationId: op.id, requestId: "req_recovery" }) }));
  expect(h.f.a.accepted_at).toBe(accepted); expect(op.dispatched_at).toBe(original); expect(h.confirmFirst).not.toHaveBeenCalled(); noProviderWrites(h);
});
test("step 8: a captured unbound checkout is published then routed to the existing first-payment receipt path", async () => {
  const h = harness(true, 72 * 3600); h.unresolved("checkout");
  expect(await h.recover()).toMatchObject({ status: "paid", firstPaymentRecorded: true, accessGranted: true });
  expect(h.confirmFirst).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id);
  expect(h.rpc.mock.invocationCallOrder.at(-1)!).toBeLessThan(h.confirmFirst.mock.invocationCallOrder[0]); noProviderWrites(h);
});
test("step 2: a stop racing an unpublished capture is preserved while captured-money recovery proceeds", async () => {
  const h = harness(true); h.f.a.debit_revoked_at = new Date().toISOString(); h.f.a.renewal_stopped_at = new Date().toISOString();
  const before = h.f.a.debit_revoked_at;
  expect((await h.recover()).status).toBe("paid"); expect(h.f.a.debit_revoked_at).toBe(before); expect(h.prepare).not.toHaveBeenCalled(); noProviderWrites(h);
});
test("step 10: new billing pause preserves paid recovery but never exposes a payable checkout", async () => {
  const h = harness(true); h.env.CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY = "false";
  expect(membershipCheckoutRecoveryReady(h.env)).toBe(true); expect((await h.recover()).status).toBe("paid");
  h.f.session.status = "open"; h.f.session.payment_status = "unpaid";
  expect(await h.recover()).toMatchObject({ status: "review_required", canResume: false }); expect(h.prepare).not.toHaveBeenCalled();
});
test.each(["CHECKOUT_RECOVERY_READY", "CHECKOUT_RECOVERY_SCHEMA_READY", "EVENTS_READY"])("step 10: missing %s prevents provider and journal work", async flag => {
  const h = harness(); h.env["CREATOR_MONTHLY_MENTORSHIPS_" + flag] = "false";
  await expect(h.recover()).rejects.toThrow("not enabled"); expect(h.load).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
});
test("step 8: an empty search after key expiry is not treated as permission to recreate a customer", async () => {
  const h = harness(false, 21 * 3600); h.unresolved("customer");
  h.stripe.customers.search.mockResolvedValueOnce(h.response({ data: [], has_more: false }));
  expect(await h.recover()).toMatchObject({ status: "review_required", canResume: false, completedStages: 0 });
  expect(h.rpc).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled(); noProviderWrites(h);
});
test("step 8: recent unseen result can only resume through the original journal-backed prepare path after explicit confirmation", async () => {
  const h = harness(), op = h.unresolved("customer"); op.status = "dispatched";
  h.stripe.customers.search.mockResolvedValue(h.response({ data: [], has_more: false }));
  expect(await h.recover()).toMatchObject({ status: "resumable", canResume: true });
  await expect(h.runtime.resumeFirstCheckout(h.f.a.id, h.f.a.buyer_id, false)).rejects.toThrow("Explicit");
  expect(h.prepare).not.toHaveBeenCalled();
  expect((await h.runtime.resumeFirstCheckout(h.f.a.id, h.f.a.buyer_id, true)).url).toBe("https://checkout.stripe.com/c/pay/original");
  expect(h.prepare).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id); expect(h.rpc).not.toHaveBeenCalled(); noProviderWrites(h);
});
test.each(["pagination", "duplicates"])("step 8: %s never authorizes resumption of an ambiguous provider result", async state => {
  const h = harness(); h.unresolved("customer");
  h.stripe.customers.search.mockResolvedValueOnce(h.response({ data: state === "duplicates" ? [h.f.customer, { ...h.f.customer, id: "cus_duplicate" }] : [h.f.customer], has_more: state === "pagination" }));
  expect(await h.recover()).toMatchObject({ status: "review_required", canResume: false }); expect(h.rpc).not.toHaveBeenCalled(); noProviderWrites(h);
});
test.each(["metadata", "amount", "destination"])("step 8: changed recovered checkout %s cannot be published", async field => {
  const h = harness(); h.unresolved("checkout");
  if (field === "metadata") h.f.session.metadata!.buyer_id = "foreign";
  if (field === "amount") h.f.session.amount_total = 1;
  if (field === "destination") h.f.session.metadata!.creator_stripe_account_id = "acct_other";
  expect((await h.recover()).status).toBe("review_required"); expect(h.rpc).not.toHaveBeenCalled(); expect(h.confirmFirst).not.toHaveBeenCalled();
});
test("step 5: a fresh provider retrieval must retain the searched object identity", async () => {
  const h = harness(); h.unresolved("customer"); h.stripe.customers.retrieve.mockResolvedValueOnce(h.response({ ...h.f.customer, id: "cus_foreign" }));
  expect((await h.recover()).status).toBe("review_required"); expect(h.rpc).not.toHaveBeenCalled();
});
test("step 8: a saved operation with changed accepted parameters is not reconciled", async () => {
  const h = harness(); h.f.ops[0].request = { ...h.f.ops[0].request, params: { changed: true } };
  expect((await h.recover()).status).toBe("review_required"); expect(h.stripe.customers.search).not.toHaveBeenCalled();
});
test("step 8: missing predecessor with later operations cannot be treated as an unstarted purchase", async () => {
  const h = harness(); h.setRows(h.rows.slice(1)); expect(await h.recover()).toMatchObject({ status: "review_required", canResume: false }); expect(h.prepare).not.toHaveBeenCalled();
});
test("step 1: original acceptance with no started operations remains resumable only inside its original window", async () => {
  const h = harness(); h.setRows([]); expect(await h.recover()).toMatchObject({ status: "resumable", canResume: true });
  h.f.a.accepted_at = "2000-01-01T00:00:00Z"; expect(await h.recover()).toMatchObject({ status: "review_required", canResume: false }); noProviderWrites(h);
});
test("step 8: an expired unpaid checkout does not become a replacement payment or a receipt", async () => {
  const h = harness(false, 25 * 3600); h.f.session.status = "expired";
  expect(await h.recover()).toMatchObject({ status: "expired_unpaid", canResume: false, firstPaymentRecorded: false });
  expect(h.confirmFirst).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled(); noProviderWrites(h);
});
test("step 8: complete but unpaid checkout stays pending and never grants access", async () => {
  const h = harness(); h.f.session.status = "complete";
  expect(await h.recover()).toMatchObject({ status: "payment_pending", firstPaymentRecorded: false, accessGranted: false });
  expect(h.confirmFirst).not.toHaveBeenCalled(); noProviderWrites(h);
});
test("step 8: failed durable recovery proof remains retryable, not falsely published", async () => {
  const h = harness(); h.unresolved("checkout"); h.saveFailure();
  await expect(h.recover()).rejects.toThrow("proof needs retry"); expect(h.confirmFirst).not.toHaveBeenCalled(); expect(h.f.a.stripe_subscription_id).toBeNull();
});
test("step 5: malformed or oversized journal projection is rejected", async () => {
  const h = harness(); h.setRows([...h.rows, { ...h.rows[0] }]); await expect(h.recover()).rejects.toThrow("journal unavailable");
  expect(h.rpc).not.toHaveBeenCalled();
});
test.each(["javascript:alert(1)", "https://unrelated.example.invalid/charge"])("step 5: unsafe resumption URL %s is rejected", async url => {
  const h = harness(); h.prepare.mockResolvedValueOnce({ membershipId: h.f.a.id, url });
  await expect(h.runtime.resumeFirstCheckout(h.f.a.id, h.f.a.buyer_id, true)).rejects.toThrow("destination");
});
