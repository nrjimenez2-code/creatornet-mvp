/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
let mockPathname = "/dashboard";
let mockDesktop = true;
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname }));
jest.mock("@/lib/browserVisibility", () => ({ useDesktopViewport: () => mockDesktop }));
jest.mock("next/dynamic", () => ({ __esModule: true, default: () => jest.requireActual("@/components/StripeConnectBanner").default }));

jest.mock("@/lib/useUser", () => ({ useUser: () => ({ session: { access_token: "test-session" }, loading: false }) }));
jest.mock("@/lib/actionSession", () => ({ getActionSession: jest.fn() }));
import StripeConnectBanner from "@/components/StripeConnectBanner";
import DesktopStripeConnectBanner from "@/components/DesktopStripeConnectBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const statusRequest = jest.fn();

beforeEach(() => {
  mockPathname = "/dashboard";
  mockDesktop = true;
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

test("sidebar omits fees only on Earnings and restores disclosure when leaving", async () => {
  statusRequest.mockResolvedValue({ ok: true, json: async () => ({ connected: false }) });
  const renderSidebar = () => act(async () => { root.render(createElement(DesktopStripeConnectBanner)); });
  await renderSidebar();
  expect(container.textContent).toContain("12% platform fee");
  mockPathname = "/dashboard/earnings"; await renderSidebar();
  expect(container.textContent).not.toMatch(/12%|platform fee|processing fee/i);
  expect(container.querySelector("button")?.textContent).toBe("Connect Stripe");
  mockPathname = "/profile"; await renderSidebar();
  expect(container.textContent).toContain("12% platform fee");
  expect(container.textContent).toContain("payment-processing fees");
});

test("Earnings sidebar still hides an active connection and stays absent on mobile", async () => {
  mockPathname = "/dashboard/earnings";
  statusRequest.mockResolvedValue({ ok: true, json: async () => ({ connected: true, onboarding_complete: true }) });
  await act(async () => { root.render(createElement(DesktopStripeConnectBanner)); });
  expect(container.textContent).toBe("");
  statusRequest.mockReset(); mockDesktop = false;
  await act(async () => { root.render(createElement(DesktopStripeConnectBanner)); });
  expect(container.textContent).toBe("");
  expect(statusRequest).not.toHaveBeenCalled();
});
