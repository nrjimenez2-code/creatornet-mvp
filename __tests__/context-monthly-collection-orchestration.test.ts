import { createMockClient } from "./__mocks__/supabaseQueryMock";

// #3: exercise the worker and real invoice discovery together. Account
// observation, reservation decoding, publication, and the final claimed
// collector are boundary doubles, not hosted payment acceptance evidence.
const bookingId = "11000000-0000-4000-8000-000000000001";
const reservationId = "11000000-0000-4000-8000-000000000002";
const creatorId = "11000000-0000-4000-8000-000000000003";
const buyerId = "11000000-0000-4000-8000-000000000004";
const mockContext = { mode: "test", fixture: "independently-approved-context-double" };
const mockConfig = { approvedContext: mockContext, stripeSecretKey: "sk_test_synthetic_not_a_real_key" };
const mockObserve = jest.fn(), mockCollect = jest.fn(), mockReconcile = jest.fn();
const mockReadReservation = jest.fn(), mockReadPublication = jest.fn();
const mockStripe = { invoices: { list: jest.fn() } };
jest.mock("stripe", () => ({ __esModule: true, default: jest.fn(() => mockStripe) }));
jest.mock("@/lib/installments/contextServer", () => ({ exactContextServerConfig: jest.fn(() => mockConfig) }));
jest.mock("@/lib/installments/contextRuntime", () => ({
  createExactContextRuntime: () => ({ observeContext: mockObserve }),
  createExactContextInvoiceCollection: () => ({ collectInvoice: mockCollect }),
  createExactContextBankVerification: () => ({ checkPayment: mockReconcile }),
}));
jest.mock("@/lib/installments/contextReservation", () => ({ readExactContextReservation: (...args: unknown[]) => mockReadReservation(...args) }));
jest.mock("@/lib/installments/contextCheckoutApp", () => ({ readContextCheckoutPayments: (...args: unknown[]) => mockReadPublication(...args) }));
import { collectContextMonthlyBooking } from "@/lib/installments/contextMonthlyCollection";
import type { SupabaseClient } from "@supabase/supabase-js";

const now = 2000000000;
let env: Record<string, string | undefined>;
let binding: Record<string, unknown>;
let reservationRow: Record<string, unknown> | null;
let agreementStatus: string;
let periods: Array<Record<string, unknown>>, claims: Array<Record<string, unknown>>, receipts: Array<Record<string, unknown>>;
const db = createMockClient(op => {
  const values: Record<string, unknown> = {
    exact_installment_context_reservations_v2: reservationRow,
    resolve_exact_context_event_v2: binding,
    exact_installment_agreements: { status: agreementStatus },
    exact_installment_periods: periods,
    exact_installment_invoice_claims: claims,
    exact_installment_receipts: receipts,
  };
  return { data: values[op.table] ?? null, error: null };
});
const run = () => collectContextMonthlyBooking(db as unknown as SupabaseClient, bookingId, env);
function invoice(overrides: Record<string, unknown> = {}) {
  return { id: "in_duefixture", livemode: false, customer: "cus_ownedfixture", currency: "usd",
    parent: { subscription_details: { subscription: "sub_ownedfixture" } }, billing_reason: "subscription_cycle",
    status: "draft", auto_advance: false, amount_paid: 0,
    lines: { has_more: false, data: [{ parent: { type: "subscription_item_details", subscription_item_details: { proration: false } },
      period: { start: now - 100, end: now + 100 } }] }, ...overrides };
}
beforeEach(() => {
  jest.clearAllMocks(); db.ops.length = 0;
  jest.spyOn(Date, "now").mockReturnValue(now * 1000);
  env = { CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY: "true",
    CREATOR_EXACT_INSTALLMENTS_CONTEXT_MONTHLY_WORKER_READY: "true",
    CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY: "true",
    CREATOR_EXACT_INSTALLMENTS_CONTEXT_CHECKOUT_BOOKING_IDS: bookingId };
  reservationRow = { id: reservationId, booking_id: bookingId };
  mockReadReservation.mockReturnValue({ id: reservationId, bookingId, context: mockContext,
    terms: { creatorId, buyerId, paymentCount: 3 } });
  mockObserve.mockResolvedValue({ contextEvidence: { fixture: true } });
  mockReadPublication.mockResolvedValue([{ id: reservationId, stripe_checkout_session_id: "cs_publishedfixture" }]);
  binding = { reservationId, creatorId, buyerId, context: mockContext, sessionId: "cs_publishedfixture",
    subscriptionId: "sub_ownedfixture", customerId: "cus_ownedfixture", firstCredited: true };
  agreementStatus = "active";
  periods = [2, 3].map((number, index) => ({ agreement_id: reservationId, payment_number: number,
    due_at: now - 100 + 200 * index, period_end: now + 100 + 200 * index }));
  claims = []; receipts = [];
  mockStripe.invoices.list.mockResolvedValue({ data: [invoice()], has_more: false });
  mockCollect.mockResolvedValue({ status: "credited" });
  mockReconcile.mockResolvedValue({ status: "already_credited" });
});
afterEach(() => jest.restoreAllMocks());
const noDispatch = () => { expect(mockCollect).not.toHaveBeenCalled(); expect(mockReconcile).not.toHaveBeenCalled(); };

