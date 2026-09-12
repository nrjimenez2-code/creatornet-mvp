/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MONTHLY_CARD_SETUP_CONSENT_TEXT, MONTHLY_CARD_SETUP_CONSENT_VERSION } from "@/lib/membershipCardSetupConsent";
let mockParams = new URLSearchParams();
jest.mock("next/navigation", () => ({ useSearchParams: () => mockParams }));
import Page from "@/app/memberships/renewal-recovery/page";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch, mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
let root: Root, container: HTMLDivElement;
const id = "20000000-0000-4000-8000-000000000001", setup = "20000000-0000-4000-8000-000000000002";
const initial = () => ({ membershipId: id, renewal: { membershipId: id, invoiceId: "in_fixture", month: 2, amountCents: 10000,
  periodStart: 1788220800, periodEnd: 1790812800, outcome: "payment_method_required" }, setup: null });
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!;
const box = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const render = async () => act(async () => root.render(createElement(Page)));
beforeEach(() => { jest.clearAllMocks(); mockParams = new URLSearchParams({ membership_id: id });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); globalThis.fetch = mockFetch; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
test("steps 4/5: visiting only checks status and setup consent starts unchecked", async () => {
  mockFetch.mockResolvedValueOnce(response(initial())); await render();
  expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ action: "status" });
  expect(box().checked).toBe(false); expect(button("Prepare secure card setup").disabled).toBe(true);
  expect(container.textContent).toContain(MONTHLY_CARD_SETUP_CONSENT_TEXT); expect(container.textContent).toContain("$100.00");
});
test("step 4: accepting setup consent creates only a secure setup handoff", async () => {
  mockFetch.mockResolvedValueOnce(response(initial())).mockResolvedValueOnce(response({
    membershipId: id, setupId: setup, status: "setup_pending", url: "https://checkout.stripe.com/c/pay/cs_test_setup" }))
    .mockResolvedValueOnce(response({ ...initial(), setup: { id: setup, status: "setup_pending" } }));
  await render(); await act(async () => box().click()); await act(async () => button("Prepare secure card setup").click());
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ action: "setup", accepted: true, consentVersion: MONTHLY_CARD_SETUP_CONSENT_VERSION });
  expect(container.querySelector('a[href="https://checkout.stripe.com/c/pay/cs_test_setup"]')).not.toBeNull();
  expect(mockFetch.mock.calls.some(([, init]) => JSON.parse(String(init?.body)).action === "pay")).toBe(false);
});
test("step 5: card verification stays separate from a payment retry", async () => {
  mockFetch.mockResolvedValueOnce(response({ ...initial(), setup: { id: setup, status: "setup_pending" } }))
    .mockResolvedValueOnce(response({ membershipId: id, setupId: setup, status: "card_saved_payment_not_attempted" }))
    .mockResolvedValueOnce(response({ ...initial(), setup: { id: setup, status: "card_saved_payment_not_attempted" } }));
  await render(); await act(async () => button("Check saved card").click());
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ action: "verify", setupId: setup });
  expect(container.textContent).toContain("No payment was attempted"); expect(box()).toBeNull();
});
test.each(["payment_pending", "action_required", "paid_accounted", "terminal_unpaid", "review_required"])("step 8: %s does not offer setup consent", async outcome => {
  mockFetch.mockResolvedValueOnce(response({ ...initial(), renewal: { ...initial().renewal, outcome } })); await render();
  expect(box()).toBeNull(); expect(button("Prepare secure card setup")).toBeUndefined();
});
test("step 5: a foreign membership result is not displayed as owned recovery", async () => {
  mockFetch.mockResolvedValueOnce(response({ ...initial(), membershipId: setup })); await render();
  expect(container.textContent).toContain("ownership differs"); expect(box()).toBeNull();
});
test("step 8: an untrusted handoff URL is not displayed", async () => {
  mockFetch.mockResolvedValueOnce(response(initial())).mockResolvedValueOnce(response({
    membershipId: id, setupId: setup, status: "setup_pending", url: "https://other.example.invalid/c/pay/setup" }))
    .mockResolvedValueOnce(response({ ...initial(), setup: { id: setup, status: "setup_pending" } }));
  await render(); await act(async () => box().click()); await act(async () => button("Prepare secure card setup").click());
  expect(container.textContent).toContain("Invalid secure card setup destination");
  expect(container.querySelector('a[href^="https://other.example.invalid"]')).toBeNull();
});

