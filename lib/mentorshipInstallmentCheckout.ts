import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import type { reserveBuyerMentorshipInstallments } from "./mentorshipInstallmentReservation";
import { mentorshipInstallmentQuote } from "./mentorshipInstallmentQuote";
import { calculateInstallmentPlan } from "./installmentPlan";
import { creatorFeeMetadata } from "./money";
import { assertAgreementId } from "./installments/agreementStore";
import { validateExactPaymentContext } from "./installments/paymentContext";
import { CONTEXT_CUSTOMER_API_VERSION } from "./installments/contextBootstrap";
import { installmentMonthBoundary } from "./installments/checkoutPreparation";
import { buildFixedTotalCheckoutPayload } from "./installments/checkoutContract";
import { assertFixedTotalCheckoutSession } from "./installments/contextCheckout";
import { FIXED_PURCHASE_CONSENT_VERSION } from "./installments/purchaseConsent";
import type { ExactPaymentContext } from "./installments/paymentContext";
import {SERVER_PAYMENT_PROTOCOL,type ServerPaymentContract} from "./serverPaymentConfirmation";

type Reservation = Awaited<ReturnType<typeof reserveBuyerMentorshipInstallments>>;
export type BuyerMentorshipCheckoutDependencies = Readonly<{
  customerId: string; subscriptionId: string; productId: string; anchorSeconds: number;
}>;
const check: (value: unknown) => asserts value = value => {
  if (!value) throw Error("Buyer installment Checkout requires review");
};
const stripeId = (value: string, prefix: string) => check(new RegExp(`^${prefix}_[A-Za-z0-9]{1,196}$`).test(value));

/** Pure original request bytes, shared by bootstrap and captured-payment
 * verification. This is not provider-state validation or dispatch authority. */
export function buyerMentorshipFirstPaymentRequest(r: Reservation, context: ExactPaymentContext, d: BuyerMentorshipCheckoutDependencies) {
  const t = r.terms;
  const plan = calculateInstallmentPlan(t.amountCents, t.paymentCount, t.renewalFeeSchedule, t.firstPaymentFeeSchedule);
  const metadata = { creatornet_installment_version: t.installmentVersion, creatornet_installment_reservation_id: r.id,
    creatornet_installment_request_id: r.requestId, buyer_id: r.buyerId, creator_id: t.creatorId, product_id: r.productId, post_id: r.postId,
    terms_fingerprint: r.fingerprint, payment_mode: context.mode, platform_account_id: context.platformAccountId,
    supabase_project_ref: context.supabaseProjectRef, site_origin: context.siteOrigin,
    operation_kind: "checkout.create", installment_number: "1", installment_subscription_id: d.subscriptionId,
    creator_stripe_account_id: r.destinationId, installment_total_cents: String(t.amountCents),
    plan_months: String(t.paymentCount), plan_type: "installment", ...creatorFeeMetadata(plan.payments[0].fees) };
  return { apiVersion: CONTEXT_CUSTOMER_API_VERSION as typeof CONTEXT_CUSTOMER_API_VERSION, method: "POST" as const, path: "/v1/checkout/sessions" as const,
    params: { ...buildFixedTotalCheckoutPayload({ customerId: d.customerId, destinationId: r.destinationId, totalCents: t.amountCents,
      paymentCount: t.paymentCount, title: t.title, firstPaymentFeeSchedule: t.firstPaymentFeeSchedule,
      renewalFeeSchedule: t.renewalFeeSchedule, origin: context.siteOrigin }, metadata, FIXED_PURCHASE_CONSENT_VERSION, t.serviceMonths),
    billing_address_collection: "required" as const, customer_update: { address: "auto" as const }, expires_at: d.anchorSeconds + 24 * 3600 } };
}

/** The same frozen first-payment economics, with truthful manual source
 * metadata. Does not manufacture a hosted session or authorize any dispatch. */
