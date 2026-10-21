/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let params = new URLSearchParams(); const replace = jest.fn(), router = { replace };
jest.mock("next/navigation", () => ({ useSearchParams: () => params,
  useRouter: () => router }));
import Page from "@/app/memberships/payment/return/page";
const originalFetch = globalThis.fetch, fetchMock = jest.fn();
let root: Root, host: HTMLDivElement;
beforeEach(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks(); fetchMock.mockReset(); host = document.createElement("div"); document.body.append(host);
  root = createRoot(host); globalThis.fetch = fetchMock;
  params = new URLSearchParams({ attempt: id(1), payment_intent_client_secret: "private",
    redirect_status: "succeeded" });
  window.history.replaceState(null, "", "/memberships/payment/return?" + params);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });

test.each(["first", "payoff"] as const)("%s bank return navigates only to its saved payment page", async kind => {
  fetchMock.mockResolvedValueOnce({ ok: true,
    json: async () => ({ membershipId: id(2), selectionId: id(1), kind }) });
  await act(async () => root.render(createElement(Page)));
  expect(fetchMock.mock.calls[0][0]).toBe(`/api/memberships/manual/resolve?attempt_id=${id(1)}`);
  expect(window.location.search).toBe(`?attempt=${id(1)}`);
  expect(replace).toHaveBeenCalledWith(kind === "payoff" ?
    `/memberships/manual-payoff?membership_id=${id(2)}` :
    `/memberships/manual?membership_id=${id(2)}`);
  expect(host.textContent).not.toContain("Payment successful");
});

test("unrecognized saved kind cannot navigate to a payment page", async () => {
  fetchMock.mockResolvedValueOnce({ ok: true,
    json: async () => ({ membershipId: id(2), selectionId: id(1), kind: "other" }) });
  await act(async () => root.render(createElement(Page)));
  expect(replace).not.toHaveBeenCalled();
  expect(host.textContent).toContain("needs a status check");
});
