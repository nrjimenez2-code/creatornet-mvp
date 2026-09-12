/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import Page from "@/app/memberships/page";
import { managementFixture } from "../test-support/membership-management-fixtures";
import type { MembershipManagementItem, MembershipView } from "@/lib/membershipManagement";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch, mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
let root: Root, container: HTMLDivElement;
const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const page = (item = managementFixture(), view: MembershipView = "buyer", nextCursor: string | null = null) => ({ view, items: [item], nextCursor });
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!;
const boxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
const link = (text: string) => Array.from(container.querySelectorAll("a")).find(a => a.textContent === text);
const render = async () => act(async () => root.render(createElement(Page)));
beforeEach(() => { jest.clearAllMocks(); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); globalThis.fetch = mockFetch; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
test("steps 4/5: closed unpaid attempts remain visible without payoff, debit or first-payment controls", async () => {
  const item = managementFixture(); item.initialAbandoned = true; item.firstPaymentRecorded = false;
  item.access.allowed = false; item.exitStatus.billingBlocked = true; item.billingReview = true;
  mockFetch.mockResolvedValueOnce(reply(page(item))); await render();
  expect(container.textContent).toContain("Unpaid checkout closed"); expect(container.textContent).toContain("No first payment or access recorded");
  expect(link("Review closed checkout")?.getAttribute("href")).toBe("/memberships/recovery?membership_id=" + item.id);
  expect(link("Review early-exit payoff")).toBeUndefined(); expect(link("Check first payment")).toBeUndefined();
  expect(button("Stop automatic debits")).toBeUndefined(); expect(boxes()).toHaveLength(0);
  expect(container.textContent).not.toContain("Provider cancellation is not confirmed");
});
test("steps 2/3/5: unpaid minimum offers payoff review, not cancel-anytime treatment of fixed commitments", async () => {
  const item = managementFixture(); mockFetch.mockResolvedValueOnce(reply(page(item))); await render();
  expect(button("Stop renewal")).toBeUndefined(); expect(link("Review early-exit payoff")?.getAttribute("href")).toBe("/memberships/payoff?membership_id=" + item.id);
  expect(link("View fixed-total payment plans")?.getAttribute("href")).toBe("/payments");
  expect(container.textContent).toContain("3 months, $300.00 total"); expect(container.textContent).toContain("2 months, $200.00");
  expect(mockFetch).toHaveBeenCalledTimes(1); expect(boxes().map(b => b.checked)).toEqual([false]);
});
test("steps 2/4: minimum-settled cancellation needs unchecked consent and submits only the exact quote", async () => {
  const item = managementFixture(1), stopped: MembershipManagementItem = JSON.parse(JSON.stringify(item)); stopped.quote.renewalStopped = true;
  stopped.exitStatus = { ...stopped.exitStatus, billingBlocked: true, providerStopped: true };
  mockFetch.mockResolvedValueOnce(reply(page(item))).mockResolvedValueOnce(reply({ requestId: "19000000-0000-4000-8000-000000000001",
    kind: "stop_renewal", billingBlocked: true, providerStopped: true, balanceWaived: false, status: "provider_stopped" })).mockResolvedValueOnce(reply(page(stopped)));
  await render(); expect(button("Stop renewal").disabled).toBe(true); expect(boxes().map(b => b.checked)).toEqual([false, false]);
  await act(async () => boxes()[0].click()); await act(async () => button("Stop renewal").click());
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ kind: "stop_renewal", accepted: true, quote: item.quote });
  expect(container.textContent).toContain("provider stop is confirmed"); expect(container.textContent).toContain("Paid-period access available");
  expect(button("Stop renewal")).toBeUndefined(); expect(boxes().map(b => b.checked)).toEqual([false]);
});
test("steps 2/4/8: debit revocation has separate consent, no payoff and no false provider completion", async () => {
  const item = managementFixture(); item.quote.payoffAmountCents = null; item.quote.reviewReasons = ["billing_review"];
  mockFetch.mockResolvedValueOnce(reply(page(item))).mockResolvedValueOnce(reply({ requestId: "19000000-0000-4000-8000-000000000002",
    kind: "revoke_debits", billingBlocked: true, providerStopped: false, balanceWaived: false, status: "provider_review_required" }, 202)).mockResolvedValueOnce(reply(page(item)));
  await render(); expect(button("Stop automatic debits").disabled).toBe(true);
  await act(async () => boxes()[0].click()); await act(async () => button("Stop automatic debits").click());
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ kind: "revoke_debits", accepted: true });
  expect(container.textContent).toContain("provider stop still needs reconciliation"); expect(container.textContent).toContain("remaining agreed balance are unchanged");
});
test("step 4: cancellation consent does not enable debit revocation", async () => {
  mockFetch.mockResolvedValueOnce(reply(page(managementFixture(1)))); await render(); await act(async () => boxes()[0].click());
  expect(button("Stop renewal").disabled).toBe(false); expect(button("Stop automatic debits").disabled).toBe(true);
});
test("step 5: creator customer view has no buyer exit authority", async () => {
  mockFetch.mockResolvedValueOnce(reply(page())).mockResolvedValueOnce(reply(page(managementFixture(1, "creator"), "creator")));
  await render(); await act(async () => button("My customers").click());
  expect(mockFetch.mock.calls[1][0]).toBe("/api/memberships?view=creator"); expect(boxes()).toHaveLength(0);
  expect(button("Stop renewal")).toBeUndefined(); expect(button("Stop automatic debits")).toBeUndefined(); expect(link("Review early-exit payoff")).toBeUndefined();
  expect(container.textContent).toContain("Buyer: Example Buyer");
});
test("steps 5/8: pending first payment and saved payoff have explicit confirmation links", async () => {
  const item = managementFixture(); item.firstPaymentRecorded = false; item.access.allowed = false;
  item.payoff = { id: "19000000-0000-4000-8000-000000000003", status: "checkout_bound" };
  mockFetch.mockResolvedValueOnce(reply(page(item))); await render();
  expect(link("Check first payment")?.getAttribute("href")).toBe("/memberships/complete?membership_id=" + item.id);
  expect(link("Recover original checkout")?.getAttribute("href")).toBe("/memberships/recovery?membership_id=" + item.id);
  expect(link("Check existing payoff payment")?.getAttribute("href")).toBe(`/memberships/payoff?membership_id=${item.id}&payoff_id=${item.payoff.id}&confirm=1`);
  expect(container.textContent).toContain("Access not currently available");
});
test("step 8: a local billing stop is not displayed as confirmed provider cancellation", async () => {
  const item = managementFixture(); item.exitStatus.billingBlocked = true; item.quote.debitsRevoked = true;
  mockFetch.mockResolvedValueOnce(reply(page(item))); await render();
  expect(container.textContent).toContain("Provider cancellation is not confirmed yet"); expect(button("Stop automatic debits")).toBeUndefined();
});
test("step 5: signed-out and unavailable states do not masquerade as empty accounts", async () => {
  mockFetch.mockResolvedValueOnce(reply({ error: "Sign in to manage your memberships." }, 401)); await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Sign in"); expect(link("Sign in")?.getAttribute("href")).toBe("/auth");
  expect(container.textContent).not.toContain("No monthly mentorships are recorded");
  mockFetch.mockResolvedValueOnce(reply({ error: "Temporarily unavailable." }, 503)); await act(async () => button("Refresh details").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Temporarily unavailable.");
});
test("step 5: bounded pagination forwards the opaque cursor and can return to the first page", async () => {
  mockFetch.mockResolvedValueOnce(reply(page(managementFixture(), "buyer", "c29tZWN1cnNvcg"))).mockResolvedValueOnce(reply(page())).mockResolvedValueOnce(reply(page()));
  await render(); await act(async () => button("Next page").click());
  expect(mockFetch.mock.calls[1][0]).toBe("/api/memberships?view=buyer&cursor=c29tZWN1cnNvcg");
  await act(async () => button("First page").click()); expect(mockFetch.mock.calls[2][0]).toBe("/api/memberships?view=buyer");
});
test("step 5: a late buyer response cannot replace the selected creator view", async () => {
  let resolveBuyer!: (value: Response) => void; mockFetch.mockImplementationOnce(() => new Promise(resolve => { resolveBuyer = resolve; }));
  mockFetch.mockResolvedValueOnce(reply(page(managementFixture(1, "creator"), "creator"))); await render();
  await act(async () => button("My customers").click()); await act(async () => resolveBuyer(reply(page())));
  expect(container.textContent).toContain("Buyer: Example Buyer"); expect(boxes()).toHaveLength(0);
  expect((mockFetch.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
});
test("step 4: refreshing details clears earlier checkbox acceptance", async () => {
  mockFetch.mockResolvedValue(reply(page(managementFixture(1)))); await render(); await act(async () => { boxes()[0].click(); boxes()[1].click(); });
  await act(async () => button("Refresh details").click()); expect(boxes().map(b => b.checked)).toEqual([false, false]);
});
test("step 8: inconsistent exit response is treated as uncertain, not successful cancellation", async () => {
  mockFetch.mockResolvedValueOnce(reply(page(managementFixture(1)))).mockResolvedValueOnce(reply({ requestId: "19000000-0000-4000-8000-000000000004",
    kind: "stop_renewal", billingBlocked: true, providerStopped: true, balanceWaived: true, status: "provider_stopped" })).mockResolvedValueOnce(reply(page()));
  await render(); await act(async () => boxes()[0].click()); await act(async () => button("Stop renewal").click());
  expect(container.textContent).toContain("Do not assume cancellation or a balance waiver");
});
test("step 8: navigation remains disabled until all independently submitted stop requests settle", async () => {
  const first = managementFixture(1), second: MembershipManagementItem = JSON.parse(JSON.stringify(first));
  second.id = "19000000-0000-4000-8000-000000000005"; second.quote.membershipId = second.id; second.exitStatus.membershipId = second.id;
  let resolveFirst!: (value: Response) => void, resolveSecond!: (value: Response) => void;
  mockFetch.mockResolvedValueOnce(reply({ view: "buyer", items: [first, second], nextCursor: null }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }))
    .mockResolvedValue(reply(page(first)));
  await render();
  const cards = Array.from(container.querySelectorAll("article"));
  await act(async () => { cards[0].querySelector<HTMLInputElement>("input")!.click(); cards[1].querySelector<HTMLInputElement>("input")!.click(); });
  await act(async () => { cards[0].querySelector<HTMLButtonElement>("button")!.click(); cards[1].querySelector<HTMLButtonElement>("button")!.click(); });
  expect(button("My customers").disabled).toBe(true);
  const result = { requestId: "19000000-0000-4000-8000-000000000006", kind: "stop_renewal", billingBlocked: true, providerStopped: false, balanceWaived: false, status: "provider_review_required" };
  await act(async () => resolveFirst(reply(result, 202))); expect(button("My customers").disabled).toBe(true);
  await act(async () => resolveSecond(reply(result, 202))); expect(button("My customers").disabled).toBe(false);
});
