/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("@/lib/useUser", () => ({ useUser: () => ({ session: { access_token: "test-session" }, loading: false }) }));
jest.mock("@/lib/actionSession", () => ({ getActionSession: jest.fn() }));
import StripeConnectBanner from "@/components/StripeConnectBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const statusRequest = jest.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  statusRequest.mockReset();
  global.fetch = statusRequest;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function renderStatus(status: object, appearance: "default" | "earnings" = "default") {
  statusRequest.mockResolvedValue({ ok: true, json: async () => status });
  await act(async () => { root.render(createElement(StripeConnectBanner, { appearance })); });
  expect(statusRequest).toHaveBeenCalledWith("/api/stripe/connect/status", expect.objectContaining({
    credentials: "include", headers: { Authorization: "Bearer test-session" },
  }));
  expect(statusRequest.mock.calls.every(([url]) => url === "/api/stripe/connect/status")).toBe(true);
}

test("unconnected and incomplete accounts get setup actions", async () => {
  await renderStatus({ connected: false });
  expect(container.textContent).toContain("Connect Stripe to sell");
  expect(container.querySelector("button")?.textContent).toBe("Connect Stripe");
  await act(async () => root.unmount());
  root = createRoot(container);
  statusRequest.mockReset();
  await renderStatus({ connected: true, onboarding_complete: false });
  expect(container.textContent).toContain("Finish Stripe setup");
  expect(container.querySelector("button")?.textContent).toBe("Continue");
});

test("connected accounts stay absent from navigation and show status on Earnings", async () => {
  await renderStatus({ connected: true, onboarding_complete: true });
  expect(container.textContent).toBe("");
  await act(async () => { root.render(createElement(StripeConnectBanner, { appearance: "earnings" })); });
  expect(container.textContent).toContain("Payouts active");
  expect(container.textContent).toContain("Stripe connected");
});
