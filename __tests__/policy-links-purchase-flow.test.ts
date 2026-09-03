/**
 * @jest-environment jsdom
 */
/**
 * Stripe's website review (and Noah's brief) require the refund, delivery /
 * cancellation, privacy and terms policies to be reachable from the PURCHASE
 * FLOW, not just the landing-page footer. This suite renders the real
 * components that a buyer passes through and asserts the links are in the
 * rendered DOM:
 *
 *   - app/auth/page.tsx            sign-in (refunds, delivery, support)
 *   - components/VideoCard.tsx     the Buy dropdown (refunds, new tab)
 *   - app/success/page.tsx         post-checkout (support mailto + refunds)
 *   - app/cancel/page.tsx          checkout abandoned (support mailto + refunds)
 *
 * Real render, not a source regex: a link that is present in the file but
 * never reaches the DOM (wrong branch, wrong state) fails here.
 * Mutation-checked: deleting any one link makes exactly its assertion fail.
 */

import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

// ---------------------------------------------------------------------------
// Module mocks — registered before the components import (jest hoists these).
// ---------------------------------------------------------------------------

const mockClient = createMockClient();
jest.mock("@/lib/supabaseClient", () => ({
  createClient: () => mockClient,
  supabase: mockClient,
}));

/** Per-test auth context; components read it through useUser() only. */
const userCtx: { session: { access_token: string } | null; loading: boolean; userId: string | null } = {
  session: null,
  loading: false,
  userId: null,
};
jest.mock("@/lib/useUser", () => ({
  useUser: () => userCtx,
}));

jest.mock("@/lib/posthog", () => ({
  trackEvent: jest.fn(),
  normalizeCategory: (raw: string | null | undefined) => raw ?? null,
}));

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// The comment drawer drags in its own data fetching; it is not part of the
// purchase flow and is never opened here.
jest.mock("@/components/CommentPanel", () => ({
  __esModule: true,
  default: () => null,
}));

import AuthPage from "@/app/auth/page";
import SuccessPage from "@/app/success/page";
import CancelPage from "@/app/cancel/page";
import VideoCard from "@/components/VideoCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no IntersectionObserver; VideoCard constructs one for autoplay.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = NoopObserver;

const SUPPORT_MAILTO = "mailto:support@creatornet.net";

function anchor(scope: ParentNode, href: string): HTMLAnchorElement | null {
  return scope.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
}

