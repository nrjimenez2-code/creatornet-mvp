/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { membershipPayoffFixture } from "../test-support/membership-payoff-fixtures";
let params = new URLSearchParams(), paymentProps: Record<string, unknown> | null = null;
jest.mock("next/navigation", () => ({ useSearchParams: () => params }));
jest.mock("../components/ManualMentorshipPayment", () => ({ __esModule: true,
  default: (props: Record<string, unknown>) => { paymentProps = props;
    return createElement("div", { "data-payment": props.requestId }, "Original payoff form"); } }));
import Page from "@/app/memberships/manual-payoff/page";

const f = membershipPayoffFixture(false), originalFetch = globalThis.fetch;
const fetchMock = jest.fn(), reply = (body: unknown, ok = true) => ({ ok, json: async () => body });
let root: Root, host: HTMLDivElement;
const details = (selected = false) => ({ membershipId: f.a.id,
  selectionId: selected ? "40000000-0000-4000-8000-000000000011" : null,
  buyerId: f.a.buyer_id, productId: f.a.product_id, title: f.a.terms.title,
  amountCents: f.p.terms.amountCents, currency: "usd", payoffId: selected ? f.p.id : null,
  status: selected ? "accepted" : "quoted", terms: f.p.terms, fingerprint: f.p.fingerprint,
  acceptanceExpiresAt: selected ? Math.floor(Date.now() / 1000) + 3600 : null,
  newPaymentAllowed: selected, acceptanceAllowed: !selected, manualAvailable: true });
beforeEach(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks(); paymentProps = null; params = new URLSearchParams({ membership_id: f.a.id });
  globalThis.fetch = fetchMock; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
const render = async () => act(async () => root.render(createElement(Page)));

test("a reviewed quote asks for separate exact payoff consent before selecting", async () => {
  fetchMock.mockResolvedValueOnce(reply(details())).mockResolvedValueOnce(reply({ requestId: f.a.id,
    status: "payoff_selected", selectionId: "40000000-0000-4000-8000-000000000011" }))
    .mockResolvedValueOnce(reply(details(true)));
  await render();
  expect(paymentProps).toBeNull();
  const button = [...host.querySelectorAll("button")].find(b => b.textContent === "Confirm this payoff")!;
  expect(button.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button.click());
  expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ kind: "accept",
    consent: { accepted: true, version: f.p.terms.version, fingerprint: f.p.fingerprint } });
  expect(paymentProps).toMatchObject({ requestId: f.a.id, mode: "monthly_payoff",
    selectionId: "40000000-0000-4000-8000-000000000011",
    amountCents: f.p.terms.amountCents });
});

test("a saved payoff mounts only its own card scope and a paused admission disables new card actions", async () => {
  fetchMock.mockResolvedValueOnce(reply({ ...details(true), newPaymentAllowed: false }));
  await render();
  expect(paymentProps).toMatchObject({ mode: "monthly_payoff", allowNewPayment: false,
    buyerId: f.a.buyer_id, productId: f.a.product_id });
  expect(host.textContent).toContain("New card actions are paused");
});

test("captured payoff and invalid membership never mount a payment form", async () => {
  fetchMock.mockResolvedValueOnce(reply({ ...details(true), status: "captured", newPaymentAllowed: false }));
  await render(); expect(paymentProps).toBeNull(); expect(host.textContent).toContain("payoff is recorded");
  params = new URLSearchParams({ membership_id: "bad" });
  await render(); expect(paymentProps).toBeNull();
});
