import "server-only";
import { isSupportedStripeSnapshotVersion } from "../stripeSnapshotVersion";
import Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { assertAgreementId } from "./agreementStore";
import { readExactContextReservation } from "./contextReservation";
import { inspectContextReservationEvent } from "./contextReconciliation";
import { buildExactContextCustomerPlan, readExactContextCustomerIntent, type ExactContextCustomerIntent } from "./contextBootstrap";
import { assertContextBootstrapCustomer, assertContextHeldObject, exactHeldFormMatches, readContextHeldDispatch,
  type HeldBootstrapAttempt, type HeldBootstrapDependencies, type HeldBootstrapStage } from "./contextHeldBootstrap";
import { validateExactPaymentContext, type ExactPaymentContext, type ExactPaymentContextEvidence } from "./paymentContext";
import { assertContextCheckoutSession, contextStripeId, inspectContextFirstCharge, readContextCheckoutState,
  type ContextCheckoutAttempt } from "./contextCheckout";
import { assertContextActivationCard, assertContextBootstrapInvoices, contextActivationParams, contextActivationAuthorization,
  inspectContextActivationSubscription, readContextActivation } from "./contextActivation";
import { readContextInvoiceState, readContextInvoiceCollection, contextInvoicePeriod, contextInvoiceAuthorization, contextInvoiceContract } from "./contextInvoice";
import { heldInvoicePreparationRequests, prepareHeldInvoiceUsingContract } from "./heldInvoice";
import { inspectPaidRenewal, verifyRenewalProviderHistory } from "./renewal";
import { calculateInstallmentPlan } from "../installmentPlan";
import { inspectContextFinancialEvent, readContextFinancialState, type ContextFinancialEvent } from "./contextFinancialEvent";
import { inspectExactRefundCapture, inspectExactRefundTotals } from "./refundEvent";
import { stopCreditedContextBilling } from "./contextBillingStop";
import { inspectUnpaidExactRecovery, parseExactRecoveryRead, type RecoveryRead, type RecoveryEvidence, type RecoveryOutcome } from "./paymentRecovery";
import { prepareContextCardSetup } from "./contextCardSetup";
import { runContextBuyerRetry } from "./contextBuyerRetry";
import { runContextBankVerification } from "./contextBankVerification";
import { observeContextSubscription } from "./contextSubscription";
import { runContextAdminRefund, type ContextRefundAction } from "./contextAdminRefund";

export const CONTEXT_RUNTIME_ERROR = "Exact context runtime requires review";
export const CONTEXT_RUNTIME_MAX_AGE_MS = 30_000;
export type ExactContextRuntimeConfig = Readonly<{
  approvedContext: ExactPaymentContext;
  vercelEnvironment: "preview" | "production";
  configuredSupabaseUrl: string;
  configuredSiteOrigin: string;
  stripeSecretKey: string;
  stripePublishableKeyMode: "test" | "live";
  supabaseServiceKey: string;
  expectedApiVersion: string;
}>;
export type ExactRuntimeContextObservation = Readonly<{
  version: "exact-context-runtime-observation-v1";
  context: ExactPaymentContext;
  contextEvidence: ExactPaymentContextEvidence;
  databaseIdentity: "authenticated_project_api_endpoint";
  startedAtMilliseconds: number;
  observedAtMilliseconds: number;
  providerOperationsAllowed: false;
  accountingOperationsAllowed: false;
}>;

const observations = new WeakSet<object>();
const fail = () => new Error(CONTEXT_RUNTIME_ERROR);
function check(value: unknown): asserts value { if (!value) throw fail(); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  const proto = Object.getPrototypeOf(value);
  check(proto === Object.prototype || proto === null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  check(names.length === keys.length && names.every(name => typeof name === "string" && keys.includes(name)));
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = descriptors[key];
    check(d && "value" in d && d.enumerable);
    snapshot[key] = d.value;
  }
  return snapshot;
}
function own(value: unknown, key: string): unknown {
  check(value && typeof value === "object" && !Array.isArray(value));
  const d = Object.getOwnPropertyDescriptor(value, key);
  check(d && "value" in d && d.enumerable);
  return d.value;
}
function secret(value: unknown): string {
  check(typeof value === "string" && value.length > 0 && value.length <= 8192 && !/\s/.test(value));
  return value;
}
function elapsed(start: number) {
  const end = Date.now();
  check(Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(end) && end >= start &&
    end - start <= CONTEXT_RUNTIME_MAX_AGE_MS);
  return end;
}

/** Process-local provenance and age, not a financial capability or cached
 * authorization. Copies/serialized observations are deliberately not accepted. */
export function assertFreshExactRuntimeContextObservation(value: unknown): asserts value is ExactRuntimeContextObservation {
  try {
    check(value && typeof value === "object" && observations.has(value));
    const observation = value as ExactRuntimeContextObservation;
    check(elapsed(observation.startedAtMilliseconds) >= observation.observedAtMilliseconds);
  } catch { throw fail(); }
}

const selection = "id,booking_id,context,terms,status,created_at";
const pinPath = "/rest/v1/rpc/read_exact_installment_context_pin_v2";
const reservationPath = "/rest/v1/exact_installment_context_reservations_v2";
const customerPlanPath = "/rest/v1/rpc/plan_exact_customer_operation_v2";
const customerReadPath = "/rest/v1/rpc/read_exact_customer_operation_v2";
const customerClaimPath = "/rest/v1/rpc/claim_exact_customer_dispatch_v2";
const customerBindPath = "/rest/v1/rpc/bind_exact_customer_dispatch_v2";
const customerDispatchReadPath = "/rest/v1/rpc/read_exact_customer_dispatch_v2";
const heldReadPath = "/rest/v1/rpc/read_exact_held_step_v2";
const heldClaimPath = "/rest/v1/rpc/claim_exact_held_step_v2";
const heldBindPath = "/rest/v1/rpc/bind_exact_held_step_v2";
const checkoutReadPath = "/rest/v1/rpc/read_exact_context_checkout_v2";
const checkoutClaimPath = "/rest/v1/rpc/claim_exact_context_checkout_v2";
const checkoutBindPath = "/rest/v1/rpc/bind_exact_context_checkout_v2";
const firstReceiptPath = "/rest/v1/rpc/record_exact_context_first_receipt_v2";
const firstCreditPath = "/rest/v1/rpc/credit_exact_context_first_payment_v2";
const activationReadPath = "/rest/v1/rpc/read_exact_context_activation_v2";
const activationClaimPath = "/rest/v1/rpc/claim_exact_context_activation_v2";
const activationCompletePath = "/rest/v1/rpc/complete_exact_context_activation_v2";
type CustomerAttempt = Readonly<{ operation_id: string; id: string; claimed_at: string }>;
type CustomerBinding = Readonly<{ operation_id: string; attempt_id: string; customer_id: string;
  request_id: string; customer_created: number; bound_at: string }>;
type CustomerDispatch = Readonly<{ claimed: boolean; attempt: CustomerAttempt | null; binding: CustomerBinding | null }>;
function readCustomerDispatch(value: unknown, intent: ExactContextCustomerIntent): CustomerDispatch {
  const result = fields(value, ["claimed", "attempt", "binding"]);
  check(typeof result.claimed === "boolean");
  let attempt: CustomerAttempt | null = null, binding: CustomerBinding | null = null;
  if (result.attempt !== null) {
    const a = fields(result.attempt, ["operation_id", "id", "claimed_at"]);
    check(a.operation_id === intent.id && typeof a.id === "string" && typeof a.claimed_at === "string");
    assertAgreementId(a.id);
    check(Number.isFinite(Date.parse(a.claimed_at)) && Date.parse(a.claimed_at) >= intent.createdAt * 1000);
    attempt = Object.freeze(a) as CustomerAttempt;
  }
  if (result.binding !== null) {
    const b = fields(result.binding, ["operation_id", "attempt_id", "customer_id", "request_id", "customer_created", "bound_at"]);
    check(attempt && b.operation_id === intent.id && b.attempt_id === attempt.id &&
      typeof b.customer_id === "string" && /^cus_[A-Za-z0-9]{1,196}$/.test(b.customer_id) &&
      typeof b.request_id === "string" && /^req_[A-Za-z0-9]{1,196}$/.test(b.request_id) &&
      typeof b.customer_created === "number" && Number.isSafeInteger(b.customer_created) &&
      b.customer_created >= Math.floor(Date.parse(attempt.claimed_at) / 1000) &&
      b.customer_created <= Math.floor(Date.parse(attempt.claimed_at) / 1000) + 60 &&
      typeof b.bound_at === "string" && Date.parse(b.bound_at) >= Date.parse(attempt.claimed_at) &&
      Date.parse(b.bound_at) <= Date.parse(attempt.claimed_at) + 60_000);
    binding = Object.freeze(b) as CustomerBinding;
  }
  check(!result.claimed || (attempt && !binding));
  return Object.freeze({ claimed: result.claimed, attempt, binding });
}
const uuidFilter = /^eq\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function databaseRead(url: URL): boolean {
  if (url.pathname === pinPath) return url.search === "";
  if (url.pathname !== reservationPath) return false;
  const entries = [...url.searchParams.entries()];
  return entries.length === 3 && url.searchParams.get("select") === selection &&
    uuidFilter.test(url.searchParams.get("id") ?? "") &&
    uuidFilter.test(url.searchParams.get("terms->>creatorId") ?? "");
}

/** Private composition shared by separately exported inspection, planning and
 * unpaid bootstrap surfaces. Inspection stays GET-only and the planner stays
 * database-only. Customer-only bootstrap cannot enter the held setup branch.
 *
 * Constructs private SDK clients, never accepts a caller's Stripe client,
 * account headers, session, alternate endpoint, arbitrary RPC or request body.
 * A valid v2 event, saved intent or bound customer remains non-payment authority.
 *
 * serverFetch is a TRUSTED server transport seam (synthetic in local tests), not
 * request input. Production provenance depends on its honest HTTPS/TLS/DNS and
 * response URL behavior. Missing final URL, redirects and endpoint mismatch fail.
 * An authenticated response at the approved unique Supabase project API URL plus
 * the matching owner pin establishes endpoint identity. The pin ALONE is not
 * independent project evidence; this does not attest physical SQL/backup identity
 * or protect against a compromised provider/transport. Custom domains unsupported.
 *
 * Keys/configuration must be supplied by separately approved server composition;
 * this module never reads environment or credential files. Publishable-key mode,
 * deployment environment and site origin remain explicit server configuration,
 * not facts independently discoverable through these private read-only APIs.
 */
