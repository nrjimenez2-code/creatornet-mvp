/**
 * @jest-environment jsdom
 */
/**
 * Client half of hidden-posts-not-discoverable.test.ts.
 *
 * components/ContinueWatching reads `posts` with the browser client and must
 * exclude hidden and removed posts. app/watch/[postId] (a direct link) reads
 * the moderation columns instead and decides in code: a paid buyer or the
 * post's own creator still opens a hidden/removed post (a buyer never loses
 * what they paid for); anyone else lands in the same "Post not found." branch
 * a nonexistent id does today — no new UI state.
 *
 * Renders the REAL components with react-dom and asserts on the query each
 * one issued (and, for the watch page, on what it then showed).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_fake";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
const routerPush = jest.fn();
// One stable router object: the watch page lists `router` in its effect deps,
// so a fresh object per render would re-run the effect on every state change.
const router = { push: routerPush, prefetch: jest.fn() };

jest.mock("@/lib/supabaseClient", () => ({ createClient: () => db }));
jest.mock("@/lib/useUser", () => ({
  useUser: () => ({ userId: "buyer_1", session: null, loading: false }),
  useRequireUser: () => ({ userId: "buyer_1", session: null, loading: false }),
}));
// Mutable so a test can choose the fromProfile path (no purchase lookup) or
// the buyer path (purchases lookup first).
let mockSearch = "fromProfile=1";
jest.mock("next/navigation", () => ({
  useParams: () => ({ postId: "post_1" }),
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children?: unknown }) =>
    createElement("a", { href }, children as never),
}));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function expectModerationFilter(op: Op) {
  expect(op.table).toBe("posts");
  expect(op.kind).toBe("select");
  expect(op.isFilters).toEqual(
    expect.arrayContaining([
      { column: "hidden_at", value: null },
      { column: "removed_at", value: null },
    ])
  );
}

let container: HTMLDivElement;
let root: Root;

async function render(Component: () => unknown) {
  await act(async () => {
    root.render(createElement(Component as never));
  });
  // Let the component's async effect chain settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSearch = "fromProfile=1";
  // The watch page logs the not-found branch; expected here, keep output clean.
  jest.spyOn(console, "error").mockImplementation(() => {});
  // No resetModules(): it would hand the component a second copy of react,
  // and hooks then fail against the react-dom that renders it.
  db = createMockClient(() => undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // The watch page fetches /api/watch/* after a post loads; never reached
  // here, but keep it from touching the network if it is.
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
});

afterEach(async () => {
  (console.error as jest.Mock).mockRestore?.();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

const HIDDEN_POST = {
  id: "post_1",
  creator_id: "someone_else",
  title: "Hidden thing",
  video_url: null,
  poster_url: null,
  hidden_at: "2026-09-03T00:00:00Z",
  removed_at: null,
};

describe("app/watch/[postId]", () => {
  // The watch page is the one consumer surface that must NOT filter hidden or
  // removed posts out of the query: a buyer never loses what they paid for.
  // It reads the moderation columns and decides in code.
  it("reads the moderation columns and shows 'Post not found.' for a hidden post to a non-entitled viewer", async () => {
    db = createMockClient((op) => (op.table === "posts" ? { data: HIDDEN_POST, error: null } : undefined));
    const { default: WatchPage } = await import("@/app/watch/[postId]/page");
    await render(WatchPage);

    const reads = db.opsFor("posts").filter((o) => o.kind === "select");
    expect(reads).toHaveLength(1);
    expect(reads[0].filters).toHaveProperty("id", "post_1");
    expect(reads[0].columns).toMatch(/\bhidden_at\b/);
    expect(reads[0].columns).toMatch(/\bremoved_at\b/);
    // Same branch as a nonexistent id — no new UI state.
    expect(container.textContent).toContain("Post not found.");
    expect(container.textContent).not.toContain("Hidden thing");
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("shows 'Post not found.' for a REMOVED post to a non-entitled viewer", async () => {
    db = createMockClient((op) =>
      op.table === "posts"
        ? { data: { ...HIDDEN_POST, hidden_at: null, removed_at: "2026-09-03T00:00:00Z" }, error: null }
        : undefined
    );
    const { default: WatchPage } = await import("@/app/watch/[postId]/page");
    await render(WatchPage);
    expect(container.textContent).toContain("Post not found.");
  });

  it("still opens a hidden post for a buyer with a paid purchase row", async () => {
    mockSearch = ""; // the buyer path: purchases lookup first
    db = createMockClient((op) =>
      op.table === "purchases"
        ? { data: { id: "pur_1" }, error: null }
        : op.table === "posts"
          ? { data: HIDDEN_POST, error: null }
          : undefined
    );
    const { default: WatchPage } = await import("@/app/watch/[postId]/page");
    await render(WatchPage);

    const pur = db.opsFor("purchases").filter((o) => o.kind === "select");
    expect(pur).toHaveLength(1);
    expect(pur[0].filters).toMatchObject({
      buyer_id: "buyer_1",
      post_id: "post_1",
      access_granted: true,
    });
    expect(pur[0].inFilters).toContainEqual({
      column: "status",
      values: ["paid", "active", "complete"],
    });
    expect(container.textContent).toContain("Hidden thing");
    expect(container.textContent).not.toContain("Post not found.");
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("still opens a hidden post for its own creator (from their profile)", async () => {
    db = createMockClient((op) =>
      op.table === "posts" ? { data: { ...HIDDEN_POST, creator_id: "buyer_1" }, error: null } : undefined
    );
    const { default: WatchPage } = await import("@/app/watch/[postId]/page");
    await render(WatchPage);
    expect(container.textContent).toContain("Hidden thing");
    expect(container.textContent).not.toContain("Post not found.");
  });

  it("a non-entitled viewer without a purchase is sent to the dashboard, never shown the post", async () => {
    mockSearch = "";
    db = createMockClient((op) =>
      op.table === "purchases" ? { data: null, error: null } : op.table === "posts" ? { data: HIDDEN_POST, error: null } : undefined
    );
    const { default: WatchPage } = await import("@/app/watch/[postId]/page");
    await render(WatchPage);
    expect(routerPush).toHaveBeenCalledWith("/dashboard?postId=post_1");
    expect(db.opsFor("posts")).toHaveLength(0);
  });

  it("still renders a visible post (the gate does not break the happy path)", async () => {
    db = createMockClient((op) =>
      op.table === "posts"
        ? { data: { id: "post_1", creator_id: null, title: "Hello", video_url: null, poster_url: null, hidden_at: null, removed_at: null }, error: null }
        : undefined
    );
    const { default: WatchPage } = await import("@/app/watch/[postId]/page");
    await render(WatchPage);

    expect(container.textContent).toContain("Hello");
    expect(container.textContent).not.toContain("Post not found.");
  });
});

describe("components/ContinueWatching", () => {
  it("resolves watched ids to posts with the moderation filter", async () => {
    db = createMockClient((op) =>
      op.table === "watch_progress"
        ? { data: [{ post_id: "post_1", seconds: 12, updated_at: "2026-01-01T00:00:00Z" }], error: null }
        : op.table === "posts"
          ? { data: [], error: null }
          : undefined
    );
    const { default: ContinueWatching } = await import("@/components/ContinueWatching");
    await render(ContinueWatching);

    const reads = db.opsFor("posts").filter((o) => o.kind === "select");
    expect(reads).toHaveLength(1);
    expect(reads[0].inFilters).toEqual([{ column: "id", values: ["post_1"] }]);
    expectModerationFilter(reads[0]);

    // A progress row whose post was filtered out is not shown.
    expect(container.textContent).toContain("Nothing here yet");
  });
});
