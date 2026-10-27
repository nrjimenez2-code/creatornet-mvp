/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const replace = jest.fn(), documentReplace = jest.fn(), prepare = jest.fn(), profile = jest.fn();
const oauthSignIn = jest.fn();
const session = { user: { id: "u" } };
let mockUser: { session: typeof session | null; loading: boolean };
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
jest.mock("@/lib/useUser", () => ({ useUser: () => mockUser }));
jest.mock("@/lib/browserSession", () => ({
  ...jest.requireActual("@/lib/browserSession"),
  prepareSessionNavigation: (...args: unknown[]) => prepare(...args),
  replaceBrowserDocument: (destination: string) => documentReplace(destination),
}));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({ auth: { signInWithOAuth: (...args: unknown[]) => oauthSignIn(...args) }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: profile }) }) }) }) }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn() }));
import AuthPage from "@/app/auth/page";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, container: HTMLDivElement;
const originalFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks(); prepare.mockResolvedValue(true); profile.mockResolvedValue({ data: { interests: ["fitness"] }, error: null });
  oauthSignIn.mockReset().mockResolvedValue({ error: null });
  mockUser = { session, loading: false };
  window.history.replaceState(null, "", "/auth");
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ privateAccess: true, registrationOpen: false }) });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); container.remove(); global.fetch = originalFetch; });
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

const button = (text: string) => Array.from(container.querySelectorAll("button")).find(element => element.textContent?.includes(text));
function releaseReply(body: unknown, ok = true) {
  mockUser = { session: null, loading: false };
  (global.fetch as jest.Mock).mockResolvedValue({ ok, json: async () => body });
}
function expectPrivateEmailOnly() {
  expect(button("Continue with email")).toBeDefined();
  expect(button("Continue with Apple")).toBeUndefined();
  expect(button("Continue with Google")).toBeUndefined();
  expect(container.textContent).toContain("Private sign-in for existing accounts.");
  expect(container.textContent).not.toContain("Sign in or create an account.");
}

test.each([undefined, false, "true", "false", 1, {}, []])("closed registration rejects absent or non-true Apple capability %p", async capability => {
  releaseReply({ registrationOpen: false, ...(capability === undefined ? {} : { privateAppleSignInEnabled: capability }) });
  await render(); expectPrivateEmailOnly(); expect(oauthSignIn).not.toHaveBeenCalled();
});

test.each([null, true, "true", [], 1])("malformed release payload %p cannot expose a provider", async body => {
  releaseReply(body); await render(); expectPrivateEmailOnly();
});

test("unsuccessful responses cannot expose Apple or public registration even with true fields", async () => {
  releaseReply({ registrationOpen: true, privateAppleSignInEnabled: true }, false);
  await render(); expectPrivateEmailOnly();
});

test.each(["network", "json"])("a failed %s request keeps both providers closed", async failure => {
  mockUser = { session: null, loading: false };
  if (failure === "network") (global.fetch as jest.Mock).mockRejectedValue(Error("offline"));
  else (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => { throw Error("invalid JSON"); } });
  await render(); expectPrivateEmailOnly();
});

test("a pending capability request stays closed, then explicit true exposes Apple alone", async () => {
  mockUser = { session: null, loading: false };
  let complete!: (value: unknown) => void;
  (global.fetch as jest.Mock).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await render(); expectPrivateEmailOnly();
  await act(async () => complete({ ok: true, json: async () => ({ registrationOpen: false, privateAppleSignInEnabled: true }) }));
  expect(button("Continue with Apple")).toBeDefined();
  expect(button("Continue with Google")).toBeUndefined();
  expect(container.textContent).toContain("Private sign-in for existing accounts.");
});

test("the private Apple entry uses the normal provider invocation and pending state", async () => {
  releaseReply({ registrationOpen: false, privateAppleSignInEnabled: true });
  await render();
  await act(async () => button("Continue with Apple")!.click());
  expect(oauthSignIn).toHaveBeenCalledTimes(1);
  expect(oauthSignIn).toHaveBeenCalledWith({ provider: "apple", options: { redirectTo: expect.stringMatching(/^https?:\/\/[^/]+\/auth$/) } });
  expect(button("Opening Apple")?.disabled).toBe(true);
  expect(button("Opening Apple")?.getAttribute("aria-busy")).toBe("true");
  expect(button("Continue with Google")).toBeUndefined();
  expect(prepare).not.toHaveBeenCalled(); expect(documentReplace).not.toHaveBeenCalled();
});

test("private Apple failures remain retryable and render one existing error", async () => {
  releaseReply({ registrationOpen: false, privateAppleSignInEnabled: true });
  oauthSignIn.mockResolvedValue({ error: Error("Apple unavailable") });
  await render(); await act(async () => button("Continue with Apple")!.click());
  expect(button("Continue with Apple")?.disabled).toBe(false);
  expect(Array.from(container.querySelectorAll('[role="alert"]')).map(element => element.textContent)).toEqual(["Apple unavailable"]);
});

test.each(["apple", "google"])("public registration retains the normal %s provider flow", async provider => {
  releaseReply({ registrationOpen: true }); await render();
  expect(button("Continue with Apple")).toBeDefined(); expect(button("Continue with Google")).toBeDefined();
  expect(container.textContent).toContain("Sign in or create an account.");
  await act(async () => button(provider === "apple" ? "Continue with Apple" : "Continue with Google")!.click());
  expect(oauthSignIn).toHaveBeenCalledWith(expect.objectContaining({ provider }));
});

test("leaving the page aborts the capability read and ignores its late response", async () => {
  mockUser = { session: null, loading: false };
  let complete!: (value: unknown) => void;
  let signal!: AbortSignal;
  (global.fetch as jest.Mock).mockImplementation((_url: unknown, options: { signal: AbortSignal }) => {
    signal = options.signal; return new Promise(resolve => { complete = resolve; });
  });
  await render(); expectPrivateEmailOnly();
  await act(async () => { root!.unmount(); root = undefined; });
  expect(signal.aborted).toBe(true);
  await act(async () => complete({ ok: true, json: async () => ({ registrationOpen: true, privateAppleSignInEnabled: true }) }));
  expect(container.textContent).toBe(""); expect(oauthSignIn).not.toHaveBeenCalled(); expect(documentReplace).not.toHaveBeenCalled();
});
