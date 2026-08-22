// lib/orderStatus.ts — the orders.status state machine, in one place.
//
// orders.status is constrained in the database to:
//   pending | processing | paid | failed | refunded | canceled
// plus "created", which checkout writes and which predates the constraint.
//
// The webhook used to UPDATE status unconditionally, so a late or replayed
// Stripe event could move an order backwards: a checkout.session.completed
// arriving after charge.refunded reset the order to "paid"; a
// payment_intent.payment_failed for a retried card canceled an order that a
// later attempt had already paid. Every status write now carries a
// `.in("status", …)` guard built from these lists.

/** Not yet settled. The only states that may become paid or canceled. */
export const ORDER_OPEN_STATUSES = ["created", "pending", "processing"] as const;

/** Money was taken, so it can be given back. */
export const ORDER_REFUNDABLE_STATUSES = ["paid", ...ORDER_OPEN_STATUSES] as const;

/** Nothing moves out of these except by an explicit human action. */
export const ORDER_TERMINAL_STATUSES = ["refunded", "canceled", "failed"] as const;

export type OrderStatus =
  | (typeof ORDER_OPEN_STATUSES)[number]
  | "paid"
  | (typeof ORDER_TERMINAL_STATUSES)[number];

/** True if a transition from `from` to `to` is allowed by the rules above. */
export function canTransition(from: string | null | undefined, to: OrderStatus): boolean {
  const f = (from ?? "created") as string;
  switch (to) {
    case "paid":
    case "canceled":
    case "failed":
    case "processing":
      return (ORDER_OPEN_STATUSES as readonly string[]).includes(f);
    case "refunded":
      return (ORDER_REFUNDABLE_STATUSES as readonly string[]).includes(f);
    case "created":
    case "pending":
      return f === "created" || f === "pending";
  }
}