function createRuntime(config: ExactContextRuntimeConfig, serverFetch: typeof fetch, allowCustomerPlan: boolean, allowCustomerDispatch = false,
  allowHeldBootstrap = false, allowCheckout = false, allowFirstCredit = false, allowActivation = false, allowInvoicePreparation = false,
  allowInvoiceCollection = false, allowFinancialEvents = false, allowBillingStop = false, allowPaymentRecovery = false, allowCardSetup = false,
  allowBuyerRetry = false, allowBankVerification = false, allowAdminRefund = false, allowCheckoutPublication = false) {
  try {
    const c = fields(config, ["approvedContext", "vercelEnvironment", "configuredSupabaseUrl", "configuredSiteOrigin",
      "stripeSecretKey", "stripePublishableKeyMode", "supabaseServiceKey", "expectedApiVersion"]);
    const stripeKey = secret(c.stripeSecretKey), databaseKey = secret(c.supabaseServiceKey);
    const keyMode = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(stripeKey)?.[1];
    check((keyMode === "test" || keyMode === "live") && typeof serverFetch === "function" &&
      typeof c.expectedApiVersion === "string" && /^\d{4}-\d{2}-\d{2}(?:\.[a-z0-9-]+)?$/.test(c.expectedApiVersion));
    const apiVersion = c.expectedApiVersion;
    const approved = fields(c.approvedContext, ["version", "mode", "platformAccountId", "supabaseProjectRef", "siteOrigin"]);
    // Only a static consistency check here. No observation escapes until fresh
    // authenticated reads below replace both candidate observed identities.
    const staticEvidence = { approvedContext: approved, vercelEnvironment: c.vercelEnvironment,
      stripeSecretKeyMode: keyMode, stripePublishableKeyMode: c.stripePublishableKeyMode,
      observedPlatformAccountId: approved.platformAccountId, observedSupabaseProjectRef: approved.supabaseProjectRef,
      configuredSupabaseUrl: c.configuredSupabaseUrl, configuredSiteOrigin: c.configuredSiteOrigin };
    const context = validateExactPaymentContext(approved, staticEvidence);
    const databaseOrigin = `https://${context.supabaseProjectRef}.supabase.co`;
    const transport = serverFetch;
    // Private one-shot transport capabilities. Neither is supplied by a caller,
    // serialized, retained for a retry, or exposed on the returned surface.
    let customerSend: { intent: ExactContextCustomerIntent; attempt: CustomerAttempt } | null = null;
    let customerBind: string | null = null;
    let heldSend: HeldBootstrapAttempt | null = null;
    let heldBind: string | null = null;
    let checkoutSend: ContextCheckoutAttempt | null = null;
    let checkoutBind: string | null = null;
    let checkoutPublication: string | null = null;
    let firstReceiptWrite: string | null = null;
    let firstCreditWrite: string | null = null;
    let activationWrite: string | null = null;
    let activationSend: { path: string; key: string; params: Stripe.SubscriptionUpdateParams; firstStartedAt: number } | null = null;
    let invoiceRpcSend: { path: string; body: string; keys: string[] } | null = null;
    let financialRpcSend: { path: string; body: string; keys: string[] } | null = null;
    let stopRpcSend: { path: string; body: string; keys: string[] } | null = null;
    let stopSend: { path: string; authorizedAt: number } | null = null;
    let cardRpcSend: { path: string; body: string; keys: string[] } | null = null;
    let cardSend: { params: Stripe.Checkout.SessionCreateParams; key: string; startedAt: number } | null = null;
    let retryRpcSend: { path: string; body: string; keys: string[] } | null = null;
    let retryPaySend: { path: string; params: Stripe.InvoicePayParams; key: string; admittedAt: number } | null = null;
    let invoiceSend: { path: string; key: string; params: object; firstStartedAt: number; leaseUntil: number } | null = null;
    let invoicePaySend: { path: string; key: string; params: Stripe.InvoicePayParams; admittedAt: number } | null = null;
    // One GET of a previously database-bound identity. No arbitrary provider
    // object reads are exposed on any public composition.
    let boundRead: string | null = null;
    let boundAccount: string | null = null;
    let refundRpcSend: { path: string; body: string; keys: string[] } | null = null;
    let refundSend: { path: string; params: object; key: string; admittedAt: number } | null = null;
    function customerRead(url: URL): boolean {
      if (!allowCustomerPlan || (url.pathname !== customerReadPath &&
        !(allowCustomerDispatch && url.pathname === customerDispatchReadPath) &&
        !(allowHeldBootstrap && url.pathname === heldReadPath) &&
        !(allowCheckout && url.pathname === checkoutReadPath))) return false;
      const held = url.pathname === heldReadPath;
      const entries = [...url.searchParams.entries()];
      check(entries.length === (held ? 4 : 3));
      const args = fields(Object.fromEntries(entries), ["p_reservation_id", "p_actor_id", "p_context", ...(held ? ["p_stage"] : [])]);
      if (held) check(["product", "subscription", "hold"].includes(String(args.p_stage)));
      check(typeof args.p_reservation_id === "string" && typeof args.p_actor_id === "string" && typeof args.p_context === "string");
      assertAgreementId(args.p_reservation_id); assertAgreementId(args.p_actor_id);
      validateExactPaymentContext(JSON.parse(args.p_context), { ...staticEvidence, approvedContext: context });
      return true;
    }
    function restrictedFetch(provider: "stripe" | "supabase"): typeof fetch {
      return async (input, init) => {
        try {
          check(typeof input === "string" || input instanceof URL);
          const url = new URL(String(input)), headers = new Headers(init?.headers);
          const method = init?.method ?? "GET";
          check(!url.username && !url.password && !url.hash);
          const connectedBalance = provider === "stripe" && allowAdminRefund && method === "GET" && url.pathname === "/v1/balance" &&
            url.search === "" && boundRead === "/v1/balance" && boundAccount !== null && headers.get("stripe-account") === boundAccount;
          check((!headers.has("stripe-account") || connectedBalance) && !headers.has("stripe-context"));
          if (provider === "stripe") {
            check(url.origin === "https://api.stripe.com" &&
              headers.get("authorization") === `Bearer ${stripeKey}` && headers.get("stripe-version") === apiVersion);
            if (method === "GET") {
              const knownRead = (allowHeldBootstrap || allowFinancialEvents || allowBillingStop || allowCardSetup || allowBuyerRetry || allowBankVerification || allowAdminRefund) && boundRead === url.pathname + url.search;
              if (knownRead) { check(boundAccount === null || connectedBalance); boundRead = null; boundAccount = null; }
              check(!headers.has("idempotency-key") && init?.body == null &&
                (knownRead || url.search === "" && (url.pathname === "/v1/account" || url.pathname === "/v1/balance" || /^\/v1\/events\/evt_[A-Za-z0-9]+$/.test(url.pathname))));
            } else if (allowAdminRefund && refundSend !== null) {
              const send = refundSend; refundSend = null;
              check(method === "POST" && url.search === "" && url.pathname === send.path &&
                headers.get("idempotency-key") === send.key && headers.get("content-type") === "application/x-www-form-urlencoded" &&
                typeof init?.body === "string" && exactHeldFormMatches(init.body, send.params));
              elapsed(send.admittedAt);
            } else if (allowBuyerRetry && retryPaySend !== null) {
              const send = retryPaySend; retryPaySend = null;
              check(method === "POST" && url.search === "" && url.pathname === send.path &&
                headers.get("idempotency-key") === send.key && headers.get("content-type") === "application/x-www-form-urlencoded" &&
                typeof init?.body === "string" && exactHeldFormMatches(init.body, send.params));
              elapsed(send.admittedAt);
            } else if (allowCardSetup && cardSend !== null) {
              const send = cardSend; cardSend = null;
              check(method === "POST" && url.search === "" && url.pathname === "/v1/checkout/sessions" &&
                headers.get("idempotency-key") === send.key && headers.get("content-type") === "application/x-www-form-urlencoded" &&
                typeof init?.body === "string" && exactHeldFormMatches(init.body, send.params));
              elapsed(send.startedAt);
            } else if (allowBillingStop && stopSend !== null) {
              const send = stopSend; stopSend = null;
              // stripe-node encodes DELETE parameters in the query, not body.
              check(method === "DELETE" && url.pathname === send.path && url.search === "?invoice_now=false&prorate=false" &&
                !headers.has("idempotency-key") && (init?.body == null || init.body === ""));
              elapsed(send.authorizedAt);
            } else if (allowInvoiceCollection && invoicePaySend !== null) {
              const send = invoicePaySend; invoicePaySend = null;
              check(method === "POST" && url.search === "" && url.pathname === send.path && headers.get("idempotency-key") === send.key &&
                headers.get("content-type") === "application/x-www-form-urlencoded" && typeof init?.body === "string" && exactHeldFormMatches(init.body, send.params));
              elapsed(send.admittedAt);
            } else if (allowInvoicePreparation && invoiceSend !== null) {
              const send = invoiceSend; invoiceSend = null;
              check(method === "POST" && url.search === "" && url.pathname === send.path && headers.get("idempotency-key") === send.key &&
                headers.get("content-type") === "application/x-www-form-urlencoded" && typeof init?.body === "string" && exactHeldFormMatches(init.body, send.params) &&
                Date.now() >= send.firstStartedAt && Date.now() < send.firstStartedAt + 20 * 3600_000 && Date.now() < send.leaseUntil);
            } else if (allowActivation && activationSend !== null) {
              const send = activationSend; activationSend = null;
              check(method === "POST" && url.search === "" && url.pathname === send.path && headers.get("idempotency-key") === send.key &&
                headers.get("content-type") === "application/x-www-form-urlencoded" && typeof init?.body === "string" && exactHeldFormMatches(init.body, send.params) &&
                Date.now() >= send.firstStartedAt && Date.now() < send.firstStartedAt + 20 * 3600_000);
            } else if (allowCheckout && checkoutSend !== null) {
              const send = checkoutSend; checkoutSend = null;
              check(method === "POST" && url.search === "" && url.pathname === send.request.path && send.request.apiVersion === apiVersion &&
                headers.get("idempotency-key") === send.idempotency_key && typeof init?.body === "string" &&
                headers.get("content-type") === "application/x-www-form-urlencoded" && exactHeldFormMatches(init.body, send.request.params));
              elapsed(Date.parse(send.claimed_at));
            } else if (allowHeldBootstrap && heldSend !== null) {
              const send = heldSend; heldSend = null;
              check(method === "POST" && url.search === "" && url.pathname === send.request.path && send.request.apiVersion === apiVersion &&
                headers.get("idempotency-key") === send.idempotency_key && typeof init?.body === "string" &&
                headers.get("content-type") === "application/x-www-form-urlencoded" && exactHeldFormMatches(init.body, send.request.params));
              elapsed(Date.parse(send.claimed_at));
            } else {
              const send = customerSend; customerSend = null; // Consume BEFORE any await/transport.
              check(allowCustomerDispatch && send && method === "POST" && url.search === "" && url.pathname === "/v1/customers" &&
                headers.get("idempotency-key") === send.intent.idempotencyKey && typeof init?.body === "string" &&
                headers.get("content-type") === "application/x-www-form-urlencoded");
              elapsed(Date.parse(send.attempt.claimed_at));
              const params = [...new URLSearchParams(init.body).entries()];
              const expected = Object.entries(send.intent.request.params.metadata).map(([key, value]) => [`metadata[${key}]`, value]);
              check(params.length === expected.length && expected.every(([key, value]) =>
                params.filter(([k, v]) => k === key && v === value).length === 1));
            }
          } else {
            check(!headers.has("idempotency-key") && url.origin === databaseOrigin && headers.get("apikey") === databaseKey &&
              headers.get("authorization") === `Bearer ${databaseKey}`);
            if (method === "GET") {
              check(init?.body == null && (databaseRead(url) || customerRead(url)) && headers.get("accept-profile") === "public");
            } else {
              check(allowCustomerPlan && method === "POST" && url.search === "" &&
                headers.get("content-profile") === "public" && headers.get("content-type") === "application/json" &&
                typeof init?.body === "string");
              const binding = allowCustomerDispatch && url.pathname === customerBindPath;
              const held = allowHeldBootstrap && (url.pathname === heldClaimPath || url.pathname === heldBindPath);
              const heldBinding = held && url.pathname === heldBindPath;
              const checkout = allowCheckout && (url.pathname === checkoutClaimPath || url.pathname === checkoutBindPath || url.pathname === firstReceiptPath);
              const firstCredit = allowFirstCredit && url.pathname === firstCreditPath;
              const activation = allowActivation && [activationReadPath, activationClaimPath, activationCompletePath].includes(url.pathname);
              const invoiceRpc = allowInvoicePreparation && invoiceRpcSend !== null && url.pathname === invoiceRpcSend.path;
              const invoiceKeys = invoiceRpc ? invoiceRpcSend!.keys : [];
              const financialRpc = allowFinancialEvents && financialRpcSend !== null && url.pathname === financialRpcSend.path;
              const financialKeys = financialRpc ? financialRpcSend!.keys : [];
              const stopRpc = allowBillingStop && stopRpcSend !== null && url.pathname === stopRpcSend.path;
              const stopKeys = stopRpc ? stopRpcSend!.keys : [];
              const cardRpc = allowCardSetup && cardRpcSend !== null && url.pathname === cardRpcSend.path;
              const cardKeys = cardRpc ? cardRpcSend!.keys : [];
              const retryRpc = (allowBuyerRetry || allowBankVerification) && retryRpcSend !== null && url.pathname === retryRpcSend.path;
              const retryKeys = retryRpc ? retryRpcSend!.keys : [];
              const refundRpc = allowAdminRefund && refundRpcSend !== null && url.pathname === refundRpcSend.path;
              const refundKeys = refundRpc ? refundRpcSend!.keys : [];
              const publication = allowCheckoutPublication && url.pathname === "/rest/v1/rpc/publish_exact_context_checkout_v2";
              const checkoutBinding = checkout && url.pathname === checkoutBindPath, receipt = checkout && url.pathname === firstReceiptPath;
              check(url.pathname === customerPlanPath || (allowCustomerDispatch && url.pathname === customerClaimPath) || binding || held || checkout || firstCredit || activation || invoiceRpc || financialRpc || stopRpc || cardRpc || retryRpc || refundRpc || publication);
              if (publication) { const expected = checkoutPublication; checkoutPublication = null; check(expected !== null && init.body === expected); }
              if (refundRpc) { const expected = refundRpcSend; refundRpcSend = null; check(expected && init.body === expected.body); }
              if (retryRpc) { const expected = retryRpcSend; retryRpcSend = null; check(expected && init.body === expected.body); }
              if (cardRpc) { const expected = cardRpcSend; cardRpcSend = null; check(expected && init.body === expected.body); }
              if (invoiceRpc) { const expected = invoiceRpcSend; invoiceRpcSend = null; check(expected && init.body === expected.body); }
              if (financialRpc) { const expected = financialRpcSend; financialRpcSend = null; check(expected && init.body === expected.body); }
              if (stopRpc) { const expected = stopRpcSend; stopRpcSend = null; check(expected && init.body === expected.body); }
              if (binding) {
                const expected = customerBind; customerBind = null;
                check(expected !== null && init.body === expected);
              }
              if (heldBinding) {
                const expected = heldBind; heldBind = null; check(expected !== null && init.body === expected);
              }
              if (checkoutBinding) { const expected = checkoutBind; checkoutBind = null; check(expected !== null && init.body === expected); }
              if (receipt) { const expected = firstReceiptWrite; firstReceiptWrite = null; check(expected !== null && init.body === expected); }
              if (firstCredit) { const expected = firstCreditWrite; firstCreditWrite = null; check(expected !== null && init.body === expected); }
              if (activation) { const expected = activationWrite; activationWrite = null; check(expected !== null && init.body === expected); }
              const body = fields(JSON.parse(init.body), refundRpc ? refundKeys : retryRpc ? retryKeys : cardRpc ? cardKeys : stopRpc ? stopKeys : financialRpc ? financialKeys : invoiceRpc ? invoiceKeys : ["p_reservation_id", "p_actor_id", "p_context",
                ...(publication ? ["p_proof"] : []),
                ...(activation ? url.pathname === activationClaimPath ? ["p_payment_method_id", "p_item_id"] :
                  url.pathname === activationCompletePath ? ["p_token"] : [] : []),
                ...(checkoutBinding ? ["p_attempt_id", "p_session_id", "p_request_id"] : []), ...(receipt || firstCredit ? ["p_receipt"] : []),
                ...(held ? ["p_stage"] : []), ...(heldBinding ? ["p_step_id", "p_provider_id", "p_request_id"] : []),
                ...(binding ? ["p_attempt_id", "p_customer_id", "p_request_id", "p_customer_created"] : [])]);
              if (held) check(["product", "subscription", "hold"].includes(String(body.p_stage)));
              check(typeof body.p_reservation_id === "string" && typeof body.p_actor_id === "string");
              assertAgreementId(body.p_reservation_id); assertAgreementId(body.p_actor_id);
              // Extra binding fields are admitted only through the private
              // one-shot expected response above, never a caller's JSON object.
              validateExactPaymentContext(body.p_context, { ...staticEvidence, approvedContext: context });
            }
          }
          const response = await transport(url.href, { ...init, method, headers, redirect: "error",
            credentials: "omit", cache: "no-store", signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10_000)]) });
          check(response.status === 200 && !response.redirected && response.url === url.href &&
            /^application\/(?:json|vnd\.pgrst\.object\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""));
          return response;
        } catch { throw fail(); }
      };
    }
    const stripe = new Stripe(stripeKey, { apiVersion: apiVersion as Stripe.LatestApiVersion,
      host: "api.stripe.com", protocol: "https", port: 443, maxNetworkRetries: 0, timeout: 10_000,
      telemetry: false, httpClient: Stripe.createFetchHttpClient(restrictedFetch("stripe")) });
    const admin = createClient(databaseOrigin, databaseKey, { db: { schema: "public", retry: false, timeout: 10_000 },
      accessToken: async () => null, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: restrictedFetch("supabase") }, tracePropagation: { enabled: false } });

    async function readEvidence(): Promise<ExactPaymentContextEvidence> {
      const account = await stripe.accounts.retrieveCurrent(); // GET /v1/account, NEVER /accounts/{configured-id}
      check(own(account, "object") === "account" && own(account, "id") === context.platformAccountId);
      const balance = await stripe.balance.retrieve();
      check(own(balance, "object") === "balance" && own(balance, "livemode") === (context.mode === "live"));
      const { data, error } = await admin.rpc("read_exact_installment_context_pin_v2", {}, { get: true });
      check(!error && data);
      const pin = fields(data, ["version", "context", "status", "source"]);
      check(pin.version === "exact-context-pin-observation-v1" && pin.status === "reserved_not_issuable" &&
        pin.source === "owner_provisioned_database_pin");
      // The project ref comes from the successfully authenticated, transport-
      // checked unique endpoint, NOT from the database pin or a configurable GUC.
      const evidence: ExactPaymentContextEvidence = Object.freeze({ approvedContext: context,
        vercelEnvironment: c.vercelEnvironment as "preview" | "production", stripeSecretKeyMode: keyMode as "test" | "live",
        stripePublishableKeyMode: c.stripePublishableKeyMode as "test" | "live",
        observedPlatformAccountId: context.platformAccountId, observedSupabaseProjectRef: new URL(databaseOrigin).hostname.split(".")[0],
        configuredSupabaseUrl: databaseOrigin, configuredSiteOrigin: context.siteOrigin });
      validateExactPaymentContext(pin.context, evidence);
      return evidence;
    }
    return Object.freeze({
      async adminRefund(reservationId: string, actorId: string, ledgerId: string, action: ContextRefundAction) {
        try {
          check(allowAdminRefund); const start = Date.now();
          return await runContextAdminRefund({ reservationId, actorId, ledgerId, action, context, stripe,
            evidence: readEvidence, fresh: () => elapsed(start),
            rpc: async params => {
              check(refundRpcSend === null);
              const name = "run_exact_context_admin_refund_v2";
              refundRpcSend = { path: `/rest/v1/rpc/${name}`, body: JSON.stringify(params), keys: Object.keys(params) };
              const value = await admin.rpc(name, params); check(!value.error && value.data && refundRpcSend === null); return value.data;
            },
            get: async <T>(path: string, read: () => Promise<T>, account?: string): Promise<T> => {
              check(boundRead === null && boundAccount === null); boundRead = path; boundAccount = account ?? null;
              try { const value = await read(); check(boundRead === null && boundAccount === null); return value; }
              finally { boundRead = null; boundAccount = null; }
            },
            send: async <T>(path: string, params: object, key: string, write: () => Promise<T>): Promise<T> => {
              check(refundSend === null && (path === "/v1/refunds" || /^\/v1\/application_fees\/fee_[A-Za-z0-9]+\/refunds$/.test(path)));
              elapsed(start); refundSend = { path, params, key, admittedAt: Date.now() };
              try { const value = await write(); check(refundSend === null); return value; }
              finally { refundSend = null; }
            },
          });
        } catch { throw fail(); }
        finally { refundRpcSend = null; refundSend = null; boundRead = null; boundAccount = null; }
      },
      async bankVerification(reservationId: string, buyerId: string, invoiceId: string, action: "challenge" | "check" | "observe", publicKey: string | null, eventId: string | null) {
        try {
          check(allowBankVerification); const start = Date.now();
          return await runContextBankVerification({ reservationId, buyerId, invoiceId, action, publicKey, eventId, context, stripe, apiVersion,
            evidence: readEvidence, fresh: () => elapsed(start),
            rpc: async (name, params) => {
              check(retryRpcSend === null && ["read_exact_context_bank_v2", "run_exact_context_recovery_v2", "credit_exact_context_invoice_v2"].includes(name));
              retryRpcSend = { path: `/rest/v1/rpc/${name}`, body: JSON.stringify(params), keys: Object.keys(params) };
              const response = await admin.rpc(name, params); check(!response.error && response.data && retryRpcSend === null); return response.data;
            },
            get: async <T>(path: string, read: () => Promise<T>): Promise<T> => {
              check(boundRead === null); boundRead = path; const value = await read(); check(boundRead === null); return value;
            },
            retryReceipt: quoteId => createExactContextBuyerRetry(config, serverFetch).reconcile(reservationId, buyerId, invoiceId, quoteId),
          });
        } catch { throw fail(); }
        finally { retryRpcSend = null; boundRead = null; }
      },
      async buyerRetry(reservationId: string, buyerId: string, invoiceId: string, quoteId: string, action: "review" | "review_future" | "pay" | "reconcile", consent: unknown) {
        try {
          check(allowBuyerRetry); const start = Date.now();
          const cards = createExactContextCardSetup(config, serverFetch);
          return await runContextBuyerRetry({ reservationId, buyerId, invoiceId, quoteId, action, consent, context, stripe, apiVersion,
            evidence: readEvidence, fresh: () => elapsed(start),
            rpc: async (name, params) => {
              check(retryRpcSend === null && ["read_exact_context_buyer_retry_v2", "run_exact_context_buyer_retry_v2"].includes(name));
              retryRpcSend = { path: `/rest/v1/rpc/${name}`, body: JSON.stringify(params), keys: Object.keys(params) };
              const response = await admin.rpc(name, params); check(!response.error && response.data && retryRpcSend === null); return response.data;
            },
            get: async <T>(path: string, read: () => Promise<T>): Promise<T> => {
              check(boundRead === null); boundRead = path; const value = await read(); check(boundRead === null); return value;
            },
            verifyCard: requestId => cards.verifyCard(reservationId, buyerId, invoiceId, requestId),
            pay: async (params, key, admittedAt) => {
              check(retryPaySend === null); elapsed(start); elapsed(admittedAt);
              retryPaySend = { path: `/v1/invoices/${invoiceId}/pay`, params, key, admittedAt };
              try { await stripe.invoices.pay(invoiceId, params, { idempotencyKey: key, maxNetworkRetries: 0 }); check(retryPaySend === null); }
              finally { retryPaySend = null; }
            },
          });
        } catch { throw fail(); }
        finally { retryRpcSend = null; retryPaySend = null; boundRead = null; }
      },
      async cardSetup(reservationId: string, buyerId: string, invoiceId: string, requestId: string, action: "prepare" | "verify" | "publish", consent: unknown) {
        try {
          check(allowCardSetup); const start = Date.now();
          return await prepareContextCardSetup({ reservationId, buyerId, invoiceId, requestId, action, consent, context, stripe, apiVersion,
            evidence: readEvidence, fresh: () => elapsed(start),
            rpc: async (name, params) => {
              check(cardRpcSend === null && ["read_exact_context_card_setup_v2", "run_exact_context_card_setup_v2"].includes(name));
              cardRpcSend = { path: `/rest/v1/rpc/${name}`, body: JSON.stringify(params), keys: Object.keys(params) };
              const value = await admin.rpc(name, params); check(!value.error && value.data && cardRpcSend === null); return value.data;
            },
            get: async <T>(path: string, read: () => Promise<T>): Promise<T> => {
              check(boundRead === null); boundRead = path; const value = await read(); check(boundRead === null); return value;
            },
            create: async (params, key, startedAt) => {
              check(cardSend === null); elapsed(start); elapsed(startedAt); cardSend = { params, key, startedAt };
              const session = await stripe.checkout.sessions.create(params, { idempotencyKey: key, maxNetworkRetries: 0 });
              check(cardSend === null); return session;
            },
          });
        } catch { throw fail(); }
        finally { cardRpcSend = null; cardSend = null; boundRead = null; }
      },
      async billingStop(reservationId: string, actorId: string, requestId: string) {
        try {
          check(allowBillingStop); const start = Date.now();
          return await stopCreditedContextBilling({ reservationId, actorId, requestId, context, stripe, evidence: readEvidence,
            fresh: () => { elapsed(start); },
            rpc: async (name, params) => {
              check(stopRpcSend === null && ["read_exact_context_stop_v2", "run_exact_context_stop_v2"].includes(name));
              stopRpcSend = { path: `/rest/v1/rpc/${name}`, body: JSON.stringify(params), keys: Object.keys(params) };
              const value = await admin.rpc(name, params); check(!value.error && value.data && stopRpcSend === null); return value.data;
            },
            get: async <T>(path: string, read: () => Promise<T>): Promise<T> => {
              check(boundRead === null); boundRead = path; const value = await read(); check(boundRead === null); return value;
            },
            cancel: async (id, authorizedAt) => {
              contextStripeId(id, "sub"); check(stopSend === null); elapsed(start); elapsed(authorizedAt);
              stopSend = { path: `/v1/subscriptions/${id}`, authorizedAt };
              const sub = await stripe.subscriptions.cancel(id, { invoice_now: false, prorate: false }, { maxNetworkRetries: 0 });
              check(stopSend === null); return sub;
            },
          });
        } catch { throw fail(); }
        finally { stopRpcSend = null; stopSend = null; boundRead = null; }
      },
      async subscriptionEvent(reservationId: string, actorId: string, eventId: string) {
        try {
          check(allowFinancialEvents); const start = Date.now();
          return await observeContextSubscription({ reservationId, actorId, eventId, context, stripe, apiVersion,
            evidence: readEvidence, fresh: () => elapsed(start),
            rpc: async (name, params) => {
              check(financialRpcSend === null && ["read_exact_context_subscription_v2", "observe_exact_context_subscription_v2"].includes(name));
              financialRpcSend = { path: `/rest/v1/rpc/${name}`, body: JSON.stringify(params), keys: Object.keys(params) };
              const value = await admin.rpc(name, params); check(!value.error && value.data && financialRpcSend === null); return value.data;
            },
            get: async <T>(path: string, read: () => Promise<T>): Promise<T> => {
              check(boundRead === null); boundRead = path; const value = await read(); check(boundRead === null); return value;
            },
          });
        } catch { throw fail(); }
        finally { financialRpcSend = null; boundRead = null; }
      },
      async financialEvent(reservationId: string, actorId: string, eventId: string) {
        try {
          check(allowFinancialEvents); assertAgreementId(reservationId); assertAgreementId(actorId); contextStripeId(eventId, "evt");
          const start = Date.now(), evidence = await readEvidence();
          const { data, error } = await admin.from("exact_installment_context_reservations_v2")
            .select(selection).eq("id", reservationId).eq("terms->>creatorId", actorId).maybeSingle();
          check(!error && data);
          const r = readExactContextReservation(data, evidence); check(r.id === reservationId && r.terms.creatorId === actorId);
          const locator = inspectContextFinancialEvent(await stripe.events.retrieve(eventId), eventId, r, apiVersion);
          // Reads are one-shot, identity-bound capabilities. This surface has no
          // Stripe mutation capability, including no refund or cancel endpoint.
          async function get<T>(path: string, read: () => Promise<T>): Promise<T> {
            check(boundRead === null); boundRead = path; const value = await read(); check(boundRead === null); return value;
          }
          const charge = await get(`/v1/charges/${locator.chargeId}`, () => stripe.charges.retrieve(locator.chargeId));
          check(charge.object === "charge" && charge.id === locator.chargeId && charge.livemode === (context.mode === "live"));
          const paymentIntentId = contextStripeId(charge.payment_intent, "pi");
          check(locator.paymentIntentId === null || locator.paymentIntentId === paymentIntentId);
          const event: ContextFinancialEvent = Object.freeze({ ...locator, paymentIntentId });
          const args = { p_reservation_id: reservationId, p_actor_id: actorId, p_context: context, p_event: event };
          async function financialRpc(name: "read_exact_context_financial_event_v2" | "hold_exact_context_financial_event_v2" |
            "apply_exact_context_financial_event_v2", proof?: object) {
            const params = { ...args, ...(proof ? { p_proof: proof } : {}) };
            financialRpcSend = { path: `/rest/v1/rpc/${name}`, body: JSON.stringify(params), keys: Object.keys(params) };
            const value = await admin.rpc(name, params); check(!value.error && value.data && financialRpcSend === null); return value.data;
          }
          const state = readContextFinancialState(await financialRpc("read_exact_context_financial_event_v2"), r, event);
          check(contextStripeId(charge.customer, "cus") === state.customerId);
          const summary = (status: string) => Object.freeze({ version: "exact-context-financial-event-result-v1" as const,
            reservationId, eventId, status, providerOperationsAllowed: false as const, collectionAllowed: false as const, publicationAllowed: false as const });
          async function hold() {
            await readEvidence(); elapsed(start);
            check(await financialRpc("hold_exact_context_financial_event_v2") === "held");
          }
          // Disputes may arrive before a dispatched payment is credited: hold
          // that admitted payment now, but never manufacture its receipt.
          if (event.kind === "dispute") await hold();
          if (!state.receipt) return summary("reconciliation_required");
          const receipt = state.receipt;
          const capture = await inspectExactRefundCapture({
            paymentIntents: { retrieve: async id => { check(id === paymentIntentId); return get(`/v1/payment_intents/${id}`, () => stripe.paymentIntents.retrieve(id)); } },
            charges: { retrieve: async id => { check(id === event.chargeId); return get(`/v1/charges/${id}`, () => stripe.charges.retrieve(id)); } },
            balanceTransactions: { retrieve: async id => { check(id === receipt.balanceTransactionId); return get(`/v1/balance_transactions/${id}`, () => stripe.balanceTransactions.retrieve(id)); } },
          }, { paymentIntentId, chargeId: event.chargeId, customerId: state.customerId, destinationId: r.terms.destinationId,
            expectedLiveMode: context.mode === "live", receipt });
          let proof: object;
          if (event.kind === "refund") {
            await hold(); // Keep collection held even if current refund reads fail.
            if (event.type !== "charge.refunded") {
              const refund = await get(`/v1/refunds/${event.objectId}`, () => stripe.refunds.retrieve(event.objectId));
              check(refund.object === "refund" && refund.id === event.objectId && refund.currency === "usd" &&
                contextStripeId(refund.charge, "ch") === event.chargeId && contextStripeId(refund.payment_intent, "pi") === paymentIntentId);
            }
            const totals = await inspectExactRefundTotals({ refunds: { list: async params => {
              check(params.charge === event.chargeId && params.limit === 100 && !params.ending_before);
              const query = new URLSearchParams({ charge: event.chargeId, limit: "100" });
              if (params.starting_after) query.set("starting_after", contextStripeId(params.starting_after, "re"));
              return get(`/v1/refunds?${query}`, () => stripe.refunds.list(params));
            } } }, capture);
            if (totals.uncertain || totals.confirmed === 0 || totals.confirmed !== capture.refundedAmountCents) return summary("reconciliation_required");
            proof = { refundedAmountCents: totals.confirmed, succeeded: totals.succeeded };
          } else {
            const dispute = await get(`/v1/disputes/${event.objectId}`, () => stripe.disputes.retrieve(event.objectId));
            check(dispute.object === "dispute" && dispute.id === event.objectId && dispute.livemode === (context.mode === "live") &&
              dispute.currency === "usd" && contextStripeId(dispute.charge, "ch") === event.chargeId &&
              (dispute.payment_intent === null || contextStripeId(dispute.payment_intent, "pi") === paymentIntentId) &&
              Number.isSafeInteger(dispute.amount) && dispute.amount > 0 && dispute.amount <= 99999999 &&
              ["warning_needs_response", "warning_under_review", "warning_closed", "needs_response", "under_review", "won", "lost", "prevented"].includes(dispute.status));
            check(state.lifecycle); proof = { read: state.lifecycle, amount: dispute.amount, status: dispute.status };
          }
          await readEvidence(); elapsed(start);
          const result = fields(await financialRpc("apply_exact_context_financial_event_v2", proof), ["reservation_id", "event_id", "status"]);
          check(result.reservation_id === reservationId && result.event_id === eventId && typeof result.status === "string" &&
            ["refund_reconciled", "lifecycle_observed", "lifecycle_review_recorded", "reconciliation_required"].includes(result.status));
          return summary(result.status);
        } catch { throw fail(); }
        finally { financialRpcSend = null; boundRead = null; }
      },
      async observeContext(): Promise<ExactRuntimeContextObservation> {
        try {
          const start = Date.now();
          const evidence = await readEvidence();
          const observation: ExactRuntimeContextObservation = Object.freeze({ version: "exact-context-runtime-observation-v1",
            context, contextEvidence: evidence, databaseIdentity: "authenticated_project_api_endpoint",
            startedAtMilliseconds: start, observedAtMilliseconds: elapsed(start),
            providerOperationsAllowed: false, accountingOperationsAllowed: false });
          observations.add(observation);
          return observation;
        } catch { throw fail(); }
      },
      async inspectEvent(reservationId: string, actorId: string, eventId: string) {
        try {
          // actorId must already be authenticated by future server composition;
          // it is never taken from event metadata or used to choose an account.
          assertAgreementId(reservationId); assertAgreementId(actorId);
          check(typeof eventId === "string" && /^evt_[A-Za-z0-9]{1,196}$/.test(eventId));
          const start = Date.now(), evidence = await readEvidence();
          const { data, error } = await admin.from("exact_installment_context_reservations_v2")
            .select(selection).eq("id", reservationId).eq("terms->>creatorId", actorId).maybeSingle();
          check(!error && data);
          const row = readExactContextReservation(data, evidence);
          check(row.id === reservationId && row.terms.creatorId === actorId);
          const event = await stripe.events.retrieve(eventId);
          const after = await readEvidence();
          elapsed(start);
          return inspectContextReservationEvent({ reservationRow: data, contextEvidence: after, eventId,
            expectedApiVersion: apiVersion, event });
        } catch { throw fail(); }
      },
      async planCustomer(reservationId: string, actorId: string) {
        try {
          check(allowCustomerPlan);
          assertAgreementId(reservationId); assertAgreementId(actorId);
          const start = Date.now(), evidence = await readEvidence();
          const { data: reservationRow, error: readError } = await admin.from("exact_installment_context_reservations_v2")
            .select(selection).eq("id", reservationId).eq("terms->>creatorId", actorId).maybeSingle();
          check(!readError && reservationRow);
          const saved = readExactContextReservation(reservationRow, evidence);
          check(saved.id === reservationId && saved.terms.creatorId === actorId);
          const planned = buildExactContextCustomerPlan({ reservationRow, contextEvidence: evidence, actorId });
          check(planned.request.apiVersion === apiVersion);
          elapsed(start);
          const { data: intentRow, error } = await admin.rpc("plan_exact_customer_operation_v2", {
            p_reservation_id: reservationId, p_actor_id: actorId, p_context: context,
          }).single();
          check(!error && intentRow);
          const after = await readEvidence();
          elapsed(start);
          return readExactContextCustomerIntent({ intentRow, reservationRow, contextEvidence: after, actorId });
        } catch {
          // The immutable plan may already have committed if its response was
          // lost. Never retry here or infer that no record exists. A later owned
          // read/exact-repeat can reconcile it; no Stripe dispatch has occurred.
          throw fail();
        }
      },
      async readCustomerPlan(reservationId: string, actorId: string) {
        try {
          check(allowCustomerPlan);
          assertAgreementId(reservationId); assertAgreementId(actorId);
          const start = Date.now(), evidence = await readEvidence();
          const { data: reservationRow, error: readError } = await admin.from("exact_installment_context_reservations_v2")
            .select(selection).eq("id", reservationId).eq("terms->>creatorId", actorId).maybeSingle();
          check(!readError && reservationRow);
          const saved = readExactContextReservation(reservationRow, evidence);
          check(saved.id === reservationId && saved.terms.creatorId === actorId);
          const expected = buildExactContextCustomerPlan({ reservationRow, contextEvidence: evidence, actorId });
          check(expected.request.apiVersion === apiVersion);
          elapsed(start);
          // GET RPC serializes arguments as strings in the installed SDK. Pass
          // JSON bytes explicitly so PostgREST decodes a jsonb context, not the
          // JavaScript string '[object Object]'. Reservation identity is known
          // even when the generated operation ID's response was lost.
          const { data: intentRow, error } = await admin.rpc("read_exact_customer_operation_v2", {
            p_reservation_id: reservationId, p_actor_id: actorId, p_context: JSON.stringify(context),
          }, { get: true }).single();
          check(!error && intentRow);
          const after = await readEvidence();
          elapsed(start);
          return readExactContextCustomerIntent({ intentRow, reservationRow, contextEvidence: after, actorId });
        } catch {
          // Missing or unreadable is never proof that a new provider request is
          // safe. This diagnostic method cannot write even a new database plan.
          throw fail();
        }
      },
      async customerResult(reservationId: string, actorId: string, create: boolean) {
        try {
          check(allowCustomerDispatch);
          assertAgreementId(reservationId); assertAgreementId(actorId);
          const start = Date.now(), evidence = await readEvidence();
          const { data: reservationRow, error: rowError } = await admin.from("exact_installment_context_reservations_v2")
            .select(selection).eq("id", reservationId).eq("terms->>creatorId", actorId).maybeSingle();
          check(!rowError && reservationRow);
          const owned = readExactContextReservation(reservationRow, evidence);
          check(owned.id === reservationId && owned.terms.creatorId === actorId);
          const { data: intentRow, error: intentError } = await admin.rpc("read_exact_customer_operation_v2", {
            p_reservation_id: reservationId, p_actor_id: actorId, p_context: JSON.stringify(context),
          }, { get: true }).single();
          check(!intentError && intentRow);
          const intent = readExactContextCustomerIntent({ intentRow, reservationRow, contextEvidence: evidence, actorId });
          check(intent.request.apiVersion === apiVersion);
          elapsed(start);
          const args = { p_reservation_id: reservationId, p_actor_id: actorId, p_context: context };
          const result = create
            ? await admin.rpc("claim_exact_customer_dispatch_v2", args)
            : await admin.rpc("read_exact_customer_dispatch_v2", { ...args, p_context: JSON.stringify(context) }, { get: true });
          check(!result.error && result.data);
          let dispatch = readCustomerDispatch(result.data, intent);
          check(create || !dispatch.claimed);
          await readEvidence(); elapsed(start);
          if (create && dispatch.claimed) {
            check(dispatch.attempt);
            elapsed(Date.parse(dispatch.attempt.claimed_at));
            // No caller-supplied provider fields, SDK auto-retries, or second
            // send after ambiguity. The durable claim is never recycled.
            customerSend = { intent, attempt: dispatch.attempt };
            const customer = await stripe.customers.create(intent.request.params, { idempotencyKey: intent.idempotencyKey });
            check(customerSend === null);
            check(own(customer, "object") === "customer" && (customer.deleted as unknown) !== true &&
              typeof customer.id === "string" && /^cus_[A-Za-z0-9]{1,196}$/.test(customer.id) &&
              customer.livemode === (context.mode === "live") && customer.balance === 0 && customer.email === null &&
              customer.default_source === null && customer.invoice_settings?.default_payment_method === null &&
              customer.test_clock === null && customer.delinquent === false &&
              Number.isSafeInteger(customer.created) && customer.created >= Math.floor(Date.parse(dispatch.attempt.claimed_at) / 1000) &&
              customer.created <= Math.floor(Date.now() / 1000));
            const metadata = fields(customer.metadata, Object.keys(intent.request.params.metadata));
            for (const [key, value] of Object.entries(intent.request.params.metadata)) check(metadata[key] === value);
            const requestId = customer.lastResponse?.requestId;
            check(typeof requestId === "string" && /^req_[A-Za-z0-9]{1,196}$/.test(requestId));
            // Re-observe identities after Stripe, before recording its result.
            // Identity uncertainty retains the attempt, never sends a new one.
            await readEvidence(); elapsed(start);
            const bindArgs = { ...args, p_attempt_id: dispatch.attempt.id, p_customer_id: customer.id,
              p_request_id: requestId, p_customer_created: customer.created };
            customerBind = JSON.stringify(bindArgs);
            const saved = await admin.rpc("bind_exact_customer_dispatch_v2", bindArgs);
            check(!saved.error && saved.data && customerBind === null);
            const bound = readCustomerDispatch(saved.data, intent);
            check(!bound.claimed && bound.attempt?.id === dispatch.attempt.id &&
              bound.binding?.customer_id === customer.id && bound.binding.request_id === requestId &&
              bound.binding.customer_created === customer.created);
            dispatch = bound;
            await readEvidence(); elapsed(start);
          }
          return Object.freeze({ version: "exact-context-customer-result-v1" as const,
            reservationId, context, operationId: intent.id, attemptId: dispatch.attempt?.id ?? null,
            status: dispatch.binding ? "customer_bound" as const : dispatch.attempt ? "review_required" as const : "not_attempted" as const,
            customerId: dispatch.binding?.customer_id ?? null, requestId: dispatch.binding?.request_id ?? null,
            replayAllowed: false as const, accountingOperationsAllowed: false as const });
        } catch { throw fail(); }
        finally { customerSend = null; customerBind = null; }
      },
      async heldPreparation(reservationId: string, actorId: string, create: boolean) {
        try {
          check(allowHeldBootstrap);
          assertAgreementId(reservationId); assertAgreementId(actorId);
          const start = Date.now(), evidence = await readEvidence();
          const { data: reservationRow, error: rowError } = await admin.from("exact_installment_context_reservations_v2")
            .select(selection).eq("id", reservationId).eq("terms->>creatorId", actorId).maybeSingle();
          check(!rowError && reservationRow);
          const r = readExactContextReservation(reservationRow, evidence);
          check(r.id === reservationId && r.terms.creatorId === actorId);
          const args = { p_reservation_id: reservationId, p_actor_id: actorId, p_context: context };
          const readArgs = { ...args, p_context: JSON.stringify(context) };
          const savedIntent = await admin.rpc("read_exact_customer_operation_v2", readArgs, { get: true }).single();
          check(!savedIntent.error && savedIntent.data);
          const intent = readExactContextCustomerIntent({ intentRow: savedIntent.data, reservationRow, contextEvidence: evidence, actorId });
          check(intent.request.apiVersion === apiVersion);
          const savedCustomer = await admin.rpc("read_exact_customer_dispatch_v2", readArgs, { get: true });
          check(!savedCustomer.error && savedCustomer.data);
          const customer = readCustomerDispatch(savedCustomer.data, intent);
          check(!customer.claimed && customer.binding);
          const deps: { -readonly [K in keyof HeldBootstrapDependencies]: HeldBootstrapDependencies[K] } = {
            customerId: customer.binding.customer_id, productId: null, subscriptionId: null };
          const summary = (status: "not_attempted" | "review_required" | "held_unpublished", stage: HeldBootstrapStage) => Object.freeze({
            version: "exact-context-held-preparation-v1" as const, reservationId, context, status, stage,
            customerId: deps.customerId, productId: deps.productId, subscriptionId: deps.subscriptionId,
            checkoutPublicationAllowed: false as const, accountingOperationsAllowed: false as const, replayAllowed: false as const });
          async function freshCustomer() {
            boundRead = `/v1/customers/${deps.customerId}`;
            const value = await stripe.customers.retrieve(deps.customerId);
            check(boundRead === null); assertContextBootstrapCustomer(value, intent, deps.customerId);
          }
          async function freshObject(attempt: HeldBootstrapAttempt, providerId: string, hold: boolean | null) {
            boundRead = attempt.stage === "product" ? `/v1/products/${providerId}` : `/v1/subscriptions/${providerId}`;
            const value = attempt.stage === "product" ? await stripe.products.retrieve(providerId) : await stripe.subscriptions.retrieve(providerId);
            check(boundRead === null); assertContextHeldObject(value, r, intent, attempt, deps, providerId, hold);
            return value;
          }
          await freshCustomer(); await readEvidence(); elapsed(start);
          let productAttempt: HeldBootstrapAttempt | null = null, subscriptionAttempt: HeldBootstrapAttempt | null = null;
          for (const stage of ["product", "subscription", "hold"] as const) {
            const stepStart = Date.now();
            const existing = await admin.rpc("read_exact_held_step_v2", { ...readArgs, p_stage: stage }, { get: true });
            check(!existing.error && existing.data);
            let dispatch = readContextHeldDispatch(existing.data, r, intent, stage, deps);
            check(!dispatch.claimed);
            if (!dispatch.attempt && create) {
              // Dependencies are freshly checked before a new claim. The DB
              // independently derives the whole request and rechecks admission.
              await freshCustomer();
              if (productAttempt && deps.productId) await freshObject(productAttempt, deps.productId, false);
              if (subscriptionAttempt && deps.subscriptionId) await freshObject(subscriptionAttempt, deps.subscriptionId, false);
              await readEvidence(); elapsed(stepStart);
              const claimed = await admin.rpc("claim_exact_held_step_v2", { ...args, p_stage: stage });
              check(!claimed.error && claimed.data);
              dispatch = readContextHeldDispatch(claimed.data, r, intent, stage, deps);
            }
            if (!dispatch.attempt) return summary("not_attempted", stage);
            if (productAttempt) check(dispatch.attempt.anchor_seconds === productAttempt.anchor_seconds);
            if (dispatch.claimed) {
              const attempt = dispatch.attempt;
              await readEvidence(); elapsed(stepStart); elapsed(Date.parse(attempt.claimed_at));
              heldSend = attempt;
              const opts = { idempotencyKey: attempt.idempotency_key };
              const result = stage === "product"
                ? await stripe.products.create(attempt.request.params as Stripe.ProductCreateParams, opts)
                : stage === "subscription"
                  ? await stripe.subscriptions.create(attempt.request.params as Stripe.SubscriptionCreateParams, opts)
                  : await stripe.subscriptions.update(deps.subscriptionId!, attempt.request.params as Stripe.SubscriptionUpdateParams, opts);
              check(heldSend === null);
              assertContextHeldObject(result, r, intent, attempt, deps, stage === "hold" ? deps.subscriptionId : null, stage === "hold");
              const requestId = result.lastResponse?.requestId;
              check(typeof requestId === "string" && /^req_[A-Za-z0-9]{1,196}$/.test(requestId));
              await readEvidence(); elapsed(stepStart);
              const bindArgs = { ...args, p_stage: stage, p_step_id: attempt.id, p_provider_id: result.id, p_request_id: requestId };
              heldBind = JSON.stringify(bindArgs);
              const saved = await admin.rpc("bind_exact_held_step_v2", bindArgs);
              check(!saved.error && saved.data && heldBind === null);
              const bound = readContextHeldDispatch(saved.data, r, intent, stage, deps);
              check(!bound.claimed && bound.attempt?.id === attempt.id && bound.binding?.provider_id === result.id && bound.binding.request_id === requestId);
              dispatch = bound;
            }
            if (!dispatch.binding) return summary("review_required", stage);
            check(dispatch.attempt);
            // Creation remains a creation record after the subsequent hold. Its
            // known object may now be held; the final hold stage validates that
            // state separately and an unbound hold still requires review.
            await freshObject(dispatch.attempt, dispatch.binding.provider_id, stage === "hold" ? true : stage === "subscription" ? null : false);
            await readEvidence(); elapsed(stepStart);
            if (stage === "product") { deps.productId = dispatch.binding.provider_id; productAttempt = dispatch.attempt; }
            if (stage === "subscription") { deps.subscriptionId = dispatch.binding.provider_id; subscriptionAttempt = dispatch.attempt; }
          }
          // No URL or financial capability is returned, even with all three
          // identities durably saved and an indefinite hold freshly verified.
          const finalStart = Date.now(); await freshCustomer(); await readEvidence(); elapsed(finalStart);
          return summary("held_unpublished", "hold");
        } catch { throw fail(); }
        finally { heldSend = null; heldBind = null; boundRead = null; }
      },
      async contextCheckout(reservationId: string, actorId: string, action: "prepare" | "publish" | "inspect_payment" | "inspect_unpaid" | "record_payment" | "credit_payment" | "activate" | "prepare_invoice" | "collect_invoice" | "reconcile_invoice" | "recover_invoice" | "inspect_bootstrap_invoice", invoiceId?: string, eventId?: string) {
        try {
          check(allowCheckout && (action !== "credit_payment" || allowFirstCredit) && (action !== "activate" || allowActivation) &&
            (action !== "publish" || allowCheckoutPublication) &&
            (action !== "prepare_invoice" || allowInvoicePreparation) &&
            (!["collect_invoice", "reconcile_invoice"].includes(action) || allowInvoiceCollection) &&
            (action !== "recover_invoice" || allowPaymentRecovery));
          assertAgreementId(reservationId); assertAgreementId(actorId);
          const start = Date.now(), evidence = await readEvidence();
          const { data: reservationRow, error: rowError } = await admin.from("exact_installment_context_reservations_v2")
            .select(selection).eq("id", reservationId).eq("terms->>creatorId", actorId).maybeSingle();
          check(!rowError && reservationRow);
          const r = readExactContextReservation(reservationRow, evidence);
          check(r.id === reservationId && r.terms.creatorId === actorId);
          const args = { p_reservation_id: reservationId, p_actor_id: actorId, p_context: context };
          const readArgs = { ...args, p_context: JSON.stringify(context) };
          const intentResult = await admin.rpc("read_exact_customer_operation_v2", readArgs, { get: true }).single();
          check(!intentResult.error && intentResult.data);
          const intent = readExactContextCustomerIntent({ intentRow: intentResult.data, reservationRow, contextEvidence: evidence, actorId });
          check(intent.request.apiVersion === apiVersion);
          const customerResult = await admin.rpc("read_exact_customer_dispatch_v2", readArgs, { get: true });
          check(!customerResult.error && customerResult.data);
          const customer = readCustomerDispatch(customerResult.data, intent); check(!customer.claimed && customer.binding);
          const deps: { customerId: string; productId: string | null; subscriptionId: string | null; anchor: number } = {
            customerId: customer.binding.customer_id, productId: null, subscriptionId: null, anchor: 0 };
          let productAttempt: HeldBootstrapAttempt | null = null, holdAttempt: HeldBootstrapAttempt | null = null;
          for (const stage of ["product", "subscription", "hold"] as const) {
            const result = await admin.rpc("read_exact_held_step_v2", { ...readArgs, p_stage: stage }, { get: true });
            check(!result.error && result.data);
            const saved = readContextHeldDispatch(result.data, r, intent, stage, deps);
            check(!saved.claimed && saved.attempt && saved.binding);
            if (stage === "product") { deps.productId = saved.binding.provider_id; deps.anchor = saved.attempt.anchor_seconds; productAttempt = saved.attempt; }
            else check(saved.attempt.anchor_seconds === deps.anchor);
            if (stage === "subscription") deps.subscriptionId = saved.binding.provider_id;
            if (stage === "hold") { check(saved.binding.provider_id === deps.subscriptionId); holdAttempt = saved.attempt; }
          }
          check(deps.subscriptionId && productAttempt && holdAttempt);
          if (action === "inspect_bootstrap_invoice") {
            check(deps.productId); const id = contextStripeId(invoiceId, "in");
            check(boundRead === null); boundRead = `/v1/invoices/${id}`;
            const invoice = await stripe.invoices.retrieve(id); check(boundRead === null && invoice.id === id);
            if (invoice.billing_reason !== "subscription_create") return { status: "not_bootstrap" as const };
            assertContextBootstrapInvoices({ object: "list", has_more: false, url: "/v1/invoices", data: [invoice] }, r,
              { ...deps, productId: deps.productId, subscriptionId: deps.subscriptionId });
            check(!invoice.total_taxes?.length && invoice.amount_remaining === 0);
            await readEvidence(); elapsed(start); return { status: "bootstrap_zero" as const };
          }
          if (["prepare_invoice", "collect_invoice", "reconcile_invoice", "recover_invoice"].includes(action)) {
            check(deps.productId); const inId = contextStripeId(invoiceId, "in");
            const invoiceDeps = { ...deps, productId: deps.productId, subscriptionId: deps.subscriptionId };
            const invoiceArgs = { ...args, p_invoice_id: inId };
            async function invoiceRpc(name: "read_exact_context_invoice_v2" | "claim_exact_context_invoice_v2" |
              "assert_exact_context_invoice_preparation_v2" | "bind_exact_context_invoice_preparation_v2" |
              "read_exact_context_invoice_collection_v2" | "admit_exact_context_invoice_dispatch_v2" | "credit_exact_context_invoice_v2" |
              "run_exact_context_recovery_v2", extra: Record<string, unknown> = {}) {
              check(!["read_exact_context_invoice_collection_v2", "credit_exact_context_invoice_v2"].includes(name) || allowInvoiceCollection || allowPaymentRecovery);
              check(name !== "admit_exact_context_invoice_dispatch_v2" || allowInvoiceCollection);
              check(name !== "run_exact_context_recovery_v2" || allowPaymentRecovery);
              const parameters = { ...invoiceArgs, ...extra };
              invoiceRpcSend = { path: `/rest/v1/rpc/${name}`, body: JSON.stringify(parameters), keys: Object.keys(parameters) };
              const value = await admin.rpc(name, parameters); check(!value.error && value.data && invoiceRpcSend === null);
              return value.data as unknown;
            }
            async function collectionRead() {
              return readContextInvoiceCollection(await invoiceRpc("read_exact_context_invoice_collection_v2"), r, invoiceDeps, inId);
            }
            const collection = action === "prepare_invoice" ? null : await collectionRead();
            const saved = collection?.state ?? readContextInvoiceState(await invoiceRpc("read_exact_context_invoice_v2"), r, inId);
            let recoveryEvent: Record<string, unknown> | null = null, recoveryRead: RecoveryRead | null = null, retryAdmitted = false;
            async function recoveryOperation(phase: "begin" | "finish", snapshot: RecoveryRead | null = null,
              outcome: RecoveryOutcome | null = null, proof: RecoveryEvidence | null = null) {
              check(recoveryEvent);
              const value = fields(await invoiceRpc("run_exact_context_recovery_v2", { p_event: recoveryEvent,
                p_phase: phase, p_read: snapshot, p_outcome: outcome, p_evidence: proof }), ["read", "retryAdmitted", "saved"]);
              check(typeof value.retryAdmitted === "boolean" && typeof value.saved === "boolean");
              return { read: value.read === null ? null : parseExactRecoveryRead(value.read), retryAdmitted: value.retryAdmitted, saved: value.saved };
            }
            if (action === "recover_invoice") {
              check(collection?.authorization && saved.claim && ["dispatching", "paid"].includes(saved.claim.status));
              const evId = contextStripeId(eventId, "evt"); boundRead = `/v1/events/${evId}`;
              const event = await stripe.events.retrieve(evId); check(boundRead === null);
              check(event.object === "event" && event.id === evId && isSupportedStripeSnapshotVersion(event.api_version, apiVersion) && event.livemode === (r.context.mode === "live") &&
                ["invoice.payment_failed", "invoice.payment_action_required", "invoice.voided", "invoice.marked_uncollectible", "invoice.paid", "invoice.payment_succeeded"].includes(event.type) &&
                Number.isSafeInteger(event.created) && event.created > 0 && event.created <= Math.floor(Date.now() / 1000));
              const eventInvoice = event.data.object as Stripe.Invoice;
              check(eventInvoice.object === "invoice" && eventInvoice.id === inId && eventInvoice.livemode === event.livemode &&
                contextStripeId(eventInvoice.customer, "cus") === deps.customerId &&
                contextStripeId(eventInvoice.parent?.subscription_details?.subscription, "sub") === deps.subscriptionId);
              recoveryEvent = { id: evId, type: event.type, invoiceId: inId, customerId: deps.customerId,
                subscriptionId: deps.subscriptionId, created: event.created, livemode: event.livemode };
              // Persist the original 049 hold before reading current invoice/PI.
              const started = await recoveryOperation("begin"); recoveryRead = started.read; retryAdmitted = started.retryAdmitted;
              if (recoveryRead) check(recoveryRead.paymentIntentId === saved.claim.paymentIntentId && recoveryRead.subscriptionId === deps.subscriptionId &&
                recoveryRead.periodStart === collection.authorization.periodStart && recoveryRead.periodEnd === collection.authorization.periodEnd &&
                recoveryRead.dispatchStartedAt === Math.floor(saved.claim.dispatchStartedAt! / 1000));
            }
            boundRead = `/v1/invoices/${inId}`;
            const invoice = await stripe.invoices.retrieve(inId); check(boundRead === null);
            const period = contextInvoicePeriod(invoice, r, invoiceDeps, saved, inId);
            await readEvidence(); elapsed(start);
            const summary = (status: "busy" | "reconciliation_required" | "prepared_unpaid" | "credited" | "already_credited", agreementStatus?: string) => Object.freeze({
              version: action === "prepare_invoice" ? "exact-context-invoice-preparation-result-v1" as const : "exact-context-invoice-collection-result-v1" as const,
              reservationId, context, invoiceId: inId,
              paymentNumber: period.paymentNumber, status, ...(agreementStatus ? { agreementStatus } : {}), collectionAllowed: false as const, publicationAllowed: false as const });
            // Read only identities linked from this owned admission. The helper
            // rechecks provider money and capture; no event payload is a receipt.
            async function reconcile(current: NonNullable<typeof collection>) {
              const a = current.authorization, claim = current.state.claim;
              check(a && claim && ["dispatching", "paid"].includes(claim.status) && claim.paymentIntentId && claim.dispatchStartedAt !== null && a.paymentNumber === period.paymentNumber);
              const expectedPI = claim.paymentIntentId, receiptStart = Date.now();
              let chargeId: string | null = null, balanceId: string | null = null;
              const contract = contextInvoiceContract(r, intent, invoiceDeps, current.state, a);
              const receipt = await inspectPaidRenewal({
                invoices: { retrieve: async id => { check(id === inId); boundRead = `/v1/invoices/${id}`;
                  const value = await stripe.invoices.retrieve(id); check(boundRead === null); return value; } },
                invoicePayments: { list: async p => { check(isDeepStrictEqual(p, { invoice: inId, limit: 100 }));
                  boundRead = `/v1/invoice_payments?invoice=${inId}&limit=100`;
                  const value = await stripe.invoicePayments.list(p); check(boundRead === null); return value; } },
                paymentIntents: { retrieve: async id => { check(id === expectedPI); boundRead = `/v1/payment_intents/${id}`;
                  const value = await stripe.paymentIntents.retrieve(id); check(boundRead === null);
                  chargeId = contextStripeId(value.latest_charge, "ch"); return value; } },
                charges: { retrieve: async id => { check(id === chargeId); boundRead = `/v1/charges/${id}`;
                  const value = await stripe.charges.retrieve(id); check(boundRead === null);
                  balanceId = contextStripeId(value.balance_transaction, "txn"); return value; } },
                balanceTransactions: { retrieve: async id => { check(id === balanceId); boundRead = `/v1/balance_transactions/${id}`;
                  const value = await stripe.balanceTransactions.retrieve(id); check(boundRead === null); return value; } },
              }, a, expectedPI, { ...contract, now: () => Math.floor(Date.now() / 1000), minimumChargeCreatedAt: Math.floor(claim.dispatchStartedAt / 1000) });
              if (!receipt) return summary("reconciliation_required");
              const fresh = await collectionRead();
              check(isDeepStrictEqual(fresh.authorization, a) && fresh.state.claim?.paymentIntentId === expectedPI &&
                fresh.state.claim.token === claim.token && fresh.state.claim.dispatchStartedAt === claim.dispatchStartedAt);
              await readEvidence(); elapsed(receiptStart);
              const credited = fields(await invoiceRpc("credit_exact_context_invoice_v2", { p_receipt: receipt }),
                ["reservation_id", "invoice_id", "payment_number", "credited", "agreement_status"]);
              check(credited.reservation_id === r.id && credited.invoice_id === inId && credited.payment_number === a.paymentNumber &&
                typeof credited.credited === "boolean" && typeof credited.agreement_status === "string");
              return summary(credited.credited ? "credited" : "already_credited", credited.agreement_status);
            }
            if (action === "recover_invoice") {
              check(collection?.authorization && saved.claim?.paymentIntentId);
              // A separately admitted replacement must use its own receipt path;
              // never misclassify it against the original card or grant a retry.
              if (retryAdmitted) return createExactContextBankVerification(config, serverFetch)
                .observeInvoice(reservationId, r.terms.buyerId, inId, eventId!);
              const recoveryResult = (outcome: RecoveryOutcome) => Object.freeze({ ...summary("reconciliation_required"),
                version: "exact-context-payment-recovery-result-v1" as const, status: "payment_recovery_recorded" as const, outcome });
              if (invoice.status === "paid") {
                const result = await reconcile(collection);
                if (!recoveryRead || !["credited", "already_credited"].includes(result.status)) return result;
                const refreshed = await recoveryOperation("begin"); check(refreshed.read && !refreshed.retryAdmitted);
                await readEvidence();
                const completed = await recoveryOperation("finish", refreshed.read, "paid_accounted", { invoiceStatus: "paid", paymentStatus: "succeeded",
                  amountReceived: invoice.amount_paid, amountCapturable: 0, canceledAt: null, voidedAt: null });
                return completed.saved ? recoveryResult("paid_accounted") : summary("reconciliation_required");
              }
              check(recoveryRead);
              const expectedPI = saved.claim.paymentIntentId; let failedCharge: string | null = null;
              const observed = await inspectUnpaidExactRecovery({
                invoicePayments: { list: async p => { check(isDeepStrictEqual(p, { invoice: inId, limit: 100 }));
                  boundRead = `/v1/invoice_payments?invoice=${inId}&limit=100`;
                  const value = await stripe.invoicePayments.list(p); check(boundRead === null); return value; } },
                paymentIntents: { retrieve: async id => { check(id === expectedPI); boundRead = `/v1/payment_intents/${id}`;
                  const value = await stripe.paymentIntents.retrieve(id); check(boundRead === null);
                  failedCharge = value.latest_charge == null ? null : contextStripeId(value.latest_charge, "ch"); return value; } },
                charges: { retrieve: async id => { check(id === failedCharge); boundRead = `/v1/charges/${id}`;
                  const value = await stripe.charges.retrieve(id); check(boundRead === null); return value; } },
              }, invoice, collection.authorization, recoveryRead, collection.authorization.paymentMethodId,
              contextInvoiceContract(r, intent, invoiceDeps, collection.state, collection.authorization));
              await readEvidence(); elapsed(start);
              const completed = await recoveryOperation("finish", recoveryRead, observed.outcome, observed.evidence);
              return completed.saved ? recoveryResult(observed.outcome) : summary("reconciliation_required");
            }
            if (collection && saved.claim && ["dispatching", "paid"].includes(saved.claim.status)) return await reconcile(collection);
            if (action === "reconcile_invoice") return summary("reconciliation_required");
            const claimed = fields(await invoiceRpc("claim_exact_context_invoice_v2", { p_subscription_id: deps.subscriptionId,
              p_period_start: period.start, p_period_end: period.end }), ["claim", "state"]);
            const claimStatus = own(claimed.claim, "status");
            if (claimStatus === "busy") return summary("busy");
            if (claimStatus === "reconcile") return action === "collect_invoice" ? await reconcile(await collectionRead()) : summary("reconciliation_required");
            check(claimStatus === "prepare");
            const state = readContextInvoiceState(claimed.state, r, inId); check(state.claim && state.claim.number === period.paymentNumber);
            const authorization = contextInvoiceAuthorization(own(claimed.claim, "authorization"), r, invoiceDeps, state, inId, period);
            const contract = contextInvoiceContract(r, intent, invoiceDeps, state, authorization);
            const requests = heldInvoicePreparationRequests(authorization, contract), token = state.claim.token;
            async function ready() {
              const fresh = readContextInvoiceState(await invoiceRpc("assert_exact_context_invoice_preparation_v2", { p_token: token }), r, inId);
              check(fresh.claim?.token === token && fresh.claim.number === period.paymentNumber && ["preparing", "prepared"].includes(fresh.claim.status));
              await readEvidence(); elapsed(start); return fresh.claim;
            }
            async function beforePost(id: string, params: object, options: Stripe.RequestOptions | undefined,
              step: "adjustment" | "configure" | "finalize") {
              const suffix = step === "adjustment" ? ":final-cent" : `:${step}`;
              const key = `${contract.idempotencyPrefix}${suffix}`;
              check(id === inId && isDeepStrictEqual(params, requests[step]) && isDeepStrictEqual(options, { idempotencyKey: key }));
              const claim = await ready();
              invoiceSend = { path: `/v1/invoices/${inId}${step === "adjustment" ? "/add_lines" : step === "finalize" ? "/finalize" : ""}`,
                key, params: requests[step], firstStartedAt: claim.firstStartedAt, leaseUntil: claim.leaseUntil };
            }
            let linkedPaymentId: string | null = null;
            const scoped = {
              subscriptions: { retrieve: async (id: string) => {
                check(id === deps.subscriptionId); boundRead = `/v1/subscriptions/${id}`;
                const s = await stripe.subscriptions.retrieve(id); check(boundRead === null); return s;
              } },
              invoices: {
                retrieve: async (id: string) => { check(id === inId); boundRead = `/v1/invoices/${id}`;
                  const i = await stripe.invoices.retrieve(id); check(boundRead === null); return i; },
                addLines: async (id: string, p: Stripe.InvoiceAddLinesParams, o?: Stripe.RequestOptions) => {
                  await beforePost(id, p, o, "adjustment"); const i = await stripe.invoices.addLines(id, p, o); check(invoiceSend === null); return i; },
                update: async (id: string, p?: Stripe.InvoiceUpdateParams, o?: Stripe.RequestOptions) => {
                  check(p); await beforePost(id, p, o, "configure"); const i = await stripe.invoices.update(id, p, o); check(invoiceSend === null); return i; },
                finalizeInvoice: async (id: string, p?: Stripe.InvoiceFinalizeInvoiceParams, o?: Stripe.RequestOptions) => {
                  check(p); await beforePost(id, p, o, "finalize"); const i = await stripe.invoices.finalizeInvoice(id, p, o); check(invoiceSend === null); return i; },
              },
              invoicePayments: { list: async (p?: Stripe.InvoicePaymentListParams) => {
                check(isDeepStrictEqual(p, { invoice: inId, limit: 100 })); boundRead = `/v1/invoice_payments?invoice=${inId}&limit=100`;
                const links = await stripe.invoicePayments.list(p); check(boundRead === null);
                if (links.has_more === false && links.data.length === 1) linkedPaymentId = contextStripeId(links.data[0].payment.payment_intent, "pi");
                return links;
              } },
              paymentIntents: { retrieve: async (id: string) => { check(id === linkedPaymentId); boundRead = `/v1/payment_intents/${id}`;
                const p = await stripe.paymentIntents.retrieve(id); check(boundRead === null); return p; } },
            };
            await ready();
            const prepared = await prepareHeldInvoiceUsingContract(scoped, authorization, contract);
            await ready();
            const bound = readContextInvoiceState(await invoiceRpc("bind_exact_context_invoice_preparation_v2", {
              p_token: token, p_payment_intent_id: prepared.paymentIntentId }), r, inId);
            check(bound.claim?.token === token && bound.claim.status === "prepared" && bound.claim.paymentIntentId === prepared.paymentIntentId);
            await readEvidence(); elapsed(start);
            if (action === "prepare_invoice") return summary("prepared_unpaid");
            const beforeDispatch = await collectionRead();
            check(beforeDispatch.agreementStatus === "active" && isDeepStrictEqual(beforeDispatch.authorization, authorization) &&
              beforeDispatch.state.claim?.token === token && beforeDispatch.state.claim.paymentIntentId === prepared.paymentIntentId &&
              beforeDispatch.state.claim.status === "prepared" && Math.floor(Date.now() / 1000) >= authorization.periodStart &&
              Math.floor(Date.now() / 1000) < authorization.periodEnd);
            let priorCharge: string | null = null;
            await verifyRenewalProviderHistory({
              paymentMethods: { retrieve: async id => { check(id === authorization.paymentMethodId); boundRead = `/v1/payment_methods/${id}`;
                const value = await stripe.paymentMethods.retrieve(id); check(boundRead === null); return value; } },
              customers: { retrieve: async id => { check(id === deps.customerId); boundRead = `/v1/customers/${id}`;
                const value = await stripe.customers.retrieve(id); check(boundRead === null); return value; } },
              paymentIntents: { retrieve: async id => { check(beforeDispatch.prior.some(p => p.paymentIntentId === id)); boundRead = `/v1/payment_intents/${id}`;
                const value = await stripe.paymentIntents.retrieve(id); check(boundRead === null);
                priorCharge = contextStripeId(value.latest_charge, "ch"); return value; } },
              charges: { retrieve: async id => { check(id === priorCharge); boundRead = `/v1/charges/${id}`;
                const value = await stripe.charges.retrieve(id); check(boundRead === null); return value; } },
            }, authorization, beforeDispatch.prior, calculateInstallmentPlan(r.terms.totalCents, r.terms.paymentCount,
              r.terms.renewalFeeSchedule, r.terms.firstPaymentFeeSchedule).payments, r.context.mode === "live");
            // Recheck the open, unpaid default PI after the history reads. Never
            // refinalize an outside state transition or resume auto collection.
            check((await scoped.invoices.retrieve(inId)).status === "open");
            const finalUnpaid = await prepareHeldInvoiceUsingContract(scoped, authorization, contract);
            check(finalUnpaid.paymentIntentId === prepared.paymentIntentId); await ready();
            const admissionStart = Date.now();
            const admitted = fields(await invoiceRpc("admit_exact_context_invoice_dispatch_v2", {
              p_token: token, p_payment_intent_id: prepared.paymentIntentId }), ["admitted", "collection"]);
            const afterAdmission = readContextInvoiceCollection(admitted.collection, r, invoiceDeps, inId);
            const dispatch = afterAdmission.state.claim;
            check(admitted.admitted === true && isDeepStrictEqual(afterAdmission.authorization, authorization) && dispatch?.token === token &&
              dispatch.status === "dispatching" && dispatch.paymentIntentId === prepared.paymentIntentId && dispatch.dispatchStartedAt !== null &&
              dispatch.dispatchStartedAt >= admissionStart);
            const params = { payment_method: authorization.paymentMethodId, off_session: true };
            const key = `${contract.idempotencyPrefix}:pay-once-v1`;
            invoicePaySend = { path: `/v1/invoices/${inId}/pay`, key, params, admittedAt: dispatch.dispatchStartedAt };
            try { await stripe.invoices.pay(inId, params, { idempotencyKey: key, maxNetworkRetries: 0 }); }
            catch { /* Uncertain/declined admission is consumed, never retried. */ }
            finally { invoicePaySend = null; }
            return await reconcile(afterAdmission);
          }
          const checkoutDeps = { customerId: deps.customerId, subscriptionId: deps.subscriptionId, anchor: deps.anchor };
          const existing = await admin.rpc("read_exact_context_checkout_v2", readArgs, { get: true });
          check(!existing.error && existing.data);
          let state = readContextCheckoutState(existing.data, r, intent, checkoutDeps); check(!state.claimed);
          const result = (status: "review_required" | "checkout_prepared_unpublished") => Object.freeze({
            version: "exact-context-checkout-result-v1" as const, reservationId, context, status, sessionId: state.binding?.session_id ?? null,
            publicationAllowed: false as const, accountingOperationsAllowed: false as const, replayAllowed: false as const });
          async function freshUnpaidHold() {
            boundRead = `/v1/customers/${deps.customerId}`;
            const c = await stripe.customers.retrieve(deps.customerId); check(boundRead === null); assertContextBootstrapCustomer(c, intent, deps.customerId);
            boundRead = `/v1/products/${deps.productId}`;
            const p = await stripe.products.retrieve(deps.productId!); check(boundRead === null);
            assertContextHeldObject(p, r, intent, productAttempt!, deps, deps.productId, false);
            boundRead = `/v1/subscriptions/${deps.subscriptionId}`;
            const s = await stripe.subscriptions.retrieve(deps.subscriptionId!); check(boundRead === null);
            assertContextHeldObject(s, r, intent, holdAttempt!, deps, deps.subscriptionId, true);
          }
          elapsed(start); await readEvidence(); elapsed(start);
          if (action === "prepare" || action === "publish") {
            // Publishing must start from a previously bound session. It cannot
            // implicitly create/replay a customer, subscription or Checkout.
            if (action === "publish") check(state.attempt && state.binding);
            if (state.attempt && !state.binding) return result("review_required");
            await freshUnpaidHold(); elapsed(start);
            if (!state.attempt) {
              const claimed = await admin.rpc("claim_exact_context_checkout_v2", args); check(!claimed.error && claimed.data);
              state = readContextCheckoutState(claimed.data, r, intent, checkoutDeps);
            }
            check(state.attempt);
            if (state.claimed) {
              const attempt = state.attempt;
              await readEvidence(); elapsed(start); elapsed(Date.parse(attempt.claimed_at));
              checkoutSend = attempt;
              const session = await stripe.checkout.sessions.create(attempt.request.params, { idempotencyKey: attempt.idempotency_key });
              check(checkoutSend === null); assertContextCheckoutSession(session, r, attempt, checkoutDeps, null, false);
              const requestId = session.lastResponse?.requestId;
              check(typeof requestId === "string" && /^req_[A-Za-z0-9]{1,196}$/.test(requestId));
              await readEvidence(); elapsed(start);
              const bindArgs = { ...args, p_attempt_id: attempt.id, p_session_id: session.id, p_request_id: requestId };
              checkoutBind = JSON.stringify(bindArgs);
              const bound = await admin.rpc("bind_exact_context_checkout_v2", bindArgs); check(!bound.error && bound.data && checkoutBind === null);
              state = readContextCheckoutState(bound.data, r, intent, checkoutDeps);
              check(!state.claimed && state.attempt?.id === attempt.id && state.binding?.session_id === session.id && state.binding.request_id === requestId);
            }
            if (!state.binding) return result("review_required");
            check(state.attempt);
            boundRead = `/v1/checkout/sessions/${state.binding.session_id}`;
            const session = await stripe.checkout.sessions.retrieve(state.binding.session_id); check(boundRead === null);
            assertContextCheckoutSession(session, r, state.attempt, checkoutDeps, state.binding.session_id, false);
            await freshUnpaidHold(); await readEvidence(); elapsed(start);
            if (action === "publish") {
              check(typeof session.url === "string" && session.url.length <= 8192 && !/\s/.test(session.url));
              const url = new URL(session.url);
              check(url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.port && !url.username && !url.password &&
                url.pathname === `/c/pay/${session.id}` && session.expires_at > Math.floor(Date.now() / 1000) + 60 &&
                !session.adaptive_pricing?.enabled && !session.after_expiration);
              const params = { ...args, p_proof: { sessionId: session.id, url: session.url, expiresAt: session.expires_at,
                verifiedAt: Math.floor(Date.now() / 1000) } };
              checkoutPublication = JSON.stringify(params);
              const published = await admin.rpc("publish_exact_context_checkout_v2", params);
              check(!published.error && checkoutPublication === null);
              const p = fields(published.data, ["reservationId", "sessionId", "url", "expiresAt", "publishedAt", "reused"]);
              check(p.reservationId === r.id && p.sessionId === session.id && p.url === session.url && p.expiresAt === session.expires_at &&
                typeof p.reused === "boolean" && typeof p.publishedAt === "string" && Number.isFinite(Date.parse(p.publishedAt)));
              return Object.freeze({ reservationId: r.id, sessionId: session.id, url: session.url, expiresAt: session.expires_at,
                publishedAt: p.publishedAt, reused: p.reused, status: "checkout_published" as const, accountingOperationsAllowed: false as const });
            }
            // Never persist or expose the payable URL before the full lifecycle
            // and independent publication admission have been connected.
            return result("checkout_prepared_unpublished");
          }
          // Read-only provider chain from a known durable session. Event/request
          // metadata cannot introduce any session/intent/charge to this path.
          check(state.attempt && state.binding);
          boundRead = `/v1/checkout/sessions/${state.binding.session_id}`;
          const session = await stripe.checkout.sessions.retrieve(state.binding.session_id); check(boundRead === null);
          if (action === "inspect_unpaid" && session.status !== "complete") {
            // #2/#3: observe a failed/expired attempt, not a cancellation,
            // replacement Checkout, purchase, refund or billing authorization.
            assertContextCheckoutSession(session, r, state.attempt, checkoutDeps, state.binding.session_id, "observe_unpaid");
            let paymentIntentId: string | null = null;
            if (session.payment_intent !== null) {
              paymentIntentId = contextStripeId(session.payment_intent, "pi"); boundRead = `/v1/payment_intents/${paymentIntentId}`;
              const unpaid = await stripe.paymentIntents.retrieve(paymentIntentId); check(boundRead === null);
              const p = state.attempt.request.params.payment_intent_data!;
              check(unpaid.object === "payment_intent" && unpaid.id === paymentIntentId && unpaid.livemode === (r.context.mode === "live") &&
                unpaid.customer === deps.customerId && ["requires_payment_method", "canceled"].includes(unpaid.status) &&
                unpaid.amount === session.amount_total && unpaid.currency === "usd" && unpaid.amount_received === 0 && unpaid.amount_capturable === 0 &&
                unpaid.application_fee_amount === p.application_fee_amount && unpaid.transfer_data !== null && unpaid.transfer_data.destination === p.transfer_data?.destination &&
                unpaid.transfer_data.amount == null && unpaid.setup_future_usage === "off_session" && isDeepStrictEqual(unpaid.metadata, p.metadata));
              // The original Checkout contract does not select capture_method.
              // Terminal/requires-method state, zero received/capturable cents
              // and the actual latest charge are the no-capture evidence.
              if (unpaid.latest_charge !== null) {
                const chargeId = contextStripeId(unpaid.latest_charge, "ch"); boundRead = `/v1/charges/${chargeId}`;
                const charge = await stripe.charges.retrieve(chargeId); check(boundRead === null);
                check(charge.id === chargeId && charge.payment_intent === paymentIntentId && charge.customer === deps.customerId &&
                  charge.livemode === (r.context.mode === "live") && charge.paid === false && charge.captured === false &&
                  charge.amount_captured === 0 && charge.amount_refunded === 0);
              }
            }
            await freshUnpaidHold(); await readEvidence(); elapsed(start);
            return Object.freeze({ status: "checkout_unpaid_observed" as const, sessionId: session.id,
              sessionStatus: session.status, paymentIntentId, accountingOperationsAllowed: false as const });
          }
          assertContextCheckoutSession(session, r, state.attempt, checkoutDeps, state.binding.session_id, true);
          const piId = contextStripeId(session.payment_intent, "pi"); boundRead = `/v1/payment_intents/${piId}`;
          const pi = await stripe.paymentIntents.retrieve(piId); check(boundRead === null && pi.id === piId);
          const chargeId = contextStripeId(pi.latest_charge, "ch"); boundRead = `/v1/charges/${chargeId}`;
          const charge = await stripe.charges.retrieve(chargeId); check(boundRead === null && charge.id === chargeId);
          const balanceId = contextStripeId(charge.balance_transaction, "txn"); boundRead = `/v1/balance_transactions/${balanceId}`;
          const balance = await stripe.balanceTransactions.retrieve(balanceId); check(boundRead === null && balance.id === balanceId);
          const receipt = inspectContextFirstCharge(r, state.attempt, checkoutDeps, session, pi, charge, balance);
          await readEvidence(); elapsed(start);
          if (action === "activate") {
            check(deps.productId && deps.subscriptionId);
            const activationDeps = { ...checkoutDeps, productId: deps.productId };
            async function readCard() {
              boundRead = `/v1/payment_methods/${receipt.payment_method_id}`;
              const pm = await stripe.paymentMethods.retrieve(receipt.payment_method_id); check(boundRead === null);
              boundRead = `/v1/customers/${deps.customerId}`;
              const c = await stripe.customers.retrieve(deps.customerId); check(boundRead === null);
              assertContextActivationCard(pm, c, r, intent, activationDeps, receipt);
            }
            async function readSub() {
              boundRead = `/v1/subscriptions/${activationDeps.subscriptionId}`;
              const s = await stripe.subscriptions.retrieve(activationDeps.subscriptionId); check(boundRead === null);
              return inspectContextActivationSubscription(s, r, intent, activationDeps, receipt);
            }
            async function readInvoices() {
              boundRead = `/v1/invoices?subscription=${activationDeps.subscriptionId}&limit=100`;
              const invoices = await stripe.invoices.list({ subscription: activationDeps.subscriptionId, limit: 100 }); check(boundRead === null);
              assertContextBootstrapInvoices(invoices, r, activationDeps);
            }
            await readCard(); let sub = await readSub();
            const auth = contextActivationAuthorization(r, receipt, sub.itemId);
            const summary = (status: "activated_held" | "busy" | "review_required") => Object.freeze({
              version: "exact-context-activation-result-v1" as const, reservationId, context, status,
              firstRenewalAt: auth.firstRenewalAt, cancelAt: auth.cancelAt, collectionAllowed: false as const, publicationAllowed: false as const });
            // This SQL assertion locks the agreement: PostgREST GET is READ
            // ONLY, so use its fixed POST capability even though no row changes.
            activationWrite = JSON.stringify(args);
            const saved = await admin.rpc("read_exact_context_activation_v2", args); check(!saved.error && saved.data && activationWrite === null);
            let activation = readContextActivation(saved.data, r, receipt, sub.itemId);
            if (activation?.status === "complete") {
              check(sub.activated); await readEvidence(); elapsed(start); return summary("activated_held");
            }
            await readInvoices(); await readEvidence(); elapsed(start);
            const claimArgs = { ...args, p_payment_method_id: receipt.payment_method_id, p_item_id: sub.itemId };
            activationWrite = JSON.stringify(claimArgs);
            const claim = await admin.rpc("claim_exact_context_activation_v2", claimArgs); check(!claim.error && claim.data && activationWrite === null);
            const claimed = fields(claim.data, ["claim", "state"]), status = own(claimed.claim, "status");
            if (status === "busy" || status === "review_required") return summary(status);
            check(status === "new" || status === "complete");
            activation = readContextActivation(claimed.state, r, receipt, sub.itemId); check(activation);
            const returnedAuth = fields(own(claimed.claim, "authorization"), Object.keys(auth));
            for (const [key, value] of Object.entries(auth)) check(returnedAuth[key] === value);
            await readCard(); sub = await readSub(); check(sub.itemId === auth.subscriptionItemId);
            if (status === "complete") { check(activation.status === "complete" && sub.activated); return summary("activated_held"); }
            check(activation.status === "running" && activation.leaseUntil > Date.now());
            activationWrite = JSON.stringify(args);
            const ready = await admin.rpc("read_exact_context_activation_v2", args); check(!ready.error && ready.data && activationWrite === null);
            check(readContextActivation(ready.data, r, receipt, sub.itemId)?.claimToken === activation.claimToken);
            await readEvidence(); elapsed(start);
            if (!sub.activated) {
              const params = contextActivationParams(r, receipt);
              const key = `cn-exact-v2-activate:${r.id}:${intent.contextHash}:${intent.termsHash}`;
              activationSend = { path: `/v1/subscriptions/${deps.subscriptionId}`, key, params, firstStartedAt: activation.firstStartedAt };
              const updated = await stripe.subscriptions.update(deps.subscriptionId, params, { idempotencyKey: key }); check(activationSend === null);
              const checked = inspectContextActivationSubscription(updated, r, intent, activationDeps, receipt);
              check(checked.activated && checked.itemId === auth.subscriptionItemId);
            }
            await readInvoices(); await readCard(); const finalSub = await readSub();
            check(finalSub.activated && finalSub.itemId === auth.subscriptionItemId);
            await readEvidence(); elapsed(start);
            const completeArgs = { ...args, p_token: activation.claimToken }; activationWrite = JSON.stringify(completeArgs);
            const completed = await admin.rpc("complete_exact_context_activation_v2", completeArgs); check(!completed.error && completed.data && activationWrite === null);
            check(readContextActivation(completed.data, r, receipt, sub.itemId)?.status === "complete");
            await readEvidence(); elapsed(start); return summary("activated_held");
          }
          if (action === "record_payment" || action === "credit_payment") {
            const receiptArgs = { ...args, p_receipt: receipt }; firstReceiptWrite = JSON.stringify(receiptArgs);
            const saved = await admin.rpc("record_exact_context_first_receipt_v2", receiptArgs);
            check(!saved.error && saved.data && firstReceiptWrite === null);
            const row = fields(saved.data, ["reservation_id", "recorded_at", ...Object.keys(receipt)]);
            check(row.reservation_id === reservationId && typeof row.recorded_at === "string" &&
              Date.parse(row.recorded_at) >= receipt.paid_at * 1000 && Date.parse(row.recorded_at) <= Date.now() + 1000);
            for (const [key, value] of Object.entries(receipt)) check(row[key] === value);
            await readEvidence(); elapsed(start);
          }
          if (action === "credit_payment") {
            const creditArgs = { ...args, p_receipt: receipt }; firstCreditWrite = JSON.stringify(creditArgs);
            const credited = await admin.rpc("credit_exact_context_first_payment_v2", creditArgs);
            check(!credited.error && credited.data && firstCreditWrite === null);
            const row = fields(credited.data, ["reservation_id", "agreement_id", "purchase_id", "ledger_id", "credited", "first_payment_fulfilled"]);
            check(row.reservation_id === reservationId && row.agreement_id === reservationId && typeof row.purchase_id === "string" &&
              typeof row.ledger_id === "string" && typeof row.credited === "boolean" && row.first_payment_fulfilled === true);
            assertAgreementId(row.purchase_id); assertAgreementId(row.ledger_id);
            await readEvidence(); elapsed(start);
            return Object.freeze({ version: "exact-context-first-credit-result-v1" as const, reservationId, context,
              status: "first_payment_fulfilled" as const, agreementId: reservationId, purchaseId: row.purchase_id, ledgerId: row.ledger_id,
              credited: row.credited, publicationAllowed: false as const, collectionAllowed: false as const });
          }
          return Object.freeze({ version: "exact-context-first-payment-result-v1" as const, reservationId, context,
            status: action === "record_payment" ? "receipt_recorded" as const : "captured_payment_verified" as const,
            receipt, publicationAllowed: false as const, accountingOperationsAllowed: false as const, collectionAllowed: false as const });
        } catch { throw fail(); }
        finally { checkoutSend = null; checkoutBind = null; checkoutPublication = null; firstReceiptWrite = null; firstCreditWrite = null;
          activationSend = null; activationWrite = null; invoiceSend = null; invoicePaySend = null; invoiceRpcSend = null; boundRead = null; }
      },
    });
  } catch { throw fail(); }
}

