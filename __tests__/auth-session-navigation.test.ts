/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const replace = jest.fn(), documentReplace = jest.fn(), prepare = jest.fn(), profile = jest.fn();
const session = { user: { id: "u" } };
let mockUser: { session: typeof session | null; loading: boolean };
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
jest.mock("@/lib/useUser", () => ({ useUser: () => mockUser }));
jest.mock("@/lib/browserSession", () => ({
  ...jest.requireActual("@/lib/browserSession"),
  prepareSessionNavigation: (...args: unknown[]) => prepare(...args),
  replaceBrowserDocument: (destination: string) => documentReplace(destination),
}));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: profile }) }) }) }) }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn() }));
import AuthPage from "@/app/auth/page";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, container: HTMLDivElement;
beforeEach(() => {
  jest.clearAllMocks(); prepare.mockResolvedValue(true); profile.mockResolvedValue({ data: { interests: ["fitness"] }, error: null });
  mockUser = { session, loading: false };
  window.history.replaceState(null, "", "/auth");
  global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ privateAccess: true, registrationOpen: false }) });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); container.remove(); });
const render = () => act(async () => { root!.render(createElement(AuthPage)); });

test("an invalid stored session cannot bounce the user back to the feed", async () => {
  prepare.mockResolvedValue(false); await render(); expect(replace).not.toHaveBeenCalled(); expect(documentReplace).not.toHaveBeenCalled(); expect(profile).not.toHaveBeenCalled();
});
test("cookie sync failure leaves a visible error, not a redirect loop", async () => {
  prepare.mockRejectedValue(Error("Could not synchronize your sign-in. Please try again."));
  await render(); expect(replace).not.toHaveBeenCalled(); expect(documentReplace).not.toHaveBeenCalled(); expect(container.textContent).toContain("Could not synchronize");
});
test("profile lookup failure never redirects to feed", async () => {
  profile.mockResolvedValue({ data: null, error: { message: "unavailable" } });
  await render(); expect(replace).not.toHaveBeenCalled(); expect(documentReplace).not.toHaveBeenCalled(); expect(container.textContent).toContain("Could not load your profile");
});
test("fallback feed navigation rebuilds the product document after verified cookie sync", async () => {
  await render(); expect(documentReplace).toHaveBeenCalledWith("/dashboard"); expect(replace).not.toHaveBeenCalled();
  expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(profile.mock.invocationCallOrder[0]);
  expect(profile.mock.invocationCallOrder[0]).toBeLessThan(documentReplace.mock.invocationCallOrder[0]);
});
test.each([{ interests: [] }, { interests: null }, null])("fallback onboarding navigation rebuilds the product document for profile %p", async data => {
  profile.mockResolvedValue({ data, error: null });
  await render(); expect(documentReplace).toHaveBeenCalledWith("/onboarding"); expect(replace).not.toHaveBeenCalled();
});
test("delayed auth and a newly signed-in session use the same document handoff", async () => {
  mockUser = { session: null, loading: true }; await render(); expect(prepare).not.toHaveBeenCalled();
  mockUser = { session: null, loading: false }; await render(); expect(documentReplace).not.toHaveBeenCalled();
  mockUser = { session, loading: false }; await render(); expect(documentReplace).toHaveBeenCalledWith("/dashboard"); expect(replace).not.toHaveBeenCalled();
});
test.each(["/profile", "/profile/edit", "/account/security"])("an allowed return keeps document navigation to %s", async next => {
  window.history.replaceState(null, "", "/auth?next=" + encodeURIComponent(next));
  await render(); expect(documentReplace).toHaveBeenCalledWith(next); expect(profile).not.toHaveBeenCalled();
});
test.each(["/dashboard", "/private-access", "https://evil.test", "//evil.test"])("a disallowed return %s uses the safe profile-based document handoff", async next => {
  window.history.replaceState(null, "", "/auth?next=" + encodeURIComponent(next));
  await render(); expect(documentReplace).toHaveBeenCalledWith("/dashboard"); expect(replace).not.toHaveBeenCalled();
});
test("private access denial still precedes profile routing and allowed next", async () => {
  window.history.replaceState(null, "", "/auth?next=/profile");
  (global.fetch as jest.Mock).mockResolvedValue({ json: async () => ({ privateAccess: false, publicFeed: false }) });
  await render(); expect(documentReplace).toHaveBeenCalledWith("/private-access"); expect(profile).not.toHaveBeenCalled();
});
test("a profile response after leaving the page cannot navigate", async () => {
  let complete!: (value: unknown) => void;
  profile.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await render(); expect(profile).toHaveBeenCalled();
  await act(async () => { root!.unmount(); root = undefined; });
  await act(async () => complete({ data: { interests: ["fitness"] }, error: null }));
  expect(documentReplace).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
});
