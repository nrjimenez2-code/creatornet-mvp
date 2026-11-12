import "server-only";
import {inspectPaymentCaptureEvidence} from "./paymentCaptureEvidence";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateExactPaymentContext } from "./installments/paymentContext";
import { assertAgreementId } from "./installments/agreementStore";
import { exactContextServerConfig } from "./installments/contextServer";
import { createExactContextRuntime } from "./installments/contextRuntime";
import { CONTEXT_CUSTOMER_API_VERSION } from "./installments/contextBootstrap";
import { installmentMonthBoundary } from "./installments/checkoutPreparation";
import { readBuyerMentorshipCheckoutBindings,readBuyerMentorshipManualBindings,buyerMentorshipFirstPaymentRequest,buyerMentorshipServerPaymentContract, type BuyerMentorshipCheckoutDependencies } from "./mentorshipInstallmentCheckout";
import {SERVER_PAYMENT_PROTOCOL,inspectServerPaymentIntent,type ServerPaymentContract} from "./serverPaymentConfirmation";
import { readBuyerMentorshipBootstrapReservation } from "./mentorshipInstallmentReservation";
import { mentorshipInstallmentQuote } from "./mentorshipInstallmentQuote";
import { calculateInstallmentPlan } from "./installmentPlan";
import { fixedServiceEndAt } from "./fixedServiceTerms";
import { buyerMentorshipActivationParams,inspectBuyerMentorshipActivationSubscription } from "./mentorshipInstallmentActivation";

type Reservation = NonNullable<Awaited<ReturnType<typeof readBuyerMentorshipBootstrapReservation>>>;
export function assertBuyerFinancialInspectionReady(env:Record<string,string|undefined>,kind:"refund"|"dispute") {
  const gate=kind.toUpperCase();
  for(const suffix of ["SCHEMA_READY","EVENTS_READY","RECOVERY_READY"])
    check(env[`CREATOR_MENTORSHIP_INSTALLMENT_${gate}_${suffix}`]==="true");
}

type FinancialCaptureProof={version:string;reservationId:string;requestId:string;buyerId:string;termsFingerprint:string;
  customerId:string;paymentIntentId:string;chargeId:string;destinationId:string;paymentNumber:number;context:unknown;
  amountCents:number;fees:{totalCreatorDeductionCents:number};balanceTransactionId:string;actualStripeFeeCents:number;invoiceId?:string};

/** Common immutable receipt/accepted-economics check for refund and dispute
 * inspection. Provider capture verification and atomic writes remain separate. */
export function inspectBuyerMentorshipFinancialReceipt(args:{reservation:Reservation;proof:FinancialCaptureProof;invoiceId:string|null;
  contextEvidence:unknown;paymentIntentId:string;chargeId:string;customerId:string}):import("./installments/refundEvent").ExactRefundReceipt {
  const r=args.reservation,f=args.proof;
  check(f?.reservationId===r.id && f.requestId===r.requestId && f.buyerId===r.buyerId && f.termsFingerprint===r.fingerprint &&
    f.customerId===args.customerId && f.paymentIntentId===args.paymentIntentId && f.chargeId===args.chargeId && f.destinationId===r.destinationId &&
    Number.isInteger(f.paymentNumber) && f.paymentNumber>=1 && f.paymentNumber<=r.terms.paymentCount &&
    f.version===(f.paymentNumber===1?"buyer-mentorship-first-capture-v1":"buyer-mentorship-later-capture-v1"));
  validateExactPaymentContext(f.context,args.contextEvidence);
  const payment=calculateInstallmentPlan(r.terms.amountCents,r.terms.paymentCount,r.terms.renewalFeeSchedule,r.terms.firstPaymentFeeSchedule).payments[f.paymentNumber-1];
  check(payment && payment.amountCents===f.amountCents && payment.fees.totalCreatorDeductionCents===f.fees?.totalCreatorDeductionCents &&
    /^txn_[A-Za-z0-9]+$/.test(f.balanceTransactionId) && Number.isSafeInteger(f.actualStripeFeeCents) && f.actualStripeFeeCents>=0 &&
    (f.paymentNumber===1?args.invoiceId===null:args.invoiceId===f.invoiceId && typeof f.invoiceId==="string" && /^in_[A-Za-z0-9]+$/.test(f.invoiceId)));
  return {paymentNumber:f.paymentNumber,amountCents:f.amountCents,applicationFeeCents:payment.fees.totalCreatorDeductionCents,
    chargeId:f.chargeId,balanceTransactionId:f.balanceTransactionId,actualStripeFeeCents:f.actualStripeFeeCents,invoiceId:args.invoiceId};
}
type Capture = { session: Stripe.Checkout.Session; paymentIntent: Stripe.PaymentIntent; charge: Stripe.Charge;
  balance: Stripe.BalanceTransaction; paymentMethod: Stripe.PaymentMethod; customer: Stripe.Customer | Stripe.DeletedCustomer;
  subscription: Stripe.Subscription };
