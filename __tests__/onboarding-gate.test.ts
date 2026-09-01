/**
 * The onboarding gate, and the one asymmetry in it that is easy to "tidy" away.
 *
 * The gate used to live only in app/page.tsx, so anything that landed anywhere
 * else walked past it. The app's own Share button does exactly that: VideoCard
 * copies `${origin}/dashboard?postId=…`. In production 35 of 47 accounts have
 * no profile row at all.
 *
 * These tests import and invoke the real helper and the real layout.
 */

let sessionValue: { user: { id: string } } | null = { user: { id: "u1" } };
let profileValue: { username: string | null; interests: unknown } | null = null;
const profileSelect = jest.fn();

jest.mock("@/lib/supabaseServer", () => ({
  createSupabaseServer: async () => ({
    auth: { getSession: async () => ({ data: { session: sessionValue } }) },
    from: (table: string) => ({
      select: (cols: string) => {
        profileSelect(table, cols);
        return {
          eq: () => ({ maybeSingle: async () => ({ data: profileValue, error: null }) }),
        };
      },
    }),
  }),
}));

const redirectMock = jest.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
jest.mock("next/navigation", () => ({ redirect: (to: string) => redirectMock(to) }));

beforeEach(() => {
  jest.clearAllMocks();
  sessionValue = { user: { id: "u1" } };
  profileValue = null;
});

describe("resolveOnboardingRedirect", () => {
  it("sends a signed-out visitor to /auth", async () => {
    sessionValue = null;
    const { resolveOnboardingRedirect } = await import("@/lib/onboardingGate");
    await expect(resolveOnboardingRedirect()).resolves.toBe("/auth");
  });

  it("sends a user with no profile row at all to /onboarding", async () => {
    profileValue = null;
    const { resolveOnboardingRedirect } = await import("@/lib/onboardingGate");
    await expect(resolveOnboardingRedirect()).resolves.toBe("/onboarding");
  });

  it("sends a user with a username but no interests to /onboarding", async () => {
    profileValue = { username: "landon", interests: [] };
    const { resolveOnboardingRedirect } = await import("@/lib/onboardingGate");
    await expect(resolveOnboardingRedirect()).resolves.toBe("/onboarding");
  });

  it("sends a user with interests but no username to /onboarding", async () => {
    profileValue = { username: null, interests: ["fitness"] };
    const { resolveOnboardingRedirect } = await import("@/lib/onboardingGate");
    await expect(resolveOnboardingRedirect()).resolves.toBe("/onboarding");
  });

  it("treats a non-array interests value as empty rather than throwing", async () => {
    profileValue = { username: "landon", interests: null };
    const { resolveOnboardingRedirect } = await import("@/lib/onboardingGate");
    await expect(resolveOnboardingRedirect()).resolves.toBe("/onboarding");
  });

  it("lets a finished profile through", async () => {
    profileValue = { username: "landon", interests: ["fitness"] };
    const { resolveOnboardingRedirect } = await import("@/lib/onboardingGate");
    await expect(resolveOnboardingRedirect()).resolves.toBeNull();
  });

  it("reads the caller's own profile row, not a service-role query", async () => {
    profileValue = { username: "landon", interests: ["fitness"] };
    const { resolveOnboardingRedirect } = await import("@/lib/onboardingGate");
    await resolveOnboardingRedirect();
    expect(profileSelect).toHaveBeenCalledWith("profiles", "username, interests");
  });
});

describe("the /dashboard layout gate", () => {
  /**
   * Reverts to: no gate in the layout at all. This is the whole point of the
   * change — a shared link lands on /dashboard, never on "/".
   */
  it("redirects an incomplete profile to /onboarding", async () => {
    profileValue = { username: null, interests: [] };
    const { default: DashboardLayout } = await import("@/app/dashboard/layout");
    await expect(DashboardLayout({ children: null })).rejects.toThrow("REDIRECT:/onboarding");
    expect(redirectMock).toHaveBeenCalledWith("/onboarding");
  });

  it("lets a finished profile through and renders its children", async () => {
    profileValue = { username: "landon", interests: ["fitness"] };
    const { default: DashboardLayout } = await import("@/app/dashboard/layout");
    await expect(DashboardLayout({ children: "FEED" as never })).resolves.toBe("FEED");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  /**
   * The asymmetry, spelled out so nobody "completes" it later.
   *
   * This layout now runs a server-side session read on EVERY feed load. If that
   * read ever comes back empty for a transient reason, redirecting would throw
   * a real signed-in user off the feed. /dashboard already handles a signed-out
   * visitor on the client, so the layout deliberately ignores the /auth case
   * and enforces only the incomplete-profile one.
   */
  it("does NOT bounce to /auth when the server-side session read comes back empty", async () => {
    sessionValue = null;
    const { default: DashboardLayout } = await import("@/app/dashboard/layout");
    await expect(DashboardLayout({ children: "FEED" as never })).resolves.toBe("FEED");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
