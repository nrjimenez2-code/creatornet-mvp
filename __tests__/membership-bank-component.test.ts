/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MembershipRenewalRecoveryResult } from "@/lib/membershipRenewalRecovery";
const mockConfirm = jest.fn(), mockLoadStripe = jest.fn();
jest.mock("@stripe/stripe-js", () => ({ loadStripe: (key: string) => mockLoadStripe(key) }));
import Component from "@/components/MonthlyBankVerification";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch, mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
let root: Root, container: HTMLDivElement;
const payment: MembershipRenewalRecoveryResult = { membershipId: "40000000-0000-4000-8000-000000000001", invoiceId: "in_original",
  month: 2, amountCents: 10000, periodStart: 1788220800, periodEnd: 1790812800, outcome: "action_required" };
const challenge = () => ({ ...payment, status: "bank_verification_ready", publishableKey: "pk_test_fixture", clientSecret: "pi_original_secret_fixture" });
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const onChecked = jest.fn(), button = () => container.querySelector("button")!;
const render = async () => act(async () => root.render(createElement(Component, { payment, onChecked })));
beforeEach(() => { jest.clearAllMocks(); container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container); globalThis.fetch = mockFetch; mockLoadStripe.mockResolvedValue({ confirmCardPayment: mockConfirm });
  mockConfirm.mockResolvedValue({ paymentIntent: { status: "succeeded" } }); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
test("steps 4/5: loading the screen never starts bank authentication", async () => {
  await render(); expect(mockFetch).not.toHaveBeenCalled(); expect(mockLoadStripe).not.toHaveBeenCalled(); expect(mockConfirm).not.toHaveBeenCalled();
});
test("steps 1/5/8: explicit click authenticates only the original attached payment and then checks the server receipt", async () => {
  mockFetch.mockResolvedValueOnce(response(challenge())).mockResolvedValueOnce(response({ ...payment, outcome: "paid_accounted" }));
  await render(); await act(async () => button().click());
  expect(mockConfirm).toHaveBeenCalledWith("pi_original_secret_fixture"); expect(mockConfirm.mock.calls[0]).toHaveLength(1);
  expect(mockFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { action: "challenge", invoiceId: "in_original" }, { action: "status", invoiceId: "in_original" }]);
  expect(onChecked).toHaveBeenCalledWith({ ...payment, outcome: "paid_accounted" });
  expect(container.innerHTML).not.toContain("_secret_"); expect(JSON.stringify(mockFetch.mock.calls)).not.toContain("_secret_");
});
test("step 8: SDK success alone cannot become a paid receipt", async () => {
  mockFetch.mockResolvedValueOnce(response(challenge())).mockResolvedValueOnce(response({ ...payment, outcome: "payment_pending" }));
  await render(); await act(async () => button().click());
  expect(onChecked).toHaveBeenCalledWith({ ...payment, outcome: "payment_pending" }); expect(container.textContent).not.toContain("Payment recorded");
});
test.each(["membershipId", "invoiceId", "month", "amountCents", "periodEnd", "clientSecret", "publishableKey"])(
  "step 8: contradictory challenge %s cannot reach Stripe.js", async field => {
    const value = { ...challenge() } as Record<string, unknown>; value[field] = typeof value[field] === "number" ? Number(value[field]) + 1 : "other";
    mockFetch.mockResolvedValueOnce(response(value)).mockResolvedValueOnce(response(payment));
    await render(); await act(async () => button().click()); expect(mockConfirm).not.toHaveBeenCalled();
  });
test("step 8: a canceled challenge checks the original payment without a new payment request", async () => {
  mockConfirm.mockResolvedValueOnce({ error: { message: "Synthetic cancel" } });
  mockFetch.mockResolvedValueOnce(response(challenge())).mockResolvedValueOnce(response(payment));
  await render(); await act(async () => button().click()); expect(onChecked).toHaveBeenCalledWith(payment);
  expect(container.textContent).toContain("not completed"); expect(mockConfirm).toHaveBeenCalledTimes(1);
});
test("step 8: rapid repeated clicks cannot start parallel SDK challenges", async () => {
  let finish!: (value: unknown) => void;
  mockConfirm.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  mockFetch.mockResolvedValueOnce(response(challenge())).mockResolvedValueOnce(response(payment));
  await render(); await act(async () => { button().click(); button().click(); });
  expect(mockConfirm).toHaveBeenCalledTimes(1); expect(button().disabled).toBe(true);
  await act(async () => finish({ error: { message: "Canceled" } }));
});
test("step 5: unmount before SDK load completes prevents capability use", async () => {
  let finish!: (value: unknown) => void;
  mockLoadStripe.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  mockFetch.mockResolvedValueOnce(response(challenge()));
  await render(); await act(async () => button().click()); await act(async () => root.render(null));
  await act(async () => finish({ confirmCardPayment: mockConfirm })); expect(mockConfirm).not.toHaveBeenCalled();
});
test("step 8: a foreign status response does not become payment evidence", async () => {
  mockFetch.mockResolvedValueOnce(response(challenge())).mockResolvedValue(response({ ...payment, membershipId: "other", outcome: "paid_accounted" }));
  await render(); await act(async () => button().click()); expect(onChecked).not.toHaveBeenCalled();
  expect(container.textContent).toContain("not confirmed here");
});
