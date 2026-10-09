import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { exactActivationDates } from "./installments/activation";
import { installmentMonthBoundary } from "./installments/checkoutPreparation";
import { hasExpectedFutureEnd } from "./installments/scheduledEnd";
import { calculateInstallmentPlan } from "./installmentPlan";
import type { readBuyerMentorshipBootstrapReservation } from "./mentorshipInstallmentReservation";
import type { BuyerMentorshipCheckoutDependencies } from "./mentorshipInstallmentCheckout";
type Reservation=NonNullable<Awaited<ReturnType<typeof readBuyerMentorshipBootstrapReservation>>>;
const version="buyer-first-paid-v1";
function check(v:unknown):asserts v {if(!v)throw Error("Buyer installment activation requires review");}

/** Request shape only, never dispatch authorization. A durable operation must
 * freeze this request/key and prove original receipt ownership before sending. */
export function buyerMentorshipActivationParams(paidAt:number,paymentCount:number,paymentMethodId:string):Stripe.SubscriptionUpdateParams {
  check(/^pm_[A-Za-z0-9]+$/.test(paymentMethodId));
  const dates=exactActivationDates(paidAt,paymentCount);
  return {trial_end:dates.firstRenewalAt,cancel_at:dates.cancelAt,proration_behavior:"none",default_payment_method:paymentMethodId,
    pause_collection:{behavior:"keep_as_draft"},payment_settings:{payment_method_types:["card"],save_default_payment_method:"off"},
    metadata:{installment_activation_version:version}};
}

/** Inspect the actual buyer-owned subscription without adapting it into the
 * creator-booking protocol. Activation always retains the indefinite hold;
 * monthly collection remains a separate exact-amount operation. */
export function inspectBuyerMentorshipActivationSubscription(args:{
  reservation:Reservation;context:{mode:"test"|"live";platformAccountId:string;supabaseProjectRef:string;siteOrigin:string};
  dependencies:BuyerMentorshipCheckoutDependencies;paidAt:number;paymentMethodId:string;subscription:Stripe.Subscription;
  nowSeconds:number;allowActivated?:boolean;inspection?:"capture"|"activation";allowPastDueRecovery?:boolean;
}) {
  const {reservation:r,context:c,dependencies:d,subscription:s,nowSeconds:now}=args,t=r.terms;
  const dates=exactActivationDates(args.paidAt,t.paymentCount),bootstrapEnd=d.anchorSeconds+48*3600;
  const bootstrapCancel=installmentMonthBoundary(bootstrapEnd,t.paymentCount-1);
  const activated=s.trial_end===dates.firstRenewalAt && s.billing_cycle_anchor===dates.firstRenewalAt &&
    s.cancel_at===dates.cancelAt && s.default_payment_method===args.paymentMethodId && s.metadata.installment_activation_version===version;
  check(!activated||args.allowActivated===true);
  const identity={creatornet_installment_version:t.installmentVersion,creatornet_installment_reservation_id:r.id,
    creatornet_installment_request_id:r.requestId,buyer_id:r.buyerId,creator_id:t.creatorId,product_id:r.productId,post_id:r.postId,
    terms_fingerprint:r.fingerprint,payment_mode:c.mode,platform_account_id:c.platformAccountId,supabase_project_ref:c.supabaseProjectRef,
    site_origin:c.siteOrigin,operation_kind:"subscription.create",...(activated?{installment_activation_version:version}:{})};
  check(s.object==="subscription" && s.id===d.subscriptionId && s.customer===d.customerId && s.livemode===(c.mode==="live") &&
    s.billing_mode?.type==="classic" && s.billing_cycle_anchor_config==null && s.schedule==null && s.pending_update==null &&
    s.test_clock==null && s.pause_collection?.behavior==="keep_as_draft" && s.pause_collection.resumes_at==null &&
    hasExpectedFutureEnd(s,activated?dates.cancelAt:bootstrapCancel,d.anchorSeconds,now,args.allowPastDueRecovery===true) &&
    s.collection_method==="charge_automatically" && s.default_source==null && s.application_fee_percent==null &&
    s.transfer_data?.destination===r.destinationId && s.transfer_data.amount_percent==null && s.automatic_tax?.enabled===false &&
    !s.discounts?.length && !s.default_tax_rates?.length && s.billing_thresholds==null && s.pending_invoice_item_interval==null &&
    s.trial_settings?.end_behavior?.missing_payment_method==="create_invoice" && s.payment_settings?.save_default_payment_method==="off" &&
    isDeepStrictEqual(s.payment_settings.payment_method_types,["card"]) && isDeepStrictEqual(s.metadata,identity) &&
    s.items.has_more===false && s.items.data.length===1);
  if(!activated) {
    check(s.trial_end===bootstrapEnd && s.cancel_at===bootstrapCancel && s.default_payment_method==null);
    // A delayed capture read is not permission to reset an elapsed trial.
    if(args.inspection!=="capture")check(s.status==="trialing" && now<bootstrapEnd && now<dates.firstRenewalAt);
  }
  const item=s.items.data[0],price=item.price;
  check(/^si_[A-Za-z0-9]+$/.test(item.id) && item.subscription===s.id && item.quantity===1 && !item.tax_rates?.length &&
    !item.discounts?.length && item.billing_thresholds==null && typeof price.active==="boolean" && price.livemode===(c.mode==="live") &&
    price.product===d.productId && price.currency==="usd" &&
    price.unit_amount===calculateInstallmentPlan(t.amountCents,t.paymentCount,t.renewalFeeSchedule,t.firstPaymentFeeSchedule).regularAmountCents &&
    price.recurring?.interval==="month" && price.recurring.interval_count===1 && price.recurring.usage_type==="licensed" &&
    price.billing_scheme==="per_unit" && price.transform_quantity==null);
  return Object.freeze({itemId:item.id,activated,firstRenewalAt:dates.firstRenewalAt,cancelAt:dates.cancelAt});
}
