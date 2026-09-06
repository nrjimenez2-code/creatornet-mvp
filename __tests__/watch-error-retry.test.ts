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
    db = createMockClient((op) =>
      op.table === "purchases" ? { data: null, error: { message: "timeout" } } : undefined
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