export function buyerMentorshipServerPaymentContract(r:Reservation,context:ExactPaymentContext,d:BuyerMentorshipCheckoutDependencies):ServerPaymentContract{
  const t=r.terms,original=buyerMentorshipFirstPaymentRequest(r,context,d);
  const first=calculateInstallmentPlan(t.amountCents,t.paymentCount,t.renewalFeeSchedule,t.firstPaymentFeeSchedule).payments[0];
  return {protocol:SERVER_PAYMENT_PROTOCOL,attemptId:r.attemptId,buyerId:r.buyerId,creatorId:t.creatorId,productId:r.productId,
    termsFingerprint:r.fingerprint,context,customerId:d.customerId,destinationId:r.destinationId,amountCents:first.amountCents,
    processingFees:t.firstPaymentFeeSchedule,kind:"first_installment",
    sourceMetadata:{...original.params.payment_intent_data!.metadata as Record<string,string>,operation_kind:"payment_intent.create"},
    acceptedAt:Math.floor(Date.parse(r.acceptedAt)/1000),expiresAt:d.anchorSeconds+86400-1860};
}

/** Request construction only. Inputs must be the owned saved acceptance and
 * durable bootstrap dependencies, with freshly retrieved provider objects and
 * independent context evidence. No network or database writes occur here.
 * Durable claim/bind, receipt processing and country-rule acceptance must be
 * complete before a caller may dispatch or publish this request. */
