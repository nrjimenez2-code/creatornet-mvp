import "server-only";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import { assertAgreementId } from "./installments/agreementStore";
import { exactContextServerConfig } from "./installments/contextServer";
import { createExactContextRuntime } from "./installments/contextRuntime";
import { CONTEXT_CUSTOMER_API_VERSION } from "./installments/contextBootstrap";
import { installmentMonthBoundary } from "./installments/checkoutPreparation";
import { readBuyerMentorshipBootstrapReservation } from "./mentorshipInstallmentReservation";
import { prepareBuyerMentorshipCustomer } from "./mentorshipInstallmentCustomer";
import { buildBuyerMentorshipCheckoutRequest,readBuyerMentorshipCheckoutBindings,inspectBuyerMentorshipUnpaidCheckout } from "./mentorshipInstallmentCheckout";
import { inspectExpiredCheckoutPaymentIntent } from "./installments/checkoutExpiry";
import { calculateInstallmentPlan } from "./installmentPlan";
import { SERVER_PAYMENT_PROTOCOL } from "./serverPaymentConfirmation";

type Step = "product.create" | "subscription.create" | "subscription.hold" | "checkout.create";
type Request = { apiVersion: typeof CONTEXT_CUSTOMER_API_VERSION; method: "POST"; path: string; params: object };
const check: (value: unknown) => asserts value = value => { if (!value) throw Error("Buyer installment bootstrap needs review"); };
const objectId = (value: string | { id: string } | null) => typeof value === "string" ? value : value?.id;

/** Internal, unpublished preparation. The caller must supply an authenticated
 * buyer, never a creator impersonation or booking. Claims commit before writes;
 * uncertain responses retain the original request/key. This has no HTTP caller
 * and cannot grant access or release a purchase lock. Checkout dispatch requires
 * a separate default-off gate pending real receipt/lifecycle acceptance.
 * recoverExistingOnly stops at the first missing operation using atomic SQL
 * admission. It must never be used by abandonment to manufacture dependencies. */
