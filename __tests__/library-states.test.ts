/**
 * @jest-environment jsdom
 */
/**
 * app/library/page.tsx — loading / signed-out / error / empty / loaded.
 *
 * Renders the REAL page against the recording supabase stub. Locks:
 *  - auth still settling → skeleton, no sign-in prompt, no query
 *  - signed out → "Sign in to see your library" with a link to /auth
 *  - purchases read fails → "Couldn't load your library" + Try again; the raw
 *    database message goes to console.error, never onto the page
 *  - no purchases → "Your library is empty" + Explore the feed link
 *  - one purchase → the card renders (no false empty state)
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_fake";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
let mockUser: { userId: string | null; loading: boolean } = { userId: null, loading: false };
const router = { push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() };

jest.mock("@/lib/supabaseClient", () => ({ createClient: () => db }));
jest.mock("@/lib/useUser", () => ({
  useUser: () => ({ userId: mockUser.userId, session: null, loading: mockUser.loading }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => router }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href, className }, children as never),
}));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));

import LibraryPage from "@/app/library/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(createElement(LibraryPage));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const text = () => container.textContent ?? "";
const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) ?? null;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockUser = { userId: null, loading: false };
  db = createMockClient(() => undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ profiles: [] }),
  }));
});

afterEach(async () => {
  (console.error as jest.Mock).mockRestore?.();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("LibraryPage states", () => {
  test("auth still settling: skeleton only, no sign-in prompt, no purchases query", async () => {
    mockUser = { userId: null, loading: true };

    await render();

    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(text()).not.toContain("Sign in");
    expect(text()).not.toContain("library is empty");
    expect(db.opsFor("purchases")).toHaveLength(0);
  });

  test("signed out: sign-in prompt with a link to /auth (not a red error)", async () => {
    mockUser = { userId: null, loading: false };

    await render();

    expect(text()).toContain("Sign in to see your library");
    const link = container.querySelector('a[href="/auth"]');
    expect(link?.textContent).toBe("Sign in");
    expect(text()).not.toContain("You must be signed in");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("purchases read fails: error text, Try again control, raw detail logged not shown", async () => {
    mockUser = { userId: "buyer_1", loading: false };
    db = createMockClient((op) =>
      op.table === "purchases" ? { data: null, error: { message: "relation is on fire" } } : undefined
    );

    await render();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load your library");
    expect(text()).not.toContain("relation is on fire");
    expect(console.error).toHaveBeenCalledWith(
      "[library] purchases read error:",
      expect.objectContaining({ message: "relation is on fire" })
    );
    const retry = buttonNamed("Try again");
    expect(retry).not.toBeNull();
    expect(retry?.getAttribute("type")).toBe("button");
    expect(text()).not.toContain("library is empty");
  });

  test("no purchases: named empty state with an Explore the feed link", async () => {
    mockUser = { userId: "buyer_1", loading: false };
    db = createMockClient((op) => (op.table === "purchases" ? { data: [], error: null } : undefined));

    await render();

    expect(text()).toContain("Your library is empty");
    expect(text()).toContain("Videos and offers you buy will show up here.");
    const explore = container.querySelector('a[href="/dashboard"]');
    expect(explore?.textContent).toBe("Explore the feed");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("one purchase: the card renders, no empty state", async () => {
    mockUser = { userId: "buyer_1", loading: false };
    db = createMockClient((op) => {
      if (op.table === "purchases") {
        return {
          data: [
            {
              id: "pur_1",
              post_id: "post_1",
              created_at: "2026-09-01T00:00:00Z",
              posts: { id: "post_1", title: "Kettlebell basics", poster_url: null, video_url: null, creator_id: "c1" },
            },
          ],
          error: null,
        };
      }
      if (op.table === "watch_progress") return { data: [], error: null };
      return undefined;
    });

    await render();

    expect(text()).toContain("Kettlebell basics");
    expect(text()).not.toContain("library is empty");
    expect(container.querySelector('a[href="/watch/post_1"]')).not.toBeNull();
  });
});
