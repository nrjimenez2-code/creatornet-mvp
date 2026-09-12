import type Stripe from "stripe";

/** canceled_at can be the time a FUTURE cancellation was requested, not the
 * time service ended. Verified against the held Sandbox subscription on
 * 2026-09-06 in both the historical flexible fixture and a new isolated
 * no-card classic-mode trial. Never use that marker alone to infer immediate cancellation.
 * The actual live status, exact immutable end date, and absence of ended_at
 * must all agree. The explicit past_due exception is only for buyer-confirmed
 * recovery; ordinary renewal/activation callers retain the strict default.
 * This predicate is not authorization to collect. */
export function hasExpectedFutureEnd(
  sub: Pick<Stripe.Subscription, "status" | "cancel_at" | "cancel_at_period_end" | "canceled_at" | "ended_at">,
  expectedEnd: number, earliest: number, now: number, allowPastDue = false,
): boolean {
  return [expectedEnd, earliest, now].every(Number.isSafeInteger) && earliest > 0 && now >= earliest && expectedEnd > now &&
    (["trialing", "active"].includes(sub.status) || allowPastDue && sub.status === "past_due") && sub.cancel_at === expectedEnd &&
    sub.cancel_at_period_end === false && sub.ended_at == null &&
    (sub.canceled_at == null || Number.isSafeInteger(sub.canceled_at) && sub.canceled_at >= earliest && sub.canceled_at <= now);
}
