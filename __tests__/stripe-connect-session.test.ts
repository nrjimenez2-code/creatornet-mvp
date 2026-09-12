/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
let mockSession: { access_token: string; refresh_token: string } | null;
let mockLoading = false;
const mockGetSession = jest.fn();
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ session: mockSession, loading: mockLoading }) }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({ auth: { getSession: mockGetSession } }) }));
import StripeConnectBanner from "@/components/StripeConnectBanner";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const request = jest.fn();
const response = (status: number, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const render = () => act(async () => { root.render(createElement(StripeConnectBanner)); });
const click = () => act(async () => { container.querySelector("button")!.click(); });
beforeEach(() => {
  mockSession = { access_token: "test-access", refresh_token: "test-refresh" };
  mockLoading = false;
  mockGetSession.mockReset().mockImplementation(async () => ({ data: { session: mockSession }, error: null }));
  request.mockReset();
  global.fetch = request;
  container = document.createElement("div"); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); });
test("signed-out and loading visitors cannot start Connect", async () => {
  mockLoading = true; await render(); expect(container.textContent).toBe("");
  mockLoading = false; mockSession = null; await render();
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/auth');
  expect(container.querySelector('button')).toBeNull(); expect(request).not.toHaveBeenCalled();
});
test("status uses the browser token even without cookies and reruns after token refresh", async () => {
  request.mockResolvedValue(response(200, { connected: false })); await render();
  expect(request).toHaveBeenCalledWith('/api/stripe/connect/status', expect.objectContaining({ headers: { Authorization: 'Bearer test-access' } }));
  mockSession = { access_token: 'refreshed', refresh_token: 'refresh' }; await render();
  expect(request).toHaveBeenLastCalledWith('/api/stripe/connect/status', expect.objectContaining({ headers: { Authorization: 'Bearer refreshed' } }));
});
test("status 401 offers sign in; 503 offers retry, not onboarding", async () => {
  request.mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(401)); await render();
  expect(container.textContent).toContain('Could not check'); await click();
  expect(container.querySelector('button')).toBeNull(); expect(container.textContent).toContain('Sign in');
});
test("failed cookie sync prevents onboarding and permits retry", async () => {
  request.mockResolvedValueOnce(response(200, { connected: false })).mockResolvedValueOnce(response(403));
  await render(); await click();
  expect(request.mock.calls.map(call => call[0])).toEqual(['/api/stripe/connect/status', '/auth/callback']);
  expect(container.textContent).toContain('Could not verify your session');
  expect(container.querySelector('button')?.disabled).toBe(false);
});
test("waits for cookie sync, then sends a fresh bearer token; onboarding 401 recovers to sign in", async () => {
  let complete!: (value: unknown) => void;
  request.mockResolvedValueOnce(response(200, { connected: false }))
    .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
    .mockResolvedValueOnce(response(401));
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'fresh', refresh_token: 'refresh' } }, error: null });
  await render(); await click(); expect(request).toHaveBeenCalledTimes(2);
  await act(async () => { complete(response(200)); });
  expect(request).toHaveBeenLastCalledWith('/api/stripe/connect/onboard', expect.objectContaining({ headers: { Authorization: 'Bearer fresh' } }));
  expect(container.textContent).toContain('Sign in'); expect(container.textContent).not.toContain('Unauthorized');
});
test("session expiring before click prevents any onboarding call", async () => {
  request.mockResolvedValueOnce(response(200, { connected: false })); await render();
  mockGetSession.mockResolvedValueOnce({ data: { session: null }, error: null }); await click();
  expect(request).toHaveBeenCalledTimes(1); expect(container.textContent).toContain('Sign in');
});
test("successful onboarding navigates only after session sync", async () => {
  request.mockResolvedValueOnce(response(200, { connected: false }))
    .mockResolvedValueOnce(response(200))
    .mockResolvedValueOnce(response(200, { url: '#stripe-onboarding-test' }));
  await render(); await click();
  expect(request.mock.calls.map(call => call[0])).toEqual([
    '/api/stripe/connect/status', '/auth/callback', '/api/stripe/connect/onboard',
  ]);
  expect(window.location.hash).toBe('#stripe-onboarding-test');
});
test("earnings keeps its status while the connected sidebar banner disappears", async () => {
  request.mockResolvedValue(response(200, { connected: true, onboarding_complete: true }));
  await act(async () => { root.render(createElement(StripeConnectBanner, { appearance: 'earnings' })); });
  expect(container.textContent).toContain('Payouts active'); expect(container.textContent).toContain('Stripe connected');
  expect(container.querySelector('button')).toBeNull();
  await render(); expect(container.textContent).toBe('');
});
