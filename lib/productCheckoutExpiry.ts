import "server-only";
import type Stripe from "stripe";

/** Existing product-checkout retirement, shared with full-mode recovery. The
 * caller owns the saved attempt; missing/uncertain provider state is not expiry.
 * This only establishes terminal state, never accounting or purchase release. */
export async function retireProductCheckoutSession(args:{stripe:Pick<Stripe,"checkout"|"paymentIntents">;
  session:Stripe.Checkout.Session;attemptKey:string;
  onTerminalUnpaid?:(session:Stripe.Checkout.Session,intent:Stripe.PaymentIntent|null)=>void}):Promise<"expired"|"complete"> {
  const fail=()=>{throw Error("Prior Stripe Checkout Session could not be retired safely.");};
  const expected=args.session;
  if(!/^cs_[A-Za-z0-9_]+$/.test(expected.id)||!args.attemptKey) return fail();
  const read=async()=>{
    const session=await args.stripe.checkout.sessions.retrieve(expected.id);
    if(session.id!==expected.id||session.mode!=="payment"||session.livemode!==expected.livemode||
      session.amount_total!==expected.amount_total||session.currency!==expected.currency||session.customer!==expected.customer)return fail();
    return session;
  };
  let session=await read();
  if(session.status==="complete"||session.payment_status==="paid")return "complete";
  if(session.status==="open"&&session.payment_status==="unpaid"){
    try {await args.stripe.checkout.sessions.expire(session.id,{},
      {idempotencyKey:`creatornet-product-checkout:${args.attemptKey}:expire`,maxNetworkRetries:0});}
    catch{/* Always recover from the original object, not the response. */}
    session=await read();
  }
  if(session.status==="complete"||session.payment_status==="paid")return "complete";
  if(session.status!=="expired"||session.payment_status!=="unpaid")return fail();
  if(session.payment_intent===null){args.onTerminalUnpaid?.(session,null);return "expired";}
  if(typeof session.payment_intent!=="string"||!/^pi_[A-Za-z0-9]+$/.test(session.payment_intent))return fail();
  const pi=await args.stripe.paymentIntents.retrieve(session.payment_intent);
  if(pi.id!==session.payment_intent||pi.livemode!==session.livemode||pi.amount!==session.amount_total||pi.currency!==session.currency||
    pi.customer!==session.customer)return fail();
  if(pi.status!=="canceled"||pi.amount_received!==0||pi.amount_capturable!==0)return fail();
  args.onTerminalUnpaid?.(session,pi);
  return "expired";
}