export async function prepareBuyerMentorshipBootstrap(args: {
  buyerId: string; requestId: string; recoverExistingOnly?: boolean; serverControlledFirstPayment?: boolean; env?: Record<string, string | undefined>;
}): Promise<{ status: "held_unpublished"; subscriptionId: string } |
  { status: "checkout_unpublished"; sessionId: string; subscriptionId: string } |
  { status: "busy" | "review_required" | "partial_preparation" }> {
  try {
    const env = args.env ?? process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_SCHEMA_READY === "true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_READY === "true");
    if(args.serverControlledFirstPayment)check(!args.recoverExistingOnly&&env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY==="true"&&
      env.CREATOR_SERVER_PAYMENT_INTENT_READY==="true");
    if (args.recoverExistingOnly) check(env.CREATOR_MENTORSHIP_INSTALLMENT_ORIGINAL_BOOTSTRAP_RECOVERY_SCHEMA_READY === "true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_ORIGINAL_BOOTSTRAP_RECOVERY_READY === "true");
    assertAgreementId(args.buyerId); assertAgreementId(args.requestId);
    const prepared = await prepareBuyerMentorshipCustomer({ ...args, env });
    if (prepared.status !== "customer_bound") return prepared;
    const config = exactContextServerConfig(env), runtime = createExactContextRuntime(config);
    let observed = await runtime.observeContext();
    const admin = createClient(config.configuredSupabaseUrl, config.supabaseServiceKey,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const r = await readBuyerMentorshipBootstrapReservation({ admin, requestId: args.requestId, buyerId: args.buyerId,
      context: config.approvedContext, contextEvidence: observed.contextEvidence });
    check(r); const t = r.terms, c = config.approvedContext;
    const scope = { p_request_id: args.requestId, p_buyer_id: args.buyerId, p_context: c };
    if(args.serverControlledFirstPayment){
      const pin=await admin.rpc("pin_installment_server_payment_v1",scope);
      check(!pin.error&&pin.data?.attempt_id===r.attemptId&&pin.data?.reservation_id===r.id&&pin.data?.buyer_id===r.buyerId&&
        pin.data?.product_id===r.productId&&pin.data?.kind==="first_installment"&&pin.data?.protocol===SERVER_PAYMENT_PROTOCOL&&
        isDeepStrictEqual(pin.data?.context,c));
    }
    const started = args.recoverExistingOnly
      ? await admin.rpc("recover_buyer_mentorship_preparation_v1", { ...scope, p_step: "bootstrap.begin" })
      : await admin.rpc("begin_buyer_mentorship_bootstrap_v1", scope);
    check(!started.error);
    if (args.recoverExistingOnly && started.data?.status === "partial_preparation") return { status: "partial_preparation" };
    const b = started.data;
    check(!started.error && b?.reservation_id === r.id && b.customer_id === prepared.customerId &&
      Number.isSafeInteger(b.anchor_seconds) && b.anchor_seconds >= Math.floor(Date.parse(r.acceptedAt) / 1000));
    const now = () => Math.floor(Date.now() / 1000), anchor = b.anchor_seconds as number;
    const inWindow = () => check(now() >= anchor && now() < anchor + 86400 - 1860);
    inWindow();
    const stripe = new Stripe(config.stripeSecretKey, { apiVersion: CONTEXT_CUSTOMER_API_VERSION, maxNetworkRetries: 0, timeout: 10000 });
    const metadata = { creatornet_installment_version: t.installmentVersion, creatornet_installment_reservation_id: r.id,
      creatornet_installment_request_id: r.requestId, buyer_id: r.buyerId, creator_id: t.creatorId, product_id: r.productId,
      post_id: r.postId, terms_fingerprint: r.fingerprint, payment_mode: c.mode, platform_account_id: c.platformAccountId,
      supabase_project_ref: c.supabaseProjectRef, site_origin: c.siteOrigin };
    const plan = calculateInstallmentPlan(t.amountCents, t.paymentCount, t.renewalFeeSchedule, t.firstPaymentFeeSchedule);
    const validateCustomer = (value: Stripe.Customer | Stripe.DeletedCustomer): Stripe.Customer => {
      check(!value.deleted); const customer = value as Stripe.Customer;
      check(customer.object === "customer" && customer.id === prepared.customerId && customer.livemode === (c.mode === "live") &&
        customer.balance === 0 && customer.delinquent === false && customer.default_source === null &&
        customer.invoice_settings.default_payment_method === null && customer.test_clock === null &&
        isDeepStrictEqual(customer.metadata, { ...metadata, operation_kind: "customer.create" }));
      return customer;
    };
    let customer = validateCustomer(await stripe.customers.retrieve(prepared.customerId));
    const destination = await stripe.accounts.retrieve(r.destinationId);
    check(destination.id === r.destinationId && destination.charges_enabled && destination.payouts_enabled &&
      destination.capabilities?.transfers === "active");

    async function step<T extends { id: string; object: string; livemode: boolean; metadata: unknown }>(
      kind: Step, request: Request, dispatch: (key: string) => Promise<T & { lastResponse?: { requestId: string } }>,
      retrieve: (id: string) => Promise<T>, validate: (value: T) => void): Promise<T> {
      inWindow();
      const claimed = await admin.rpc(args.recoverExistingOnly ? "recover_buyer_mentorship_preparation_v1" : "claim_buyer_mentorship_bootstrap_v1",
        { ...scope, p_step: kind, p_request: request });
      check(!claimed.error);
      if (args.recoverExistingOnly && claimed.data?.status === "partial_preparation") throw new BootstrapPending("partial_preparation");
      const result = claimed.data, op = result?.operation;
      check(!claimed.error && op?.reservation_id === r!.id && op.step === kind && isDeepStrictEqual(op.request, request) &&
        typeof op.idempotency_key === "string" && /^cn-buyer-bootstrap-v1:[0-9a-f-]{36}$/.test(op.idempotency_key));
      assertAgreementId(op.idempotency_key.slice("cn-buyer-bootstrap-v1:".length));
      if (result.status === "busy" || result.status === "review_required") throw new BootstrapPending(result.status);
      if (result.status === "bound") {
        check(typeof op.result_id === "string");
        const value = await retrieve(op.result_id); check(value.id === op.result_id); validate(value); return value;
      }
      check(result.status === "dispatch"); assertAgreementId(op.lease_token);
      const first = Date.parse(op.first_dispatch_at), deadline = Date.parse(result.dispatch_before);
      check(Number.isFinite(first) && Number.isFinite(deadline) && first <= Date.now() + 5000 &&
        deadline > Date.now() && deadline <= Date.now() + 35000 && deadline <= first + 23 * 3600000 &&
        deadline <= (anchor + 86400 - 1860) * 1000);
      observed = await runtime.observeContext(); inWindow(); check(Date.now() < deadline);
      const created = await dispatch(op.idempotency_key); validate(created);
      const value = await retrieve(created.id); check(value.id === created.id); validate(value);
      const providerRequestId = created.lastResponse?.requestId;
      check(typeof providerRequestId === "string" && /^req_[A-Za-z0-9]+$/.test(providerRequestId));
      const proof = { id: value.id, object: value.object, livemode: value.livemode, metadata: value.metadata,
        ...(kind === "subscription.hold" ? { pause_collection: (value as unknown as Stripe.Subscription).pause_collection } : {}) };
      const bound = await admin.rpc("bind_buyer_mentorship_bootstrap_v1", { ...scope, p_step: kind, p_token: op.lease_token,
        p_object: proof, p_provider_request_id: providerRequestId });
      check(!bound.error && bound.data?.reservation_id === r!.id && bound.data?.step === kind && bound.data?.result_id === value.id &&
        bound.data?.idempotency_key === op.idempotency_key && isDeepStrictEqual(bound.data?.request, request));
      return value;
    }
    const request = (path: string, params: object): Request => ({ apiVersion: CONTEXT_CUSTOMER_API_VERSION, method: "POST", path, params });
    const productParams = { name: `${t.title} installments`, metadata: { ...metadata, operation_kind: "product.create" } };
    const product = await step("product.create", request("/v1/products", productParams),
      key => stripe.products.create(productParams, { idempotencyKey: key, maxNetworkRetries: 0 }), id => stripe.products.retrieve(id), value => {
        check(value.object === "product" && /^prod_[A-Za-z0-9]+$/.test(value.id) && value.livemode === (c.mode === "live") &&
          value.active && value.name === productParams.name && isDeepStrictEqual(value.metadata, productParams.metadata));
      });
    const trialEnd = anchor + 48 * 3600;
    const subscriptionParams: Stripe.SubscriptionCreateParams = { customer: customer.id,
      items: [{ quantity: 1, price_data: { currency: "usd", product: product.id, unit_amount: plan.regularAmountCents,
        recurring: { interval: "month" } } }], trial_end: trialEnd, cancel_at: installmentMonthBoundary(trialEnd, t.paymentCount - 1),
      proration_behavior: "none", billing_mode: { type: "classic" }, collection_method: "charge_automatically",
      transfer_data: { destination: r.destinationId }, automatic_tax: { enabled: false },
      payment_settings: { payment_method_types: ["card"], save_default_payment_method: "off" },
      trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } },
      metadata: { ...metadata, operation_kind: "subscription.create" } };
    const validateSubscription = (s: Stripe.Subscription) => {
      check(s.object === "subscription" && /^sub_[A-Za-z0-9]+$/.test(s.id) && s.livemode === (c.mode === "live") &&
        s.customer === customer.id && s.status === "trialing" && s.trial_end === trialEnd && s.cancel_at === subscriptionParams.cancel_at &&
        s.test_clock === null && s.default_payment_method === null && s.default_source === null &&
        s.application_fee_percent === null && objectId(s.transfer_data?.destination ?? null) === r!.destinationId &&
        isDeepStrictEqual(s.metadata, subscriptionParams.metadata));
    };
    const subscription = await step("subscription.create", request("/v1/subscriptions", subscriptionParams),
      key => stripe.subscriptions.create(subscriptionParams, { idempotencyKey: key, maxNetworkRetries: 0 }),
      id => stripe.subscriptions.retrieve(id), validateSubscription);
    const dependencies = { customerId: customer.id, productId: product.id, subscriptionId: subscription.id, anchorSeconds: anchor };
    const checkoutRequest = (s: Stripe.Subscription) => buildBuyerMentorshipCheckoutRequest({ reservation: r,
      context: c, contextEvidence: observed.contextEvidence, dependencies, customer, subscription: s, nowSeconds: now() });
    const hold = { pause_collection: { behavior: "keep_as_draft" as const } };
    await step("subscription.hold", request(`/v1/subscriptions/${subscription.id}`, hold),
      key => stripe.subscriptions.update(subscription.id, hold, { idempotencyKey: key, maxNetworkRetries: 0 }),
      id => stripe.subscriptions.retrieve(id), s => { validateSubscription(s); checkoutRequest(s); });
    // Full fresh verification, including independent context, before a payable
    // request. A previous successful hold operation alone is insufficient.
    observed = await runtime.observeContext();
    customer = validateCustomer(await stripe.customers.retrieve(customer.id));
    const held = await stripe.subscriptions.retrieve(subscription.id), checkout = checkoutRequest(held);
    if (args.serverControlledFirstPayment || env.CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_DISPATCH_READY !== "true") {
      return { status: "held_unpublished", subscriptionId: subscription.id };
    }
    const session = await step("checkout.create", checkout,
      key => stripe.checkout.sessions.create(checkout.params, { idempotencyKey: key, maxNetworkRetries: 0 }),
      id => stripe.checkout.sessions.retrieve(id), s => {
        check(s.object === "checkout.session" && /^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(s.id) && s.livemode === (c.mode === "live") &&
          s.status === "open" && s.mode === "payment" && s.payment_status === "unpaid" && objectId(s.customer) === customer.id &&
          s.currency === "usd" && s.amount_total === plan.payments[0].amountCents && s.expires_at === anchor + 86400 &&
          s.automatic_tax?.enabled === false && s.total_details?.amount_tax === 0 && s.total_details.amount_discount === 0 &&
          s.billing_address_collection === "required" && isDeepStrictEqual(s.metadata, checkout.params.metadata));
      });
    checkoutRequest(await stripe.subscriptions.retrieve(subscription.id));
    return { status: "checkout_unpublished", sessionId: session.id, subscriptionId: subscription.id };
  } catch (error) {
    if (error instanceof BootstrapPending) return { status: error.status };
    throw Error("Buyer installment bootstrap needs review");
  }
}
class BootstrapPending extends Error { constructor(readonly status: "busy" | "review_required" | "partial_preparation") { super(status); } }


