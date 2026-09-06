/**
 * @jest-environment jsdom
 */
/**
 * components/ReviewForm.tsx — what renders while auth settles, signed out,
 * and signed in.
 *
 * The form used to read only `userId` from useUser(), so every signed-in
 * reviewer saw "Please sign in to leave a review." flash before the session
 * seeded. It now holds the slot with a placeholder while `loading` is true,
 * and the signed-out prompt links to /auth.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let mockUser: { userId: string | null; loading: boolean } = { userId: null, loading: false };

jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({}) }));
jest.mock("@/lib/useUser", () => ({
  useUser: () => ({ userId: mockUser.userId, session: null, loading: mockUser.loading }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href, className }, children as never),
}));

import ReviewForm from "@/components/ReviewForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(createElement(ReviewForm, { creatorId: "creator_1" }));
  });
}

const text = () => container.textContent ?? "";

beforeEach(() => {
  mockUser = { userId: null, loading: false };
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

describe("ReviewForm auth states", () => {
  test("auth still settling: placeholder only — no sign-in prompt, no form", async () => {
    mockUser = { userId: null, loading: true };

    await render();

    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(text()).not.toContain("Please sign in");
    expect(container.querySelector("form")).toBeNull();
  });

  test("signed out: prompt with a Sign in link to /auth", async () => {
    mockUser = { userId: null, loading: false };

    await render();

    expect(text()).toContain("Please sign in to leave a review.");
    const link = container.querySelector('a[href="/auth"]');
    expect(link?.textContent).toBe("Sign in");
    expect(container.querySelector("form")).toBeNull();
  });

  test("signed in: the form renders", async () => {
    mockUser = { userId: "buyer_1", loading: false };

    await render();

    expect(container.querySelector("form")).not.toBeNull();
    expect(text()).toContain("Write a Review");
    expect(text()).not.toContain("Please sign in");
  });
});
