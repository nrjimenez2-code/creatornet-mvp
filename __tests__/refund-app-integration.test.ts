import type { NextRequest } from "next/server";
import { POST, PATCH } from "../app/api/admin/refunds/route";
import { POST as preview } from "../app/api/admin/refunds/preview/route";
import { executeAdminRefundAction } from "../lib/admin/refund-app";
import { exactContextServerConfig } from "../lib/installments/contextServer";
import { createExactContextAdminRefund } from "../lib/installments/contextRuntime";
import { createAndProcessAdminRefund, previewAdminRefund, processRefundOperation } from "../lib/admin/refunds";

const actor = "11111111-1111-4111-8111-111111111111", ledger = "22222222-2222-4222-8222-222222222222";
const reservation = "33333333-3333-4333-8333-333333333333", operation = "44444444-4444-4444-8444-444444444444";
let protocol: string | null | undefined, badLink = false;
const runtimeRun = jest.fn(), select = jest.fn(), source = jest.fn();
const store = { getSourceContext: source, getOperation: jest.fn(async () => ({ paymentFeeLedgerId: ledger })) };
const admin = { from: jest.fn((table: string) => { if (table !== "booking_payments") throw Error("Private table SELECT denied");
  return { select: (...args: unknown[]) => { select(...args); return { eq: () => ({ single: async () => ({ error: null,
  data: { installment_collection_version: protocol } }) }) }; } }; }),
  rpc: jest.fn(async () => ({ error: null, data: { reservationId: reservation, firstCredited: !badLink } })) };
jest.mock("../lib/admin/server", () => ({ requireAdmin: jest.fn(async () => ({ user: { id: actor }, admin })), adminAuthErrorResponse: jest.fn() }));
jest.mock("../lib/admin/refund-store", () => ({ createSupabaseRefundStore: jest.fn(() => store) }));
jest.mock("../lib/installments/contextRuntime", () => ({ createExactContextAdminRefund: jest.fn(() => ({ run: runtimeRun })) }));
jest.mock("../lib/installments/contextServer", () => ({ exactContextServerConfig: jest.fn(() => ({ approvedContext: "synthetic" })) }));
jest.mock("../lib/stripeClient", () => ({ getStripe: jest.fn(() => ({})) }));
jest.mock("../lib/admin/refunds", () => ({ previewAdminRefund: jest.fn(), createAndProcessAdminRefund: jest.fn(), processRefundOperation: jest.fn(),
  publicRefundOperation: jest.fn((v: unknown) => v), RefundWorkflowError: class extends Error {} }));
const input = { paymentFeeLedgerId: ledger, amountCents: 10000, reasonCode: "creator_non_delivery" as const, responsibility: "creator" as const,
  internalNotes: null, idempotencyKey: "synthetic-existing-admin-request", expectedRefundedBeforeCents: 0, expectedApplicationFeeRefundedBeforeCents: 0 };
const response = { disposition: "completed", operation: { id: operation } };
const request = (body: unknown) => new Request("https://synthetic.example/api/admin/refunds", { method: "POST",
  headers: { origin: "https://synthetic.example", host: "synthetic.example", "content-type": "application/json" }, body: JSON.stringify(body) }) as NextRequest;
beforeEach(() => {
  jest.clearAllMocks(); protocol = "exact-cents-context-v2"; badLink = false;
  source.mockResolvedValue({ ledger: { id: ledger, bookingPaymentId: "synthetic-payment", stripePaymentIntentId: "pi_Synthetic" } });
  runtimeRun.mockResolvedValue(response); jest.mocked(exactContextServerConfig).mockImplementation(() => ({ approvedContext: "synthetic" }) as never);
  jest.mocked(createAndProcessAdminRefund).mockResolvedValue(response as never);
  jest.mocked(processRefundOperation).mockResolvedValue(response as never);
  jest.mocked(previewAdminRefund).mockResolvedValue({ paymentFeeLedgerId: ledger } as never);
});

test.each(["preview", "create", "retry"])("#1/#3 existing %s endpoint routes a v2 payment to the owned context", async kind => {
  if (kind === "preview") runtimeRun.mockResolvedValue({ paymentFeeLedgerId: ledger });
  const r = await (kind === "preview" ? preview(request(input)) : kind === "create" ? POST(request(input)) : PATCH(request({ refundId: operation })));
  expect(r.status).toBe(200);
  expect(runtimeRun).toHaveBeenCalledWith(reservation, actor, ledger,
    kind === "retry" ? { kind, operationId: operation } : { kind, input: expect.objectContaining({ paymentFeeLedgerId: ledger, amountCents: 10000 }) });
  expect(createExactContextAdminRefund).toHaveBeenCalledTimes(1);
  expect(admin.rpc).toHaveBeenCalledWith("resolve_exact_context_event_v2", { p_kind: "intent", p_provider_id: "pi_Synthetic", p_hint: null });
  expect(createAndProcessAdminRefund).not.toHaveBeenCalled(); expect(processRefundOperation).not.toHaveBeenCalled(); expect(previewAdminRefund).not.toHaveBeenCalled();
});
test.each([undefined, null, "exact-cents-held-v1"])("#1/#3 preserves existing refund treatment for protocol %s", async version => {
  protocol = version;
  expect((await POST(request(input))).status).toBe(200);
  expect(createAndProcessAdminRefund).toHaveBeenCalledWith(store, {}, actor, input);
  expect(exactContextServerConfig).not.toHaveBeenCalled(); expect(runtimeRun).not.toHaveBeenCalled();
});
test("#1/#3 missing context configuration cannot fall back to legacy refunds", async () => {
  jest.mocked(exactContextServerConfig).mockImplementation(() => { throw Error("Not enabled"); });
  await expect(executeAdminRefundAction({ admin: admin as never, actorId: actor }, { kind: "create", input })).rejects.toThrow("Not enabled");
  expect(createAndProcessAdminRefund).not.toHaveBeenCalled(); expect(runtimeRun).not.toHaveBeenCalled();
});
test.each(["link", "protocol"])("#1/#3 mismatched %s cannot select a refund engine", async fault => {
  if (fault === "link") badLink = true; else protocol = "unrecognized-future-protocol";
  await expect(executeAdminRefundAction({ admin: admin as never, actorId: actor }, { kind: "create", input })).rejects.toThrow();
  expect(runtimeRun).not.toHaveBeenCalled(); expect(createAndProcessAdminRefund).not.toHaveBeenCalled();
});
