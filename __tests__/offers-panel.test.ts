/**
 * @jest-environment jsdom
 */
/**
 * components/OffersPanel.tsx + components/SidePanel.tsx — the creator-profile
 * "Offers" side panel (Noah #8).
 *
 * Renders the REAL components (createRoot + act, no JSX — same pattern as
 * single-auth-flow.test.ts / buy-button.test.ts) and locks:
 *   - trigger opens a role="dialog" with aria-modal + aria-labelledby
 *   - Esc closes and focus returns to the trigger
 *   - Tab / Shift+Tab wrap inside the panel
 *   - not-sell-ready creators get a disabled Buy CTA (booking stays live)
 *   - signed-out clicks go to /auth, never to /api/checkout
 *   - the /api/checkout POST bodies match VideoCard's product and booking
 *     payloads exactly, and server error strings surface verbatim
 */

import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import type { OfferCard } from "@/lib/offers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- mocks (hoisted by jest) ------------------------------------------------

let userCtx: { userId: string | null; session: null; loading: boolean } = {
  userId: "buyer_1",
  session: null,
  loading: false,
};
jest.mock("@/lib/useUser", () => ({
  useUser: () => userCtx,
}));

const routerPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), prefetch: jest.fn() }),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

// Real startCheckout (so the fetch body is the real one); only the final
// window.location.assign is stubbed — jsdom refuses to redefine location.
const assignMock = jest.fn();
jest.mock("@/lib/checkoutClient", () => ({
  ...jest.requireActual("@/lib/checkoutClient"),
  navigateTo: (url: string) => assignMock(url),
}));

// Imported after the mocks are registered.
import OffersPanel, { NOT_SELL_READY_LABEL } from "@/components/OffersPanel";

// --- fixtures ---------------------------------------------------------------

const CREATOR_ID = "creator_1";

const courseCard: OfferCard = {
  key: "product:prod_1",
  kind: "course",
  label: "COURSE",
  title: "Creator Growth Blueprint",
  description: "Step-by-step system.",
  priceCents: 9700,
  currency: "usd",
  imageUrl: null,
  postId: "post_1",
  productId: "prod_1",
  bookingUrl: null,
  cta: "View course",
};

const bookingCard: OfferCard = {
  key: "booking:post_2",
  kind: "consultation",
  label: "CONSULTATION",
  title: "30-Min Strategy Call",
  description: "Pick a time that works for you.",
  priceCents: null,
  currency: "usd",
  imageUrl: null,
  postId: "post_2",
  productId: null,
  bookingUrl: "https://cal.com/noah/30min",
  cta: "Book a call",
};

type PanelProps = Parameters<typeof OffersPanel>[0];

const baseProps: PanelProps = {
  creatorId: CREATOR_ID,
  creatorName: "Noah Jimenez",
  offers: [courseCard, bookingCard],
  sellReady: true,
  rating: { avgRating: 4.9, reviewCount: 128 },
};

/**
 * The bodies components/VideoCard.tsx sends (handleBuy / handleBook), after
 * the same JSON round trip the browser performs (undefined keys drop out).
 */
const videoCardProductBody = (card: OfferCard, buyerId: string) =>
  JSON.parse(
    JSON.stringify({
      type: "product",
      product_id: String(card.productId),
      post_id: card.postId ?? undefined,
      creator_id: CREATOR_ID ?? null,
      titleForCheckout: card.title ?? undefined,
      buyer_id: buyerId ?? undefined,
    }),
  );
const videoCardBookingBody = (card: OfferCard) =>
  JSON.parse(
    JSON.stringify({
      type: "booking",
      post_id: card.postId,
      creator_id: CREATOR_ID ?? undefined,
      bookingRedirectUrl: card.bookingUrl,
    }),
  );

// --- harness ----------------------------------------------------------------

