/**
 * @jest-environment jsdom
 */
/**
 * Tripwire for the single-auth-flow invariant (P1).
 *
 * Client components never call `supabase.auth.getUser()` / `getSession()`
 * themselves — they consume `useUser()` from lib/useUser.tsx, and ONLY the
 * provider talks to supabase auth (one local seed + one onAuthStateChange
 * subscription). Every direct call a client component makes is a network
 * round trip to the auth provider on every mount, which is exactly the
 * rate-limit spiral this migration removed.
 *
 * The scan reads source as text (same style as platform-fee-units.test.ts):
 * importing these modules would construct Supabase clients at module scope,
 * which needs real credentials.
 *
 * Allowed and deliberately NOT scanned:
 *   - app/api (whole tree)  server routes verify per-request by design
 *   - any route.ts under app ditto (route handlers, e.g. app/auth/callback)
 *   - lib (whole tree)      the provider itself + server-side auth helpers
 *   - the SERVER_PAGE_EXCEPTIONS below: server components that verify with
 *     the SERVER client per-request. Each is asserted to still BE a server
 *     component — converting one to "use client" while keeping its auth
 *     call fails this suite.
 *
 * If this fails, do not exempt the new call site. Migrate it to useUser()
 * (take the access token from the context session when a fetch needs it).
 */

import { readdirSync, readFileSync } from "fs";
import { join, sep } from "path";
import {
  ReactNode,
  act,
  createElement,
} from "react";
import { createRoot, Root } from "react-dom/client";
import type { Session, User } from "@supabase/supabase-js";

const REPO_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Part 1 — source scan
// ---------------------------------------------------------------------------

/** Catches `auth.getUser(` / `auth.getSession(` including chains Prettier
 *  wrapped across lines (`supabase.auth\n  .getSession()`). */