/** Explicit buyer-owned pay-now only; review and reconciliation never dispatch.
 * A separate future-card review records the existing optional same-plan choice;
 * neither action changes defaults, releases holds or publishes an app route. */
export function createExactContextBuyerRetry(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, false, false, false, false, false, false, false, false, false, false, false, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  const runtime = () => createRuntime(snapshot, serverFetch, true, false, false, false, false, false, false, false, false, false, false, false, true);
  return Object.freeze({
    reviewPayment: (reservationId: string, buyerId: string, invoiceId: string, quoteId: string) =>
      runtime().buyerRetry(reservationId, buyerId, invoiceId, quoteId, "review", null),
    reviewWithFutureCardChoice: (reservationId: string, buyerId: string, invoiceId: string, quoteId: string) =>
      runtime().buyerRetry(reservationId, buyerId, invoiceId, quoteId, "review_future", null),
    payNow: (reservationId: string, buyerId: string, invoiceId: string, quoteId: string, consent: unknown) =>
      runtime().buyerRetry(reservationId, buyerId, invoiceId, quoteId, "pay", consent),
    reconcile: (reservationId: string, buyerId: string, invoiceId: string, quoteId: string) =>
      runtime().buyerRetry(reservationId, buyerId, invoiceId, quoteId, "reconcile", null),
  });
}