describe("OffersPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    userCtx = { userId: "buyer_1", session: null, loading: false };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.style.overflow = "";
  });

  async function render(props: Partial<PanelProps> = {}) {
    await act(async () => {
      root.render(createElement(OffersPanel, { ...baseProps, ...props }));
    });
  }

  const trigger = () =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      /Offers/.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const ctaButtons = () =>
    Array.from(dialog()?.querySelectorAll<HTMLButtonElement>("li button") ?? []);

  async function open() {
    const t = trigger();
    t.focus();
    await act(async () => {
      t.click();
    });
    const d = dialog();
    if (!d) throw new Error("dialog did not open");
    return d;
  }

  const okResponse = (url: string) =>
    ({ ok: true, status: 200, json: async () => ({ url, session_id: "cs_1" }) }) as Response;
  const errorResponse = (status: number, error: string, code?: string) =>
    ({ ok: false, status, json: async () => ({ error, code }) }) as Response;

  // --- trigger + dialog semantics ------------------------------------------

  test("renders nothing when the creator has no offers (button hidden by default)", async () => {
    await render({ offers: [] });
    expect(container.querySelector("button")).toBeNull();
  });

  test("trigger is a button that announces its dialog and opens it on click", async () => {
    await render();
    const t = trigger();
    expect(t.getAttribute("type")).toBe("button");
    expect(t.getAttribute("aria-haspopup")).toBe("dialog");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(t.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(dialog()).toBeNull();

    const d = await open();

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(d.getAttribute("aria-modal")).toBe("true");
    const labelId = d.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe("Offers");
    expect(d.textContent).toContain("Exclusive products and services from Noah Jimenez.");
  });

  test("moves focus into the dialog on open and locks body scroll", async () => {
    await render();
    const d = await open();

    expect(d.contains(document.activeElement)).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("Escape closes the dialog, restores scroll, and returns focus to the trigger", async () => {
    await render();
    await open();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(dialog()).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  test("backdrop click and the Close button both close the dialog", async () => {
    await render();
    await open();
    await act(async () => {
      (document.querySelector('[data-testid="side-panel-backdrop"]') as HTMLElement).click();
    });
    expect(dialog()).toBeNull();

    await open();
    const close = dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    expect(close.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      close.click();
    });
    expect(dialog()).toBeNull();
  });

  test("Tab from the last focusable wraps to the first; Shift+Tab from the first wraps to the last", async () => {
    await render();
    const d = await open();
    const focusable = Array.from(
      d.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    );
    expect(focusable.length).toBeGreaterThan(2);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    await act(async () => {
      last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(first);

    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  // --- content -------------------------------------------------------------

  test("shows the creator-level rating once, and cards with label, title, price, and CTA", async () => {
    await render();
    const d = await open();

    const ratingLink = d.querySelector<HTMLAnchorElement>(`a[href="/creators/${CREATOR_ID}/reviews"]`);
    expect(ratingLink?.textContent).toContain("4.9 · 128 reviews");
    expect((d.textContent?.match(/reviews/g) ?? []).length).toBe(1);

    const cards = Array.from(d.querySelectorAll("li"));
    expect(cards.map((c) => c.getAttribute("data-offer-kind"))).toEqual(["course", "consultation"]);
    expect(cards[0].textContent).toContain("COURSE");
    expect(cards[0].textContent).toContain("Creator Growth Blueprint");
    expect(cards[0].textContent).toContain("$97");
    expect(cards[0].querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(ctaButtons().map((b) => b.textContent)).toEqual(["View course", "Book a call"]);
    expect(d.textContent).toContain("Secure payments powered by CreatorNet");
  });

  test("hides the rating line when there are no reviews", async () => {
    await render({ rating: { avgRating: 0, reviewCount: 0 }, offers: [courseCard] });
    const d = await open();
    expect(d.textContent).not.toContain("review");
  });

  // --- sell-ready gate -----------------------------------------------------

  test("not sell-ready: Buy CTA is disabled with the explanatory label; booking CTA stays enabled", async () => {
    await render({ sellReady: false });
    await open();
    const [buy, book] = ctaButtons();

    expect(buy.disabled).toBe(true);
    expect(buy.textContent).toBe(NOT_SELL_READY_LABEL);
    expect(book.disabled).toBe(false);
    expect(book.textContent).toBe("Book a call");

    await act(async () => {
      buy.click();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // --- auth gate -----------------------------------------------------------

  test("signed out: a CTA click goes to /auth and never calls /api/checkout", async () => {
    userCtx = { userId: null, session: null, loading: false };
    await render();
    await open();

    await act(async () => {
      ctaButtons()[0].click();
    });

    expect(routerPush).toHaveBeenCalledWith("/auth");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("while auth is still loading a click is a no-op (no redirect, no fetch)", async () => {
    userCtx = { userId: null, session: null, loading: true };
    await render();
    await open();

    await act(async () => {
      ctaButtons()[0].click();
    });

    expect(routerPush).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // --- checkout payloads ---------------------------------------------------

  test("product CTA POSTs /api/checkout with VideoCard's exact product payload and follows the URL", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("https://checkout.stripe.com/c/pay/cs_1"));
    await render();
    await open();

    await act(async () => {
      ctaButtons()[0].click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/checkout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(videoCardProductBody(courseCard, "buyer_1"));
    expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_1");
  });

  test("booking CTA POSTs VideoCard's exact booking payload", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("https://checkout.stripe.com/c/pay/cs_2"));
    await render();
    await open();

    await act(async () => {
      ctaButtons()[1].click();
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(videoCardBookingBody(bookingCard));
    expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_2");
  });

  test("surfaces the server's error string verbatim in an alert and re-enables the CTA", async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(403, "This creator is not accepting payments yet.", "STRIPE_CONNECT_REQUIRED"),
    );
    await render();
    const d = await open();

    await act(async () => {
      ctaButtons()[0].click();
    });

    const alert = d.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("This creator is not accepting payments yet.");
    expect(ctaButtons()[0].disabled).toBe(false);
    expect(ctaButtons()[0].textContent).toBe("View course");
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("rejects a non-http checkout URL instead of navigating", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("javascript:alert(1)"));
    await render();
    const d = await open();

    await act(async () => {
      ctaButtons()[0].click();
    });

    expect(assignMock).not.toHaveBeenCalled();
    expect(d.querySelector('[role="alert"]')?.textContent).toContain("Not a valid checkout URL");
  });
});