export function buildBuyerMentorshipCheckoutRequest(args: {
  reservation: Reservation; context: unknown; contextEvidence: unknown;
  dependencies: BuyerMentorshipCheckoutDependencies;
  customer: Stripe.Customer | Stripe.DeletedCustomer; subscription: Stripe.Subscription;
  nowSeconds: number;
}): { apiVersion: typeof CONTEXT_CUSTOMER_API_VERSION; method: "POST"; path: "/v1/checkout/sessions";
  params: Stripe.Checkout.SessionCreateParams } {
  const r = args.reservation, t = r.terms, d = args.dependencies;
  const context = validateExactPaymentContext(args.context, args.contextEvidence), live = context.mode === "live";
  for (const id of [r.id, r.requestId, r.attemptId, r.buyerId, r.productId, r.postId, t.creatorId]) assertAgreementId(id);
  stripeId(r.destinationId, "acct"); stripeId(d.customerId, "cus"); stripeId(d.subscriptionId, "sub"); stripeId(d.productId, "prod");
  const accepted = Date.parse(r.acceptedAt), now = args.nowSeconds;
  check(r.status === "reserved" && Number.isSafeInteger(now) && now > 0 && Number.isFinite(accepted) && accepted > 0 &&
    Number.isSafeInteger(d.anchorSeconds) && d.anchorSeconds >= Math.floor(accepted / 1000) && d.anchorSeconds <= now &&
    now < d.anchorSeconds + 24 * 3600 - 31 * 60 && t.buyerId === r.buyerId && t.productId === r.productId && t.postId === r.postId &&
    createHash("sha256").update(JSON.stringify(t)).digest("hex") === r.fingerprint);
  const expectedQuote = mentorshipInstallmentQuote({ buyerId: r.buyerId, postId: r.postId, paymentCount: t.paymentCount,
    firstPaymentFees: t.firstPaymentFeeSchedule, renewalFees: t.renewalFeeSchedule,
    product: { id: t.productId, creator_id: t.creatorId, type: "mentorship", title: t.title, description: t.description,
      amount_cents: t.amountCents, currency: t.currency, fixed_service_months: t.serviceMonths, installment_options: [t.paymentCount] } });
  check(isDeepStrictEqual(expectedQuote.terms, t));
  const metadata = { creatornet_installment_version: t.installmentVersion, creatornet_installment_reservation_id: r.id,
    creatornet_installment_request_id: r.requestId, buyer_id: r.buyerId, creator_id: t.creatorId, product_id: r.productId, post_id: r.postId,
    terms_fingerprint: r.fingerprint, payment_mode: context.mode, platform_account_id: context.platformAccountId,
    supabase_project_ref: context.supabaseProjectRef, site_origin: context.siteOrigin };
  const c = args.customer;
  check(c.object === "customer" && !("deleted" in c && c.deleted));
  const customer = c as Stripe.Customer;
  check(customer.id === d.customerId && customer.livemode === live && customer.balance === 0 && customer.delinquent === false &&
    customer.default_source === null && customer.invoice_settings?.default_payment_method === null && customer.test_clock === null &&
    isDeepStrictEqual(customer.metadata, { ...metadata, operation_kind: "customer.create" }));
  const s = args.subscription, item = s.items?.data?.[0], price = item?.price;
  const plan = calculateInstallmentPlan(t.amountCents, t.paymentCount, t.renewalFeeSchedule, t.firstPaymentFeeSchedule);
  const trialEnd = d.anchorSeconds + 48 * 3600;
  // Stripe archives prices created inline with subscription items.price_data.
  // Catalog availability does not invalidate this already-bound subscription.
  // Keep validating its original product, economics, recurrence and ownership.
  check(s.object === "subscription" && s.id === d.subscriptionId && s.livemode === live && s.customer === d.customerId &&
    s.status === "trialing" && s.billing_mode?.type === "classic" && s.trial_end === trialEnd &&
    s.cancel_at === installmentMonthBoundary(trialEnd, t.paymentCount - 1) && s.cancel_at_period_end === false &&
    s.pause_collection?.behavior === "keep_as_draft" && s.pause_collection.resumes_at == null &&
    s.default_payment_method === null && s.default_source === null && s.application_fee_percent === null &&
    s.transfer_data?.destination === r.destinationId && s.transfer_data.amount_percent == null &&
    s.collection_method === "charge_automatically" && s.automatic_tax?.enabled === false && s.discounts?.length === 0 &&
    s.default_tax_rates?.length === 0 && s.pending_update === null && s.schedule === null && s.test_clock === null &&
    isDeepStrictEqual(s.metadata, { ...metadata, operation_kind: "subscription.create" }) &&
    s.items.has_more === false && s.items.data.length === 1 && item.quantity === 1 && item.tax_rates?.length === 0 && item.discounts?.length === 0 &&
    typeof price?.active === "boolean" && price.livemode === live && price.currency === "usd" && price.product === d.productId &&
    price.unit_amount === plan.regularAmountCents && price.billing_scheme === "per_unit" &&
    price.recurring?.interval === "month" && price.recurring.interval_count === 1 && price.recurring.usage_type === "licensed" &&
    s.payment_settings?.save_default_payment_method === "off" && isDeepStrictEqual(s.payment_settings.payment_method_types, ["card"]) &&
    s.trial_settings?.end_behavior?.missing_payment_method === "create_invoice");
  return buyerMentorshipFirstPaymentRequest(r, context, d);
}


/** Pure observation of the original bound unpaid Checkout. Expiry alone does
 * not authorize releasing a purchase lock or stopping its held subscription. */