const check: (value: unknown) => asserts value = value => { if (!value) throw Error("Buyer installment first payment requires review"); };
function sid(value: unknown, prefix: string): string {
  const id = typeof value === "string" ? value : value && typeof value === "object" ? (value as { id?: unknown }).id : null;
  check(typeof id === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(id)); return id;
}

/** Verify an already-captured first installment against an owned, bound original
 * request. Returns selected evidence only. No receipt write, charge, accounting,
 * schedule activation or entitlement transition occurs in this function. */
type CaptureArguments={
  reservation: Reservation; context: unknown; contextEvidence: unknown; dependencies: BuyerMentorshipCheckoutDependencies;
  firstDispatchAt: string; nowSeconds: number;
  allowActivatedSubscription?:boolean;
  /** Read-only capture evidence for atomic refund recovery; never clean credit. */
  financialInspection?:"refund"|"dispute";
};
type ManualSource={contract:ServerPaymentContract;paymentIntentId:string;confirmationOperationId:string};
export function inspectBuyerMentorshipFirstCapture(args:CaptureArguments&{sessionId:string;originalRequest:unknown;data:Capture}){
  return inspectBuyerMentorshipCapture({...args,source:{kind:"checkout",sessionId:args.sessionId,originalRequest:args.originalRequest,session:args.data.session}});
}
export function inspectBuyerMentorshipManualFirstCapture(args:CaptureArguments&{manual:ManualSource;data:Omit<Capture,"session">}){
  return inspectBuyerMentorshipCapture({...args,source:{kind:"manual",...args.manual}});
}
function inspectBuyerMentorshipCapture(args:CaptureArguments&{data:Omit<Capture,"session">;
  source:{kind:"checkout";sessionId:string;originalRequest:unknown;session:Stripe.Checkout.Session}|({kind:"manual"}&ManualSource)}) {
  const r = args.reservation, t = r.terms, d = args.dependencies, context = validateExactPaymentContext(args.context, args.contextEvidence);
  for (const id of [r.id, r.requestId, r.buyerId, r.productId, r.postId, r.attemptId, t.creatorId]) assertAgreementId(id);
  sid(d.customerId, "cus"); sid(d.subscriptionId, "sub"); sid(d.productId, "prod"); sid(r.destinationId, "acct");
  check(r.status === "reserved" && t.buyerId === r.buyerId && t.productId === r.productId && t.postId === r.postId &&
    createHash("sha256").update(JSON.stringify(t)).digest("hex") === r.fingerprint);
  const quote = mentorshipInstallmentQuote({ buyerId: r.buyerId, postId: r.postId, paymentCount: t.paymentCount,
    firstPaymentFees: t.firstPaymentFeeSchedule, renewalFees: t.renewalFeeSchedule,
    product: { id: r.productId, creator_id: t.creatorId, type: "mentorship", title: t.title, description: t.description,
      amount_cents: t.amountCents, currency: t.currency, fixed_service_months: t.serviceMonths, installment_options: [t.paymentCount] } });
  check(isDeepStrictEqual(quote.terms, t));
  const request = buyerMentorshipFirstPaymentRequest(r, context, d);
  const first = calculateInstallmentPlan(t.amountCents, t.paymentCount, t.renewalFeeSchedule, t.firstPaymentFeeSchedule).payments[0];
  const {paymentIntent: pi, charge, balance, paymentMethod: pm, subscription: sub } = args.data;
  const live = context.mode === "live", now = args.nowSeconds, dispatch = Date.parse(args.firstDispatchAt) / 1000;
  check(Number.isSafeInteger(now) && now > 0 && Number.isSafeInteger(d.anchorSeconds) && d.anchorSeconds > 0 &&
    d.anchorSeconds >= Math.floor(Date.parse(r.acceptedAt) / 1000) && Number.isFinite(dispatch) && dispatch >= d.anchorSeconds &&
    dispatch < d.anchorSeconds + 86400 - 1860 && dispatch <= now);
  let expectedIntentId:string,created:number,expires:number,metadata:unknown,sessionId:string|null;
  if(args.source.kind==="checkout"){
    const s=args.source.session;sid(args.source.sessionId,"cs");check(isDeepStrictEqual(args.source.originalRequest,request));
    check(s.object === "checkout.session" && s.id === args.source.sessionId && s.livemode === live && s.mode === "payment" &&
    s.status === "complete" && s.payment_status === "paid" && sid(s.customer, "cus") === d.customerId &&
    s.currency === "usd" && s.amount_total === first.amountCents && s.amount_subtotal === first.amountCents &&
    s.automatic_tax?.enabled === false && s.total_details?.amount_tax === 0 && s.total_details.amount_discount === 0 &&
    s.total_details.amount_shipping === 0 && s.expires_at === request.params.expires_at &&
    Number.isSafeInteger(s.created) && s.created >= Math.floor(dispatch) - 5 && s.created <= now &&
    s.consent?.terms_of_service === "accepted" && s.billing_address_collection === "required" &&
    isDeepStrictEqual(s.metadata, request.params.metadata)&&s.customer_details?.address?.country==="US");
    expectedIntentId=sid(s.payment_intent,"pi");created=s.created;expires=s.expires_at;metadata=request.params.payment_intent_data?.metadata;sessionId=s.id;
  }else{
    const source=args.source;assertAgreementId(source.confirmationOperationId);
    check(isDeepStrictEqual(source.contract,buyerMentorshipServerPaymentContract(r,context,d)));
    inspectServerPaymentIntent(source.contract,args.contextEvidence,pi,{paymentIntentId:source.paymentIntentId,firstDispatchAt:Math.floor(dispatch)},now);
    expectedIntentId=source.paymentIntentId;created=pi.created;expires=source.contract.expiresAt;metadata=pi.metadata;sessionId=null;
  }
  check(pi.object === "payment_intent" && pi.id === expectedIntentId && pi.livemode === live &&
    sid(pi.customer, "cus") === d.customerId && pi.status === "succeeded" && pi.currency === "usd" &&
    pi.amount === first.amountCents && pi.amount_received === first.amountCents && pi.amount_capturable === 0 &&
    ["automatic", "automatic_async"].includes(pi.capture_method) && pi.setup_future_usage === "off_session" &&
    isDeepStrictEqual(pi.payment_method_types, ["card"]) && pi.application_fee_amount === first.fees.totalCreatorDeductionCents &&
    sid(pi.transfer_data?.destination, "acct") === r.destinationId && pi.transfer_data?.amount == null &&
    isDeepStrictEqual(pi.metadata, metadata));
  const capture=inspectPaymentCaptureEvidence({paymentIntent:pi,charge,balance,paymentMethod:pm,
    customerId:d.customerId,live,amountCents:first.amountCents,applicationFeeCents:first.fees.totalCreatorDeductionCents,
    createdAt:created,expiresAt:expires,nowSeconds:now,financialInspection:args.financialInspection});
  const c = args.data.customer; check(!c.deleted);
  const customer = c as Stripe.Customer;
  const identity = { creatornet_installment_version: t.installmentVersion, creatornet_installment_reservation_id: r.id,
    creatornet_installment_request_id: r.requestId, buyer_id: r.buyerId, creator_id: t.creatorId, product_id: r.productId,
    post_id: r.postId, terms_fingerprint: r.fingerprint, payment_mode: context.mode, platform_account_id: context.platformAccountId,
    supabase_project_ref: context.supabaseProjectRef, site_origin: context.siteOrigin };
  check(customer.object === "customer" && customer.id === d.customerId && customer.livemode === live && customer.test_clock === null &&
    isDeepStrictEqual(customer.metadata, { ...identity, operation_kind: "customer.create" }));
  const transferId = capture.transferId;
  inspectBuyerMentorshipActivationSubscription({reservation:r,context,dependencies:d,paidAt:charge.created,
    paymentMethodId:pm.id,subscription:sub,nowSeconds:now,inspection:"capture",allowActivated:args.allowActivatedSubscription});
  return Object.freeze({ version: "buyer-mentorship-first-capture-v1" as const, reservationId: r.id, requestId: r.requestId,
    buyerId: r.buyerId, creatorId: t.creatorId, productId: r.productId, postId: r.postId, termsFingerprint: r.fingerprint,
    context, paymentNumber: 1 as const, checkoutSessionId: sessionId, customerId: d.customerId, subscriptionId: d.subscriptionId,
    paymentIntentId: pi.id, chargeId: charge.id, balanceTransactionId: balance.id, transferId, paymentMethodId: pm.id,
    destinationId: r.destinationId, amountCents: first.amountCents, fees: first.fees, actualStripeFeeCents: balance.fee,
    paidAt: charge.created, serviceEndsAt: t.serviceMonths == null ? null : fixedServiceEndAt(charge.created, t.serviceMonths),
    nextPaymentAt: installmentMonthBoundary(charge.created, 1), buyerCountry: "US" as const,
    ...(args.source.kind==="manual"?{manualPayment:{attemptId:r.attemptId,confirmationOperationId:args.source.confirmationOperationId}}:{}) });
}

