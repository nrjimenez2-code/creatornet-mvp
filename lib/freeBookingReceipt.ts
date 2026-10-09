import type Stripe from "stripe";

/** Stripe can report a completed zero-cost payment as paid without a PaymentIntent. */
export function completedFreeBooking(session:Stripe.Checkout.Session):boolean{
 return session.mode==="payment" && session.status==="complete" &&
  ["paid","no_payment_required"].includes(session.payment_status) &&
  session.amount_total===0 && session.currency==="usd" && !session.payment_intent &&
  !session.subscription && session.metadata?.kind==="free_booking_v1";
}