export function inspectBuyerMentorshipUnpaidCheckout(args:{reservation:Reservation;context:unknown;contextEvidence:unknown;
  dependencies:BuyerMentorshipCheckoutDependencies;originalRequest:unknown;sessionId:string;firstDispatchAt:string;
  session:Stripe.Checkout.Session;nowSeconds:number}) {
  const {reservation:r,dependencies:d,session:s}=args;
  const context=validateExactPaymentContext(args.context,args.contextEvidence);
  const dispatched=Date.parse(args.firstDispatchAt)/1000;
  check(r.status==="reserved" && r.terms.buyerId===r.buyerId && r.terms.productId===r.productId && r.terms.postId===r.postId &&
    createHash("sha256").update(JSON.stringify(r.terms)).digest("hex")===r.fingerprint &&
    Number.isSafeInteger(args.nowSeconds) && Number.isSafeInteger(d.anchorSeconds) && d.anchorSeconds>=Math.floor(Date.parse(r.acceptedAt)/1000) &&
    Number.isFinite(dispatched) && dispatched>=d.anchorSeconds && dispatched<d.anchorSeconds+86400-1860 && dispatched<=args.nowSeconds);
  const original=buyerMentorshipFirstPaymentRequest(r,context,d);
  check(isDeepStrictEqual(args.originalRequest,original));
  assertFixedTotalCheckoutSession(s,{params:original.params,customerId:d.customerId,expectedLiveMode:context.mode==="live",
    firstDispatchAt:args.firstDispatchAt,purchaseConsentRequired:true},args.sessionId,"observe_unpaid");
  check(s.billing_address_collection==="required" && s.created<=args.nowSeconds);
  if(s.status==="open") {
    check(s.expires_at>args.nowSeconds);
    return {status:"open_unpaid" as const,sessionId:s.id,paymentIntentId:s.payment_intent as string|null,releaseAllowed:false as const};
  }
  check(s.status==="expired" && s.expires_at<=args.nowSeconds);
  return {status:s.payment_intent===null?"expired_without_payment_intent" as const:"payment_reconciliation_required" as const,
    sessionId:s.id,paymentIntentId:s.payment_intent as string|null,releaseAllowed:false as const};
}


/** Shared durable binding reader for receipt inspection and unpaid recovery.
 * A caller must first load this reservation through the authenticated owner reader. */
export async function readBuyerMentorshipCheckoutBindings(admin:SupabaseClient,reservation:Reservation) {
  const bootstrap=await admin.from("buyer_mentorship_bootstraps_v1").select("reservation_id,customer_id,anchor_seconds")
    .eq("reservation_id",reservation.id).maybeSingle();
  const operations=await admin.from("buyer_mentorship_bootstrap_operations_v1").select("reservation_id,step,request,result_id,first_dispatch_at,bound_at")
    .eq("reservation_id",reservation.id);
  check(!bootstrap.error && bootstrap.data?.reservation_id===reservation.id && !operations.error && operations.data?.length===4);
  const op=(step:string)=>{
    const found=operations.data!.filter(row=>row.step===step);
    check(found.length===1 && found[0].reservation_id===reservation.id && found[0].bound_at && found[0].result_id);
    return found[0];
  };
  const product=op("product.create"),subscription=op("subscription.create"),hold=op("subscription.hold"),checkout=op("checkout.create");
  check(hold.result_id===subscription.result_id);
  return {bootstrap:bootstrap.data,product,subscription,hold,checkout};
}

/** Original non-hosted preparation only; an admitted Checkout, even unbound,
 * is a different protocol and cannot be silently adopted. */
export async function readBuyerMentorshipManualBindings(admin:SupabaseClient,reservation:Reservation){
  const bootstrap=await admin.from("buyer_mentorship_bootstraps_v1").select("reservation_id,customer_id,anchor_seconds")
    .eq("reservation_id",reservation.id).single();
  const operations=await admin.from("buyer_mentorship_bootstrap_operations_v1")
    .select("reservation_id,step,result_id,bound_at,lease_until").eq("reservation_id",reservation.id);
  check(!bootstrap.error&&bootstrap.data?.reservation_id===reservation.id&&!operations.error&&operations.data?.length===3);
  const op=(step:string)=>{
    const matches=operations.data!.filter(o=>o.step===step);check(matches.length===1);
    const value=matches[0];check(value.reservation_id===reservation.id&&value.bound_at&&value.result_id&&value.lease_until===null);return value;
  };
  const product=op("product.create"),subscription=op("subscription.create"),hold=op("subscription.hold");
  check(subscription.result_id===hold.result_id);
  return {customerId:bootstrap.data.customer_id as string,subscriptionId:subscription.result_id as string,
    productId:product.result_id as string,anchorSeconds:bootstrap.data.anchor_seconds as number};
}
