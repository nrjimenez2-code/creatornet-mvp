/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { membershipFixture } from "../test-support/membership-fixtures";
let mockParams = new URLSearchParams();
jest.mock("next/navigation", () => ({ useSearchParams: () => mockParams }));
import ReviewPage from "@/app/memberships/review/page";
import CompletePage from "@/app/memberships/complete/page";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch, mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
let root: Root, container: HTMLDivElement;
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
beforeEach(() => {
  const f = membershipFixture(); mockParams = new URLSearchParams({ product_id: f.a.product_id, post_id: f.a.post_id });
  mockFetch.mockReset(); globalThis.fetch = mockFetch; container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
const render = async (page = ReviewPage) => { await act(async () => root.render(createElement(page))); };
const button = (text: string) => [...container.querySelectorAll("button")].find(value => value.textContent === text)!;
test("steps 1/4/5: monthly review shows server minimum, renewal and separate payoff consent", async () => {
  mockFetch.mockResolvedValueOnce(reply(membershipFixture().quote)); await render();
  expect(container.textContent).toContain("$100.00 today"); expect(container.textContent).toContain("3-month minimum: $300.00");
  expect(container.textContent).toContain("does not authorize a separate early-exit payoff");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  expect(button("Agree and continue to payment").disabled).toBe(true);
});
test("step 4: explicit consent sends the displayed fingerprint, not price or buyer identity", async () => {
  const f = membershipFixture(); mockFetch.mockResolvedValueOnce(reply(f.quote)).mockImplementationOnce(() => new Promise<Response>(() => {}));
  await render(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Agree and continue to payment").click());
  expect(mockFetch.mock.calls[1][0]).toBe("/api/memberships/checkout");
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ product_id: f.a.product_id, post_id: f.a.post_id,
    consent: { accepted: true, version: f.a.terms.version, fingerprint: f.a.fingerprint } });
});
test("steps 4/5: quote reload after a refusal requires fresh unchecked acceptance", async () => {
  const f = membershipFixture(); mockFetch.mockResolvedValueOnce(reply(f.quote)).mockResolvedValueOnce(reply({ error: "Review current terms" }, false))
    .mockResolvedValueOnce(reply(f.quote));
  await render(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Agree and continue to payment").click()); await act(async () => button("Review current offer").click());
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  expect(button("Agree and continue to payment").disabled).toBe(true);
});
test("step 5: an unavailable quote can be retried without payment or implied consent", async () => {
  mockFetch.mockResolvedValueOnce(reply({ error: "Synthetic unavailable offer" }, false)).mockResolvedValueOnce(reply(membershipFixture().quote));
  await render(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("unavailable offer");
  await act(async () => button("Reload offer").click()); expect(button("Agree and continue to payment").disabled).toBe(true);
});
test.each(["https://unrelated.example.invalid/pay", "javascript:alert(1)"])("step 5: unexpected payment destination %s is refused", async url => {
  mockFetch.mockResolvedValueOnce(reply(membershipFixture().quote)).mockResolvedValueOnce(reply({ url })); await render();
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Agree and continue to payment").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Invalid checkout destination.");
});
test("steps 1/5: redirect query cannot imply payment and retry uses only owned membership confirmation", async () => {
  const f = membershipFixture(); mockParams = new URLSearchParams({ membership_id: f.a.id, session_id: "cs_untrusted", paid: "true" });
  const summary = { membershipId: f.a.id, title: f.a.terms.title, firstPaymentRecorded: false, accessGranted: false, paidThrough: null };
  mockFetch.mockResolvedValueOnce(reply(summary)).mockResolvedValueOnce(reply({ ...summary, firstPaymentRecorded: true, accessGranted: true }));
  await render(CompletePage); expect(container.textContent).toContain("Payment has not been confirmed yet");
  expect(mockFetch.mock.calls[0][0]).toBe(`/api/memberships/${f.a.id}/confirm`); expect(mockFetch.mock.calls[0][1]?.method).toBe("POST");
  await act(async () => button("Retry confirmation").click()); expect(container.textContent).toContain("Your first payment is recorded");
});
test("step 5: missing confirmation identity does not make a request", async () => {
  mockParams = new URLSearchParams(); await render(CompletePage); expect(mockFetch).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Open the confirmation");
});
test("step 5: confirmation failure remains retryable without offering a second purchase", async () => {
  const f = membershipFixture(); mockParams = new URLSearchParams({ membership_id: f.a.id });
  mockFetch.mockResolvedValueOnce(reply({ error: "Synthetic confirmation retry" }, false)); await render(CompletePage);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("confirmation retry"); expect(button("Retry confirmation")).toBeDefined();
  expect(container.querySelector('a[href*="checkout"]')).toBeNull();
});
