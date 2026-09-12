/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { productPurchaseTerms } from "@/lib/purchaseConsent";
let mockParams = new URLSearchParams("product_id=owned-product");
jest.mock("next/navigation", () => ({ useSearchParams: () => mockParams }));
import PurchaseReviewPage from "@/app/purchase/review/page";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: Root, container: HTMLDivElement;
const mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const quote = (kind = "course", amount = 10000) => productPurchaseTerms({ id: "owned-product", creator_id: "owned-creator",
  title: "Owned offer", type: kind, description: "Promised service", price_cents: amount, currency: "usd" }, "signed-in-buyer", null);
beforeEach(() => {
  mockParams = new URLSearchParams("product_id=owned-product"); mockFetch.mockReset(); globalThis.fetch = mockFetch;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
const render = async () => { await act(async () => root.render(createElement(PurchaseReviewPage))); };
const button = (text: string) => [...container.querySelectorAll("button")].find(value => value.textContent === text)!;

test("#6 actual review renders server price and policy while explicit acceptance starts unchecked", async () => {
  mockFetch.mockResolvedValueOnce(reply(quote())); await render();
  expect(container.textContent).toContain("$100.00"); expect(container.textContent).toContain("Promised service");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  expect(button("Agree and continue to payment").disabled).toBe(true);
  expect(container.querySelector('a[href="/legal/purchase-agreement"]')).not.toBeNull();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
test("#6 explicit acceptance sends only the displayed fingerprint, not a browser price or buyer identity", async () => {
  const displayed = quote("call");
  mockFetch.mockResolvedValueOnce(reply(displayed)).mockImplementationOnce(() => new Promise<Response>(() => {}));
  await render(); expect(container.textContent).toContain(displayed.terms.policy.calls);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Agree and continue to payment").click());
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(mockFetch.mock.calls[1][0]).toBe("/api/checkout");
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ type: "product", product_id: "owned-product",
    purchase_consent: { accepted: true, version: displayed.terms.version, fingerprint: displayed.fingerprint } });
  expect(button("Opening checkout...").disabled).toBe(true);
});
test("#6 loading failure offers a working retry without accepting terms", async () => {
  mockFetch.mockResolvedValueOnce(reply({ error: "Offer temporarily unavailable" }, false)).mockResolvedValueOnce(reply(quote()));
  await render(); expect(container.querySelector('[role="alert"]')?.textContent).toBe("Offer temporarily unavailable");
  await act(async () => button("Reload offer").click());
  expect(container.textContent).toContain("$100.00"); expect(button("Agree and continue to payment").disabled).toBe(true);
});
test("#6 a stale-price refusal can reload the current offer and requires a new explicit acceptance", async () => {
  mockFetch.mockResolvedValueOnce(reply(quote())).mockResolvedValueOnce(reply({ error: "Review and accept the current purchase terms before payment." }, false))
    .mockResolvedValueOnce(reply(quote("course", 12000)));
  await render(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Agree and continue to payment").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("current purchase terms");
  await act(async () => button("Review current offer").click());
  expect(container.textContent).toContain("$120.00"); expect(container.textContent).not.toContain("$100.00");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  expect(button("Agree and continue to payment").disabled).toBe(true);
});
test("#6 changing the selected offer never carries over the prior checkbox acceptance", async () => {
  mockFetch.mockResolvedValueOnce(reply(quote())).mockResolvedValueOnce(reply(quote("course", 15000)));
  await render(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  mockParams = new URLSearchParams("product_id=second-product"); await render();
  expect(container.textContent).toContain("$150.00"); expect(button("Agree and continue to payment").disabled).toBe(true);
});
test("#6 an unsafe checkout URL is refused instead of navigating", async () => {
  mockFetch.mockResolvedValueOnce(reply(quote())).mockResolvedValueOnce(reply({ url: "javascript:alert(1)" }));
  await render(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Agree and continue to payment").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Invalid checkout destination.");
});

test("timed review displays service length and payment independence before acceptance", async () => {
  const timed = productPurchaseTerms({ id: "owned-product", creator_id: "owned-creator", type: "mentorship",
    title: "Ten month mentorship", price_cents: 10000, fixed_service_months: 10 }, "signed-in-buyer", null);
  mockFetch.mockResolvedValueOnce(reply(timed)); await render();
  expect(container.textContent).toContain("10 calendar months from the first captured payment, independent of payment count.");
  expect(container.textContent).toContain("One payment for the listed offer");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
});

