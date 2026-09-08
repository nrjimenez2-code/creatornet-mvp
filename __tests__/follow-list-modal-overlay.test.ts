/**
 * @jest-environment jsdom
 */
/**
 * components/FollowListModal.tsx — the overlay itself, not the data.
 *
 * Two production defects this locks down, both found live on
 * /creators/luis at a 1280x900 viewport on 2026-09-07:
 *
 *  1. The dialog was NOT portalled. Rendered in place inside the creator
 *     profile header, its `fixed inset-0` was trapped by an ancestor
 *     containing block and laid out as a 1152x400 box at (64,24) instead of
 *     covering the viewport — so the backdrop dimmed only that box and the
 *     rest of the page stayed bright and clickable underneath an
 *     aria-modal="true" dialog. SidePanel already portals for this reason.
 *  2. The scroll lock captured document.body.style.overflow on open and
 *     restored that captured value on close. With the post-gallery overlay
 *     also open, the second modal captured "hidden" and restored "hidden",
 *     leaving the page permanently unscrollable with no modal open.
 *     Reproduced live: dialogs 0, body.style.overflow "hidden".
 *
 * Mutation checks: drop createPortal and the first test fails; restore the
 * captured-value scroll lock and the third fails.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("@/components/UserRow", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className, onClick }: { href: string; children?: unknown; className?: string; onClick?: () => void }) =>
    createElement("a", { href, className, onClick }, children as never),
}));

import FollowListModal from "@/components/FollowListModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  // Never resolves: these tests are about the shell, not the data.
  (globalThis as { fetch?: unknown }).fetch = jest.fn(() => new Promise(() => {}));
  document.body.style.overflow = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  (console.error as jest.Mock).mockRestore?.();
  await act(async () => {
    root.unmount();
  });
  container.remove();
  document.body.style.overflow = "";
});

async function renderModal(open: boolean) {
  await act(async () => {
    root.render(
      createElement(FollowListModal, {
        userId: "creator_1",
        type: "followers" as const,
        open,
        onClose: () => {},
        title: "Followers",
      })
    );
  });
}

test("the dialog is portalled to document.body, not left inside its parent", async () => {
  await renderModal(true);

  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  // The whole point: it must not be a descendant of where it was rendered,
  // or an ancestor's containing block breaks its position:fixed.
  expect(container.contains(dialog)).toBe(false);
  expect(dialog!.parentElement).toBe(document.body);
  expect(dialog!.className).toContain("fixed inset-0");
});

test("the page scroll is locked while the dialog is open", async () => {
  await renderModal(true);
  expect(document.body.style.overflow).toBe("hidden");
});

test("closing restores the page default even if another modal locked it first", async () => {
  // Simulate the post-gallery overlay already holding the lock.
  document.body.style.overflow = "hidden";

  await renderModal(true);
  expect(document.body.style.overflow).toBe("hidden");

  await renderModal(false);

  // Must be scrollable again: restoring the captured "hidden" is what left the
  // real profile page frozen with nothing open.
  expect(document.body.style.overflow).toBe("");
});

// A 401 is not a transient failure. Offering "Retry" to a signed-out visitor
// gives them a button that can never succeed and no way to sign in — confirmed
// live on production: the followers dialog showed "Sign in to see this list."
// directly above a Retry button.
// Mutation check: make fetchPage throw a plain Error for 401 and this fails.
describe("FollowListModal signed-out state", () => {
  test("a 401 offers a Sign in link, not a Retry button", async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
      status: 401,
      ok: false,
      json: async () => ({ error: "unauthorized" }),
    }));

    await renderModal(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Sign in to see this list.");
    const signIn = dialog.querySelector('a[href="/auth"]');
    expect(signIn).not.toBeNull();
    expect(signIn?.textContent).toBe("Sign in");
    const retry = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry"
    );
    expect(retry).toBeUndefined();
  });

  test("a real failure still offers Retry, not a sign-in link", async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
      status: 500,
      ok: false,
      json: async () => ({ error: "boom" }),
    }));

    await renderModal(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const dialog = document.querySelector('[role="dialog"]')!;
    const retry = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry"
    );
    expect(retry).not.toBeUndefined();
    expect(dialog.querySelector('a[href="/auth"]')).toBeNull();
  });
});
