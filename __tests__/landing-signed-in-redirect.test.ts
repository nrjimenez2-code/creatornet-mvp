/**
 * @jest-environment jsdom
 */
/**
 * components/landing/SignedInRedirect.tsx — the landing page must never strand
 * a visitor who has just signed in.
 *
 * Supabase Auth only honours a redirect_to whose host is site_url's host
 * (creatornet.net) or is on the allow-list, and the app asks for
 * www.creatornet.net/auth. So after OAuth or a magic link the browser arrives
 * at "/" with the session in the URL fragment and NO auth cookie: app/page.tsx
 * renders the logged-out landing page, the browser client establishes the
 * session, and nothing navigates. This component is the client-side hand-off
 * to /auth that "/" used to perform server-side before PR #119.
 *
 * Imports the real component; mocks useUser (the single client auth source)
 * and the router, and drives it through the states the provider can emit.
 * Mutation-checked — see the commit message.
 */

import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import type { Session, User } from "@supabase/supabase-js";

type UserState = {
  userId: string | null;
  session: Session | null;
  loading: boolean;
};

// Declared before the mocks so the (hoisted) factories close over them.
let mockUser: UserState = { userId: null, session: null, loading: true };
const mockReplace = jest.fn();
const mockPush = jest.fn();
// One stable router object, as Next's useRouter returns. A fresh object per
// render would re-trigger the effect on every render and hide a real
// "fires more than once" regression behind test noise.
const mockRouter = { replace: mockReplace, push: mockPush };

jest.mock("@/lib/useUser", () => ({
  useUser: () => mockUser,
}));

jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

// Imported after the mocks above are registered (jest hoists the factories).
import SignedInRedirect from "@/components/landing/SignedInRedirect";

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

const makeSession = (userId: string): Session => ({
  access_token: `token-${userId}`,
  refresh_token: `refresh-${userId}`,
  expires_in: 3600,
  token_type: "bearer",
  user: makeUser(userId),
});

const signedIn = (userId = "user-1"): UserState => ({
  userId,
  session: makeSession(userId),
  loading: false,
});

const signedOut = (): UserState => ({ userId: null, session: null, loading: false });

describe("SignedInRedirect", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (state: UserState) => {
    mockUser = state;
    await act(async () => {
      root.render(createElement(SignedInRedirect, null));
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
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

  test("(1) does not navigate while useUser is still loading, even with a session in hand", async () => {
    // The provider never emits loading=true with a session, but the guard must
    // hold on its own: a redirect decided before the seed settles is a redirect
    // decided on stale state, and the server render must never navigate.
    await render({ ...signedIn(), loading: true });

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("(2) leaves a signed-out visitor on the landing page", async () => {
    await render(signedOut());

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("(3) sends a signed-in visitor to /auth, via replace, exactly once", async () => {
    await render(signedIn());

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/auth");
    // replace, not push: Back must not return to the page that stranded them.
    expect(mockPush).not.toHaveBeenCalled();

    // A re-render with the same state (parent re-render, unrelated setState)
    // must not queue a second navigation.
    await render(mockUser);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  test("(4) renders nothing", async () => {
    await render(signedIn());
    expect(container.innerHTML).toBe("");

    await render(signedOut());
    expect(container.innerHTML).toBe("");
  });

  test("(5) fires when the session arrives after the seed settled empty (SIGNED_IN)", async () => {
    // The production sequence: getSession() seeds nothing, then the browser
    // client finishes reading the URL fragment and emits SIGNED_IN.
    await render(signedOut());
    expect(mockReplace).not.toHaveBeenCalled();

    await render(signedIn());
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/auth");
  });

  test("(6) a session that goes away (SIGNED_OUT) never triggers another navigation", async () => {
    await render(signedIn());
    expect(mockReplace).toHaveBeenCalledTimes(1);

    await render(signedOut());
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
