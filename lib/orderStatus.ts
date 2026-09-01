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

/**
 * The `purchases` half of the same idea.
 *
 * `purchases.status` has no CHECK constraint and a looser vocabulary than
 * `orders.status` (pending | processing | active | paid | complete | refunded |
 * failed), so this is an explicit list of the states a Stripe event must never
 * move a row OUT of, rather than a full state machine.
 *
 * Once money has been given back or the charge failed, no later or replayed
 * event may put the row back to paid — that is how a refunded buyer kept
 * permanent access to the file they were refunded for.
 */
export const PURCHASE_TERMINAL_STATUSES = ["refunded", "failed"] as const;

/** PostgREST `not.in` list form: `("refunded","failed")`. */
export function purchaseTerminalFilter(): string {
  return `(${PURCHASE_TERMINAL_STATUSES.map((s) => `"${s}"`).join(",")})`;
}

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