/** Internal read-only recovery of the bound original session. Never replays a
 * create operation, publishes a URL, grants access or releases the purchase. */
export async function observeBuyerMentorshipUnpaidCheckout(args:{buyerId:string;requestId:string;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_SCHEMA_READY==="true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_OBSERVATION_READY==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config),observed=await runtime.observeContext();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const reservation=await readBuyerMentorshipBootstrapReservation({...args,admin,context:config.approvedContext,contextEvidence:observed.contextEvidence});
    check(reservation);
    const bindings=await readBuyerMentorshipCheckoutBindings(admin,reservation),{bootstrap,product,subscription,checkout}=bindings;
    check(typeof checkout.result_id==="string" && /^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(checkout.result_id));
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const inspect=async(contextEvidence:unknown)=>{
      const observation=inspectBuyerMentorshipUnpaidCheckout({reservation,context:config.approvedContext,contextEvidence,
        dependencies:{customerId:bootstrap.customer_id,productId:product.result_id,subscriptionId:subscription.result_id,anchorSeconds:bootstrap.anchor_seconds},
        originalRequest:checkout.request,sessionId:checkout.result_id,firstDispatchAt:checkout.first_dispatch_at,
        session:await stripe.checkout.sessions.retrieve(checkout.result_id),nowSeconds:Math.floor(Date.now()/1000)});
      if(observation.status!=="payment_reconciliation_required") return observation;
      const intentId=observation.paymentIntentId;
      check(typeof intentId==="string" && /^pi_[A-Za-z0-9]+$/.test(intentId));
      const t=reservation.terms,first=calculateInstallmentPlan(t.amountCents,t.paymentCount,t.renewalFeeSchedule,t.firstPaymentFeeSchedule).payments[0];
      const settled=inspectExpiredCheckoutPaymentIntent(await stripe.paymentIntents.retrieve(intentId),{
        paymentIntentId:intentId,customerId:bootstrap.customer_id,liveMode:config.approvedContext.mode==="live",
        amountCents:first.amountCents,feeCents:first.fees.totalCreatorDeductionCents,destinationId:reservation.destinationId});
      return {...observation,status:settled?"expired_with_canceled_payment" as const:observation.status};
    };
    const first=await inspect(observed.contextEvidence),fresh=await runtime.observeContext();
    check(isDeepStrictEqual(await readBuyerMentorshipCheckoutBindings(admin,reservation),bindings));
    const current=await inspect(fresh.contextEvidence);check(isDeepStrictEqual(first,current));
    return {...current,requestId:args.requestId};
  } catch {throw Error("Buyer Checkout recovery requires review");}
}