/** Server-owned public key, never supplied by an HTTP buyer payload. No route is
 * published here. Existing Sandbox wrappers keep their original test-only gates. */
export function createExactContextBankVerification(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch, publicKey: string | null = null) {
  createRuntime(config, serverFetch, true, false, false, false, false, false, false, false, false, false, false, false, false, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  const runtime = () => createRuntime(snapshot, serverFetch, true, false, false, false, false, false, false, false, false, false, false, false, false, true);
  return Object.freeze({
    readChallenge: (reservationId: string, buyerId: string, invoiceId: string) => runtime().bankVerification(reservationId, buyerId, invoiceId, "challenge", publicKey, null),
    checkPayment: (reservationId: string, buyerId: string, invoiceId: string) => runtime().bankVerification(reservationId, buyerId, invoiceId, "check", null, null),
    observeInvoice: (reservationId: string, buyerId: string, invoiceId: string, eventId: string) => runtime().bankVerification(reservationId, buyerId, invoiceId, "observe", null, eventId),
  });
}

/** Buyer-consented replacement-card SETUP and actual saved-card verification.
 * No charge, billing-default change, hold release or link publication. */
export function createExactContextCardSetup(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, false, false, false, false, false, false, false, false, false, false, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  const runtime = () => createRuntime(snapshot, serverFetch, true, false, false, false, false, false, false, false, false, false, false, true);
  return Object.freeze({
    saveCard: (reservationId: string, buyerId: string, invoiceId: string, requestId: string, consent: unknown) =>
      runtime().cardSetup(reservationId, buyerId, invoiceId, requestId, "prepare", consent),
    verifyCard: (reservationId: string, buyerId: string, invoiceId: string, requestId: string) =>
      runtime().cardSetup(reservationId, buyerId, invoiceId, requestId, "verify", null),
  });
}

/** #3: authenticated buyer link handoff only after recorded card-setup consent
 * and an owned bound Setup Session. This action cannot create or pay. */
export function createExactContextCardSetupPublication(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  const runtime = () => createRuntime(snapshot, serverFetch, true, false, false, false, false, false, false, false, false, false, false, true);
  runtime();
  return Object.freeze({ readRedirect: (reservationId: string, buyerId: string, invoiceId: string, requestId: string) =>
    runtime().cardSetup(reservationId, buyerId, invoiceId, requestId, "publish", null) });
}

/** Read-only provider recovery; SQL may hold/observe and reconcile the original
 * once-only receipt. No collection admission or provider write is exposed. */
export function createExactContextPaymentRecovery(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, true, true, true, false, false, true, false, false, false, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({ recoverInvoice: (reservationId: string, actorId: string, invoiceId: string, eventId: string) =>
    createRuntime(snapshot, serverFetch, true, true, true, true, false, false, true, false, false, false, true)
      .contextCheckout(reservationId, actorId, "recover_invoice", invoiceId, eventId) });
}

/** Separately selected administrator stop; not imported by any app route.
 * The actor must be authenticated by server composition and SQL rechecks admin.
 * Existing credited purchase only; no new cancellation/debt/access policy. */
export function createExactContextBillingStop(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, false, false, false, false, false, false, false, false, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({ stopBilling: (reservationId: string, actorId: string, requestId: string) =>
    createRuntime(snapshot, serverFetch, true, false, false, false, false, false, false, false, false, true).billingStop(reservationId, actorId, requestId) });
}

/** #1: server-authenticated administrator only. The existing refund workflow
 * runs through context-bound SQL and the runtime-owned provider transport. */
export function createExactContextAdminRefund(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, false, false, false, false, false, false, false, false, false, false, false, false, false, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({ run: (reservationId: string, actorId: string, ledgerId: string, action: ContextRefundAction) =>
    createRuntime(snapshot, serverFetch, true, false, false, false, false, false, false, false, false, false, false, false, false, false, true)
      .adminRefund(reservationId, actorId, ledgerId, action) });
}

/** Observer only. Canonical signed-event claim/dispatch is separate and not enabled here. */
export function createExactContextFinancialEvents(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, false, false, false, false, false, false, false, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({ reconcileEvent: (reservationId: string, actorId: string, eventId: string) =>
    createRuntime(snapshot, serverFetch, true, false, false, false, false, false, false, false, true).financialEvent(reservationId, actorId, eventId) });
}

/** Current subscription audit only, after the first credit. The existing
 * financial-observation transport exposes no provider write or resumption. */
export function createExactContextSubscriptionObservation(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, false, false, false, false, false, false, false, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({ observeSubscription: (reservationId: string, actorId: string, eventId: string) =>
    createRuntime(snapshot, serverFetch, true, false, false, false, false, false, false, false, true).subscriptionEvent(reservationId, actorId, eventId) });
}

export function createExactContextRuntime(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  const runtime = createRuntime(config, serverFetch, false);
  return Object.freeze({ observeContext: runtime.observeContext, inspectEvent: runtime.inspectEvent });
}

/** Server-only, separately selected planning surface. actorId must be supplied
 * by authenticated server composition, never inferred from event metadata.
 * Writes only an immutable database intent through the proposed 059 RPC, or
 * reads an existing owned plan by its reservation without making another plan.
 * It cannot dispatch the request, attach a result, credit, unlock or collect.
 * No app route uses this factory; hosted invocation is not approved by code.
 */
export function createExactContextBootstrapPlanner(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  const runtime = createRuntime(config, serverFetch, true);
  return Object.freeze({ planCustomer: runtime.planCustomer, readCustomerPlan: runtime.readCustomerPlan });
}

/** Prospective private composition for unapplied 060. One metadata-only customer
 * POST, permanently claimed before send, followed by its checked result binding.
 * Nothing here can create Checkout/subscriptions, charge, credit or grant access.
 * No app route invokes it. Explicit approved server composition must supply actor
 * and context; a plan, event or HTTP input alone cannot authorize execution.
 * Each invocation owns its transport capabilities, including concurrent calls.
 * Unknown outcomes stay review_required; GET diagnoses without another POST.
 */
export function createExactContextCustomerBootstrap(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  // Snapshot/validate configuration now; private runtimes for invocations avoid
  // cross-request capability races. No SDK request happens during construction.
  createRuntime(config, serverFetch, true, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({
    createCustomer: (reservationId: string, actorId: string) =>
      createRuntime(snapshot, serverFetch, true, true).customerResult(reservationId, actorId, true),
    readCustomerResult: (reservationId: string, actorId: string) =>
      createRuntime(snapshot, serverFetch, true, true).customerResult(reservationId, actorId, false),
  });
}

/** Proposed 061 composition. A bound 060 customer is required. Creates only the
 * isolated product, no-card trial subscription and indefinite collection hold;
 * never publishes Checkout or alters financial/access state. The old inspection,
 * planner and customer-only factories retain their narrower transport scopes. */
export function createExactContextHeldBootstrap(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, true, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({
    prepareHeld: (reservationId: string, actorId: string) =>
      createRuntime(snapshot, serverFetch, true, true, true).heldPreparation(reservationId, actorId, true),
    inspectHeld: (reservationId: string, actorId: string) =>
      createRuntime(snapshot, serverFetch, true, true, true).heldPreparation(reservationId, actorId, false),
  });
}

/** Proposed 062, server-only. Preparation returns identity but never a payment
 * URL. Receipt inspection/recording retrieves an already bound payment; it has
 * no Stripe write, credit, entitlement or collection operation. Existing app
 * routes remain unmodified and new-protocol issuance stays unavailable. */
export function createExactContextCheckout(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, true, true, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({
    prepareCheckout: (reservationId: string, actorId: string) =>
      createRuntime(snapshot, serverFetch, true, true, true, true).contextCheckout(reservationId, actorId, "prepare"),
    inspectFirstPayment: (reservationId: string, actorId: string) =>
      createRuntime(snapshot, serverFetch, true, true, true, true).contextCheckout(reservationId, actorId, "inspect_payment"),
    inspectUnpaidCheckout: (reservationId: string, actorId: string) =>
      createRuntime(snapshot, serverFetch, true, true, true, true).contextCheckout(reservationId, actorId, "inspect_unpaid"),
    recordFirstPayment: (reservationId: string, actorId: string) =>
      createRuntime(snapshot, serverFetch, true, true, true, true).contextCheckout(reservationId, actorId, "record_payment"),
    inspectBootstrapInvoice: (reservationId: string, actorId: string, invoiceId: string) =>
      createRuntime(snapshot, serverFetch, true, true, true, true).contextCheckout(reservationId, actorId, "inspect_bootstrap_invoice", invoiceId),
  });
}

/** #3: separate, server-selected URL delivery for an already prepared session.
 * No existing inspection/preparation factory receives publication authority. */
export function createExactContextCheckoutPublication(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  const runtime = () => createRuntime(snapshot, serverFetch,
    true, true, true, true, // customer read/held/Checkout dependencies
    false, false, false, false, false, false, false, false, false, false, false, // no financial/card/refund authority
    true); // publication only
  runtime();
  return Object.freeze({ publishCheckout: (reservationId: string, actorId: string) => runtime().contextCheckout(reservationId, actorId, "publish") });
}

/** Proposed 063. Fresh known-payment inspection precedes one atomic call to
 * existing receipt accounting and fulfillment. No caller-supplied money,
 * receipt, purchase identity or provider write is exposed. Not route-wired;
 * monthly activation/collection and Checkout publication remain disabled. */
export function createExactContextFirstCredit(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, true, true, true, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({ creditFirstPayment: (reservationId: string, actorId: string) =>
    createRuntime(snapshot, serverFetch, true, true, true, true, true).contextCheckout(reservationId, actorId, "credit_payment") });
}

/** Proposed 064: configure only the existing held subscription after its first
 * credit/fulfillment. It exposes no payment, resume, new subscription or card
 * attachment operation. Uses the existing activation/period records and dates. */
export function createExactContextActivation(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, true, true, true, false, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({ activateHeld: (reservationId: string, actorId: string) =>
    createRuntime(snapshot, serverFetch, true, true, true, true, false, true).contextCheckout(reservationId, actorId, "activate") });
}

/** Proposed 065: one owned renewal invoice, exact residual/fee configuration
 * and unpaid finalization only. No pay, receipt credit or unhold is exposed. */
export function createExactContextInvoicePreparation(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, true, true, true, false, false, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({ prepareInvoice: (reservationId: string, actorId: string, invoiceId: string) =>
    createRuntime(snapshot, serverFetch, true, true, true, true, false, false, true).contextCheckout(reservationId, actorId, "prepare_invoice", invoiceId) });
}

/** Proposed 066, not route-enabled. One permanent admission permits one pay
 * request. Receipt-only reconciliation cannot prepare, admit, or resend payment. */
export function createExactContextInvoiceCollection(config: ExactContextRuntimeConfig, serverFetch: typeof fetch = globalThis.fetch) {
  createRuntime(config, serverFetch, true, true, true, true, false, false, true, true);
  const snapshot = Object.freeze({ ...config, approvedContext: Object.freeze({ ...config.approvedContext }) });
  return Object.freeze({
    collectInvoice: (reservationId: string, actorId: string, invoiceId: string) =>
      createRuntime(snapshot, serverFetch, true, true, true, true, false, false, true, true).contextCheckout(reservationId, actorId, "collect_invoice", invoiceId),
    reconcileInvoice: (reservationId: string, actorId: string, invoiceId: string) =>
      createRuntime(snapshot, serverFetch, true, true, true, true, false, false, true, true).contextCheckout(reservationId, actorId, "reconcile_invoice", invoiceId),
  });
}
