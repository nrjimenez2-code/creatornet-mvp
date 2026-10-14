import "server-only";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import { assertAgreementId } from "./installments/agreementStore";
import { exactContextServerConfig } from "./installments/contextServer";
import { createExactContextRuntime } from "./installments/contextRuntime";
import { CONTEXT_CUSTOMER_API_VERSION } from "./installments/contextBootstrap";
import { readBuyerMentorshipInstallmentReservation } from "./mentorshipInstallmentReservation";

function check(value: unknown): asserts value { if (!value) throw Error("Buyer installment customer needs review"); }
/** Internal preparation, not a public payment endpoint. This creates only the
 * accepted request's dedicated customer; it cannot create a Checkout session,
 * subscription, card attachment, invoice, charge or entitlement. */
export async function prepareBuyerMentorshipCustomer(args: {
  requestId: string; buyerId: string; recoverExistingOnly?: boolean; env?: Record<string, string | undefined>;
}) {
  try {
    const env = args.env ?? process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY === "true" && env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_READY === "true");
    if (args.recoverExistingOnly) check(env.CREATOR_MENTORSHIP_INSTALLMENT_ORIGINAL_BOOTSTRAP_RECOVERY_SCHEMA_READY === "true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_ORIGINAL_BOOTSTRAP_RECOVERY_READY === "true");
    assertAgreementId(args.requestId); assertAgreementId(args.buyerId);
    const config = exactContextServerConfig(env), runtime = createExactContextRuntime(config);
    const observed = await runtime.observeContext();
    const admin = createClient(config.configuredSupabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const scope = { admin, buyerId: args.buyerId, requestId: args.requestId, context: config.approvedContext, contextEvidence: observed.contextEvidence };
    const saved = await readBuyerMentorshipInstallmentReservation(scope); check(saved);
    const params = { p_request_id: args.requestId, p_buyer_id: args.buyerId, p_context: config.approvedContext };
    const claimed = args.recoverExistingOnly
      ? await admin.rpc("recover_buyer_mentorship_preparation_v1", { ...params, p_step: "customer.create" })
      : await admin.rpc("claim_buyer_mentorship_customer_v1", params);
    check(!claimed.error && claimed.data && typeof claimed.data === "object");
    const result = claimed.data;
    if (args.recoverExistingOnly && result.status === "partial_preparation") return { status: "partial_preparation" as const };
    const op = result.operation, c = config.approvedContext, t = saved.terms;
    check(op && typeof op.reservation_id === "string"); assertAgreementId(op.reservation_id);
    const metadata = { creatornet_installment_version: "buyer-mentorship-installments-v1", creatornet_installment_reservation_id: op.reservation_id,
      creatornet_installment_request_id: args.requestId, buyer_id: args.buyerId, creator_id: t.creatorId, product_id: t.productId, post_id: t.postId,
      terms_fingerprint: saved.fingerprint, operation_kind: "customer.create", payment_mode: c.mode, platform_account_id: c.platformAccountId,
      supabase_project_ref: c.supabaseProjectRef, site_origin: c.siteOrigin };
    check(op.api_version === CONTEXT_CUSTOMER_API_VERSION && isDeepStrictEqual(op.request, { metadata }) && typeof op.idempotency_key === "string" &&
      /^cn-buyer-customer-v1:[0-9a-f-]{36}$/.test(op.idempotency_key));
    assertAgreementId(op.idempotency_key.slice("cn-buyer-customer-v1:".length));
    if (result.status === "busy" || result.status === "review_required") return { status: result.status as "busy" | "review_required" };
    check(result.status === "bound" || result.status === "dispatch");
    const stripe = new Stripe(config.stripeSecretKey, { apiVersion: CONTEXT_CUSTOMER_API_VERSION, maxNetworkRetries: 0, timeout: 10000 });
    const validate = (value: Stripe.Customer | Stripe.DeletedCustomer, expectedId?: string): Stripe.Customer => {
      check(!("deleted" in value && value.deleted) && value.object === "customer");
      const customer = value as Stripe.Customer;
      check(/^cus_[A-Za-z0-9]+$/.test(customer.id) && (!expectedId || customer.id === expectedId) &&
        customer.livemode === (c.mode === "live") && customer.test_clock == null && isDeepStrictEqual(customer.metadata, metadata));
      return customer;
    };
    if (result.status === "bound") {
      check(typeof op.customer_id === "string" && /^cus_[A-Za-z0-9]+$/.test(op.customer_id));
      const customer = validate(await stripe.customers.retrieve(op.customer_id), op.customer_id);
      return { status: "customer_bound" as const, customerId: customer.id };
    }
    check(typeof op.lease_token === "string"); assertAgreementId(op.lease_token);
    const deadline = Date.parse(result.dispatch_before), first = Date.parse(op.first_dispatch_at);
    check(Number.isFinite(first) && Number.isFinite(deadline) && first <= Date.now() + 5000 &&
      Date.now() < deadline && deadline <= Date.now() + 35000 && deadline <= first + 23 * 3600000);
    // Repeat independent context observation immediately before the only write.
    await runtime.observeContext(); check(Date.now() < deadline);
    const created = await stripe.customers.create({ metadata }, { idempotencyKey: op.idempotency_key, maxNetworkRetries: 0 });
    validate(created);
    const customer = validate(await stripe.customers.retrieve(created.id), created.id);
    check(customer.created >= Math.floor(first / 1000) - 5 && customer.created <= Math.floor(Date.now() / 1000) + 5);
    const requestId = created.lastResponse?.requestId;
    check(typeof requestId === "string" && /^req_[A-Za-z0-9]+$/.test(requestId));
    const bound = await admin.rpc("bind_buyer_mentorship_customer_v1", { ...params, p_token: op.lease_token,
      p_customer: { id: customer.id, object: customer.object, created: customer.created, livemode: customer.livemode,
        metadata: customer.metadata, test_clock: customer.test_clock }, p_provider_request_id: requestId });
    check(!bound.error && bound.data?.reservation_id === op.reservation_id && bound.data?.customer_id === customer.id &&
      bound.data?.idempotency_key === op.idempotency_key && isDeepStrictEqual(bound.data?.request, op.request));
    return { status: "customer_bound" as const, customerId: customer.id };
  } catch {
    // Preserve the original operation after all uncertain replies. The durable
    // lease permits only bounded replay with the identical request and key.
    throw Error("Buyer installment customer needs review");
  }
}
