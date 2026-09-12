import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handoffExactInstallmentWebhook } from "../lib/installments/routeHandoff";
import { dispatchExactInstallmentEventSandbox } from "../lib/installments/eventBridge";
jest.mock("../lib/installments/contextEventRoute", () => ({ handoffContextInstallmentEvent: jest.fn(async () => false) }));
jest.mock("../lib/installments/eventBridge",()=>({
  createExactEventBindingStore:jest.fn(()=>({})),dispatchExactInstallmentEventSandbox:jest.fn(),
}));
const dispatch=jest.mocked(dispatchExactInstallmentEventSandbox);
const args={admin:{} as SupabaseClient,stripe:{} as Stripe,event:{} as Stripe.Event,
  env:{CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT:"true"}};
beforeEach(()=>jest.clearAllMocks());
test.each(["first_credited_held","first_already_activated","bootstrap_zero","separate_receipt_handler","credited","already_credited","refund_reconciled",
  "lifecycle_observed","lifecycle_review_recorded","payment_recovery_recorded"] as const)("%s handoff excludes the legacy handler",async(disposition)=>{
  dispatch.mockResolvedValueOnce({handled:true,disposition});expect(await handoffExactInstallmentWebhook(args)).toBe(true);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({verifiedEvent:args.event,
    env:{CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT:"false"},lifecycleStore:expect.any(Object)}));
  expect(args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT).toBe("true");
});
test.each(["busy","prepared_unpaid","reconciliation_required"] as const)("%s is not acknowledged as a completed event",async(disposition)=>{
  dispatch.mockResolvedValueOnce({handled:true,disposition});await expect(handoffExactInstallmentWebhook(args)).rejects.toThrow("held");
});
test("legacy event is explicitly returned to the existing handler",async()=>{
  dispatch.mockResolvedValueOnce({handled:false});expect(await handoffExactInstallmentWebhook(args)).toBe(false);
});
test("unknown future disposition fails closed rather than becoming a successful ACK",async()=>{
  dispatch.mockResolvedValueOnce({handled:true,disposition:"new_state"} as never);
  await expect(handoffExactInstallmentWebhook(args)).rejects.toThrow("held");
});
test("errors are propagated to canonical event-claim release",async()=>{
  dispatch.mockRejectedValueOnce(new Error("binding missing"));await expect(handoffExactInstallmentWebhook(args)).rejects.toThrow("binding missing");
});

test.each(["invoice.paid","invoice.payment_succeeded","payment_intent.succeeded","checkout.session.completed","charge.updated"])
("%s cannot receive collection permission at the HTTP boundary",async(type)=>{
  dispatch.mockResolvedValueOnce({handled:true,disposition:"credited"});
  await handoffExactInstallmentWebhook({...args,event:{type} as Stripe.Event,
    env:{...args.env,CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY:"true"}});
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({env:expect.objectContaining({
    CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT:"false"})}));
});
