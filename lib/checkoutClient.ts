// lib/checkoutClient.ts
//
// Browser-side helper that POSTs to /api/checkout with the SAME payloads
// components/VideoCard.tsx sends (product purchase and booking). Nothing
// here touches the money path itself — it only formats the request and
// surfaces the server's error string verbatim.
//
// Keep the two payload builders byte-for-byte aligned with VideoCard.tsx
// (`handleBuy` and `handleBook`); __tests__/offers-panel.test.ts pins them.

export const CHECKOUT_ENDPOINT = "/api/checkout";

export type ProductCheckoutInput = {
  productId: string;
  postId: string | null;
  creatorId: string | null;
  titleForCheckout?: string | null;
  buyerId: string | null;
};

export type BookingCheckoutInput = {
  postId: string;
  creatorId: string | null;
  bookingRedirectUrl: string;
};

/** Mirrors VideoCard.handleBuy's body (undefined keys drop out of JSON). */
export function productCheckoutPayload(input: ProductCheckoutInput) {
  return {
    type: "product" as const,
    product_id: String(input.productId),
    post_id: input.postId ?? undefined,
    creator_id: input.creatorId ?? null,
    titleForCheckout: input.titleForCheckout ?? undefined,
    buyer_id: input.buyerId ?? undefined,
  };
}

/** Mirrors VideoCard.handleBook's body. */
export function bookingCheckoutPayload(input: BookingCheckoutInput) {
  return {
    type: "booking" as const,
    post_id: input.postId,
    creator_id: input.creatorId ?? undefined,
    bookingRedirectUrl: input.bookingRedirectUrl,
  };
}

/**
 * POSTs a checkout payload and returns the Stripe URL to navigate to.
 * Throws an Error whose message is the server's `error` string verbatim
 * (or an HTTP fallback), so callers can show it as-is.
 */
export async function startCheckout(payload: unknown): Promise<string> {
  const res = await fetch(CHECKOUT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  const data = (await res.json().catch(() => null)) as { url?: unknown; error?: unknown } | null;
  if (!res.ok) {
    const message =
      typeof data?.error === "string" && data.error.trim()
        ? data.error
        : `Failed to create checkout session (HTTP ${res.status})`;
    throw new Error(message);
  }

  const url = typeof data?.url === "string" ? data.url : "";
  if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
    throw new Error("Not a valid checkout URL returned from server.");
  }
  return url;
}

/** Full-page navigation to the Stripe URL (kept separate so tests can stub it). */
export function navigateTo(url: string): void {
  window.location.assign(url);
}
