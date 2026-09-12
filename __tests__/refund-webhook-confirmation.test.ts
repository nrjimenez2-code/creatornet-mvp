import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { confirmAdminRefundWebhookDelivery, type PaymentRefundState } from "@/lib/paymentRefunds";

const state: PaymentRefundState = {
  paymentIntentId: "pi_test", chargeId: "ch_test",
  chargeAmountCents: 10000, refundedAmountCents: 3333,
};
const operation = {
  id: "c7db96d0-d000-45f8-982b-f29657f3e07f",
  stripe_refund_id: "re_test", customer_refund_amount_cents: 3333,
  cumulative_customer_refund_target_cents: 3333,
};
const refund = {
  id: "re_test", charge: "ch_test", payment_intent: "pi_test",
  status: "succeeded", amount: 3333,
  metadata: { creatornet_refund_operation_id: operation.id },
};

function harness(rows: unknown[] = [operation]) {
  const updates: Array<Record<string, unknown>> = [];
  let selectError: unknown = null;
  let updateError: unknown = null;
  const from = jest.fn(() => ({
    select: () => ({ eq: () => ({ is: async () => ({ data: rows, error: selectError }) }) }),
    update: (payload: unknown) => {
      const recorded: Record<string, unknown> = { payload };
      updates.push(recorded);
      const query = {
        eq: (key: string, value: unknown) => { recorded[key] = value; return query; },
        is: (key: string, value: unknown) => { recorded[key] = value; return query; },
        or: (value: string) => { recorded.or = value; return query; },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: updateError }).then(resolve),
      };
      return query;
    },
  }));
  const list = jest.fn().mockResolvedValue({ data: [refund], has_more: false });
  const run = (value = state) => (confirmAdminRefundWebhookDelivery as unknown as (
    db: SupabaseClient, stripe: Stripe, state: PaymentRefundState
  ) => Promise<void>)({ from } as unknown as SupabaseClient, { refunds: { list } } as unknown as Stripe, value);
  return { run, list, updates, from,
    failSelect: () => { selectError = { message: "unavailable" }; },
    failUpdate: () => { updateError = { message: "unavailable" }; },
  };
}

describe("refund webhook confirmation from Stripe's actual Refund objects", () => {
  it("fetches the exact charge's refunds when the event has no expanded list", async () => {
    const h = harness();
    await h.run();
    expect(h.list).toHaveBeenCalledWith({ charge: "ch_test", limit: 100 });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      id: operation.id, stripe_payment_intent_id: "pi_test",
      customer_refund_amount_cents: 3333, webhook_confirmed_at: null,
      or: "stripe_refund_id.is.null,stripe_refund_id.eq.re_test",
      payload: { webhook_confirmed_at: expect.any(String) },
    });
  });

  it("confirms an early webhook using the exact operation metadata before the refund ID is persisted", async () => {
    const h = harness([{ ...operation, stripe_refund_id: null }]);
    await h.run();
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].id).toBe(operation.id);
  });

  it.each([
    { status: "pending" }, { status: "failed" }, { status: "canceled" },
    { charge: "ch_other" }, { payment_intent: "pi_other" }, { amount: 3334 },
    { id: "re_other", metadata: {} },
  ])("does not confirm an unrelated or unsuccessful refund: %j", async (patch) => {
    const h = harness();
    h.list.mockResolvedValue({ data: [{ ...refund, ...patch }], has_more: false });
    await h.run();
    expect(h.updates).toHaveLength(0);
  });

  it("requires metadata for a missing persisted ID and never substitutes a conflicting ID", async () => {
    for (const stripe_refund_id of [null, "re_conflict"]) {
      const h = harness([{ ...operation, stripe_refund_id }]);
      h.list.mockResolvedValue({ data: [{ ...refund, metadata: {} }], has_more: false });
      await h.run();
      expect(h.updates).toHaveLength(0);
    }
  });

  it("does not mark a later refund as applied using an older cumulative watermark", async () => {
    const h = harness([{ ...operation, cumulative_customer_refund_target_cents: 10000 }]);
    await h.run();
    expect(h.updates).toHaveLength(0);
  });

  it("paginates rather than silently missing older refunds", async () => {
    const h = harness();
    h.list.mockResolvedValueOnce({ data: [{ ...refund, id: "re_newer", metadata: {} }], has_more: true })
      .mockResolvedValueOnce({ data: [refund], has_more: false });
    await h.run();
    expect(h.list).toHaveBeenNthCalledWith(2, { charge: "ch_test", limit: 100, starting_after: "re_newer" });
    expect(h.updates).toHaveLength(1);
  });

  it("does not query Stripe when no operations need confirmation", async () => {
    const h = harness([]);
    await h.run();
    expect(h.list).not.toHaveBeenCalled();
  });

  it.each(["select", "stripe", "update", "pagination"])("propagates %s errors for a retry", async (failure) => {
    const h = harness();
    if (failure === "select") h.failSelect();
    if (failure === "stripe") h.list.mockRejectedValue(new Error("unavailable"));
    if (failure === "update") h.failUpdate();
    if (failure === "pagination") h.list.mockResolvedValue({ data: [], has_more: true });
    await expect(h.run()).rejects.toThrow();
  });
});
