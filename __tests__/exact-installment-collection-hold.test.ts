import { coordinateExactInstallmentRefund, holdExactInstallmentForCancellation } from "@/lib/installments/collectionHold";
import { createSupabaseRefundStore } from "@/lib/admin/refund-store";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";

const f = exactInstallmentFixture();
const env = { ...f.env, CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY: "true",
  CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY: "true" };
const rpc = jest.fn();
const admin = { rpc };
beforeEach(() => rpc.mockReset());

test("legacy paths do not access any new table/RPC with all candidate flags off", async () => {
  await expect(coordinateExactInstallmentRefund(admin as never, f.terms.bookingId, f.terms.buyerId, {})).resolves.toBe("not_applicable");
  expect(rpc).not.toHaveBeenCalled();
});
test.each(["not_applicable", "held", "reconciliation_required"])("real refund store propagates %s", async (status) => {
  rpc.mockResolvedValue({ data: status, error: null });
  const store = createSupabaseRefundStore(admin as never, env);
  await expect(store.coordinateInstallmentRefund(f.terms.bookingId, f.terms.buyerId)).resolves.toBe(status);
  expect(rpc).toHaveBeenCalledWith("admit_exact_installment_admin_refund", {
    p_operation_id: f.terms.bookingId, p_processing_token: f.terms.buyerId,
  });
});
test.each([
  { CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY: "false" },
  { VERCEL_ENV: "production" }, { STRIPE_SECRET_KEY: "sk_live_not_a_real_key" },
  { NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid" },
  { NEXT_PUBLIC_SITE_URL: "https://www.creatornet.net" },
])("unsafe/unready environment fails before any database call: %j", async (override) => {
  await expect(coordinateExactInstallmentRefund(admin as never, f.terms.bookingId, f.terms.buyerId,
    { ...env, ...override })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
test("coordination stays active when preparation and collection are paused", async () => {
  rpc.mockResolvedValue({ data: "held", error: null });
  await expect(coordinateExactInstallmentRefund(admin as never, f.terms.bookingId, f.terms.buyerId,
    { ...env, CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE: "false", CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT: "false" })).resolves.toBe("held");
});
test.each([null, "allowed", true, {}, []])("unexpected admission %j fails closed", async (data) => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(coordinateExactInstallmentRefund(admin as never, f.terms.bookingId, f.terms.buyerId, env)).rejects.toThrow("Invalid");
});
test("database error details are not exposed", async () => {
  rpc.mockResolvedValue({ data: null, error: { message: "synthetic-private-details" } });
  await expect(coordinateExactInstallmentRefund(admin as never, f.terms.bookingId, f.terms.buyerId, env)).rejects.toThrow("Exact installment refund coordination failed");
});
test("malformed processor identity fails without calling the database", async () => {
  await expect(coordinateExactInstallmentRefund(admin as never, "invalid", f.terms.buyerId, env)).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
test("cancellation returns only a review hold, not cancellation/Stripe success", async () => {
  rpc.mockResolvedValue({ data: f.terms.bookingId, error: null });
  await expect(holdExactInstallmentForCancellation({ admin: admin as never, agreementId: f.agreement.id,
    requestId: f.terms.bookingId, actorId: f.terms.creatorId, env })).resolves.toEqual({
    status: "review_hold_recorded", holdId: f.terms.bookingId,
  });
  expect(rpc).toHaveBeenCalledWith("hold_exact_installment_for_cancellation", {
    p_agreement_id: f.agreement.id, p_request_id: f.terms.bookingId, p_actor_id: f.terms.creatorId,
  });
});
test("cancellation cannot run against production even with flags on", async () => {
  await expect(holdExactInstallmentForCancellation({ admin: admin as never, agreementId: f.agreement.id,
    requestId: f.terms.bookingId, actorId: f.terms.creatorId, env: { ...env, VERCEL_ENV: "production" } })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
