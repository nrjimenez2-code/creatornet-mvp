import "server-only";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {creatorFeesFromMetadata,creatorFeeMetadata} from "./money";
import {writeProductCheckoutPending} from "./productCheckoutPending";
import {productCheckoutOrderMatches} from "./productCheckoutOrder";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Original checkout attachment needs reconciliation");};

/** Attach only the independently inspected ORIGINAL session. No catalog reads,
 * consent substitution, replacement order, payment/access writes or release.
 * The create path writes the order before saving/dispatching its original request;
 * a missing order is therefore corruption/review, not permission to invent one. */
export async function attachOriginalProductCheckout(args:{admin:SupabaseClient;buyerId:string;attemptId:string;attemptKey:string;session:Stripe.Checkout.Session}){
 const {admin,buyerId,session}=args,meta=session.metadata;
 check(session.status==="open"&&session.payment_status==="unpaid"&&meta&&meta.buyer_id===buyerId&&meta.checkout_attempt_key===args.attemptKey);
 const result=await admin.from("product_checkout_attempts").select("*")
  .eq("id",args.attemptId).eq("buyer_id",buyerId).eq("attempt_key",args.attemptKey).maybeSingle();
 const a=result.data;
 check(!result.error&&a&&a.id===args.attemptId&&a.buyer_id===buyerId&&a.attempt_key===args.attemptKey&&
  a.original_request_protocol==="product-checkout-original-v1"&&!a.original_stop_requested_at&&a.stripe_checkout_session_id===session.id&&
  a.order_id===meta.order_id&&a.creator_id===meta.creator_id&&a.product_id===meta.product_id);
 const params=a.original_request?.params,amount=params?.line_items?.[0]?.price_data?.unit_amount,postId=meta.post_id||null;
 check(params?.metadata?.order_id===a.order_id&&Number.isSafeInteger(amount)&&amount>=50&&session.amount_total===amount&&session.currency==="usd");
 const fees=creatorFeesFromMetadata(meta,amount);
 // Reject legacy/fallback fee interpretation: all persisted fee fields must match.
 check(Object.entries(creatorFeeMetadata(fees)).every(([key,value])=>meta[key]===value));
 const orderResult=await admin.from("orders").select("id,buyer_id,creator_id,post_id,amount_cents,gross_amount,platform_fee,processing_fee,total_creator_deduction,creator_amount,fee_schedule_version,status,currency,stripe_checkout_session_id,stripe_payment_intent_id")
  .eq("id",a.order_id).eq("buyer_id",buyerId).maybeSingle();
 const order=orderResult.data,pi=typeof session.payment_intent==="string"?session.payment_intent:session.payment_intent?.id??null;
 check(!orderResult.error&&order&&order.currency==="usd"&&productCheckoutOrderMatches(order,{orderId:a.order_id,buyerId,creatorId:a.creator_id,
  postId,amountCents:amount,currency:"usd",fees})&&
  (!order.stripe_checkout_session_id||order.stripe_checkout_session_id===session.id)&&(!order.stripe_payment_intent_id||order.stripe_payment_intent_id===pi));
 let update=admin.from("orders").update({stripe_checkout_session_id:session.id,stripe_payment_intent_id:pi})
  .eq("id",a.order_id).eq("buyer_id",buyerId).eq("status","created");
 update=order.stripe_checkout_session_id?update.eq("stripe_checkout_session_id",session.id):update.is("stripe_checkout_session_id",null);
 update=order.stripe_payment_intent_id?update.eq("stripe_payment_intent_id",pi):update.is("stripe_payment_intent_id",null);
 const attached=await update.select("id").maybeSingle();check(!attached.error&&attached.data?.id===a.order_id);
 // Reuse the creation path's unique-winner check. A conflicting old purchase is
 // review-required; recovery never replaces its session or demotes a paid row.
 check(await writeProductCheckoutPending({admin,buyerId,sessionId:session.id,amountCents:amount,currency:"usd",orderId:a.order_id,
  creatorId:a.creator_id,postId,productId:a.product_id,reusablePurchaseId:null,expectedPriorSessionId:null}));
}
