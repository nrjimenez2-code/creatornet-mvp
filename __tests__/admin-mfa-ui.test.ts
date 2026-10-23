/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const mockEnroll = jest.fn(), mockVerify = jest.fn(), mockUnenroll = jest.fn(), mockPrepare = jest.fn(), mockFactors = jest.fn();
let mockUserId = "owner";
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ session: { user: { id: mockUserId } }, loading: false }) }));
jest.mock("@/lib/actionSession", () => ({ getActionSession: async () => ({ data: { session: { user: { id: mockUserId }, access_token: "fixture" } }, error: null }) }));
jest.mock("@/lib/supabaseClient", () => ({ runMfaAction: (_token: string, action: () => Promise<unknown>) => action(), createClient: () => ({ auth: { mfa: { listFactors: (...args: unknown[]) => mockFactors(...args), enroll: (...args: unknown[]) => mockEnroll(...args), challengeAndVerify: (...args: unknown[]) => mockVerify(...args), unenroll: (...args: unknown[]) => mockUnenroll(...args) } } }) }));
jest.mock("@/lib/browserSession", () => ({ prepareSessionNavigation: (...args: unknown[]) => mockPrepare(...args) }));
import PrivilegedMfa from "@/components/security/PrivilegedMfa";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
let status: { userId: string; verifiedFactorCount: number; aal2: boolean; recent: boolean };
beforeEach(() => {
  jest.clearAllMocks(); mockUserId = "owner";
  status = { userId: "owner", verifiedFactorCount: 0, aal2: false, recent: false };
  global.fetch = jest.fn().mockImplementation(async () => ({ ok: true, json: async () => status }));
  mockFactors.mockResolvedValue({ data: { all: [], totp: [] }, error: null });
  mockEnroll.mockResolvedValue({ data: { id: "pending", type: "totp", totp: { qr_code: "data:image/svg+xml;utf8,fixture", secret: "SYNTHETIC-SETUP-SECRET" } }, error: null });
  mockVerify.mockResolvedValue({ error: null }); mockUnenroll.mockResolvedValue({ error: null }); mockPrepare.mockResolvedValue(true);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = () => act(async () => { root.render(createElement(PrivilegedMfa)); });
const button = (text: string) => [...container.querySelectorAll("button")].find(node => node.textContent === text)!;
const click = (node: HTMLElement) => act(async () => node.click());

test("no enrollment occurs automatically and new-factor warning precedes explicit setup", async () => {
  await render();
  expect(mockEnroll).not.toHaveBeenCalled();
  expect(container.textContent).toContain("signs out other signed-in devices");
  expect(button("Start authenticator setup").disabled).toBe(true);
  await click(container.querySelector('input[type="checkbox"]')!);
  await click(button("Start authenticator setup"));
  expect(mockEnroll).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("SYNTHETIC-SETUP-SECRET");
  const secretRegion = container.querySelector("main")!;
  expect(secretRegion.classList.contains("sentry-block")).toBe(true);
  expect(secretRegion.classList.contains("ph-no-capture")).toBe(true);
  mockFactors.mockResolvedValue({ data: { all: [{ id: "pending", status: "unverified", factor_type: "totp" }], totp: [] }, error: null });
  await click(button("Cancel this pending setup"));
  expect(mockUnenroll).toHaveBeenCalledWith({ factorId: "pending" });
  expect(container.textContent).not.toContain("SYNTHETIC-SETUP-SECRET");
});
test("last verified factor cannot be removed through the UI", async () => {
  status = { ...status, verifiedFactorCount: 1, aal2: true, recent: true };
  mockFactors.mockResolvedValue({ data: { all: [], totp: [{ id: "primary", status: "verified", friendly_name: "Primary" }] }, error: null });
  await render();
  expect(button("Remove").disabled).toBe(true);
  expect(mockUnenroll).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Email sign-in cannot reset your second factor");
});
test("unfinished TOTP is read from SDK all factors and can be cancelled before replacing it", async () => {
  mockFactors.mockResolvedValue({ data: { all: [{ id: "unfinished", factor_type: "totp", status: "unverified", friendly_name: "Unfinished device" }], totp: [] }, error: null });
  await render();
  expect(container.textContent).toContain("Unfinished device");
  await click(container.querySelector('input[type="checkbox"]')!);
  expect(button("Start authenticator setup").disabled).toBe(true);
  await click(button("Cancel unfinished setup"));
  expect(mockUnenroll).toHaveBeenCalledWith({ factorId: "unfinished" });
  expect(mockEnroll).not.toHaveBeenCalled();
});
test("account switch discards setup material rather than carrying it into another account", async () => {
  await render(); await click(container.querySelector('input[type="checkbox"]')!); await click(button("Start authenticator setup"));
  expect(container.textContent).toContain("SYNTHETIC-SETUP-SECRET");
  mockUserId = "other";
  await render();
  expect(container.textContent).not.toContain("SYNTHETIC-SETUP-SECRET");
});

test("verification waits for session-cookie synchronization and confirmed server assurance", async () => {
  status = { ...status, verifiedFactorCount: 1 };
  mockFactors.mockResolvedValue({ data: { all: [], totp: [{ id: "primary", status: "verified", friendly_name: "Primary" }] }, error: null });
  mockVerify.mockImplementation(async () => { status = { ...status, aal2: true, recent: true }; return { error: null }; });
  await render();
  const input = container.querySelector('input[aria-label="Six-digit authenticator code"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "123456");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(mockVerify).toHaveBeenCalledWith({ factorId: "primary", code: "123456" });
  expect(mockPrepare).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Administrator controls are ready");
});

test.each([
  [{ code: "session_not_found", status: 403 }, "This browser's sign-in is no longer valid", true],
  [{ name: "AuthSessionMissingError", status: 400 }, "This browser's sign-in is no longer valid", true],
  [{ status: 401 }, "This browser's sign-in is no longer valid", true],
  [{ code: "over_request_rate_limit", status: 429 }, "Too many verification attempts", false],
  [{ status: 429 }, "Too many verification attempts", false],
  [{ code: "mfa_verification_failed", status: 422 }, "Check the selected authenticator and your device time", false],
  [{ status: 403 }, "Could not verify your authenticator", false],
  [{ status: 500 }, "Could not verify your authenticator", false],
  [{ name: "AuthRetryableFetchError", status: 0 }, "Could not verify your authenticator", false],
  [{ code: "mfa_session_changed", status: 409 }, "Your sign-in changed. Reload Account security", false],
])("verification failure %j gives actionable guidance without retrying", async (failure, expected, needsSignIn) => {
  status = { ...status, verifiedFactorCount: 1 };
  mockFactors.mockResolvedValue({ data: { all: [], totp: [{ id: "primary", status: "verified", friendly_name: "Primary" }] }, error: null });
  mockVerify.mockResolvedValue({ error: { name: "AuthApiError", message: "PRIVATE-PROVIDER-DETAIL", ...failure } });
  await render();
  const input = container.querySelector('input[aria-label="Six-digit authenticator code"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "123456");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(expected);
  expect(container.textContent).not.toContain("PRIVATE-PROVIDER-DETAIL");
  expect(mockVerify).toHaveBeenCalledTimes(1);
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockEnroll).not.toHaveBeenCalled();
  expect(mockUnenroll).not.toHaveBeenCalled();
  expect(container.querySelector('a[href="/auth?next=%2Faccount%2Fsecurity"]') !== null).toBe(needsSignIn);
  if (needsSignIn) {
    expect(input.isConnected).toBe(false);
    expect(container.querySelector('input[aria-label="Six-digit authenticator code"]')).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).not.toContain("Check the selected authenticator");
    await click(button("Retry"));
    const reloadedInput = container.querySelector('input[aria-label="Six-digit authenticator code"]') as HTMLInputElement;
    expect(reloadedInput).not.toBeNull();
    expect(reloadedInput.value).toBe("");
    expect(mockVerify).toHaveBeenCalledTimes(1);
  } else {
    expect((container.querySelector('input[aria-label="Six-digit authenticator code"]') as HTMLInputElement).value).toBe("");
  }
});

test("an invalid sign-in discards displayed setup material without removing the pending factor", async () => {
  await render();
  await click(container.querySelector('input[type="checkbox"]')!);
  await click(button("Start authenticator setup"));
  expect(container.textContent).toContain("SYNTHETIC-SETUP-SECRET");
  mockVerify.mockResolvedValue({ error: { code: "session_not_found", status: 403 } });
  const input = container.querySelector('input[aria-label="Six-digit authenticator code"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "123456");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(container.textContent).not.toContain("SYNTHETIC-SETUP-SECRET");
  expect(container.querySelector('[aria-label="New authenticator setup"]')).toBeNull();
  expect(container.querySelector('a[href="/auth?next=%2Faccount%2Fsecurity"]')).not.toBeNull();
  expect(mockVerify).toHaveBeenCalledTimes(1);
  expect(mockEnroll).toHaveBeenCalledTimes(1);
  expect(mockUnenroll).not.toHaveBeenCalled();
  expect(mockPrepare).not.toHaveBeenCalled();
});
