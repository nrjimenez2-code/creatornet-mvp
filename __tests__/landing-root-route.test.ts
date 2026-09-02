/**
 * app/page.tsx — the root route's one decision.
 *
 * A visitor with no session now gets the landing page instead of a bounce to
 * /auth. Signed-in users must keep exactly the redirects they had, because
 * that logic is shared with app/dashboard/layout.tsx. Imports and invokes the
 * real page. Mutation-checked.
 */

let target: "/auth" | "/onboarding" | null = "/auth";
const redirect = jest.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT:${to}`);
});

jest.mock("@/lib/onboardingGate", () => ({
  resolveOnboardingRedirect: async () => target,
}));
jest.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
// The markup is covered by landing-links-and-facts.test.ts; here only the
// branch matters, and stubbing the tree keeps the stylesheet import out of jest.
jest.mock("@/components/landing/LandingPage", () => ({
  __esModule: true,
  default: () => "LANDING",
}));

beforeEach(() => {
  jest.resetModules();
  redirect.mockClear();
});

describe("GET / for a visitor with no session", () => {
  it("renders the landing page instead of bouncing to /auth", async () => {
    target = "/auth";
    const { default: Home } = await import("@/app/page");
    const out = await Home();
    expect(redirect).not.toHaveBeenCalled();
    expect(out).toBeTruthy(); // a React element, not a redirect
  });
});

describe("GET / for signed-in users is unchanged", () => {
  it("still sends an unfinished profile to /onboarding", async () => {
    target = "/onboarding";
    const { default: Home } = await import("@/app/page");
    await expect(Home()).rejects.toThrow("NEXT_REDIRECT:/onboarding");
  });

  it("still sends a finished profile to /dashboard", async () => {
    target = null;
    const { default: Home } = await import("@/app/page");
    await expect(Home()).rejects.toThrow("NEXT_REDIRECT:/dashboard");
  });
});
