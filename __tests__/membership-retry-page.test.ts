/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MONTHLY_RETRY_CONSENT_TEXT, MONTHLY_RETRY_CONSENT_VERSION, MONTHLY_FUTURE_CARD_CONSENT_TEXT, MONTHLY_FUTURE_CARD_CONSENT_VERSION } from "@/lib/membershipRetryConsent";
let mockParams = new URLSearchParams();
jest.mock("next/navigation", () => ({ useSearchParams: () => mockParams }));
import Page from "@/app/memberships/renewal-retry/page";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch, mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
let root: Root, container: HTMLDivElement;
const id = "30000000-0000-4000-8000-000000000001", setup = "30000000-0000-4000-8000-000000000002", quote = "30000000-0000-4000-8000-000000000003";
const initial = () => ({ membershipId: id, confirmed: false, useFutureCard: null, retryRequested: false,
  quote: { version: "monthly-retry-quote-v1", id: quote, membershipId: id, setupId: setup, title: "Monthly mentorship", amountCents: 10000, currency: "usd",
    month: 2, minimumMonths: 3, autoRenew: true, canUseForFuture: true, periodStart: Math.floor(Date.now() / 1000) - 100,
    periodEnd: Math.floor(Date.now() / 1000) + 3000, expiresAt: Math.floor(Date.now() / 1000) + 600,
    consentVersion: MONTHLY_RETRY_CONSENT_VERSION, consentText: MONTHLY_RETRY_CONSENT_TEXT,
    futureConsentVersion: MONTHLY_FUTURE_CARD_CONSENT_VERSION, futureConsentText: MONTHLY_FUTURE_CARD_CONSENT_TEXT } });
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!;
const boxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
const render = async () => act(async () => root.render(createElement(Page)));
beforeEach(() => { jest.clearAllMocks(); mockParams = new URLSearchParams({ membership_id: id, setup_id: setup });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); globalThis.fetch = mockFetch; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
test("steps 4/5: initial review does not pay and both consent choices start unchecked", async () => {
  mockFetch.mockResolvedValueOnce(response(initial())); await render();
  expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ action: "review", setupId: setup });
  expect(boxes().map(b => b.checked)).toEqual([false, false]); expect(button("Confirm original payment retry").disabled).toBe(true);
  expect(container.textContent).toContain("$100.00"); expect(container.textContent).toContain(MONTHLY_RETRY_CONSENT_TEXT);
});
test.each([false, true])("step 4: explicit retry forwards independent future-card choice %s", async future => {
  const v = initial(); mockFetch.mockResolvedValueOnce(response(v)).mockResolvedValueOnce(response({ ...v, confirmed: true, useFutureCard: future, retryRequested: true }));
  await render(); await act(async () => boxes()[0].click()); if (future) await act(async () => boxes()[1].click());
  await act(async () => button("Confirm original payment retry").click());
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ action: "pay", quoteId: quote, accepted: true,
    consentVersion: MONTHLY_RETRY_CONSENT_VERSION, useFutureCard: future, futureConsentVersion: future ? MONTHLY_FUTURE_CARD_CONSENT_VERSION : null });
  expect(button("Confirm original payment retry")).toBeUndefined(); expect(container.textContent).toContain("already been requested");
});
test("step 8: ambiguous payment failure disables payment until an explicit original-status check", async () => {
  const v = initial(); mockFetch.mockResolvedValueOnce(response(v)).mockRejectedValueOnce(Error("Synthetic transport loss"))
    .mockResolvedValueOnce(response({ ...v, confirmed: true, useFutureCard: false, retryRequested: true }));
  await render(); await act(async () => boxes()[0].click()); await act(async () => button("Confirm original payment retry").click());
  expect(button("Confirm original payment retry").disabled).toBe(true); expect(container.textContent).toContain("result is uncertain");
  await act(async () => button("Check original payment status").click());
  expect(JSON.parse(String(mockFetch.mock.calls[2][1]?.body))).toEqual({ action: "status", quoteId: quote });
  expect(mockFetch.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).action === "pay")).toHaveLength(1);
});
test("step 4: a confirmed choice is displayed and cannot silently change on refresh", async () => {
  mockFetch.mockResolvedValueOnce(response({ ...initial(), confirmed: true, useFutureCard: true }));
  await render(); expect(boxes()[0].checked).toBe(false); expect(boxes()[1].checked).toBe(true); expect(boxes()[1].disabled).toBe(true);
});
test.each(["paid_accounted", "action_required", "payment_pending", "review_required"])("step 8: %s never offers another charge", async outcome => {
  const v = initial(); mockFetch.mockResolvedValueOnce(response({ ...v, confirmed: true, useFutureCard: false, retryRequested: true,
    renewal: { membershipId: id, invoiceId: "in_original", month: 2, amountCents: 10000, periodStart: v.quote.periodStart, periodEnd: v.quote.periodEnd, outcome } }));
  await render(); expect(button("Confirm original payment retry")).toBeUndefined(); expect(boxes()).toHaveLength(0);
});
test("step 5: a foreign quote cannot be displayed or confirmed", async () => {
  const v = initial(); mockFetch.mockResolvedValueOnce(response({ ...v, quote: { ...v.quote, membershipId: setup } }));
  await render(); expect(container.textContent).toContain("evidence needs review"); expect(boxes()).toHaveLength(0);
});
test("step 8: expired quote cannot be confirmed", async () => {
  const v = initial(); mockFetch.mockResolvedValueOnce(response({ ...v, quote: { ...v.quote, expiresAt: Math.floor(Date.now() / 1000) - 1 } }));
  await render(); expect(container.textContent).toContain("quote expired"); expect(button("Confirm original payment retry")).toBeUndefined();
});