const AUTH_CALL = /auth\s*\.\s*(getUser|getSession)\s*\(/;

/**
 * Server components (no "use client") that verify per-request with the
 * server client from lib/supabaseServer. These are the ONLY files under
 * app/ + components/ allowed to call auth.getUser()/getSession().
 */
const SERVER_PAGE_EXCEPTIONS = [
  // app/page.tsx was here until the onboarding gate moved into
  // lib/onboardingGate.ts. It no longer touches supabase auth itself, and lib
  // is deliberately out of this scan's scope (see the header). Removing it is
  // what "the exception list is exact" asks for — the list should shrink as
  // call sites migrate, never grow quietly.
  "app/access/[purchaseId]/page.tsx",
  "app/admin/layout.tsx",
  "app/creators/[creatorId]/page.tsx",
  "app/dashboard/analytics/page.tsx",
  "app/profile/page.tsx",
];

const toPosix = (path: string) => path.split(sep).join("/");

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

/** Every scanned file, as a repo-relative posix path. */
const scannedFiles = ["app", "components"]
  .flatMap((dir) => walk(join(REPO_ROOT, dir)))
  .map((abs) => toPosix(abs.slice(REPO_ROOT.length + 1)))
  .filter((rel) => !rel.startsWith("app/api/"))
  .filter((rel) => !/\/route\.tsx?$/.test(rel));

const read = (relativePath: string) =>
  readFileSync(join(REPO_ROOT, relativePath), "utf8");

const hasUseClientDirective = (source: string) =>
  /^\s*['"]use client['"]/m.test(source);

describe("single auth flow: no direct supabase auth calls in client code", () => {
  test("the scan actually covers the tree (sanity)", () => {
    // If the walk silently broke, the main assertion would pass vacuously.
    expect(scannedFiles.length).toBeGreaterThan(30);
    expect(scannedFiles).toContain("components/FeedList.tsx");
    expect(scannedFiles).toContain("app/auth/page.tsx");
    expect(scannedFiles).not.toContain("app/api/checkout/route.ts");
  });

  test("no client file under app/ or components/ calls auth.getUser/getSession", () => {
    const violations = scannedFiles
      .filter((rel) => !SERVER_PAGE_EXCEPTIONS.includes(rel))
      .filter((rel) => AUTH_CALL.test(read(rel)));

    expect(violations).toEqual([]);
  });

  test("every listed exception is still a server component using the server client", () => {
    for (const rel of SERVER_PAGE_EXCEPTIONS) {
      const source = read(rel);
      expect({ file: rel, useClient: hasUseClientDirective(source) }).toEqual({
        file: rel,
        useClient: false,
      });
      expect(source).toMatch(/@\/lib\/supabaseServer/);
    }
  });

  test("the exception list is exact (stale entries must be removed)", () => {
    for (const rel of SERVER_PAGE_EXCEPTIONS) {
      expect({ file: rel, callsAuth: AUTH_CALL.test(read(rel)) }).toEqual({
        file: rel,
        callsAuth: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2 — UserProvider unit tests
// ---------------------------------------------------------------------------

type AuthChangeCallback = (event: string, session: Session | null) => void;

const mockUnsubscribe = jest.fn();
const mockGetSession = jest.fn<Promise<{ data: { session: Session | null } }>, []>();
const mockOnAuthStateChange = jest.fn((callback: AuthChangeCallback) => ({
  data: { subscription: { unsubscribe: mockUnsubscribe } },
}));

jest.mock("@/lib/supabaseClient", () => ({
  createClient: () => ({
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: mockOnAuthStateChange,
    },
  }),
}));

const mockIdentify = jest.fn();
const mockReset = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { identify: mockIdentify, reset: mockReset },
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

// Imported after the mocks above are registered (jest hoists the factories).
import { UserProvider, useUser } from "@/lib/useUser";

// react-dom/client refuses act() outside a marked act environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const makeUser = (id: string): User => ({
  id,
  app_metadata: {},
  user_metadata: {},
  aud: "authenticated",
  created_at: "2026-01-01T00:00:00.000Z",
});

const makeSession = (userId: string, accessToken: string): Session => ({
  access_token: accessToken,
  refresh_token: `refresh-${accessToken}`,
  expires_in: 3600,
  token_type: "bearer",
  user: makeUser(userId),
});

type ObservedValue = ReturnType<typeof useUser>;

describe("UserProvider", () => {
  let container: HTMLDivElement;
  let root: Root;
  let observed: ObservedValue | null;
  let firedCallback: AuthChangeCallback;

  const Probe = (): null => {
    observed = useUser();
    return null;
  };

  const renderProvider = async () => {
    await act(async () => {
      root.render(
        createElement(
          UserProvider,
          null,
          createElement(Probe, null) as ReactNode,
        ),
      );
    });
    firedCallback = mockOnAuthStateChange.mock.calls[0][0];
  };

  const fireAuthEvent = async (event: string, session: Session | null) => {
    await act(async () => {
      firedCallback(event, session);
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    observed = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test("seeds once from the persisted session and identifies analytics", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: makeSession("user-1", "token-1") },
    });

    await renderProvider();

    expect(observed).toEqual(
      expect.objectContaining({
        userId: "user-1",
        loading: false,
      }),
    );
    expect(observed?.session?.access_token).toBe("token-1");
    // ONE local read, ONE subscription — nothing else talks to auth.
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockOnAuthStateChange).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenCalledWith("user-1");
  });

  test("settles to signed-out when there is no persisted session", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    await renderProvider();

    expect(observed).toEqual(
      expect.objectContaining({ userId: null, session: null, loading: false }),
    );
  });

  test("SIGNED_OUT clears userId and session, and resets analytics", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: makeSession("user-1", "token-1") },
    });
    await renderProvider();
    expect(observed?.userId).toBe("user-1");

    await fireAuthEvent("SIGNED_OUT", null);

    expect(observed).toEqual(
      expect.objectContaining({ userId: null, session: null, loading: false }),
    );
    expect(mockReset).toHaveBeenCalled();
  });

  test("TOKEN_REFRESHED swaps in the new session for the same user", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: makeSession("user-1", "token-old") },
    });
    await renderProvider();

    await fireAuthEvent(
      "TOKEN_REFRESHED",
      makeSession("user-1", "token-new"),
    );

    expect(observed?.userId).toBe("user-1");
    expect(observed?.session?.access_token).toBe("token-new");
  });

  test("SIGNED_IN after an empty seed populates the user", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await renderProvider();
    expect(observed?.userId).toBeNull();

    await fireAuthEvent("SIGNED_IN", makeSession("user-2", "token-2"));

    expect(observed?.userId).toBe("user-2");
  });

  test("unsubscribes from auth events on unmount", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await renderProvider();
    expect(mockUnsubscribe).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