/** Internal read-only provider/database adapter. It does not dispatch or publish
 * Checkout, record a receipt, credit earnings or grant access. */
export async function inspectBuyerMentorshipFirstPayment(args: { buyerId: string; requestId: string; env?: Record<string, string | undefined>; financialInspection?:"refund"|"dispute" }) {
  try {
    const env = args.env ?? process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_SCHEMA_READY === "true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_INSPECTION_READY === "true");
    if(args.financialInspection)assertBuyerFinancialInspectionReady(env,args.financialInspection);
    assertAgreementId(args.buyerId); assertAgreementId(args.requestId);
    const config = exactContextServerConfig(env), runtime = createExactContextRuntime(config), observed = await runtime.observeContext();
    const admin = createClient(config.configuredSupabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const reservation = await readBuyerMentorshipBootstrapReservation({ ...args, admin, context: config.approvedContext, contextEvidence: observed.contextEvidence });
    check(reservation);
    const stripe = new Stripe(config.stripeSecretKey, { apiVersion: CONTEXT_CUSTOMER_API_VERSION, maxNetworkRetries: 0, timeout: 10000 });
    let manual:ManualSource|undefined,session:Stripe.Checkout.Session|undefined,checkout:{result_id:string;request:unknown;first_dispatch_at:string}|undefined;
    let dependencies:BuyerMentorshipCheckoutDependencies,firstDispatchAt:string,intentId:string;
    let pinned=false;
    if(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY==="true"){
      const pin=await admin.from("server_payment_protocols_v1").select("attempt_id,buyer_id,reservation_id,kind,protocol,context")
        .eq("attempt_id",reservation.attemptId).eq("buyer_id",reservation.buyerId).maybeSingle();check(!pin.error);
      if(pin.data){
        check(pin.data.attempt_id===reservation.attemptId&&pin.data.buyer_id===reservation.buyerId&&pin.data.reservation_id===reservation.id&&
          pin.data.kind==="first_installment"&&pin.data.protocol===SERVER_PAYMENT_PROTOCOL&&isDeepStrictEqual(pin.data.context,config.approvedContext));pinned=true;
      }
    }
    if(pinned){
      check(env.CREATOR_SERVER_PAYMENT_RECEIPT_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_RECEIPT_INSPECTION_READY==="true"&&
        env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY==="true");
      const scope={p_attempt_id:reservation.attemptId,p_buyer_id:reservation.buyerId,p_context:config.approvedContext};
      const original=await admin.rpc("read_server_payment_intent_v1",scope);check(!original.error&&original.data?.bound_at);
      const {confirmBuyerMentorshipServerPayment}=await import("./mentorshipServerPayment");
      // This action only observes the existing original. It cannot prepare or
      // confirm a payment, including when dispatch has already been stopped.
      await confirmBuyerMentorshipServerPayment({...args,env,action:{kind:"observe"}});
      const latest=await admin.rpc("read_latest_server_confirmation_v1",scope);
      check(!latest.error&&latest.data?.attempt_id===reservation.attemptId&&latest.data?.payment_intent_id===original.data.payment_intent_id&&
        latest.data?.latest_observation?.status==="succeeded");
      intentId=sid(original.data.payment_intent_id,"pi");firstDispatchAt=original.data.first_dispatch_at;
      manual={contract:original.data.contract,paymentIntentId:intentId,confirmationOperationId:latest.data.operation_id};
      dependencies=await readBuyerMentorshipManualBindings(admin,reservation);
    }else{
      const bindings=await readBuyerMentorshipCheckoutBindings(admin,reservation);checkout=bindings.checkout;
      dependencies={customerId:bindings.bootstrap.customer_id,productId:bindings.product.result_id,subscriptionId:bindings.subscription.result_id,
        anchorSeconds:bindings.bootstrap.anchor_seconds};
      session=await stripe.checkout.sessions.retrieve(sid(checkout.result_id,"cs"));intentId=sid(session.payment_intent,"pi");firstDispatchAt=checkout.first_dispatch_at;
    }
    const paymentIntent = await stripe.paymentIntents.retrieve(intentId);
    const charge = await stripe.charges.retrieve(sid(paymentIntent.latest_charge, "ch"));
    const [balance, paymentMethod, customer, sub] = await Promise.all([
      stripe.balanceTransactions.retrieve(sid(charge.balance_transaction, "txn")),
      stripe.paymentMethods.retrieve(sid(paymentIntent.payment_method, "pm")),
      stripe.customers.retrieve(sid(dependencies.customerId, "cus")), stripe.subscriptions.retrieve(sid(dependencies.subscriptionId, "sub"))]);
    let activationReceipt:unknown;
    if(env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_SCHEMA_READY==="true") {
      const activation=await admin.from("buyer_mentorship_activation_operations_v1").select("reservation_id,item_id,request")
        .eq("reservation_id",reservation.id).maybeSingle();
      check(!activation.error);
      if(activation.data) {
        const receipt=await admin.from("buyer_mentorship_first_receipts_v1").select("reservation_id,proof")
          .eq("reservation_id",reservation.id).maybeSingle();
        check(!receipt.error && receipt.data?.reservation_id===reservation.id && activation.data.reservation_id===reservation.id &&
          activation.data.item_id===sub.items?.data?.[0]?.id && isDeepStrictEqual(activation.data.request,{
            apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:`/v1/subscriptions/${dependencies.subscriptionId}`,
            params:buyerMentorshipActivationParams(charge.created,reservation.terms.paymentCount,sid(paymentIntent.payment_method,"pm"))}));
        activationReceipt=receipt.data.proof;
      }
    }
    const fresh = await runtime.observeContext();
    const common={reservation,context:config.approvedContext,contextEvidence:fresh.contextEvidence,dependencies,firstDispatchAt,
      nowSeconds:Math.floor(Date.now()/1000),allowActivatedSubscription:activationReceipt!==undefined,financialInspection:args.financialInspection};
    const data={paymentIntent,charge,balance,paymentMethod,customer,subscription:sub};
    const proof=manual?inspectBuyerMentorshipManualFirstCapture({...common,manual,data}):
      inspectBuyerMentorshipFirstCapture({...common,sessionId:checkout!.result_id,originalRequest:checkout!.request,data:{...data,session:session!}});
    if(activationReceipt!==undefined)check(isDeepStrictEqual(proof,activationReceipt));
    return proof;
  } catch { throw Error("Buyer installment first payment requires review"); }
}
