/** @jest-environment node */
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipCardSetup, monthlyCardSetupParams } from "@/lib/membershipCardSetup";
import { MONTHLY_CARD_SETUP_CONSENT_VERSION } from "@/lib/membershipCardSetupConsent";
import { monthlyCardSetupFixture } from "../test-support/membership-card-setup-fixtures";
import { membershipTestEnv } from "../test-support/membership-fixtures";
import type { MembershipRenewalRecoveryOutcome } from "@/lib/membershipRenewalRecovery";
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
function harness() {
  const x = monthlyCardSetupFixture(), { f, r } = x, context = f.a.terms.paymentContext;
  let reserved = false, session: Stripe.Checkout.Session | null = null, outcome: MembershipRenewalRecoveryOutcome = "payment_method_required";
  const response = <T,>(v: T): Stripe.Response<T> => ({ ...v, lastResponse: { apiVersion: context.apiVersion, requestId: "req_setup", headers: {}, statusCode: 200 } });
  const rpc = jest.fn(async (_name: string, p: Record<string, unknown>) => {
    if (outcome !== "payment_method_required") throw Error("Synthetic state changed");
    if (p.p_action === "reserve") { if (!reserved) { r.id = String(p.p_id); r.request = monthlyCardSetupParams(r); } reserved = true; }
    if (p.p_action === "claim") r.dispatch_started_at ||= new Date().toISOString();
    if (p.p_action === "bind") r.session_id = (p.p_proof as { session: { id: string } }).session.id;
    if (p.p_action === "verify") { r.setup_intent_id = "seti_cardsetup"; r.payment_method_id = x.card.id; r.verified_at = new Date().toISOString(); }
    return { error: null, data: copy(r) };
  });
  const from = jest.fn((table: string) => {
    const q = { select: jest.fn(), eq: jest.fn(), is: jest.fn(), maybeSingle: jest.fn(async () => ({ error: null,
      data: table === "monthly_mentorship_operations_v1" ? { id: r.operation_id, request: { path: "/v1/invoices/" + f.invoice.id + "/pay" } } :
        reserved ? copy(r) : null })) }; q.select.mockReturnValue(q); q.eq.mockReturnValue(q); q.is.mockReturnValue(q); return q;
  });
  const stripe = { checkout: { sessions: {
    list: jest.fn(async () => response({ data: session ? [session] : [], has_more: false, object: "list", url: "/v1/checkout/sessions" })),
    create: jest.fn(async () => { session = x.session(); return response(session); }),
    retrieve: jest.fn(async () => { if (!session) throw Error("No setup"); return response(session); }),
  } }, setupIntents: { retrieve: jest.fn(async () => response(x.intent())) }, paymentMethods: { retrieve: jest.fn(async () => response(x.card)) },
    invoices: { pay: jest.fn(), update: jest.fn() }, subscriptions: { update: jest.fn() }, paymentIntents: { confirm: jest.fn() } };
  const env = { ...membershipTestEnv, CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_READY: "true",
    CREATOR_MONTHLY_MENTORSHIPS_CARD_SETUP_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_CARD_SETUP_READY: "true",
    CREATOR_MONTHLY_MENTORSHIPS_CARD_SETUP_PUBLISH_READY: "true" };
  const readRenewalRecovery = jest.fn(async () => ({ membershipId: f.a.id, invoiceId: f.invoice.id, month: f.period.month,
    amountCents: f.a.monthly_price_cents, periodStart: f.period.start, periodEnd: f.period.end, outcome }));
  const api = createMembershipCardSetup({ admin: { from, rpc } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe, context, env,
    checked: async p => p, observeContext: async () => context, load: async (id, buyer) => {
      if (id !== f.a.id || buyer !== f.a.buyer_id) throw Error("Synthetic foreign owner"); return copy(f.a);
    }, productId: async () => f.product.id }, { readRenewalRecovery });
  const prepare = () => api.prepareRenewalCardSetup(f.a.id, f.a.buyer_id, MONTHLY_CARD_SETUP_CONSENT_VERSION, true);
  return { ...x, api, stripe, rpc, from, env, response, readRenewalRecovery, prepare, setOutcome: (v: MembershipRenewalRecoveryOutcome) => { outcome = v; },
    complete: () => { session!.status = "complete"; session!.setup_intent = "seti_cardsetup"; },
    changeSession: (values: Partial<Stripe.Checkout.Session>) => Object.assign(session!, values) };
}
test("steps 1/4/5: explicit consent creates setup only and repeated preparation keeps the original identity", async () => {
  const h = harness(), before = JSON.stringify(h.f.a), first = await h.prepare(), second = await h.prepare();
  expect(first.url).toMatch(/^https:\/\/checkout.stripe.com\/c\//); expect(second.setupId).toBe(first.setupId);
  expect(h.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  expect(h.stripe.checkout.sessions.create).toHaveBeenCalledWith(h.r.request,
    { idempotencyKey: "creatornet-monthly-card-setup:" + first.setupId, maxNetworkRetries: 0 });
  expect(h.r.request.mode).toBe("setup"); expect(h.r.request.line_items).toBeUndefined(); expect(JSON.stringify(h.f.a)).toBe(before);
  expect(h.stripe.invoices.pay).not.toHaveBeenCalled(); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
});
test("step 4: absent or stale consent cannot create or reserve a card setup", async () => {
  const h = harness();
  await expect(h.api.prepareRenewalCardSetup(h.f.a.id, h.f.a.buyer_id, MONTHLY_CARD_SETUP_CONSENT_VERSION, false)).rejects.toThrow("consent");
  await expect(h.api.prepareRenewalCardSetup(h.f.a.id, h.f.a.buyer_id, "old-version", true)).rejects.toThrow("consent");
  expect(h.rpc).not.toHaveBeenCalled(); expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("step 8: a lost setup response is recovered by bounded original-identity discovery", async () => {
  const h = harness(), create = h.stripe.checkout.sessions.create.getMockImplementation()!;
  h.stripe.checkout.sessions.create.mockImplementationOnce(async () => { await create(); throw Error("Synthetic lost response"); });
  await expect(h.prepare()).rejects.toThrow("lost response"); const age = h.r.dispatch_started_at;
  expect((await h.prepare()).setupId).toBe(h.r.id); expect(h.r.dispatch_started_at).toBe(age);
  expect(h.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});
test("step 8: discovery cannot adopt a manually tagged session with no original dispatch", async () => {
  const h = harness(); await h.prepare(); h.r.session_id = null; h.r.dispatch_started_at = null;
  await expect(h.prepare()).rejects.toThrow("no original dispatch"); expect(h.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});
test("step 2: a stop after setup creation prevents URL publication and does not charge", async () => {
  const h = harness(), create = h.stripe.checkout.sessions.create.getMockImplementation()!;
  h.stripe.checkout.sessions.create.mockImplementationOnce(async () => { const s = await create(); h.setOutcome("review_required"); return s; });
  await expect(h.prepare()).rejects.toThrow("unpaid card decline");
  expect(h.rpc.mock.calls.some(([, p]) => p.p_action === "bind")).toBe(false); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test.each(["payment_pending", "action_required", "paid_accounted", "review_required", "terminal_unpaid"] as const)(
  "step 8: %s cannot start a replacement-card setup", async outcome => {
    const h = harness(); h.setOutcome(outcome);
    await expect(h.prepare()).rejects.toThrow("unpaid card decline"); expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
test("step 5: completed Checkout, SetupIntent and customer-owned card are all verified without a payment", async () => {
  const h = harness(); await h.prepare(); h.complete();
  expect((await h.api.verifyRenewalCardSetup(h.f.a.id, h.f.a.buyer_id, h.r.id)).status).toBe("card_saved_payment_not_attempted");
  expect(h.r.payment_method_id).toBe("pm_replacement"); expect(h.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
  expect((await h.prepare()).status).toBe("card_saved_payment_not_attempted");
  expect(h.stripe.invoices.pay).not.toHaveBeenCalled(); expect(h.stripe.invoices.update).not.toHaveBeenCalled();
  expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
});
test.each(["card_owner", "setup_owner", "setup_id", "card_id", "metadata", "usage", "mode", "amount", "url"] as const)(
  "step 8: contradictory native setup evidence %s is rejected", async fault => {
    const h = harness(); await h.prepare(); h.complete();
    if (fault === "card_owner") h.card.customer = "cus_other";
    if (fault === "setup_owner") h.stripe.setupIntents.retrieve.mockImplementation(async () => h.response({ ...h.intent(), customer: "cus_other" }));
    if (fault === "setup_id") h.stripe.setupIntents.retrieve.mockImplementation(async () => h.response({ ...h.intent(), id: "seti_other" }));
    if (fault === "card_id") h.card.id = "pm_other";
    if (fault === "metadata") h.changeSession({ metadata: {} });
    if (fault === "usage") h.stripe.setupIntents.retrieve.mockImplementation(async () => h.response({ ...h.intent(), usage: "on_session" }));
    if (fault === "mode") h.changeSession({ mode: "payment" });
    if (fault === "amount") h.changeSession({ amount_total: 1 });
    if (fault === "url") h.changeSession({ success_url: "https://other.example.invalid" });
    await expect(h.api.verifyRenewalCardSetup(h.f.a.id, h.f.a.buyer_id, h.r.id)).rejects.toThrow();
    expect(h.rpc.mock.calls.some(([, p]) => p.p_action === "verify")).toBe(false);
  });
test("step 10: disabled publication never creates even an unpublished setup", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_CARD_SETUP_PUBLISH_READY = "false";
  await expect(h.prepare()).rejects.toThrow("handoff"); expect(h.rpc).not.toHaveBeenCalled();
});
