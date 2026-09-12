/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { checkoutRecoveryFixture } from "../test-support/membership-checkout-recovery-fixtures";
let mockParams = new URLSearchParams();
jest.mock("next/navigation", () => ({ useSearchParams: () => mockParams }));
import Page from "@/app/memberships/recovery/page";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch, mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
let root: Root, container: HTMLDivElement;
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!;
const box = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const render = async () => act(async () => root.render(createElement(Page)));
beforeEach(() => { jest.clearAllMocks(); mockParams = new URLSearchParams({ membership_id: checkoutRecoveryFixture().a.id });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); globalThis.fetch = mockFetch; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
test("steps 4/5: unpaid close-out is separately unchecked and never starts a replacement payment", async () => {
  const f = checkoutRecoveryFixture(), reviewUrl = "/memberships/review?product_id=" + f.a.product_id + "&post_id=" + f.a.post_id;
  mockFetch.mockResolvedValueOnce(response({ ...f.projection, canAbandon: true })).mockResolvedValueOnce(response({
    ...f.projection, status: "abandoned", canResume: false, canAbandon: false, reviewUrl }));
  await render(); const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(boxes).toHaveLength(2); expect(boxes[1].checked).toBe(false); expect(button("Close unpaid checkout").disabled).toBe(true);
  await act(async () => boxes[0].click()); expect(button("Close unpaid checkout").disabled).toBe(true);
  await act(async () => boxes[1].click()); await act(async () => button("Close unpaid checkout").click());
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ action: "abandon", confirmed: true });
  expect(container.textContent).toContain("No first payment or access was recorded");
  expect(container.querySelector('a[href="' + reviewUrl + '"]')).not.toBeNull();
  expect(button("Resume original checkout")).toBeUndefined(); expect(mockFetch).toHaveBeenCalledTimes(2);
});
test("step 8: an incomplete close-out shows pending review without a replacement-purchase link", async () => {
  const f = checkoutRecoveryFixture(); mockFetch.mockResolvedValueOnce(response({ ...f.projection, status: "abandon_pending", canResume: false, canAbandon: true }));
  await render(); expect(container.textContent).toContain("Do not make a replacement purchase yet");
  expect(container.querySelector('a[href^="/memberships/review"]')).toBeNull(); expect(button("Close unpaid checkout").disabled).toBe(true);
});
test.each(["https://other.example.invalid/review", "/memberships/review?product_id=bad&post_id=bad", "//other.example.invalid/memberships/review"])(
  "step 5: unsafe fresh-review destination %s cannot be offered", async reviewUrl => {
    mockFetch.mockResolvedValueOnce(response({ ...checkoutRecoveryFixture().projection, status: "abandoned", canResume: false, canAbandon: false, reviewUrl }));
    await render(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("review destination");
  });
test("step 8: contradictory abandoned-and-paid evidence is rejected", async () => {
  mockFetch.mockResolvedValueOnce(response({ ...checkoutRecoveryFixture().projection, status: "abandoned", canResume: false, accessGranted: true }));
  await render(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("evidence needs review");
});
test("steps 4/5: initial visit only reconciles; original checkout resumption requires separate unchecked intent", async () => {
  const f = checkoutRecoveryFixture(); mockFetch.mockResolvedValueOnce(response(f.projection)).mockResolvedValueOnce(response({ ...f.projection, url: "https://checkout.stripe.com/c/pay/original" }));
  await render(); expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ action: "reconcile" });
  expect(box().checked).toBe(false); expect(button("Resume original checkout").disabled).toBe(true);
  expect(container.textContent).toContain("$100.00"); expect(container.textContent).toContain("$300.00");
  await act(async () => box().click()); await act(async () => button("Resume original checkout").click());
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ action: "resume", confirmed: true });
  expect(container.querySelector('a[href="https://checkout.stripe.com/c/pay/original"]')).not.toBeNull();
});
test.each(["review_required", "expired_unpaid", "payment_pending"])("step 8: %s never offers a new payable checkout", async status => {
  mockFetch.mockResolvedValueOnce(response({ ...checkoutRecoveryFixture().projection, status, canResume: false })); await render();
  expect(box()).toBeNull(); expect(button("Resume original checkout")).toBeUndefined(); expect(mockFetch).toHaveBeenCalledTimes(1);
});
test("step 8: paid result links to the original receipt and does not expose another payment", async () => {
  const f = checkoutRecoveryFixture(); mockFetch.mockResolvedValueOnce(response({ ...f.projection, status: "paid", canResume: false, firstPaymentRecorded: true, accessGranted: true })); await render();
  expect(container.querySelector('a[href="/memberships/complete?membership_id=' + f.a.id + '"]')).not.toBeNull(); expect(box()).toBeNull();
});
test("step 4: rechecking clears earlier intent", async () => {
  mockFetch.mockResolvedValue(response(checkoutRecoveryFixture().projection)); await render(); await act(async () => box().click());
  await act(async () => button("Check again").click()); expect(box().checked).toBe(false); expect(button("Resume original checkout").disabled).toBe(true);
});
test.each(["javascript:alert(1)", "https://other.example.invalid/pay"])("step 5: unsafe destination %s is not offered to the buyer", async url => {
  const f = checkoutRecoveryFixture(); mockFetch.mockResolvedValueOnce(response(f.projection)).mockResolvedValueOnce(response({ ...f.projection, url })); await render();
  await act(async () => box().click()); await act(async () => button("Resume original checkout").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Invalid recovered payment destination");
});
test("step 5: missing membership identity cannot query another account", async () => {
  mockParams = new URLSearchParams(); await render(); expect(mockFetch).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("owned membership");
});
test("step 8: URL payment flags are not payment evidence", async () => {
  const f = checkoutRecoveryFixture(); mockParams.set("paid", "true"); mockParams.set("session_id", "cs_fake");
  mockFetch.mockResolvedValueOnce(response({ ...f.projection, status: "payment_pending", canResume: false })); await render();
  expect(container.textContent).toContain("Payment is not confirmed yet"); expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ action: "reconcile" });
});
test("step 8: recovery failure remains visible rather than becoming an empty or successful account", async () => {
  mockFetch.mockResolvedValueOnce(response({ error: "Recovery needs retry." }, false)); await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Recovery needs retry."); expect(button("Check again")).toBeDefined();
});
