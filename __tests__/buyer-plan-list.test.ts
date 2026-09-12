import { listBuyerPaymentPlans } from "../lib/installments/buyerPlanList";
import { buyerRecoveryEnabled } from "../lib/installments/buyerRecovery";
import { exactContextServerConfig } from "../lib/installments/contextServer";
const buyer = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const context = { mode: "test", platformAccountId: "acct_Local" }, env = {
  CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RECOVERY_READY: "true", CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY: "true" };
jest.mock("../lib/installments/buyerRecovery", () => ({ buyerRecoveryEnabled: jest.fn(() => false) }));
jest.mock("../lib/installments/contextServer", () => ({ exactContextServerConfig: jest.fn(() => ({ approvedContext: context })) }));
let terms: Record<string, unknown>, agreement: Record<string, unknown>, binding: Record<string, unknown>, count: number;
let calls: Array<{ table: string; method: string; args: unknown[] }>;
let dbError: boolean;
const db = { from: (table: string) => {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order", "range"]) chain[method] = (...args: unknown[]) => {
    calls.push({ table, method, args }); return chain;
  };
  chain.then = (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => Promise.resolve({
    data: [table === "exact_installment_agreements" ? agreement : binding], count, error: dbError ? Error("Synthetic") : null,
  }).then(ok, fail);
  return chain;
} };
beforeEach(() => {
  jest.clearAllMocks(); calls = []; count = 1; dbError = false;
  terms = { buyerId: buyer, title: "Synthetic mentorship", version: "exact-cents-context-v2" };
  agreement = { id, terms: { ...terms, bookingPaymentId: id }, first_fulfilled_at: "2026-09-09T00:00:00Z" };
  binding = { id, terms, context };
  jest.mocked(buyerRecoveryEnabled).mockReturnValue(false);
  jest.mocked(exactContextServerConfig).mockReturnValue({ approvedContext: context } as never);
});
const run = (page = 1, e = env) => listBuyerPaymentPlans(db as never, buyer, page, e);
test("#3 owned Library navigation includes only recorded first-credit plans and no financial/provider payload", async () => {
  expect(await run()).toEqual({ plans: [{ id, title: terms.title }], hasMore: false });
  for (const table of ["exact_installment_agreements", "exact_installment_context_reservations_v2"])
    expect(calls).toContainEqual({ table, method: "eq", args: ["terms->>buyerId", buyer] });
  expect(calls).toContainEqual({ table: "exact_installment_agreements", method: "not", args: ["first_fulfilled_at", "is", null] });
  expect(calls.some(c => /purchase|access/.test(JSON.stringify(c)))).toBe(false);
});
test.each(["owner", "binding-owner", "context", "title", "uncredited", "db"])("#3 plan-list %s mismatch cannot expose a link", async fault => {
  if (fault === "owner") agreement.terms = { ...terms, buyerId: id };
  if (fault === "binding-owner") binding.terms = { ...terms, buyerId: id };
  if (fault === "context") binding.context = { ...context, platformAccountId: "acct_Other" };
  if (fault === "title") agreement.terms = { ...terms, title: "" };
  if (fault === "uncredited") agreement.first_fulfilled_at = null;
  if (fault === "db") dbError = true;
  await expect(run()).rejects.toThrow();
});
test("#3 fixed pagination does not silently discard older plans", async () => {
  count = 101; expect((await run(2)).hasMore).toBe(true);
  expect(calls).toContainEqual({ table: "exact_installment_agreements", method: "range", args: [50, 99] });
});
test.each([0, -1, 1.5, NaN, 10001])("#3 invalid plan page %s reads nothing", async page => {
  await expect(run(page)).rejects.toThrow(); expect(calls).toEqual([]);
});
test("#3 disabled context and old controls read nothing", async () => {
  await expect(run(1, { ...env, CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RECOVERY_READY: "false" })).rejects.toThrow();
  expect(calls).toEqual([]);
});
test("#3 retained v1 plan navigation never reads a v2 table when only legacy recovery is enabled", async () => {
  jest.mocked(buyerRecoveryEnabled).mockReturnValue(true);
  agreement.terms = { ...terms, version: "exact-cents-held-v1" };
  expect((await run(1, { ...env, CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RECOVERY_READY: "false" })).plans).toHaveLength(1);
  expect(calls.every(c => c.table === "exact_installment_agreements")).toBe(true);
});
