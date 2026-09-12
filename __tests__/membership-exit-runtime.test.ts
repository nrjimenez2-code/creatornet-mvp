import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipExitRuntime, membershipExitReady } from "@/lib/membershipExit";
import { membershipFixture, membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
function harness() {
  const f = membershipFixture(true), trace: string[] = [];
  const env: Record<string, string | undefined> = { ...membershipTestEnv,
    CREATOR_MONTHLY_MENTORSHIPS_EXIT_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_EXIT_READY: "true" };
  const row = { id: "19000000-0000-4000-8000-000000000001", agreement_id: f.a.id, buyer_id: f.a.buyer_id,
    kind: "stop_renewal", status: "requested" };
  const quote = { version: "monthly-exit-quote-v1", membershipId: f.a.id, agreementFingerprint: f.a.fingerprint, revision: f.a.revision, reviewReasons: [] };
  let admission = "dispatching", savedError = false, missing = false;
  type SavedQuery = { select: () => SavedQuery; eq: () => SavedQuery; maybeSingle: () => Promise<{ data: typeof row | null; error: null }> };
  const query: SavedQuery = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: missing ? null : row, error: null }) };
  const rpc = jest.fn(async (name: string, params: Record<string, unknown>) => {
    trace.push(name);
    if (name === "read_monthly_mentorship_exit_quote_v1") return { data: quote, error: null };
    if (name === "request_monthly_mentorship_exit_v1") return { data: { ...row, kind: params.p_kind }, error: null };
    if (name === "claim_monthly_mentorship_exit_stop_v1") return { data: { ...row, status: admission }, error: null };
    return { data: true, error: savedError ? Error("Synthetic persistence error") : null };
  });
  const response = () => Object.assign(f.subscription, { lastResponse: { requestId: "req_stop", apiVersion: context.apiVersion } });
  const retrieve = jest.fn(async () => { trace.push("retrieve"); return response(); });
  const cancel = jest.fn(async () => { trace.push("cancel"); f.subscription.status = "canceled"; return response(); });
  const load = jest.fn(async () => f.a), observeContext = jest.fn(async () => { trace.push("context"); return context; });
  const runtime = createMembershipExitRuntime({ admin: { rpc, from: () => query } as unknown as SupabaseClient,
    stripe: { subscriptions: { retrieve, cancel } } as unknown as Stripe, context, env, load, observeContext,
    productId: async () => "prod_fixture", checked: async <T>(p: Promise<Stripe.Response<T>>) => p });
  return { f, env, row, quote, rpc, retrieve, cancel, load, observeContext, trace, runtime,
    review: () => { admission = "review_required"; }, saveFailure: () => { savedError = true; }, missing: () => { missing = true; } };
}
test("step 2: stop is durable before provider calls and cancellation cannot invoice or prorate", async () => {
  const h = harness(); expect(await h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "stop_renewal", true, h.quote))
    .toMatchObject({ providerStopped: true, billingBlocked: true, balanceWaived: false });
  expect(h.trace.indexOf("request_monthly_mentorship_exit_v1")).toBeLessThan(h.trace.indexOf("retrieve"));
  expect(h.cancel).toHaveBeenCalledWith(h.f.a.stripe_subscription_id, { invoice_now: false, prorate: false },
    { idempotencyKey: `creatornet-membership-exit:${h.row.id}`, maxNetworkRetries: 0 });
});
test("step 2: separate debit revocation has no payoff quote or debit instruction", async () => {
  const h = harness(); await h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "revoke_debits", true);
  expect(h.rpc).toHaveBeenCalledWith("request_monthly_mentorship_exit_v1", expect.objectContaining({ p_kind: "revoke_debits", p_quote: null }));
});
test("step 10: disabling new billing does not disable the existing buyer's exit", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY = "false";
  expect(membershipExitReady(h.env)).toBe(true); expect((await h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "revoke_debits", true)).providerStopped).toBe(true);
});
test("step 10: default-off exit gates prevent any database or provider work", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_EXIT_SCHEMA_READY = "false";
  await expect(h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "stop_renewal", true)).rejects.toThrow("not enabled");
  expect(h.load).not.toHaveBeenCalled(); expect(h.cancel).not.toHaveBeenCalled();
});
test("step 4: absence of explicit confirmation cannot stop billing", async () => {
  const h = harness(); await expect(h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "stop_renewal", false)).rejects.toThrow("confirmation");
  expect(h.rpc).not.toHaveBeenCalled();
});
test("step 8: provider failure retains the durable billing block without claiming provider completion", async () => {
  const h = harness(); h.cancel.mockRejectedValueOnce(Error("Synthetic transport failure"));
  expect(await h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "stop_renewal", true, h.quote))
    .toMatchObject({ status: "provider_review_required", providerStopped: false, billingBlocked: true, balanceWaived: false });
  expect(h.rpc.mock.calls.some(([name]) => name === "record_monthly_mentorship_exit_stop_v1")).toBe(false);
});
test("step 8: observed canceled subscription is reconciled without dispatching cancellation again", async () => {
  const h = harness(); h.f.subscription.status = "canceled"; h.review();
  expect((await h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "stop_renewal", true, h.quote)).providerStopped).toBe(true);
  expect(h.cancel).not.toHaveBeenCalled(); expect(h.rpc.mock.calls.some(([name]) => name === "claim_monthly_mentorship_exit_stop_v1")).toBe(false);
});
test("step 8: uncertain stop outside the safe retry window is review-only", async () => {
  const h = harness(); h.review();
  expect((await h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "stop_renewal", true, h.quote)).providerStopped).toBe(false);
  expect(h.cancel).not.toHaveBeenCalled();
});
test("step 8: conflicting provider ownership cannot cancel another subscription", async () => {
  const h = harness(); h.f.subscription.customer = "cus_other";
  expect((await h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "revoke_debits", true)).providerStopped).toBe(false);
  expect(h.cancel).not.toHaveBeenCalled();
});
test("step 8: a failed proof write is not reported as durable provider completion", async () => {
  const h = harness(); h.saveFailure();
  expect((await h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "revoke_debits", true)).status).toBe("provider_review_required");
});
test("step 2: an unbound agreement is blocked locally but not falsely labeled provider-stopped", async () => {
  const h = harness(); h.f.a.stripe_subscription_id = null;
  expect((await h.runtime.requestExit(h.f.a.id, h.f.a.buyer_id, "revoke_debits", true)).providerStopped).toBe(false);
  expect(h.retrieve).not.toHaveBeenCalled();
});
test("step 2: exit quote must retain the exact owned agreement revision", async () => {
  const h = harness(); expect(await h.runtime.quoteExit(h.f.a.id, h.f.a.buyer_id)).toEqual(h.quote);
  h.quote.revision++; await expect(h.runtime.quoteExit(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("fresh receipt state");
});
test("step 8: recovery uses an existing accepted request without recording new buyer consent", async () => {
  const h = harness(); h.f.a.renewal_stopped_at = new Date().toISOString();
  expect(await h.runtime.reconcileExitStop(h.f.a.id, h.f.a.buyer_id, h.row.id))
    .toMatchObject({ requestId: h.row.id, providerStopped: true, billingBlocked: true, balanceWaived: false });
  expect(h.rpc.mock.calls.some(([name]) => name === "request_monthly_mentorship_exit_v1")).toBe(false);
  expect(h.cancel).toHaveBeenCalledWith(h.f.a.stripe_subscription_id, { invoice_now: false, prorate: false },
    { idempotencyKey: `creatornet-membership-exit:${h.row.id}`, maxNetworkRetries: 0 });
});
test("step 8: recovery cannot invent a request or work without its durable billing block", async () => {
  const h = harness();
  await expect(h.runtime.reconcileExitStop(h.f.a.id, h.f.a.buyer_id, h.row.id)).rejects.toThrow("durable billing block");
  h.f.a.renewal_stopped_at = new Date().toISOString(); h.missing();
  await expect(h.runtime.reconcileExitStop(h.f.a.id, h.f.a.buyer_id, h.row.id)).rejects.toThrow("Existing monthly exit");
  expect(h.retrieve).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
});
test.each(["id", "agreement_id", "buyer_id"])("step 5: recovery rejects a mismatched saved %s", async field => {
  const h = harness(); h.f.a.renewal_stopped_at = new Date().toISOString();
  const requested = h.row.id; h.row[field as "id" | "agreement_id" | "buyer_id"] = "19000000-0000-4000-8000-000000000099";
  await expect(h.runtime.reconcileExitStop(h.f.a.id, h.f.a.buyer_id, requested)).rejects.toThrow("Existing monthly exit");
  expect(h.retrieve).not.toHaveBeenCalled();
});
test("step 8: recovery outside the original retry window is observation-only", async () => {
  const h = harness(); h.f.a.renewal_stopped_at = new Date().toISOString(); h.review();
  expect((await h.runtime.reconcileExitStop(h.f.a.id, h.f.a.buyer_id, h.row.id)).providerStopped).toBe(false);
  expect(h.cancel).not.toHaveBeenCalled(); expect(h.rpc.mock.calls.some(([name]) => name === "request_monthly_mentorship_exit_v1")).toBe(false);
  h.f.subscription.status = "canceled";
  expect((await h.runtime.reconcileExitStop(h.f.a.id, h.f.a.buyer_id, h.row.id)).providerStopped).toBe(true);
  expect(h.cancel).not.toHaveBeenCalled();
});
test("step 2: recovery of a separate debit stop works while new checkout and billing are paused", async () => {
  const h = harness(); h.row.kind = "revoke_debits"; h.f.a.debit_revoked_at = new Date().toISOString();
  h.env.CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY = "false"; h.env.CREATOR_MONTHLY_MENTORSHIPS_ENABLED = "false";
  expect((await h.runtime.reconcileExitStop(h.f.a.id, h.f.a.buyer_id, h.row.id)).providerStopped).toBe(true);
  expect(h.rpc.mock.calls.some(([name]) => name === "request_monthly_mentorship_exit_v1")).toBe(false);
});
test("step 8: an unbound existing stop remains pending without provider calls", async () => {
  const h = harness(); h.f.a.renewal_stopped_at = new Date().toISOString(); h.f.a.stripe_subscription_id = null;
  expect((await h.runtime.reconcileExitStop(h.f.a.id, h.f.a.buyer_id, h.row.id)).status).toBe("provider_review_required");
  expect(h.retrieve).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
});
