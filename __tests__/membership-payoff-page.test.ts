/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { membershipPayoffFixture } from "../test-support/membership-payoff-fixtures";
let mockParams = new URLSearchParams();
jest.mock("next/navigation", () => ({ useSearchParams: () => mockParams }));
import Page from "@/app/memberships/payoff/page";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch, mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
let root: Root, container: HTMLDivElement;
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const quote = (saved = false) => { const f = membershipPayoffFixture(); return { terms: f.p.terms, fingerprint: f.p.fingerprint,
  payoffId: saved ? f.p.id : null, status: saved ? "checkout_ready" : "quoted" }; };
beforeEach(() => { const f = membershipPayoffFixture(); mockParams = new URLSearchParams({ membership_id: f.a.id });
  mockFetch.mockReset(); globalThis.fetch = mockFetch; container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
const render = async () => { await act(async () => root.render(createElement(Page))); };
const button = (text: string) => [...container.querySelectorAll("button")].find(value => value.textContent === text)!;
const boxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
test("steps 2/4: review shows the exact separate payoff and starts with no consent", async () => {
  mockFetch.mockResolvedValueOnce(reply(quote())); await render();
  expect(container.textContent).toContain("$200.00 once"); expect(container.textContent).toContain("remaining 2 month(s)");
  expect(container.textContent).toContain("Refund rights are preserved"); expect(boxes()[0].checked).toBe(false);
  expect(button("Confirm payoff and open payment").disabled).toBe(true);
});
test("step 4: explicit payoff consent sends only the displayed identity, not a browser price", async () => {
  const q = quote(); mockFetch.mockResolvedValueOnce(reply(q)).mockImplementationOnce(() => new Promise<Response>(() => {})); await render();
  await act(async () => boxes()[0].click()); await act(async () => button("Confirm payoff and open payment").click());
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ action: "checkout", consent: { accepted: true, version: q.terms.version, fingerprint: q.fingerprint } });
});
test("step 4: quote reload after rejection resets both forms of acceptance", async () => {
  mockFetch.mockResolvedValueOnce(reply(quote(true))).mockResolvedValueOnce(reply({ error: "Refresh quote" }, false)).mockResolvedValueOnce(reply(quote(true)));
  await render(); await act(async () => { boxes()[0].click(); boxes()[1].click(); });
  await act(async () => button("Confirm payoff and open payment").click()); await act(async () => button("Review current payoff").click());
  expect(boxes().map(box => box.checked)).toEqual([false, false]); expect(button("Confirm payoff and open payment").disabled).toBe(true);
});
test.each(["javascript:alert(1)", "https://unrelated.example.invalid/pay"])("step 5: unsafe checkout URL %s is refused", async url => {
  mockFetch.mockResolvedValueOnce(reply(quote())).mockResolvedValueOnce(reply({ url })); await render();
  await act(async () => boxes()[0].click()); await act(async () => button("Confirm payoff and open payment").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Invalid checkout destination.");
});
test("step 2: abandoning a payoff needs its own explicit acceptance and preserves a prior debit stop", async () => {
  const q = quote(true); mockFetch.mockResolvedValueOnce(reply(q)).mockResolvedValueOnce(reply({ status: "abandoned", originalMonthlyPaymentsMayResume: false }));
  await render(); await act(async () => boxes()[0].click()); expect(button("Abandon payoff and keep membership").disabled).toBe(true);
  await act(async () => boxes()[1].click()); await act(async () => button("Abandon payoff and keep membership").click());
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ action: "abandon", payoff_id: q.payoffId, confirmed: true });
  expect(container.textContent).toContain("did not cancel your membership"); expect(container.textContent).toContain("stop remains in place");
});
test("step 8: query flags cannot imply payment and a pending confirmation never offers another charge", async () => {
  const f = membershipPayoffFixture(); mockParams = new URLSearchParams({ membership_id: f.a.id, payoff_id: f.p.id, confirm: "1", paid: "true", session_id: "cs_fake" });
  mockFetch.mockResolvedValueOnce(reply({ payoffId: f.p.id, payoffRecorded: false })).mockResolvedValueOnce(reply({
    payoffId: f.p.id, payoffRecorded: true, accessGranted: true, paidThrough: f.p.terms.periodEnd, providerStopped: false }));
  await render(); expect(container.textContent).toContain("has not been confirmed yet"); expect(button("Confirm payoff and open payment")).toBeUndefined();
  expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ action: "confirm", payoff_id: f.p.id });
  await act(async () => button("Retry confirmation").click()); expect(container.textContent).toContain("payment is recorded");
  expect(container.textContent).toContain("Provider stop confirmation is still pending");
});
test("step 8: paid-while-abandoning can retry confirmation instead of reopening checkout", async () => {
  const q = quote(true), result = { status: "already_paid", payoffId: q.payoffId, payoffRecorded: true,
    accessGranted: true, paidThrough: q.terms.periodEnd, providerStopped: false };
  mockFetch.mockResolvedValueOnce(reply(q)).mockResolvedValueOnce(reply(result)).mockResolvedValueOnce(reply({ ...result, providerStopped: true }));
  await render(); await act(async () => boxes()[1].click()); await act(async () => button("Abandon payoff and keep membership").click());
  expect(container.textContent).toContain("payment is recorded"); await act(async () => button("Retry confirmation").click());
  expect(JSON.parse(String(mockFetch.mock.calls[2][1]?.body))).toEqual({ action: "confirm", payoff_id: q.payoffId });
  expect(container.textContent).toContain("Future membership renewal is stopped"); expect(button("Confirm payoff and open payment")).toBeUndefined();
});
test("step 5: missing membership identity never requests another buyer's quote", async () => {
  mockParams = new URLSearchParams(); await render(); expect(mockFetch).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("owned membership");
});
test("step 8: an already recorded payoff cannot offer a second checkout", async () => {
  mockFetch.mockResolvedValueOnce(reply({ ...quote(true), status: "captured" })); await render();
  expect(button("Confirm payoff and open payment")).toBeUndefined(); expect(container.textContent).toContain("View recorded payoff");
});
test("step 2: a new-checkout pause disables payment but preserves explicit abandonment", async () => {
  const q = quote(true); mockFetch.mockResolvedValueOnce(reply({ ...q, checkoutEnabled: false })); await render();
  expect(container.querySelector('a[href*="&confirm=1"]')?.getAttribute("href")).toBe(`/memberships/payoff?membership_id=${q.terms.membershipId}&payoff_id=${q.payoffId}&confirm=1`);
  expect(boxes()[0].disabled).toBe(true); expect(button("Confirm payoff and open payment").disabled).toBe(true);
  await act(async () => boxes()[1].click()); expect(button("Abandon payoff and keep membership").disabled).toBe(false);
  expect(container.textContent).toContain("New payoff checkout is paused");
});
