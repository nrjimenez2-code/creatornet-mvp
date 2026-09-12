import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseRefundStore } from "@/lib/admin/refund-store";
const operation = "11111111-1111-4111-8111-111111111111", token = "22222222-2222-4222-8222-222222222222";

test("monthly admin refund must honor collection reconciliation before provider refund", async () => {
  const rpc = jest.fn(async () => ({ data: "reconciliation_required", error: null }));
  const store = createSupabaseRefundStore({ rpc } as unknown as SupabaseClient,
    { CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY: "true" });
  expect(await store.coordinateInstallmentRefund(operation, token)).toBe("reconciliation_required");
  expect(rpc).toHaveBeenCalledWith("admit_monthly_mentorship_admin_refund_v1", { p_operation_id: operation, p_processing_token: token });
});

test.each(["held", "not_applicable"])("monthly admission preserves the %s result", async data => {
  const rpc = jest.fn(async () => ({ data, error: null }));
  const store = createSupabaseRefundStore({ rpc } as unknown as SupabaseClient, { CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY: "true" });
  expect(await store.coordinateInstallmentRefund(operation, token)).toBe(data);
});

test.each([{ data: null, error: { message: "RPC unavailable" } }, { data: "unexpected", error: null }])(
  "monthly admission failure cannot silently fall through to an ordinary refund", async result => {
    const rpc = jest.fn(async () => result);
    const store = createSupabaseRefundStore({ rpc } as unknown as SupabaseClient, { CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY: "true" });
    await expect(store.coordinateInstallmentRefund(operation, token)).rejects.toThrow("coordination requires retry or review");
    expect(rpc).toHaveBeenCalledTimes(1);
  },
);

test("without monthly or exact schema the legacy refund path is unchanged", async () => {
  const rpc = jest.fn();
  const store = createSupabaseRefundStore({ rpc } as unknown as SupabaseClient, {});
  expect(await store.coordinateInstallmentRefund(operation, token)).toBe("not_applicable");
  expect(rpc).not.toHaveBeenCalled();
});