test.each(["CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY", "CREATOR_EXACT_INSTALLMENTS_CONTEXT_MONTHLY_WORKER_READY",
  "CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY"])("#3 worker gate %s fails before provider observation", async key => {
  env[key] = "false"; await expect(run()).rejects.toThrow(); expect(mockObserve).not.toHaveBeenCalled(); noDispatch();
});
test.each(["", "invalid", `${bookingId},${bookingId}`, creatorId])("#3 rejects unselected or invalid booking lists %s", async selected => {
  env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_CHECKOUT_BOOKING_IDS = selected;
  await expect(run()).rejects.toThrow(); expect(mockObserve).not.toHaveBeenCalled(); noDispatch();
});
test("#3 absent reservation, unpublished Checkout, and uncredited first payment cannot collect", async () => {
  reservationRow = null; expect(await run()).toEqual({ status: "nothing_due" });
  reservationRow = { id: reservationId }; mockReadPublication.mockResolvedValue([]);
  expect(await run()).toEqual({ status: "nothing_due" });
  mockReadPublication.mockResolvedValue([{ id: reservationId, stripe_checkout_session_id: "cs_publishedfixture" }]);
  binding.firstCredited = false; expect(await run()).toEqual({ status: "nothing_due" });
  expect(mockStripe.invoices.list).not.toHaveBeenCalled(); noDispatch();
});
test.each(["reservationId", "creatorId", "buyerId", "sessionId", "context"])("#3 refuses resolver substitution for %s", async field => {
  binding[field] = "different"; await expect(run()).rejects.toThrow(); noDispatch();
});
test("#3 the actual discovery selects one due invoice and delegates to the existing claimed collector", async () => {
  expect(await run()).toEqual({ status: "credited" });
  expect(mockStripe.invoices.list).toHaveBeenCalledWith({ subscription: "sub_ownedfixture", limit: 100 });
  expect(mockCollect).toHaveBeenCalledTimes(1);
  expect(mockCollect).toHaveBeenCalledWith(reservationId, creatorId, "in_duefixture");
  expect(mockReconcile).not.toHaveBeenCalled();
  expect(db.ops.filter(op => ["insert", "update", "delete"].includes(op.kind))).toEqual([]);
});
test("#3 an admitted payment goes only to bank reconciliation, never a second collection", async () => {
  claims = [{ agreement_id: reservationId, payment_number: 2, stripe_invoice_id: "in_duefixture", dispatch_started_at: "recorded" }];
  expect(await run()).toEqual({ status: "already_credited" });
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(mockReconcile).toHaveBeenCalledWith(reservationId, buyerId, "in_duefixture");
  expect(mockCollect).not.toHaveBeenCalled();
});
test("#3 the next future month is not charged after the due receipt was counted", async () => {
  receipts = [{ agreement_id: reservationId, payment_number: 2, counted_at: "recorded" }];
  expect(await run()).toEqual({ status: "nothing_due" }); expect(mockStripe.invoices.list).not.toHaveBeenCalled(); noDispatch();
});
test("#3 a missing invoice waits without fabricating one", async () => {
  mockStripe.invoices.list.mockResolvedValue({ data: [], has_more: false });
  expect(await run()).toEqual({ status: "waiting_for_invoice" }); noDispatch();
});
test.each([{ livemode: true }, { customer: "cus_other" }, { currency: "eur" }, { auto_advance: true }, { amount_paid: 1 }])(
  "#3 uncertain invoice evidence %p requires review without a debit", async changes => {
    mockStripe.invoices.list.mockResolvedValue({ data: [invoice(changes)], has_more: false });
    expect(await run()).toEqual({ status: "review_required" }); noDispatch();
  });
test("#3 duplicated due-period invoices are not arbitrarily selected", async () => {
  mockStripe.invoices.list.mockResolvedValue({ data: [invoice(), invoice({ id: "in_duplicatefixture" })], has_more: false });
  expect(await run()).toEqual({ status: "review_required" }); noDispatch();
});
test("#3 stopped plans never initiate a renewal debit", async () => {
  agreementStatus = "canceled"; expect(await run()).toEqual({ status: "nothing_due" }); noDispatch();
});
test("#3 unavailable provider evidence fails closed without a collection retry", async () => {
  mockStripe.invoices.list.mockRejectedValue(new Error("Synthetic transport failure"));
  await expect(run()).rejects.toThrow("evidence unavailable"); noDispatch();
});