describe("policy links in the purchase flow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    userCtx.session = null;
    userCtx.loading = false;
    userCtx.userId = null;
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

  // -------------------------------------------------------------------------
  // app/auth/page.tsx
  // -------------------------------------------------------------------------
  describe("sign-in page", () => {
    // The page carries a <style jsx global> block. styled-jsx is a Next
    // compiler transform, so outside Next react-dom warns about the two
    // boolean attributes. Everything else console.error says still surfaces.
    const realError = console.error;
    beforeAll(() => {
      console.error = (...args: unknown[]) => {
        // react-dom logs a format string: args[0] holds "%s", the attribute name follows.
        const isStyledJsxAttr =
          String(args[0]).includes("non-boolean attribute") &&
          args.some((a) => a === "jsx" || a === "global");
        if (isStyledJsxAttr) return;
        realError(...args);
      };
    });
    afterAll(() => {
      console.error = realError;
    });

    it("links refund, delivery/cancellation and support below the terms line", async () => {
      await act(async () => {
        root.render(createElement(AuthPage));
      });

      // Sanity: the page left its "Loading…" gate (signed out, auth settled).
      expect(container.textContent).toContain("By continuing, you agree to our");

      const refunds = anchor(container, "/legal/refunds");
      const delivery = anchor(container, "/legal/delivery");
      const support = anchor(container, "/legal/support");

      expect(refunds?.textContent).toBe("Refund policy");
      expect(delivery?.textContent).toBe("Delivery & cancellation");
      expect(support?.textContent).toBe("Support");

      // Same treatment as the existing Terms / Privacy / Cookies links.
      const terms = anchor(container, "/legal/terms");
      expect(terms).not.toBeNull();
      for (const a of [refunds, delivery, support]) {
        expect(a?.className).toBe(terms!.className);
      }
    });
  });

  // -------------------------------------------------------------------------
  // components/VideoCard.tsx — the Buy dropdown
  // -------------------------------------------------------------------------
  describe("buy dropdown", () => {
    const openDropdown = async () => {
      await act(async () => {
        root.render(
          createElement(VideoCard, {
            creator: "Creator",
            title: "A paid post",
            productId: "prod_test",
            priceCents: 1999,
            isActive: false,
          })
        );
      });
      const buy = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
      expect(buy).not.toBeNull();
      await act(async () => {
        buy!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const dropdown = document.querySelector<HTMLElement>("[data-buy-dropdown]");
      expect(dropdown).not.toBeNull();
      return dropdown!;
    };

    it("ends with a secondary refund & delivery policy link that opens in a new tab", async () => {
      const dropdown = await openDropdown();

      const link = anchor(dropdown, "/legal/refunds");
      expect(link?.textContent).toBe("Refund & delivery policy");
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.getAttribute("rel")).toBe("noopener noreferrer");

      // Plain anchor: not a menuitem, so roving keyboard nav over the real
      // actions is unaffected, and it must come after them.
      expect(link?.getAttribute("role")).toBeNull();
      const items = [...dropdown.querySelectorAll("[role='menuitem']")];
      expect(items.length).toBeGreaterThan(0);
      expect(link!.compareDocumentPosition(items[items.length - 1]) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    });

    // The card fills the viewport on desktop and the Buy button sits near the
    // bottom edge; opening downward there clips the lower rows (Book, this
    // link) off-screen, and any scroll closes the menu. The menu must flip.
    const withButtonRect = async (rect: { top: number; bottom: number; left: number }, innerHeight: number) => {
      const original = HTMLButtonElement.prototype.getBoundingClientRect;
      const originalHeight = window.innerHeight;
      HTMLButtonElement.prototype.getBoundingClientRect = function () {
        return { ...rect, right: rect.left + 120, width: 120, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON() {} } as DOMRect;
      };
      Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
      try {
        return await openDropdown();
      } finally {
        HTMLButtonElement.prototype.getBoundingClientRect = original;
        Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
      }
    };

    it("opens upward when the Buy button sits near the bottom of the viewport", async () => {
      const dropdown = await withButtonRect({ top: 828, bottom: 868, left: 100 }, 900);
      expect(dropdown.style.bottom).toBe(`${900 - 828 + 8}px`);
      expect(dropdown.style.top).toBe("");
      expect(anchor(dropdown, "/legal/refunds")).not.toBeNull();
    });

    it("opens downward when there is room below", async () => {
      const dropdown = await withButtonRect({ top: 100, bottom: 140, left: 100 }, 900);
      expect(dropdown.style.top).toBe(`${140 + 8}px`);
      expect(dropdown.style.bottom).toBe("");
    });

    it("is visibly secondary to the Pay in full action", async () => {
      const dropdown = await openDropdown();
      const link = anchor(dropdown, "/legal/refunds")!;
      const pay = dropdown.querySelector<HTMLButtonElement>("[role='menuitem']")!;

      expect(pay.className).toContain("font-semibold");
      expect(link.className).not.toContain("font-semibold");
      expect(link.className).toContain("text-[11px]");
      expect(link.className).toContain("text-black/70");
      // A divider separates it from the actions.
      expect(link.previousElementSibling?.className).toContain("h-px");
    });

    it("stays open on mousedown and lets the click through (nothing swallows it)", async () => {
      const dropdown = await openDropdown();
      const link = anchor(dropdown, "/legal/refunds")!;

      // The click-outside guard listens for mousedown on document.
      await act(async () => {
        link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      expect(document.querySelector("[data-buy-dropdown]")).not.toBeNull();

      // React's portal handlers run when the event reaches document.body; a
      // listener on document sees the outcome. preventDefault there only stops
      // jsdom from attempting a real navigation.
      let swallowed: boolean | null = null;
      const observe = (e: Event) => {
        swallowed = e.defaultPrevented;
        e.preventDefault();
      };
      document.addEventListener("click", observe);
      try {
        await act(async () => {
          link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        });
      } finally {
        document.removeEventListener("click", observe);
      }
      expect(swallowed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // app/success/page.tsx
  // -------------------------------------------------------------------------
  describe("post-checkout success page", () => {
    const expectFooter = (scope: ParentNode) => {
      const mail = anchor(scope, SUPPORT_MAILTO);
      const refunds = anchor(scope, "/legal/refunds");
      expect(mail?.textContent).toBe("support@creatornet.net");
      expect(refunds?.textContent).toBe("Refund policy");
      // One footer line carrying both, so it reads "Questions? … · Refund policy".
      expect(mail?.parentElement).toBe(refunds?.parentElement);
      expect(mail?.parentElement?.textContent).toContain("Questions?");
    };

    it("shows the support + refund footer while still checking (initial render)", () => {
      // Static render: effects never run, so the card is in its "checking" state.
      const html = renderToStaticMarkup(createElement(SuccessPage));
      const scope = document.createElement("div");
      scope.innerHTML = html;
      expect(scope.textContent).toContain("Almost there...");
      expectFooter(scope);
    });

    it("shows the support + refund footer in the error state too", async () => {
      // No session_id in the URL → the purchase flow settles on "error".
      await act(async () => {
        root.render(createElement(SuccessPage));
      });
      expect(container.textContent).toContain("Missing session id.");
      expect(container.textContent).toContain("Go to Library");
      expectFooter(container);
    });
  });

  // -------------------------------------------------------------------------
  // app/cancel/page.tsx
  // -------------------------------------------------------------------------
  describe("checkout cancelled page", () => {
    it("shows the support + refund footer", () => {
      const html = renderToStaticMarkup(createElement(CancelPage));
      const scope = document.createElement("div");
      scope.innerHTML = html;
      expect(scope.textContent).toContain("Payment canceled");
      expect(anchor(scope, SUPPORT_MAILTO)?.textContent).toBe("support@creatornet.net");
      expect(anchor(scope, "/legal/refunds")?.textContent).toBe("Refund policy");
    });
  });
});