/** Internal stop intent only. Never cancels a provider object or releases the
 * purchase. Late capture accounting remains enabled under the durable hold. */
export async function requestBuyerMentorshipAbandonment(args:{buyerId:string;requestId:string;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_SCHEMA_READY==="true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_SCHEMA_READY==="true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_REQUEST_READY==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config),observed=await runtime.observeContext();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const reservation=await readBuyerMentorshipBootstrapReservation({...args,admin,context:config.approvedContext,contextEvidence:observed.contextEvidence});
    check(reservation);
    const saved=await admin.rpc("request_buyer_mentorship_abandonment_v1",{
      p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:config.approvedContext});
    check(!saved.error && saved.data?.reservation_id===reservation.id &&
      typeof saved.data.requested_at==="string" && Number.isFinite(Date.parse(saved.data.requested_at)));
    return {status:"stop_requested" as const,requestId:args.requestId,releaseAllowed:false as const};
  } catch {throw Error("Buyer Checkout abandonment requires review");}
}


/** No-provider alternative: SQL proves either no preparation was admitted, or
 * the separately gated bound-customer/product-only state preceded every payable
 * operation. Original records and all unresolved operations remain retained. */
export async function releaseBuyerMentorshipUnpreparedSelection(args:{buyerId:string;requestId:string;includeNonpayablePreparation?:boolean;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    for(const flag of ["BOOTSTRAP_SCHEMA_READY","ABANDONMENT_RELEASE_SCHEMA_READY","UNPREPARED_RELEASE_SCHEMA_READY","UNPREPARED_RELEASE_READY"])
      check(env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    const config=exactContextServerConfig(env),observed=await createExactContextRuntime(config).observeContext();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context:config.approvedContext,contextEvidence:observed.contextEvidence});check(r);
    const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:config.approvedContext};
    if(args.includeNonpayablePreparation) check(env.CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_SCHEMA_READY==="true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_READY==="true");
    let result=await admin.rpc("release_buyer_mentorship_unprepared_v1",scope);
    check(!result.error);
    if(result.data?.status==="prepared_or_uncertain" && args.includeNonpayablePreparation) {
      result=await admin.rpc("release_buyer_mentorship_nonpayable_v1",scope);check(!result.error);
    }
    if(result.data?.status==="prepared_or_uncertain")return {status:"prepared_or_uncertain" as const};
    const released=result.data;
    check(released?.status==="released"&&released.reservation_id===r.id&&released.request_id===r.requestId&&
      typeof released.released_at==="string"&&Number.isFinite(Date.parse(released.released_at))&&
      Date.parse(released.released_at)>0&&Date.parse(released.released_at)<=Date.now()+5000);
    return {status:"released" as const,requestId:r.requestId,releasedAt:released.released_at as string,providerOperationsAllowed:false as const};
  }catch{throw Error("Unprepared selection release requires review");}
}
