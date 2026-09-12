import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handoffMonthlyMentorshipWebhook } from "@/lib/membershipWebhook";
import { membershipFixture, membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
const mockPayment = jest.fn();
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({ reconcilePaymentEvent: mockPayment }) }));
function harness(type: Stripe.Event.Type) {
  const f = membershipFixture(true), q: { select: jest.Mock; or: jest.Mock; limit: jest.Mock } = {
    select: jest.fn(() => q), or: jest.fn(() => q), limit: jest.fn(async () => ({ error: null, data: [f.a] })) };
  const from = jest.fn(() => q), admin = { from } as unknown as SupabaseClient;
  const event = { id: "evt_paymenthook", type, api_version: context.apiVersion, created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: type.startsWith("charge.") ? f.charge : f.paymentIntent } } as Stripe.Event;
  return { f, event, from, run: () => handoffMonthlyMentorshipWebhook({ event, admin, env: membershipTestEnv }) };
}
beforeEach(() => { jest.clearAllMocks(); mockPayment.mockResolvedValue({ status: "reconciled" }); });
test.each(["payment_intent.created", "payment_intent.succeeded", "payment_intent.processing", "payment_intent.requires_action",
  "payment_intent.payment_failed", "payment_intent.canceled", "charge.succeeded", "charge.failed", "charge.updated", "charge.captured"] as Stripe.Event.Type[])(
  "step 8: verified owned %s is handed to the dedicated payment adapter", async type => {
    const h = harness(type); expect(await h.run()).toBe(true);
    expect(mockPayment).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id, h.event, null);
  });
test("step 8: payment adapter failure is not swallowed as a successful webhook", async () => {
  const h = harness("payment_intent.succeeded"); mockPayment.mockRejectedValue(Error("synthetic receipt unavailable"));
  await expect(h.run()).rejects.toThrow("receipt unavailable");
});
test.each(["charge.refunded", "charge.dispute.created", "refund.updated"] as Stripe.Event.Type[])(
  "step 7: %s still reaches the existing common engine", async type => {
    const h = harness(type); expect(await h.run()).toBe(false); expect(h.from).not.toHaveBeenCalled(); expect(mockPayment).not.toHaveBeenCalled();
  });
