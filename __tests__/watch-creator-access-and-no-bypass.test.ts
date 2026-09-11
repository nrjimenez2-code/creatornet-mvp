/**
 * @jest-environment jsdom
 */
/**
 * Two rules for app/watch/[postId], both of which the page got wrong.
 *
 * 1. A creator can open their OWN post. The purchase check used to run before
 *    the post was even loaded, so no creator branch was possible: the creator of
 *    a paid post was redirected to /dashboard and could never confirm that their
 *    own delivery worked.
 *
 * 2. There is no query-parameter bypass. `?fromProfile=1` disabled the purchase
 *    check for ANY signed-in user who typed it, and nothing in the app ever set
 *    it. The paywalled file never leaked (the API still returns 402), but the
 *    page rendered as though the viewer were entitled.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_fake";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "fs";
import { join } from "path";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

const VIEWER = "viewer_1";
let db: MockClient;
const routerPush = jest.fn();
const router = { push: routerPush, prefetch: jest.fn() };

jest.mock("@/lib/supabaseClient", () => ({ createClient: () => db }));
jest.mock("@/lib/useUser", () => ({
  useUser: () => ({ userId: VIEWER, session: null, loading: false }),
  useRequireUser: () => ({ userId: VIEWER, session: null, loading: false }),
}));
jest.mock("next/navigation", () => ({
  useParams: () => ({ postId: "post_1" }),
  useRouter: () => router,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children?: unknown }) =>
    createElement("a", { href }, children as never),
}));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const post = (creatorId: string | null) => ({
  id: "post_1",
  creator_id: creatorId,
  title: "Paid thing",
  video_url: null,
  poster_url: null,
  hidden_at: null,
  removed_at: null,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  }));
});

afterEach(async () => {
  (console.error as jest.Mock).mockRestore?.();
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  const { default: WatchPage } = await import("@/app/watch/[postId]/page");
  await act(async () => {
    root.render(createElement(WatchPage as never));
  });
}

describe("app/watch/[postId] creator access", () => {
  test("the creator opens their own post with no purchase row at all", async () => {
    db = createMockClient((op) =>
      op.table === "posts"
        ? { data: post(VIEWER), error: null }
        : op.table === "purchases"
        ? { data: null, error: null }
        : undefined
    );

    await render();

    expect(container.textContent).toContain("Paid thing");
    expect(routerPush).not.toHaveBeenCalled();
  });

  test("the creator branch does not even run the purchase lookup", async () => {
    db = createMockClient((op) =>
      op.table === "posts" ? { data: post(VIEWER), error: null } : undefined
    );

    await render();

    expect(db.opsFor("purchases")).toHaveLength(0);
    expect(container.textContent).toContain("Paid thing");
  });

  test("someone who is NOT the creator and has no purchase is still redirected", async () => {
    db = createMockClient((op) =>
      op.table === "posts"
        ? { data: post("someone_else"), error: null }
        : op.table === "purchases"
        ? { data: null, error: null }
        : undefined
    );

    await render();

    expect(routerPush).toHaveBeenCalledWith("/dashboard?postId=post_1");
    expect(container.textContent).not.toContain("Paid thing");
  });
});

describe("no query-parameter bypass survives in the source", () => {
  const SOURCE = readFileSync(
    join(process.cwd(), "app/watch/[postId]/page.tsx"),
    "utf8"
  );

  test("fromProfile is gone entirely", () => {
    // Allow the word in a comment explaining the removal; forbid any read of it.
    expect(SOURCE).not.toMatch(/searchParams/);
    expect(SOURCE).not.toMatch(/get\(\s*["']fromProfile["']\s*\)/);
  });

  test("entitlement is decided by ownership or a purchase row, nothing else", () => {
    expect(SOURCE).toMatch(/creator_id === userId/);
    expect(SOURCE).toMatch(/access_granted/);
  });
});
