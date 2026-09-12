/**
 * @jest-environment jsdom
 */
/**
 * app/watch/[postId]/page.tsx — error states.
 *
 * "Unable to verify access." is a transient failure (the purchases lookup
 * errored) and now offers Try again; "Post not found." is final and does
 * not. Same harness as hidden-posts-not-discoverable-client.test.ts.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_fake";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
const router = { push: jest.fn(), prefetch: jest.fn() };
let mockSearch = "";

jest.mock("@/lib/supabaseClient", () => ({ createClient: () => db }));
jest.mock("@/lib/useUser", () => ({
  useUser: () => ({ userId: "buyer_1", session: null, loading: false }),
  useRequireUser: () => ({ userId: "buyer_1", session: null, loading: false }),
}));
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

import WatchPage from "@/app/watch/[postId]/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(createElement(WatchPage));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) ?? null;

beforeEach(() => {
  jest.clearAllMocks();
  mockSearch = "";
  jest.spyOn(console, "error").mockImplementation(() => {});
  db = createMockClient(() => undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
});

afterEach(async () => {
  (console.error as jest.Mock).mockRestore?.();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("WatchPage error states", () => {
  test("purchases lookup fails: 'Unable to verify access.' with Try again + Back to Library", async () => {
    // The page now loads the post BEFORE deciding entitlement (it needs
    // creator_id to know whether the viewer is the creator), so the post must
    // resolve for the purchase lookup — and therefore this error — to be
    // reached at all. creator_id is deliberately someone else: the creator
    // branch skips the purchase check entirely.
    db = createMockClient((op) =>
      op.table === "purchases"
        ? { data: null, error: { message: "timeout" } }
        : op.table === "posts"
        ? {
            data: {
              id: "post_1",
              creator_id: "someone_else",
              title: "A post",
              video_url: null,
              poster_url: null,
              hidden_at: null,
              removed_at: null,
            },
            error: null,
          }
        : undefined
    );

    await render();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to verify access.");
    const retry = buttonNamed("Try again");
    expect(retry).not.toBeNull();
    expect(retry?.getAttribute("type")).toBe("button");
    expect(buttonNamed("Back to Library")).not.toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  test("post genuinely missing: 'Post not found.' without a Try again control", async () => {
    mockSearch = "fromProfile=1"; // skips the purchases lookup
    db = createMockClient((op) => (op.table === "posts" ? { data: null, error: null } : undefined));

    await render();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Post not found.");
    expect(buttonNamed("Try again")).toBeNull();
    expect(buttonNamed("Back to Library")).not.toBeNull();
  });
});


describe("WatchPage timed-purchase entitlement", () => {
  function ownedPurchase() {
    db = createMockClient(op => op.table === "purchases"
      ? { data: op.filters.access_granted === true ? null : { id: "timed_purchase" }, error: null }
      : op.table === "posts" ? { data: { id: "post_1", creator_id: null, title: "Paid fixed service", video_url: null,
          poster_url: null, hidden_at: null, removed_at: null }, error: null } : undefined);
  }
  function response(body: unknown, ok = true) {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string) => url === "/api/library/eligibility"
      ? { ok, status: ok ? 200 : 503, json: async () => body }
      : { ok: false, status: 404, json: async () => ({}) });
  }
  test("paid raw-false service opens through the authenticated server decision", async () => {
    ownedPurchase(); response({ purchaseIds: ["timed_purchase"] });
    await render();
    expect(container.textContent).toContain("Paid fixed service");
    expect(router.push).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("/api/library/eligibility", expect.objectContaining({
      credentials: "include", cache: "no-store", body: JSON.stringify({ purchaseIds: ["timed_purchase"] }),
    }));
    expect(fetch).toHaveBeenCalledWith("/api/watch/post_1", expect.objectContaining({ credentials: "include" }));
  });
  test.each([{ purchaseIds: [] }, { purchaseIds: ["another_purchase"] }])("server denial %p never renders the post or loads delivery", async ({ purchaseIds }) => {
    ownedPurchase(); response({ purchaseIds }); await render();
    expect(router.push).toHaveBeenCalledWith("/dashboard?postId=post_1");
    expect(container.textContent).not.toContain("Paid fixed service");
    expect(fetch).not.toHaveBeenCalledWith("/api/watch/post_1", expect.anything());
    expect(fetch).not.toHaveBeenCalledWith("/api/watch/post_1", expect.anything());
  });
  test.each([null, {}, { purchaseIds: "timed_purchase" }, { purchaseIds: [123] }])("malformed response %p fails closed with retry", async body => {
    ownedPurchase(); response(body); await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to verify access.");
    expect(buttonNamed("Try again")).not.toBeNull();
    expect(container.textContent).not.toContain("Paid fixed service");
    expect(fetch).not.toHaveBeenCalledWith("/api/watch/post_1", expect.anything());
    expect(router.push).not.toHaveBeenCalled();
  });
  test("entitlement endpoint error cannot grant access even with a matching ID", async () => {
    ownedPurchase(); response({ purchaseIds: ["timed_purchase"] }, false); await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to verify access.");
    expect(container.textContent).not.toContain("Paid fixed service");
    expect(fetch).not.toHaveBeenCalledWith("/api/watch/post_1", expect.anything());
  });
  test("network failure cannot grant access", async () => {
    ownedPurchase(); (globalThis as { fetch?: unknown }).fetch = jest.fn().mockRejectedValue(Error("offline"));
    await render(); expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to verify access.");
    expect(container.textContent).not.toContain("Paid fixed service");
    expect(fetch).not.toHaveBeenCalledWith("/api/watch/post_1", expect.anything());
  });
});
