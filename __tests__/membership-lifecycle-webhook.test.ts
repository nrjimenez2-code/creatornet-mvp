import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handoffMonthlyMentorshipWebhook } from "@/lib/membershipWebhook";
import { membershipFixture, membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
const mockLifecycle = jest.fn();
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({ reconcileLifecycle: mockLifecycle }) }));
function harness(type: Stripe.Event.Type) {
  const f = membershipFixture(false);
  const q: { select: jest.Mock; or: jest.Mock; limit: jest.Mock } = { select: jest.fn(() => q), or: jest.fn(() => q),
    limit: jest.fn(async () => ({ error: null, data: [f.a] })) };
  const from = jest.fn(() => q), admin = { from } as unknown as SupabaseClient;
  const object = type.startsWith("customer.subscription.") ? f.subscription : type.startsWith("checkout.") ? f.session :
    { id: "in_lifecycle", object: "invoice", customer: f.customer.id, parent: { subscription_details: { subscription: f.subscription.id } } };
  const event = { id: "evt_lifecycle", type, livemode: false, api_version: context.apiVersion, data: { object } } as Stripe.Event;
  return { f, event, run: () => handoffMonthlyMentorshipWebhook({ event, admin, env: membershipTestEnv }) };
}
beforeEach(() => { jest.clearAllMocks(); mockLifecycle.mockResolvedValue({ status: "observed" }); });
test.each(["invoice.created", "invoice.paid", "invoice.payment_failed", "customer.subscription.updated",
  "customer.subscription.deleted", "checkout.session.expired", "checkout.session.async_payment_failed"] as Stripe.Event.Type[])(
  "step 8: verified owned %s goes to the dedicated lifecycle adapter", async type => {
    const h = harness(type); expect(await h.run()).toBe(true);
    expect(mockLifecycle).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id, h.event, null);
  });
test("step 8: lifecycle failure remains a webhook failure instead of an acknowledgement", async () => {
  const h = harness("invoice.created"); mockLifecycle.mockRejectedValue(Error("synthetic provider unavailable"));
  await expect(h.run()).rejects.toThrow("provider unavailable");
});
test("step 8: context rejection precedes the lifecycle handoff", async () => {
  const h = harness("customer.subscription.deleted"); h.event.account = "acct_other";
  await expect(h.run()).rejects.toThrow("context differs"); expect(mockLifecycle).not.toHaveBeenCalled();
});
