/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const replace = jest.fn(), prepare = jest.fn(), profile = jest.fn();
const session = { user: { id: "u" } };
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ session, loading: false }) }));
jest.mock("@/lib/browserSession", () => ({ prepareSessionNavigation: (...args: unknown[]) => prepare(...args), authNextPath: () => null }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: profile }) }) }) }) }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn() }));
import AuthPage from "@/app/auth/page";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  jest.clearAllMocks(); prepare.mockResolvedValue(true); profile.mockResolvedValue({ data: { interests: ["fitness"] }, error: null });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = () => act(async () => { root.render(createElement(AuthPage)); });
test("an invalid stored session cannot bounce the user back to the feed", async () => {
  prepare.mockResolvedValue(false); await render(); expect(replace).not.toHaveBeenCalled(); expect(profile).not.toHaveBeenCalled();
});
test("cookie sync failure leaves a visible error, not a redirect loop", async () => {
  prepare.mockRejectedValue(Error("Could not synchronize your sign-in. Please try again."));
  await render(); expect(replace).not.toHaveBeenCalled(); expect(container.textContent).toContain("Could not synchronize");
});
test("profile lookup failure never redirects to feed", async () => {
  profile.mockResolvedValue({ data: null, error: { message: "unavailable" } });
  await render(); expect(replace).not.toHaveBeenCalled(); expect(container.textContent).toContain("Could not load your profile");
});
test("verified and synchronized session can reach the feed", async () => {
  await render(); expect(replace).toHaveBeenCalledWith("/dashboard");
});
