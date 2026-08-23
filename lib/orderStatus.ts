// lib/orderStatus.ts — the orders.status state machine, in one place.
//
// orders.status is constrained in the database (orders_status_check) to
// exactly four values:
//   created | paid | refunded | canceled
// Anything else is a check-constraint violation at write time, so these
// lists are the only source of truth the webhook should consult.
//
// The webhook used to UPDATE status unconditionally, so a late or replayed
// Stripe event could move an order backwards: a checkout.session.completed
// arriving after charge.refunded reset the order to "paid"; a
// payment_intent.payment_failed for a retried card canceled an order that a
// later attempt had already paid. Every status write now carries a
// `.in("status", …)` guard built from these lists.

/** Not yet settled. The only state that may become paid or canceled. */
export const ORDER_OPEN_STATUSES = ["created"] as const;

/** Money was taken, so it can be given back. */
export const ORDER_REFUNDABLE_STATUSES = ["paid"] as const;

/** Nothing moves out of these except by an explicit human action. */
export const ORDER_TERMINAL_STATUSES = ["refunded", "canceled"] as const;

export type OrderStatus = "created" | "paid" | "refunded" | "canceled";

/** True if a transition from `from` to `to` is allowed by the rules above. */
export function canTransition(from: string | null | undefined, to: OrderStatus): boolean {
  const f = (from ?? "created") as string;
  switch (to) {
    case "paid":
    case "canceled":
      return (ORDER_OPEN_STATUSES as readonly string[]).includes(f);
    case "refunded":
      return (ORDER_REFUNDABLE_STATUSES as readonly string[]).includes(f);
    case "created":
      return f === "created";
  }
}
