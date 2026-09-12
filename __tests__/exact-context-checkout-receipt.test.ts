/** @jest-environment ./test-support/pglite-environment.cjs */
// New Checkout/receipt boundary only. Seed the already-tested unpaid setup via
// its SQL contract; do not recreate customer/subscription provider tests.
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installStagingStructuralBaseline, installExactMigrationsInMemory } from "../test-support/staging-catalog-postgres";
import { createExactContextCheckout, createExactContextFirstCredit, createExactContextActivation, createExactContextInvoicePreparation, createExactContextInvoiceCollection, createExactContextFinancialEvents, createExactContextBillingStop, createExactContextPaymentRecovery, CONTEXT_RUNTIME_ERROR, type ExactContextRuntimeConfig } from "../lib/installments/contextRuntime";
import { exactActivationDates } from "../lib/installments/activation";
import { installmentMonthBoundary } from "../lib/installments/checkoutPreparation";
import { createExactContextCardSetup } from "../lib/installments/contextRuntime";
import { createExactContextBuyerRetry } from "../lib/installments/contextRuntime";
import { createExactContextBankVerification } from "../lib/installments/contextRuntime";
import { createExactContextSubscriptionObservation } from "../lib/installments/contextRuntime";
import { createExactContextAdminRefund } from "../lib/installments/contextRuntime";
import { createExactContextCheckoutPublication } from "../lib/installments/contextRuntime";
import { createExactContextCardSetupPublication } from "../lib/installments/contextRuntime";
import { PAY_NOW_CONSENT_VERSION, FUTURE_CARD_CONSENT_VERSION, FUTURE_CARD_CONSENT_TEXT } from "../lib/installments/buyerRecoveryView";
import { CARD_SETUP_CONSENT_VERSION } from "../lib/installments/cardRecovery";
import { FIXED_PURCHASE_CONSENT_TEXT, FIXED_PURCHASE_CONSENT_VERSION } from "../lib/installments/purchaseConsent";
import { fixedServiceEndAt, fixedServiceDescription } from "../lib/fixedServiceTerms";
import { productPurchaseTerms } from "../lib/purchaseConsent";

declare const createLocalPostgres: () => PGlite;
jest.setTimeout(120000);
type Body = Record<string, unknown>;
const ids = { buyer: "11111111-1111-4111-8111-111111111111", creator: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444", booking: "55555555-5555-4555-8555-555555555555" };
const context = { version: "exact-payment-context-v1" as const, mode: "test" as "test" | "live", platformAccountId: "acct_LocalCheckout",
  supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa", siteOrigin: "https://synthetic-checkout.vercel.app" };
const fee = { enabled: true, basisPoints: 290, fixedCents: 30, version: "local-v1" };
let db: PGlite, reservationId: string, config: ExactContextRuntimeConfig, objects: Map<string, Body>, createParams: URLSearchParams;
let expectedFirstFee = 9958;
let freshRpcTransactions = false;
let committedFixture = false;
const localSqlErrors: string[] = [];
const rpcPrefix = "/rest/v1/rpc/";
const signatures: Record<string, string> = {
  publish_exact_context_checkout_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::jsonb",
  run_exact_context_admin_refund_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::uuid,$5::text,$6::jsonb",
  read_exact_context_subscription_v2: "$1::uuid,$2::uuid,$3::jsonb",
  observe_exact_context_subscription_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::jsonb,$5::jsonb,$6::text,$7::jsonb",
  read_exact_context_bank_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::boolean",
  read_exact_installment_bank_context: "$1::uuid,$2::text,$3::uuid,$4::boolean",
  read_exact_context_buyer_retry_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::uuid",
  run_exact_context_buyer_retry_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::uuid,$6::text,$7::jsonb",
  read_exact_context_card_setup_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::uuid",
  run_exact_context_card_setup_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::uuid,$6::text,$7::jsonb",
  run_exact_context_recovery_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::jsonb,$6::text,$7::jsonb,$8::text,$9::jsonb",
  read_exact_context_stop_v2: "$1::uuid,$2::uuid,$3::jsonb",
  run_exact_context_stop_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::text,$7::jsonb",
  read_exact_context_financial_event_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::jsonb",
  hold_exact_context_financial_event_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::jsonb",
  apply_exact_context_financial_event_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::jsonb,$5::jsonb",
  read_exact_installment_context_pin_v2: "", read_exact_customer_operation_v2: "$1::uuid,$2::uuid,$3::jsonb",
  read_exact_customer_dispatch_v2: "$1::uuid,$2::uuid,$3::jsonb", read_exact_held_step_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text",
  read_exact_context_checkout_v2: "$1::uuid,$2::uuid,$3::jsonb", claim_exact_context_checkout_v2: "$1::uuid,$2::uuid,$3::jsonb",
  bind_exact_context_checkout_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::uuid,$5::text,$6::text",
  record_exact_context_first_receipt_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::jsonb",
  credit_exact_context_first_payment_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::jsonb",
  read_exact_context_activation_v2: "$1::uuid,$2::uuid,$3::jsonb",
  claim_exact_context_activation_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text",
  complete_exact_context_activation_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::uuid",
  record_exact_installment_first_receipt: "$1::uuid,$2::text,$3::text,$4::bigint,$5::bigint,$6::timestamptz",
  bind_exact_installment_purchase: "$1::uuid,$2::uuid",
  credit_exact_installment_receipt: "$1::uuid,$2::integer,$3::text,$4::text,$5::bigint",
  claim_exact_installment_activation: "$1::uuid,$2::text,$3::text,$4::uuid",
  complete_exact_installment_activation: "$1::uuid,$2::uuid",
  seed_exact_installment_purchase: "$1::uuid",
  fulfill_exact_installment_first_payment: "$1::uuid",
  read_exact_context_invoice_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text",
  claim_exact_context_invoice_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text,$6::bigint,$7::bigint",
  assert_exact_context_invoice_preparation_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::uuid",
  bind_exact_context_invoice_preparation_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::uuid,$6::text",
  claim_exact_installment_invoice: "$1::uuid,$2::text,$3::text,$4::bigint,$5::bigint,$6::uuid",
  prepare_exact_installment_dispatch: "$1::uuid,$2::text,$3::text,$4::uuid",
  admit_exact_installment_dispatch: "$1::uuid,$2::text,$3::uuid",
  read_exact_context_invoice_collection_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text",
  admit_exact_context_invoice_dispatch_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::uuid,$6::text",
  credit_exact_context_invoice_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::jsonb",
  record_exact_installment_renewal_receipt: "$1::uuid,$2::text,$3::text,$4::bigint,$5::bigint,$6::timestamptz",
  complete_exact_installment_agreement: "$1::uuid",
};
async function rpc(name: string, args: unknown[], readOnly = false) {
  if (!Object.hasOwn(signatures, name)) throw Error("Unexpected synthetic RPC");
  // Activation compares paid_at with PostgreSQL now(). Model separate HTTP RPC
  // transactions, not a test-wide frozen transaction timestamp. No fake dates.
  if (freshRpcTransactions) { await db.exec(`commit; begin${readOnly ? " read only" : ""}`); committedFixture = true; }
  await db.exec("savepoint local_rpc; set local role service_role");
  try {
    const result = await db.query<{ value: unknown }>(`select to_jsonb(public.${name}(${signatures[name]})) value`, args);
    return JSON.parse(JSON.stringify(result.rows[0].value));
  } catch (e) { localSqlErrors.push(e && typeof e === "object" && "message" in e && typeof e.message === "string" ? e.message : "local SQL error");
    await db.exec("rollback to savepoint local_rpc"); throw e; }
  finally { await db.exec("reset role; release savepoint local_rpc"); }
}
function harness(change: (body: Body, path: string, method: string) => Body | Promise<Body> = b => b,
  bankPublicKey = `pk_${config.approvedContext.mode}_SYNTHETICPUBLICKEY`) {
  const requests: Array<{ path: string; method: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET", headers = new Headers(init?.headers);
    requests.push({ path: url.pathname, method });
    expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
    expect(headers.has("stripe-context")).toBe(false);
    if (headers.has("stripe-account")) { expect(url.pathname).toBe("/v1/balance"); expect(method).toBe("GET"); expect(headers.get("stripe-account")).toBe("acct_LocalCreator"); }
    let body: unknown;
    if (url.origin === "https://api.stripe.com") {
      expect(headers.get("authorization")).toBe(`Bearer ${config.stripeSecretKey}`);
      expect(headers.get("stripe-version")).toBe("2025-10-29.clover");
      if (url.pathname === "/v1/account") body = { object: "account", id: context.platformAccountId };
      else if (url.pathname === "/v1/balance") body = { object: "balance", livemode: config.approvedContext.mode === "live", available: [], pending: [] };
      else if (method === "GET") {
        body = objects.get(url.pathname); if (!body) throw Error("Unknown synthetic provider identity");
      } else if (url.pathname === "/v1/refunds") {
        const p = new URLSearchParams(String(init?.body)), op = p.get("metadata[creatornet_refund_operation_id]")!;
        expect(headers.get("idempotency-key")).toBe(`creatornet:refund:${op}:customer`);
        expect(p.get("reverse_transfer")).toBe("true"); expect(p.get("refund_application_fee")).toBe("false");
        const id = `re_Local${op.replaceAll("-", "")}`;
        body = objects.get(`/v1/refunds/${id}`);
        if (!body) {
          body = { object: "refund", id, payment_intent: p.get("payment_intent"), charge: "ch_LocalCheckout", currency: "usd",
            amount: Number(p.get("amount")), status: "succeeded", metadata: { creatornet_refund_operation_id: op } };
          objects.set(`/v1/refunds/${id}`, body as Body);
          const charge = objects.get("/v1/charges/ch_LocalCheckout")!; charge.amount_refunded = Number(charge.amount_refunded) + Number(p.get("amount"));
        }
      } else if (url.pathname === "/v1/application_fees/fee_LocalCheckout/refunds") {
        const p = new URLSearchParams(String(init?.body)), op = p.get("metadata[creatornet_refund_operation_id]")!;
        expect(headers.get("idempotency-key")).toMatch(new RegExp(`^creatornet:refund:${op}:application-fee:[0-9]+$`));
        const fee = objects.get("/v1/application_fees/fee_LocalCheckout")!, refunds = fee.refunds as { data: Body[] };
        body = refunds.data.find(r => (r.metadata as Body).creatornet_refund_operation_id === op);
        if (!body) {
          body = { object: "fee_refund", id: `fr_Local${op.replaceAll("-", "")}`, fee: fee.id, currency: "usd", amount: Number(p.get("amount")),
            metadata: { creatornet_refund_operation_id: op } };
          refunds.data.push(body as Body); fee.amount_refunded = Number(fee.amount_refunded) + Number(p.get("amount"));
        }
      } else if (url.pathname === "/v1/checkout/sessions" && new URLSearchParams(String(init?.body)).get("mode") === "setup") {
        const p = new URLSearchParams(String(init?.body));
        expect(headers.get("idempotency-key")).toMatch(/^cn-exact-v2-card:[a-f0-9-]{36}:[a-f0-9-]{36}$/);
        expect(p.get("line_items[0][price_data][unit_amount]")).toBeNull(); expect(p.get("payment_intent_data[application_fee_amount]")).toBeNull();
        const live = config.approvedContext.mode === "live", sessionId = live ? "cs_LocalCard" : "cs_test_LocalCard";
        const metadata = Object.fromEntries([...p].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
        body = { object: "checkout.session", id: sessionId, mode: "setup", ui_mode: "hosted", livemode: live,
          customer: p.get("customer"), client_reference_id: p.get("client_reference_id"), metadata, payment_method_types: ["card"],
          created: Math.floor(Date.now() / 1000), expires_at: Number(p.get("expires_at")), status: "open", setup_intent: null,
          payment_intent: null, subscription: null, invoice: null, payment_status: "no_payment_required", amount_total: null,
          success_url: p.get("success_url"), cancel_url: p.get("cancel_url"), url: `https://checkout.stripe.com/c/pay/${sessionId}#synthetic-private-card` };
        objects.set(`/v1/checkout/sessions/${sessionId}`, body as Body);
      } else if (url.pathname === "/v1/checkout/sessions") {
        expect(headers.get("idempotency-key")).toMatch(/^cn-exact-v2-checkout:[a-f0-9-]{36}:[a-f0-9]{64}:[a-f0-9]{64}$/);
        createParams = new URLSearchParams(String(init?.body));
        expect(createParams.get("line_items[0][price_data][unit_amount]")).toBe("66633");
        expect(createParams.get("payment_intent_data[application_fee_amount]")).toBe(String(expectedFirstFee));
        expect(createParams.get("payment_intent_data[setup_future_usage]")).toBe("off_session");
        expect(createParams.get("custom_text[submit][message]")).toContain("$666.33 today, then $666.33, $666.34");
        const metadata = Object.fromEntries([...createParams].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
        const sessionId = config.approvedContext.mode === "live" ? "cs_OpaqueLocalLive" : "cs_test_LocalCheckout";
        body = { object: "checkout.session", id: sessionId, created: Math.floor(Date.now() / 1000), livemode: config.approvedContext.mode === "live",
          mode: "payment", customer: "cus_LocalCheckout", status: "open", payment_status: "unpaid", currency: "usd",
          amount_subtotal: 66633, amount_total: 66633, payment_intent: null, subscription: null, setup_intent: null,
          payment_link: null, recovered_from: null, payment_method_types: ["card"], total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 },
          automatic_tax: { enabled: false }, allow_promotion_codes: false, invoice_creation: { enabled: false },
          expires_at: Number(createParams.get("expires_at")), success_url: createParams.get("success_url"), cancel_url: createParams.get("cancel_url"),
          custom_text: { submit: { message: createParams.get("custom_text[submit][message]") } },
          consent_collection: { payment_method_reuse_agreement: { position: "auto" },
            ...(createParams.get("consent_collection[terms_of_service]") === "required" ? { terms_of_service: "required" } : {}) }, metadata,
          url: `https://checkout.stripe.com/c/pay/${sessionId}#synthetic-private-marker` };
        objects.set(`/v1/checkout/sessions/${sessionId}`, body as Body);
      } else if (method === "DELETE" && url.pathname === "/v1/subscriptions/sub_LocalCheckout") {
        expect([...url.searchParams]).toEqual([["invoice_now", "false"], ["prorate", "false"]]);
        expect(init?.body == null || init.body === "").toBe(true);
        expect(headers.has("idempotency-key")).toBe(false);
        const sub = objects.get(url.pathname)!;
        Object.assign(sub, { status: "canceled", canceled_at: Math.floor(Date.now() / 1000), ended_at: Math.floor(Date.now() / 1000) }); body = sub;
      } else if (url.pathname === "/v1/subscriptions/sub_LocalCheckout") {
        const params = new URLSearchParams(String(init?.body));
        expect(params.get("pause_collection[behavior]")).toBe("keep_as_draft");
        expect(params.get("proration_behavior")).toBe("none");
        expect(params.get("default_payment_method")).toBe("pm_LocalCheckout");
        expect(headers.get("idempotency-key")).toMatch(/^cn-exact-v2-activate:[a-f0-9-]{36}:[a-f0-9]{64}:[a-f0-9]{64}$/);
        const sub = objects.get(url.pathname)!;
        Object.assign(sub, { trial_end: Number(params.get("trial_end")), billing_cycle_anchor: Number(params.get("trial_end")),
          cancel_at: Number(params.get("cancel_at")), default_payment_method: "pm_LocalCheckout",
          metadata: { ...(sub.metadata as Body), installment_activation_version: "first-paid-context-v2" } });
        body = sub;
      } else if (url.pathname === "/v1/invoices/in_LocalRenewal/pay") {
        const p = new URLSearchParams(String(init?.body)), isRetry = p.get("off_session") === "false";
        const card = isRetry ? "pm_LocalReplacement" : "pm_LocalCheckout";
        expect([...p]).toEqual([["payment_method", card], ["off_session", isRetry ? "false" : "true"]]);
        expect(headers.get("idempotency-key")).toMatch(isRetry ? /^cn-exact-v2-retry:[a-f0-9-]{36}:[a-f0-9]{64}:[a-f0-9]{64}:pay-once-v1$/ : /^cn-exact-v2-invoice:[a-f0-9]{64}:pay-once-v1$/);
        const inv = objects.get("/v1/invoices/in_LocalRenewal")!, pi = objects.get("/v1/payment_intents/pi_LocalRenewal")!;
        Object.assign(inv, { status: "paid", attempted: true, attempt_count: 1, amount_remaining: 0, amount_paid: inv.total });
        Object.assign(pi, { status: "succeeded", amount_received: inv.total, payment_method: card, latest_charge: "ch_LocalRenewal" });
        Object.assign((objects.get("/v1/invoice_payments")!.data as Body[])[0], { status: "paid", amount_paid: inv.total });
        objects.set("/v1/charges/ch_LocalRenewal", { ...objects.get("/v1/charges/ch_LocalCheckout"), id: "ch_LocalRenewal",
          payment_intent: "pi_LocalRenewal", amount: inv.total, amount_captured: inv.total, created: Math.floor(Date.now() / 1000),
          balance_transaction: "txn_LocalRenewal", payment_method: card });
        objects.set("/v1/balance_transactions/txn_LocalRenewal", { object: "balance_transaction", id: "txn_LocalRenewal", source: "ch_LocalRenewal",
          type: "charge", currency: "usd", amount: inv.total, fee: 1962, net: Number(inv.total) - 1962 });
        body = inv;
      } else if (/^\/v1\/invoices\/in_LocalRenewal(?:\/(?:add_lines|finalize))?$/.test(url.pathname)) {
        const p = new URLSearchParams(String(init?.body)), inv = objects.get("/v1/invoices/in_LocalRenewal")!;
        expect(headers.get("idempotency-key")).toMatch(/^cn-exact-v2-invoice:[a-f0-9]{64}:(configure|finalize|final-cent)$/);
        if (url.pathname.endsWith("/add_lines")) {
          expect(p.get("lines[0][amount]")).toBe("1"); expect(p.get("lines[0][discountable]")).toBe("false");
          const lines = inv.lines as { data: Body[] };
          lines.data.push({ ...lines.data[0], id: "il_LocalResidual", amount: 1, discountable: false,
            metadata: { installment_adjustment: p.get("lines[0][metadata][installment_adjustment]"),
              installment_plan_id: p.get("lines[0][metadata][installment_plan_id]"), booking_payment_id: p.get("lines[0][metadata][booking_payment_id]") },
            parent: { type: "invoice_item_details", invoice_item_details: { proration: false, subscription: null } } });
          inv.amount_due = inv.amount_remaining = inv.total = inv.subtotal = 66634;
        } else if (url.pathname.endsWith("/finalize")) {
          expect([...p]).toEqual([["auto_advance", "false"]]); inv.status = "open";
          objects.get("/v1/payment_intents/pi_LocalRenewal")!.amount = inv.total;
          (objects.get("/v1/invoice_payments")!.data as Body[])[0].amount_requested = inv.total;
        } else {
          expect(p.get("auto_advance")).toBe("false"); expect(p.get("application_fee_amount")).toBe("9958");
          expect(p.get("transfer_data[destination]")).toBe("acct_LocalCreator");
          inv.application_fee_amount = Number(p.get("application_fee_amount"));
          inv.metadata = Object.fromEntries([...p].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
        }
        body = inv;
      } else throw Error("Unexpected synthetic Stripe write");
    } else {
      expect(url.origin).toBe(config.configuredSupabaseUrl); expect(headers.get("apikey")).toBe(config.supabaseServiceKey);
      if (url.pathname === "/rest/v1/exact_installment_context_reservations_v2") {
        body = (await db.query("select * from public.exact_installment_context_reservations_v2 where id=$1", [reservationId])).rows;
      } else {
        const a = method === "POST" ? JSON.parse(String(init?.body)) : Object.fromEntries(url.searchParams);
        const cardRpc = url.pathname.includes("_context_card_setup_v2");
        const retryRpc = url.pathname.includes("_context_buyer_retry_v2");
        const refundRpc = url.pathname.endsWith("run_exact_context_admin_refund_v2");
        body = await rpc(url.pathname.slice(rpcPrefix.length), url.pathname.endsWith("_pin_v2") ? [] : [a.p_reservation_id, a.p_actor_id,
          typeof a.p_context === "string" ? a.p_context : JSON.stringify(a.p_context),
          ...(refundRpc ? [a.p_ledger_id, a.p_phase, JSON.stringify(a.p_payload)] : []),
          ...(a.p_phase && !a.p_invoice_id && !refundRpc ? [a.p_request_id, a.p_token, a.p_phase, JSON.stringify(a.p_proof)] : []), ...(a.p_stage ? [a.p_stage] : []),
          ...(a.p_attempt_id ? [a.p_attempt_id, a.p_session_id, a.p_request_id] : []), ...(a.p_receipt && !a.p_invoice_id ? [JSON.stringify(a.p_receipt)] : []),
          ...(a.p_item_id ? [a.p_payment_method_id, a.p_item_id] : []), ...(a.p_invoice_id ? [a.p_invoice_id] : []),
          ...(cardRpc ? [a.p_request_id, ...(a.p_phase ? [a.p_phase, JSON.stringify(a.p_proof)] : [])] : []),
          ...(retryRpc ? [a.p_quote_id, ...(a.p_phase ? [a.p_phase, JSON.stringify(a.p_proof)] : [])] : []),
          ...(url.pathname.endsWith("read_exact_context_bank_v2") ? [a.p_for_action] : []),
          ...(a.p_period_start ? [a.p_subscription_id, a.p_period_start, a.p_period_end] : []),
          ...(a.p_token && !a.p_phase ? [a.p_token] : []), ...(a.p_invoice_id && a.p_payment_intent_id ? [a.p_payment_intent_id] : []),
          ...(a.p_receipt && a.p_invoice_id ? [JSON.stringify(a.p_receipt)] : []),
          ...(a.p_event ? [JSON.stringify(a.p_event)] : []),
          ...(url.pathname.endsWith("observe_exact_context_subscription_v2") ? [JSON.stringify(a.p_read), a.p_disposition, JSON.stringify(a.p_details)] : []),
          ...(a.p_phase && a.p_invoice_id && !cardRpc && !retryRpc ? [a.p_phase, JSON.stringify(a.p_read), a.p_outcome, JSON.stringify(a.p_evidence)] : []),
          ...(a.p_proof && !a.p_phase ? [JSON.stringify(a.p_proof)] : [])], method === "GET");
      }
    }
    body = await change(JSON.parse(JSON.stringify(body)) as Body, url.pathname, method);
    const bytes = JSON.stringify(body), response = new Response(bytes, { status: 200,
      headers: { "content-type": "application/json", "request-id": `req_Local${requests.length}` } });
    Object.defineProperties(response, { url: { value: url.href }, json: { value: async () => JSON.parse(bytes) } });
    return response;
  };
  return { runtime: createExactContextCheckout(config, fetcher), credit: createExactContextFirstCredit(config, fetcher),
    activation: createExactContextActivation(config, fetcher), invoice: createExactContextInvoicePreparation(config, fetcher),
    collection: createExactContextInvoiceCollection(config, fetcher), financial: createExactContextFinancialEvents(config, fetcher),
    stop: createExactContextBillingStop(config, fetcher), recovery: createExactContextPaymentRecovery(config, fetcher), card: createExactContextCardSetup(config, fetcher),
    retry: createExactContextBuyerRetry(config, fetcher),
    bank: createExactContextBankVerification(config, fetcher, bankPublicKey), requests,
    subscription: createExactContextSubscriptionObservation(config, fetcher),
    adminRefund: createExactContextAdminRefund(config, fetcher),
    publication: createExactContextCheckoutPublication(config, fetcher),
    cardPublication: createExactContextCardSetupPublication(config, fetcher),
    stripeWrites: () => requests.filter(r => r.method !== "GET" && r.path.startsWith("/v1/")),
    receiptWrites: () => requests.filter(r => r.path === rpcPrefix + "record_exact_context_first_receipt_v2") };
}
async function installDatabase() {
  db = createLocalPostgres(); await installStagingStructuralBaseline(db); await installExactMigrationsInMemory(db);
  for (const file of ["058-payment-context-reservations.sql", "059-context-customer-operation-plans.sql", "060-context-customer-dispatch.sql", "061-context-held-bootstrap.sql"])
    await db.exec(readFileSync(join(process.cwd(), "supabase/proposals", file), "utf8"));
  await db.exec("alter default privileges in schema public grant all on tables to anon,authenticated,service_role");
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/062-context-checkout-receipt.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/063-context-first-credit.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/064-context-held-activation.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/065-context-invoice-preparation.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/066-context-invoice-collection.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/067-context-financial-events.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/068-context-billing-stop.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/069-context-payment-recovery.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/070-context-card-setup.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/071-context-buyer-retry.sql"), "utf8"));
  // Existing 021 functions, unchanged. The catalog fixture has the tables but
  // excludes these two unrelated-to-earlier-checkout dependency bodies.
  const oldRefund = readFileSync(join(process.cwd(), "supabase/schema/021-admin-refund-operations.sql"), "utf8");
  for (const name of ["create_refund_operation", "claim_refund_operation"]) {
    const start = oldRefund.indexOf(`create or replace function public.${name}(`);
    const end = oldRefund.indexOf("$$;", oldRefund.indexOf("as $$", start)) + 3;
    if (start < 0 || end < start) throw Error("Original refund function missing");
    await db.exec(oldRefund.slice(start, end));
  }
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/072-context-admin-refunds.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/073-context-event-routing.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/074-context-checkout-publication.sql"), "utf8"));
}
beforeAll(installDatabase);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("begin"); objects = new Map(); expectedFirstFee = 9958; localSqlErrors.length = 0;
  freshRpcTransactions = /^(activation|invoice|collection|financial|stop|recovery|card|retry|future|bank|subscription|refund|ordering|publication) /.test(expect.getState().currentTestName ?? "");
  committedFixture = false;
  await db.query("insert into auth.users(id) values($1),($2)", [ids.buyer, ids.creator]);
  await db.query("insert into profiles(id,stripe_onboarding_complete,stripe_account_id) values($1,false,null),($2,true,'acct_LocalCreator')", [ids.buyer, ids.creator]);
  await db.query("insert into products(id,creator_id,type,title,is_active,price_cents,amount_cents,currency) values($1,$2,'mentorship','Local Checkout',true,199900,199900,'usd')", [ids.product, ids.creator]);
  await db.query("insert into posts(id,product_id,creator_id,user_id) values($1,$2,$3,$3)", [ids.post, ids.product, ids.creator]);
  await db.query("insert into bookings(id,post_id,creator_id,buyer_id,status) values($1,$2,$3,$4,'booked')", [ids.booking, ids.post, ids.creator, ids.buyer]);
  config = { approvedContext: { ...context }, vercelEnvironment: "preview", configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`,
    configuredSiteOrigin: context.siteOrigin, stripeSecretKey: "sk_test_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "test",
    supabaseServiceKey: "sb_secret_SYNTHETICNOTACREDENTIAL", expectedApiVersion: "2025-10-29.clover" };
});
afterEach(async () => {
  await db.exec("rollback");
  // Only the new activation cases commit fixtures. Destroy their isolated
  // in-memory database rather than weakening immutable production constraints.
  if (committedFixture) { await db.close(); await installDatabase(); }
});
async function seedHeld(firstFee = fee) {
  const c = JSON.stringify(config.approvedContext), live = config.approvedContext.mode === "live";
  await db.query("insert into public.exact_installment_context_pin_v2(context) values($1::jsonb)", [c]);
  reservationId = (await db.query<{ id: string }>("select * from public.reserve_exact_installment_context_v2($1,$2,3,$3::jsonb,$4::jsonb,$5::jsonb)",
    [ids.booking, ids.creator, c, JSON.stringify(firstFee), JSON.stringify(fee)])).rows[0].id;
  const args = [reservationId, ids.creator, c];
  const op = (await db.query<{ request: { params: { metadata: Body } } }>("select * from public.plan_exact_customer_operation_v2($1,$2,$3::jsonb)", args)).rows[0];
  const ca = (await db.query<{ value: { attempt: { id: string; claimed_at: string } } }>("select public.claim_exact_customer_dispatch_v2($1,$2,$3::jsonb) value", args)).rows[0].value.attempt;
  await db.query("select public.bind_exact_customer_dispatch_v2($1,$2,$3::jsonb,$4,'cus_LocalCheckout','req_SeedCustomer',$5)",
    [...args, ca.id, Math.floor(Date.parse(ca.claimed_at) / 1000)]);
  objects.set("/v1/customers/cus_LocalCheckout", { object: "customer", id: "cus_LocalCheckout", livemode: live, balance: 0,
    email: null, default_source: null, invoice_settings: { default_payment_method: null }, test_clock: null, delinquent: false, metadata: op.request.params.metadata });
  for (const stage of ["product", "subscription", "hold"]) {
    const step = (await db.query<{ value: { attempt: { id: string; request: { params: Body } } } }>("select public.claim_exact_held_step_v2($1,$2,$3::jsonb,$4) value", [...args, stage])).rows[0].value.attempt;
    const providerId = stage === "product" ? "prod_LocalCheckout" : "sub_LocalCheckout";
    await db.query("select public.bind_exact_held_step_v2($1,$2,$3::jsonb,$4,$5,$6,'req_SeedHeld')", [...args, stage, step.id, providerId]);
    const p = step.request.params;
    if (stage === "product") objects.set(`/v1/products/${providerId}`, { object: "product", id: providerId, livemode: live,
      active: true, name: p.name, metadata: p.metadata, default_price: null });
    if (stage === "subscription") objects.set(`/v1/subscriptions/${providerId}`, { ...p, object: "subscription", id: providerId, livemode: live,
      status: "trialing", cancel_at_period_end: false, default_payment_method: null, default_source: null, application_fee_percent: null,
      automatic_tax: { enabled: false }, discounts: [], default_tax_rates: [], pending_update: null, schedule: null, test_clock: null,
      pause_collection: { behavior: "keep_as_draft", resumes_at: null },
      created: Math.floor(Date.now() / 1000), items: { has_more: false, data: [{ id: "si_LocalCheckout", subscription: providerId,
        quantity: 1, tax_rates: [], discounts: [], price: { id: "price_LocalCheckout", active: true, livemode: live,
        currency: "usd", product: "prod_LocalCheckout", unit_amount: 66633, billing_scheme: "per_unit",
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] } });
  }
}
function paySyntheticSession() {
  const session = [...objects.values()].find(o => o.object === "checkout.session")!;
  session.status = "complete"; session.payment_status = "paid"; session.payment_intent = "pi_LocalCheckout";
  if ((session.consent_collection as Body).terms_of_service === "required") session.consent = { terms_of_service: "accepted" };
  const live = config.approvedContext.mode === "live", metadata = session.metadata;
  objects.set("/v1/payment_intents/pi_LocalCheckout", { object: "payment_intent", id: "pi_LocalCheckout", livemode: live,
    status: "succeeded", currency: "usd", customer: "cus_LocalCheckout", amount: 66633, amount_received: 66633,
    application_fee_amount: Number(createParams.get("payment_intent_data[application_fee_amount]")),
    transfer_data: { destination: createParams.get("payment_intent_data[transfer_data][destination]") }, setup_future_usage: "off_session",
    metadata, payment_method: "pm_LocalCheckout", latest_charge: "ch_LocalCheckout" });
  objects.set("/v1/charges/ch_LocalCheckout", { object: "charge", id: "ch_LocalCheckout", livemode: live,
    payment_intent: "pi_LocalCheckout", customer: "cus_LocalCheckout", status: "succeeded", paid: true, captured: true,
    currency: "usd", amount: 66633, amount_captured: 66633, application_fee_amount: Number(createParams.get("payment_intent_data[application_fee_amount]")), payment_method_details: { type: "card" },
    payment_method: "pm_LocalCheckout", refunded: false, amount_refunded: 0, disputed: false, created: Math.floor(Date.now() / 1000),
    balance_transaction: "txn_LocalCheckout" });
  objects.set("/v1/balance_transactions/txn_LocalCheckout", { object: "balance_transaction", id: "txn_LocalCheckout", source: "ch_LocalCheckout",
    type: "charge", currency: "usd", amount: 66633, fee: 1962, net: 64671 });
  objects.set("/v1/payment_methods/pm_LocalCheckout", { object: "payment_method", id: "pm_LocalCheckout", livemode: live, type: "card", customer: "cus_LocalCheckout" });
  objects.set("/v1/invoices", { object: "list", has_more: false, data: [] });
}
async function financialSnapshot() {
  return (await db.query<{ kind: string; details: Body }>(`select 'booking' kind,to_jsonb(r) details from public.bookings r union all select 'payment',to_jsonb(r) from public.booking_payments r
    union all select 'purchase',to_jsonb(r) from public.purchases r union all select 'agreement',to_jsonb(r) from public.exact_installment_agreements r
    union all select 'receipt',to_jsonb(r) from public.exact_installment_receipts r order by 1,2`)).rows;
}

test("publication delivers the original URL once, without financial credit, then yields to actual credit", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator);
  const before = await financialSnapshot(); h.requests.length = 0;
  const first = await h.publication.publishCheckout(reservationId, ids.creator);
  expect(first).toMatchObject({ status: "checkout_published", reservationId, reused: false, accountingOperationsAllowed: false });
  expect(await h.publication.publishCheckout(reservationId, ids.creator)).toMatchObject({ ...first, reused: true });
  expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
  const args = [ids.creator, [ids.booking]];
  const links = await db.query<{ value: Body[] }>("select read_exact_context_checkout_links_v2($1,$2::uuid[]) value", args);
  expect(links.rows[0].value).toMatchObject([{ reservationId, sessionId: "cs_test_LocalCheckout", url: first.status === "checkout_published" ? first.url : null }]);
  expect((await db.query<{ value: Body[] }>("select read_exact_context_checkout_links_v2($1,$2::uuid[]) value", [ids.buyer, [ids.booking]])).rows[0].value).toEqual([]);
  paySyntheticSession(); await h.credit.creditFirstPayment(reservationId, ids.creator);
  expect((await db.query<{ value: Body[] }>("select read_exact_context_checkout_links_v2($1,$2::uuid[]) value", args)).rows[0].value).toEqual([]);
  expect((await db.query("select status,link_url from booking_payments")).rows).toEqual([{ status: "completed", link_url: null }]);
});
test("publication lost database reply reuses only the existing URL and performs no provider writes", async () => {
  await seedHeld(); await harness().runtime.prepareCheckout(reservationId, ids.creator);
  const h = harness((b, path) => { if (path.endsWith("publish_exact_context_checkout_v2")) throw Error("Synthetic lost publication reply"); return b; });
  await expect(h.publication.publishCheckout(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const retry = harness(); expect(await retry.publication.publishCheckout(reservationId, ids.creator)).toMatchObject({ status: "checkout_published", reused: true });
  expect(h.stripeWrites()).toEqual([]); expect(retry.stripeWrites()).toEqual([]);
  expect((await db.query("select count(*)::int n from exact_context_checkout_publications_v2")).rows).toEqual([{ n: 1 }]);
});
test.each(["foreign_url", "wrong_actor", "expired", "paid", "unprepared"])("publication rejects %s without financial or link writes", async fault => {
  await seedHeld(); if (fault !== "unprepared") await harness().runtime.prepareCheckout(reservationId, ids.creator);
  const before = await financialSnapshot();
  if (fault === "paid") paySyntheticSession();
  const h = harness((b, path) => {
    if (path === "/v1/checkout/sessions/cs_test_LocalCheckout") {
      if (fault === "foreign_url") b.url = "https://checkout.stripe.com.attacker.example/c/pay/cs_test_LocalCheckout";
      if (fault === "expired") b.expires_at = Math.floor(Date.now() / 1000) - 1;
    } return b;
  });
  await expect(h.publication.publishCheckout(reservationId, fault === "wrong_actor" ? ids.buyer : ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
  expect((await db.query("select count(*)::int n from exact_context_checkout_publications_v2")).rows).toEqual([{ n: 0 }]);
});
test("publication keeps private links inaccessible to browser database roles", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,'public.exact_context_checkout_publications_v2','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') allowed", [role])).rows[0].allowed).toBe(false);
    for (const fn of ["public.publish_exact_context_checkout_v2(uuid,uuid,jsonb,jsonb)", "public.read_exact_context_checkout_links_v2(uuid,uuid[])"]) {
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, fn])).rows[0].allowed).toBe(role === "service_role");
    }
  }
});

function recoveryEvent(type = "invoice.payment_failed", apiVersion = config.expectedApiVersion) {
  objects.set("/v1/events/evt_LocalRecovery", { object: "event", id: "evt_LocalRecovery", type,
    api_version: apiVersion, livemode: config.approvedContext.mode === "live", created: Math.floor(Date.now() / 1000),
    data: { object: structuredClone(objects.get("/v1/invoices/in_LocalRenewal")) } });
  return "evt_LocalRecovery";
}

test.each(["expired", "failed"])("unpaid Checkout %s observation never changes financial state or prepares another link", async kind => {
  await seedHeld(); await harness().runtime.prepareCheckout(reservationId, ids.creator);
  const session = objects.get("/v1/checkout/sessions/cs_test_LocalCheckout")!;
  if (kind === "expired") session.status = "expired";
  else {
    paySyntheticSession(); Object.assign(session, { status: "open", payment_status: "unpaid" });
    Object.assign(objects.get("/v1/payment_intents/pi_LocalCheckout")!, { status: "requires_payment_method", amount_received: 0, amount_capturable: 0, latest_charge: null });
  }
  const before = await financialSnapshot(), h = harness();
  expect(await h.runtime.inspectUnpaidCheckout(reservationId, ids.creator)).toMatchObject({ status: "checkout_unpaid_observed", sessionId: "cs_test_LocalCheckout" });
  expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toEqual([]); expect(h.receiptWrites()).toEqual([]);
});
test.each(["received", "customer", "paid-charge", "lifted-hold"])("unpaid Checkout %s ambiguity cannot be acknowledged", async fault => {
  await seedHeld(); await harness().runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  Object.assign(objects.get("/v1/checkout/sessions/cs_test_LocalCheckout")!, { status: "open", payment_status: "unpaid" });
  const pi = objects.get("/v1/payment_intents/pi_LocalCheckout")!;
  Object.assign(pi, { status: "requires_payment_method", amount_received: 0, amount_capturable: 0, latest_charge: null });
  if (fault === "received") pi.amount_received = 66633;
  if (fault === "customer") pi.customer = "cus_Foreign";
  if (fault === "paid-charge") pi.latest_charge = "ch_LocalCheckout";
  if (fault === "lifted-hold") objects.get("/v1/subscriptions/sub_LocalCheckout")!.pause_collection = null;
  const before = await financialSnapshot(), h = harness();
  await expect(h.runtime.inspectUnpaidCheckout(reservationId, ids.creator)).rejects.toThrow();
  expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});
test("unpaid Checkout delayed signal reports verified capture without credit or activation", async () => {
  await seedHeld(); await harness().runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  const before = await financialSnapshot(), h = harness();
  expect(await h.runtime.inspectUnpaidCheckout(reservationId, ids.creator)).toMatchObject({ status: "captured_payment_verified" });
  expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toEqual([]); expect(h.receiptWrites()).toEqual([]);
});
async function seedRecovery(status = "requires_payment_method", number: 2 | 3 = 2) {
  await seedInvoicePrecursor(number, number === 3);
  const h = harness((b, path) => {
    if (path.endsWith("/pay")) {
      Object.assign(objects.get("/v1/invoices/in_LocalRenewal")!, { status: "open", amount_paid: 0, amount_remaining: objects.get("/v1/invoices/in_LocalRenewal")!.total,
        status_transitions: { voided_at: null } });
      Object.assign(objects.get("/v1/payment_intents/pi_LocalRenewal")!, { status, amount_received: 0,
        amount_capturable: 0, canceled_at: null, next_action: null, latest_charge: null });
      Object.assign((objects.get("/v1/invoice_payments")!.data as Body[])[0], { status: "open", amount_paid: 0 });
      throw Error("Synthetic original decline");
    }
    return b;
  });
  expect(await h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "reconciliation_required" });
  expect(h.stripeWrites().filter(q => q.path.endsWith("/pay"))).toHaveLength(1);
  return recoveryEvent();
}
async function recoveryRows() {
  return (await db.query("select revision,outcome from exact_installment_payment_recoveries")).rows;
}
test.each([["requires_payment_method", "payment_method_required"], ["requires_action", "action_required"], ["processing", "payment_pending"]])(
  "recovery observes %s without changing money, access or dispatch", async (status, outcome) => {
    const eventId = await seedRecovery(status), before = await financialSnapshot(), h = harness();
    expect(await h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId)).toMatchObject({ status: "payment_recovery_recorded", outcome });
    expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
    expect(await recoveryRows()).toMatchObject([{ revision: 1, outcome }]);
    expect((await db.query("select reason from exact_installment_collection_holds where reason='invoice_recovery'")).rows).toHaveLength(1);
    const begin = h.requests.findIndex(q => q.path.endsWith("run_exact_context_recovery_v2"));
    expect(begin).toBeGreaterThan(0); expect(begin).toBeLessThan(h.requests.findIndex(q => q.path === "/v1/invoices/in_LocalRenewal"));
  });
test("recovery repeated cleared-card decline only advances observation revision", async () => {
  const eventId = await seedRecovery(), before = await financialSnapshot(), h = harness();
  objects.get("/v1/payment_intents/pi_LocalRenewal")!.payment_method = null;
  for (let i = 0; i < 2; i++) expect(await h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId))
    .toMatchObject({ outcome: "payment_method_required" });
  expect(await recoveryRows()).toMatchObject([{ revision: 2 }]); expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});
test("recovery voided original invoice requires actual canceled PI and never voids it", async () => {
  await seedRecovery(); const now = Math.floor(Date.now() / 1000);
  Object.assign(objects.get("/v1/invoices/in_LocalRenewal")!, { status: "void", amount_remaining: 0, status_transitions: { voided_at: now } });
  Object.assign(objects.get("/v1/payment_intents/pi_LocalRenewal")!, { status: "canceled", canceled_at: now });
  Object.assign((objects.get("/v1/invoice_payments")!.data as Body[])[0], { status: "canceled" });
  const eventId = recoveryEvent("invoice.voided"), before = await financialSnapshot(), h = harness();
  expect(await h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId)).toMatchObject({ outcome: "terminal_unpaid" });
  expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});
test.each(["owner", "mode", "amount", "read_failure"])("recovery rejects %s evidence without new charge", async fault => {
  const eventId = await seedRecovery(), before = await financialSnapshot();
  if (fault === "owner") ((objects.get("/v1/events/evt_LocalRecovery")!.data as Body).object as Body).customer = "cus_Foreign";
  if (fault === "mode") objects.get("/v1/payment_intents/pi_LocalRenewal")!.livemode = true;
  if (fault === "amount") objects.get("/v1/payment_intents/pi_LocalRenewal")!.amount = 1;
  const h = harness((b, path) => { if (fault === "read_failure" && path.includes("/payment_intents/")) throw Error("Synthetic private read error"); return b; });
  await expect(h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
  expect(await recoveryRows()).toHaveLength(fault === "owner" ? 0 : 1);
  if (fault !== "owner") expect(await recoveryRows()).toMatchObject([{ revision: 0, outcome: null }]);
});
test.each([false, true].flatMap(failed => ["2025-09-30.clover", "2025-10-29.clover"].map(version => ({ failed, version }))))(
  "recovery actual late success reuses once-only credit with prior failure $failed and original $version Event", async ({ failed, version }) => {
  await seedInvoicePrecursor();
  const original = harness((b, path) => { if (path === "/v1/payment_intents/pi_LocalRenewal" && b.status === "succeeded") throw Error("Synthetic lost capture read"); return b; });
  await expect(original.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect((await db.query("select paid_count from purchases")).rows).toEqual([{ paid_count: 1 }]);
  const eventId = recoveryEvent(failed ? "invoice.payment_failed" : "invoice.paid"), h = harness();
  objects.get(`/v1/events/${eventId}`)!.api_version = version;
  for (let i = 0; i < 2; i++) expect(await h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId))
    .toMatchObject(failed ? { outcome: "paid_accounted" } : { status: i === 0 ? "credited" : "already_credited" });
  expect(h.stripeWrites()).toEqual([]); expect((await db.query("select paid_count from purchases")).rows).toEqual([{ paid_count: 2 }]);
  expect((await db.query("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{ n: 2 }]);
  expect(await recoveryRows()).toHaveLength(failed ? 1 : 0);
});
test("recovery committed observation with lost response remains read-only on replay", async () => {
  const eventId = await seedRecovery(), before = await financialSnapshot(); let lost = false;
  const h = harness((b, path) => { if (!lost && path.endsWith("run_exact_context_recovery_v2") && b.saved === true) { lost = true; throw Error("Synthetic lost observation response"); } return b; });
  await expect(h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId)).toMatchObject({ outcome: "payment_method_required" });
  expect(lost).toBe(true); expect(await recoveryRows()).toMatchObject([{ revision: 2 }]); expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});
test("recovery stale overlapping observation cannot overwrite a newer revision", async () => {
  const eventId = await seedRecovery(), before = await financialSnapshot(); let intervened = false;
  const second = harness(), h = harness(async (b, path) => {
    if (!intervened && path === "/v1/payment_intents/pi_LocalRenewal") {
      intervened = true;
      expect(await second.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId)).toMatchObject({ outcome: "payment_method_required" });
    }
    return b;
  });
  expect(await h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId)).toMatchObject({ status: "reconciliation_required" });
  expect(await recoveryRows()).toMatchObject([{ revision: 1 }]); expect([...h.stripeWrites(), ...second.stripeWrites()]).toEqual([]);
  expect(await financialSnapshot()).toEqual(before);
});
test("recovery SQL denies client access, wrong context and old entry bypass", async () => {
  const eventId = await seedRecovery(), before = await financialSnapshot(), h = harness();
  const signature = "public.run_exact_context_recovery_v2(uuid,uuid,jsonb,text,jsonb,text,jsonb,text,jsonb)";
  for (const role of ["anon", "authenticated"]) expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows)
    .toEqual([{ allowed: false }]);
  await expect(h.recovery.recoverInvoice(reservationId, ids.buyer, "in_LocalRenewal", eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  await db.exec("savepoint recovery_denied; set local role service_role");
  await expect(db.query("select public.begin_exact_installment_recovery($1,'in_LocalRenewal')", [reservationId])).rejects.toThrow("Context-scoped payment entry required");
  await db.exec("rollback to savepoint recovery_denied; reset role; release savepoint recovery_denied");
  const e = objects.get("/v1/events/evt_LocalRecovery")!;
  const locator = { id: e.id, type: e.type, invoiceId: "in_LocalRenewal", customerId: "cus_LocalCheckout", subscriptionId: "sub_LocalCheckout", created: e.created, livemode: false };
  await expect(rpc("run_exact_context_recovery_v2", [reservationId, ids.creator, JSON.stringify({ ...context, platformAccountId: "acct_Foreign" }),
    "in_LocalRenewal", JSON.stringify(locator), "begin", "null", null, "null"])).rejects.toThrow();
  expect(await recoveryRows()).toEqual([]); expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});
test("recovery genuine synthetic live context observes without weakening old Sandbox guards", async () => {
  config = { ...config, approvedContext: { ...context, mode: "live", siteOrigin: "https://synthetic-checkout.example" },
    configuredSiteOrigin: "https://synthetic-checkout.example", vercelEnvironment: "production", stripePublishableKeyMode: "live", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL" };
  const eventId = await seedRecovery(), before = await financialSnapshot(), h = harness();
  expect(await h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId))
    .toMatchObject({ outcome: "payment_method_required", context: { mode: "live" } });
  expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});

const cardRequest = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const cardConsent = { accepted: true, consentVersion: CARD_SETUP_CONSENT_VERSION };
test("card app recovery view reuses eligibility and is buyer/context-bound without financial changes", async () => {
  await seedCard(); const before = await financialSnapshot(), holds = await stopHolds();
  const result = (await db.query<{ value: Body }>("select read_exact_context_buyer_view_v2($1,$2,$3::jsonb) value",
    [reservationId, ids.buyer, JSON.stringify(config.approvedContext)])).rows[0].value;
  expect(result).toMatchObject({ agreementStatus: "active", invoiceId: "in_LocalRenewal",
    view: { agreementId: reservationId, amountCents: 66633, paymentNumber: 2, setupEligible: true, setupState: "not_started", outcome: "payment_method_required" } });
  expect(await financialSnapshot()).toEqual(before); expect(await stopHolds()).toEqual(holds);
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
  expect((await db.query<{ allowed: boolean }>("select has_function_privilege('authenticated','read_exact_context_buyer_view_v2(uuid,uuid,jsonb)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
  // The intentional SQL rejection aborts this test's transaction. Leave it
  // last; afterEach rolls it back rather than attempting another query in it.
  await expect(db.query("select read_exact_context_buyer_view_v2($1,$2,$3::jsonb)", [reservationId, ids.creator, JSON.stringify(config.approvedContext)])).rejects.toThrow();
});
test("card app publishes only the already consented Setup URL with no payment or hold release", async () => {
  await seedCard(); const h = harness(); await h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent);
  const before = await financialSnapshot(), holds = await stopHolds(), saved = await savedCardRows(); h.requests.length = 0;
  expect(await h.cardPublication.readRedirect(reservationId, ids.buyer, "in_LocalRenewal", cardRequest)).toMatchObject({ status: "card_setup_ready",
    url: "https://checkout.stripe.com/c/pay/cs_test_LocalCard#synthetic-private-card", paymentAttempted: false });
  expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before); expect(await stopHolds()).toEqual(holds); expect(await savedCardRows()).toEqual(saved);
});
test.each(["unprepared", "foreign_url", "completed"])("card app rejects %s setup publication", async fault => {
  await seedCard(); const h = harness();
  if (fault !== "unprepared") await h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent);
  if (fault === "foreign_url") objects.get("/v1/checkout/sessions/cs_test_LocalCard")!.url = "https://foreign.invalid/c/pay/cs_test_LocalCard";
  if (fault === "completed") completeSyntheticCard();
  h.requests.length = 0;
  await expect(h.cardPublication.readRedirect(reservationId, ids.buyer, "in_LocalRenewal", cardRequest)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toEqual([]);
});
async function seedCard(number: 2 | 3 = 2) {
  const eventId = await seedRecovery("requires_payment_method", number);
  expect(await harness().recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId))
    .toMatchObject({ outcome: "payment_method_required" });
  // Actual provider shapes needed by the reused 051 card checks.
  objects.get("/v1/subscriptions/sub_LocalCheckout")!.ended_at = null;
}
async function savedCardRows() {
  return (await db.query(`select stripe_checkout_session_id,stripe_setup_intent_id,replacement_payment_method_id,context_mode,
    context_dispatch_token is not null dispatched from exact_installment_card_setups`)).rows;
}
function completeSyntheticCard() {
  const live = config.approvedContext.mode === "live", sid = live ? "cs_LocalCard" : "cs_test_LocalCard";
  const session = objects.get(`/v1/checkout/sessions/${sid}`)!;
  Object.assign(session, { status: "complete", setup_intent: "seti_LocalCard" });
  objects.set("/v1/setup_intents/seti_LocalCard", { object: "setup_intent", id: "seti_LocalCard", livemode: live,
    customer: "cus_LocalCheckout", metadata: session.metadata, created: Math.floor(Date.now() / 1000), usage: "off_session",
    on_behalf_of: null, payment_method_types: ["card"], status: "succeeded", payment_method: "pm_LocalReplacement" });
  objects.set("/v1/payment_methods/pm_LocalReplacement", { object: "payment_method", id: "pm_LocalReplacement", livemode: live,
    type: "card", customer: "cus_LocalCheckout" });
}
test.each(["test", "live"] as const)("card %s context saves and verifies once without charge, default change or hold release", async mode => {
  if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await seedCard(); const before = await financialSnapshot(), holds = await stopHolds();
  const originalSub = structuredClone(objects.get("/v1/subscriptions/sub_LocalCheckout"));
  const ledger = (await db.query("select * from payment_fee_ledger")).rows, h = harness();
  let result;
  try { result = await h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent); }
  catch { throw Error(`Local card error: ${localSqlErrors.join("; ")}; last paths: ${h.requests.slice(-10).map(q => q.path).join(", ")}`); }
  expect(result).toMatchObject({ status: "prepared_unpublished", paymentAttempted: false, publicationAllowed: false });
  expect(await h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent)).toEqual(result);
  expect(await h.card.verifyCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest)).toMatchObject({ status: "setup_pending" });
  completeSyntheticCard();
  for (let i = 0; i < 2; i++) expect(await h.card.verifyCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest))
    .toMatchObject({ status: "card_saved_payment_not_attempted", paymentAttempted: false, publicationAllowed: false });
  expect(h.stripeWrites()).toEqual([{ method: "POST", path: "/v1/checkout/sessions" }]);
  expect(await savedCardRows()).toEqual([{ stripe_checkout_session_id: mode === "live" ? "cs_LocalCard" : "cs_test_LocalCard",
    stripe_setup_intent_id: "seti_LocalCard", replacement_payment_method_id: "pm_LocalReplacement", context_mode: mode, dispatched: true }]);
  expect(await financialSnapshot()).toEqual(before); expect(await stopHolds()).toEqual(holds);
  expect((await db.query("select * from payment_fee_ledger")).rows).toEqual(ledger);
  expect(objects.get("/v1/subscriptions/sub_LocalCheckout")).toEqual(originalSub);
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
});

test("card consent and actual buyer are required before reserving or creating setup", async () => {
  await seedCard(); const h = harness(), before = await financialSnapshot();
  await expect(h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, { ...cardConsent, accepted: false }))
    .rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.requests).toEqual([]);
  await expect(h.card.saveCard(reservationId, ids.creator, "in_LocalRenewal", cardRequest, cardConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toEqual([]); expect(await savedCardRows()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});
test.each(["claim", "creation", "binding", "verification"])("card lost %s response cannot duplicate setup or initiate payment", async stage => {
  await seedCard(); let lost = false;
  const h = harness((body, path, method) => {
    const state = body.state as { setup?: Body } | undefined, setup = state?.setup;
    if (!lost && (stage === "creation" && method === "POST" && path === "/v1/checkout/sessions" ||
      path === rpcPrefix + "run_exact_context_card_setup_v2" && (
        stage === "claim" && body.dispatched === true || stage === "binding" && setup?.stripe_checkout_session_id && !setup.stripe_setup_intent_id ||
        stage === "verification" && setup?.stripe_setup_intent_id))) {
      lost = true; throw Error("Synthetic lost card response");
    }
    return body;
  });
  const before = await financialSnapshot(), holds = await stopHolds();
  if (stage === "verification") {
    await h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent); completeSyntheticCard();
    await expect(h.card.verifyCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(await h.card.verifyCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest)).toMatchObject({ status: "card_saved_payment_not_attempted" });
  } else {
    await expect(h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(await h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent))
      .toMatchObject({ status: stage === "binding" ? "prepared_unpublished" : "reconciliation_required" });
  }
  expect(lost).toBe(true);
  expect(h.stripeWrites()).toEqual(stage === "claim" ? [] : [{ method: "POST", path: "/v1/checkout/sessions" }]);
  expect(await financialSnapshot()).toEqual(before); expect(await stopHolds()).toEqual(holds);
  expect(await savedCardRows()).toHaveLength(1);
});
test.each(["foreign card", "live setup", "wrong context", "payable session", "wrong return"])("card %s is never verified or charged", async problem => {
  await seedCard(); const h = harness(); await h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent);
  completeSyntheticCard(); const before = await financialSnapshot();
  if (problem === "foreign card") objects.get("/v1/payment_methods/pm_LocalReplacement")!.customer = "cus_Foreign";
  if (problem === "live setup") objects.get("/v1/setup_intents/seti_LocalCard")!.livemode = true;
  if (problem === "wrong context") (objects.get("/v1/setup_intents/seti_LocalCard")!.metadata as Body).context_hash = "wrong";
  if (problem === "payable session") objects.get("/v1/checkout/sessions/cs_test_LocalCard")!.payment_intent = "pi_NotSetup";
  if (problem === "wrong return") objects.get("/v1/checkout/sessions/cs_test_LocalCard")!.success_url = "https://foreign.example";
  await expect(h.card.verifyCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await savedCardRows()).toMatchObject([{ stripe_setup_intent_id: null, replacement_payment_method_id: null }]);
  expect(h.stripeWrites()).toEqual([{ method: "POST", path: "/v1/checkout/sessions" }]); expect(await financialSnapshot()).toEqual(before);
});
test("card SQL forbids client execution, context substitution and original-entry bypass", async () => {
  await seedCard(); const before = await financialSnapshot();
  for (const signature of ["public.read_exact_context_card_setup_v2(uuid,uuid,jsonb,text,uuid)", "public.run_exact_context_card_setup_v2(uuid,uuid,jsonb,text,uuid,text,jsonb)"])
    for (const role of ["anon", "authenticated"]) expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows).toEqual([{ allowed: false }]);
  await expect(rpc("run_exact_context_card_setup_v2", [reservationId, ids.buyer, JSON.stringify({ ...context, platformAccountId: "acct_Foreign" }),
    "in_LocalRenewal", cardRequest, "reserve", JSON.stringify(cardConsent)])).rejects.toThrow();
  await db.exec("savepoint card_denied; set local role service_role");
  await expect(db.query("select public.reserve_exact_card_setup($1,$2,'in_LocalRenewal',$3,'replacement-card-setup-v1')", [cardRequest, reservationId, ids.buyer]))
    .rejects.toThrow("Context-scoped payment entry required");
  await db.exec("rollback to savepoint card_denied; reset role; release savepoint card_denied");
  expect(await savedCardRows()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});
test("card overlapping preparation shares one permanent dispatch and cannot resend", async () => {
  await seedCard(); let interleaved = false; const second = harness();
  const h = harness(async (body, path) => {
    if (!interleaved && path === rpcPrefix + "run_exact_context_card_setup_v2" && body.dispatched === true) {
      interleaved = true;
      expect(await second.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent))
        .toMatchObject({ status: "reconciliation_required" });
    }
    return body;
  });
  expect(await h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent)).toMatchObject({ status: "prepared_unpublished" });
  expect(interleaved).toBe(true); expect([...h.stripeWrites(), ...second.stripeWrites()]).toEqual([{ method: "POST", path: "/v1/checkout/sessions" }]);
});
test("card intervening stop hold blocks verification and retains original authorization", async () => {
  await seedCard(); await harness().card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent); completeSyntheticCard();
  let intervened = false; const before = await financialSnapshot();
  const h = harness(async (body, path) => {
    if (!intervened && path === "/v1/payment_methods/pm_LocalReplacement") {
      intervened = true;
      // A separate stop request has its own write transaction, not the last
      // provider-observation RPC's read-only transaction in this local harness.
      await db.exec("commit; begin");
      await db.query(`insert into exact_installment_collection_holds(agreement_id,reason,request_id,requested_by)
        values($1,'cancellation_review',gen_random_uuid(),$2)`, [reservationId, ids.creator]);
    }
    return body;
  });
  await expect(h.card.verifyCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(intervened).toBe(true); expect(h.stripeWrites()).toEqual([]);
  expect(await savedCardRows()).toMatchObject([{ stripe_setup_intent_id: null, replacement_payment_method_id: null }]);
  expect(await financialSnapshot()).toEqual(before); expect(await stopHolds()).toHaveLength(2);
});

const retryQuote = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const retryConsent = { accepted: true, consentVersion: PAY_NOW_CONSENT_VERSION };
function requireSyntheticBank() {
  const invoice = objects.get("/v1/invoices/in_LocalRenewal")!;
  Object.assign(invoice, { status: "open", amount_paid: 0, amount_remaining: invoice.total });
  Object.assign(objects.get("/v1/payment_intents/pi_LocalRenewal")!, { status: "requires_action", amount_received: 0, amount_capturable: 0,
    next_action: { type: "use_stripe_sdk", use_stripe_sdk: {} }, client_secret: "pi_LocalRenewal_secret_SYNTHETICCAPABILITY",
    confirmation_method: "automatic", capture_method: "automatic", on_behalf_of: null, canceled_at: null, latest_charge: null });
  Object.assign((objects.get("/v1/invoice_payments")!.data as Body[])[0], { status: "open", amount_paid: 0 });
}
async function seedBank(replacement = false) {
  if (replacement) {
    await seedBuyerRetry(); const h = harness((b, path) => { if (path.endsWith("/pay")) { requireSyntheticBank(); throw Error("Synthetic bank challenge"); } return b; });
    await h.retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
    expect(await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).toMatchObject({ status: "reconciliation_required" });
    expect(h.stripeWrites().filter(p => p.path.endsWith("/pay"))).toHaveLength(1);
  } else { await seedRecovery("requires_action"); requireSyntheticBank(); }
  objects.get("/v1/subscriptions/sub_LocalCheckout")!.ended_at = null;
  return recoveryEvent("invoice.payment_action_required");
}
function completeSyntheticBank() {
  const invoice = objects.get("/v1/invoices/in_LocalRenewal")!;
  Object.assign(invoice, { status: "paid", amount_paid: invoice.total, amount_remaining: 0 });
  Object.assign(objects.get("/v1/payment_intents/pi_LocalRenewal")!, { status: "succeeded", amount_received: invoice.total,
    amount_capturable: 0, next_action: null, latest_charge: "ch_LocalRenewal" });
  Object.assign((objects.get("/v1/invoice_payments")!.data as Body[])[0], { status: "paid", amount_paid: invoice.total });
  objects.get("/v1/charges/ch_LocalRenewal")!.created = Math.floor(Date.now() / 1000);
}
test.each(([["test", false], ["test", true], ["live", false], ["live", true]] as const).flatMap(([mode, replacement]) =>
  ["2025-09-30.clover", "2025-10-29.clover"].map(version => ({ mode, replacement, version }))))(
  "bank $mode original admission with replacement=$replacement and $version Events observes action, releases only its challenge and credits once", async ({ mode, replacement, version }) => {
    if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-checkout.example" },
      vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
    const eventId = await seedBank(replacement), before = await financialSnapshot(), h = harness();
    objects.get(`/v1/events/${eventId}`)!.api_version = version;
    try {
      expect(await h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", eventId)).toMatchObject({ status: "payment_recovery_recorded", outcome: "action_required" });
      expect(await h.bank.readChallenge(reservationId, ids.buyer, "in_LocalRenewal")).toEqual({ status: "bank_verification_ready", amountCents: 66633,
        paymentNumber: 2, publishableKey: `pk_${mode}_SYNTHETICPUBLICKEY`, clientSecret: "pi_LocalRenewal_secret_SYNTHETICCAPABILITY" });
      expect(await h.bank.checkPayment(reservationId, ids.buyer, "in_LocalRenewal")).toMatchObject({ status: "reconciliation_required" });
      expect(await financialSnapshot()).toEqual(before); completeSyntheticBank();
      expect(await h.bank.checkPayment(reservationId, ids.buyer, "in_LocalRenewal")).toMatchObject({ status: "credited" });
      const paid = await financialSnapshot(); expect(await h.bank.checkPayment(reservationId, ids.buyer, "in_LocalRenewal")).toMatchObject({ status: "already_credited" });
      expect(await h.recovery.recoverInvoice(reservationId, ids.creator, "in_LocalRenewal", recoveryEvent("invoice.paid", version))).toMatchObject({ status: "payment_recovery_recorded", outcome: "paid_accounted" });
      expect(await financialSnapshot()).toEqual(paid);
      await expect(h.bank.readChallenge(reservationId, ids.buyer, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    } catch (e) { throw Error(`Local bank check: ${String(e)}; SQL: ${localSqlErrors.join("; ")}; paths: ${h.requests.slice(-8).map(r => r.path).join(", ")}`); }
    expect(h.stripeWrites()).toEqual([]); expect(JSON.stringify(h.requests)).not.toContain("secret_SYNTHETICCAPABILITY");
    expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
  });

test("bank refuses wrong owner, key mode, card, amounts, history, context and unobserved action", async () => {
  const eventId = await seedBank(true), h = harness(), before = await financialSnapshot();
  await expect(h.bank.readChallenge(reservationId, ids.buyer, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  await h.bank.observeInvoice(reservationId, ids.buyer, "in_LocalRenewal", eventId);
  await expect(h.bank.readChallenge(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  for (const [path, change] of [
    ["/v1/account", { id: "acct_Foreign" }], ["/v1/payment_methods/pm_LocalReplacement", { customer: "cus_Foreign" }],
    ["/v1/payment_intents/pi_LocalRenewal", { payment_method: "pm_LocalCheckout" }],
    ["/v1/payment_intents/pi_LocalRenewal", { application_fee_amount: 9959 }],
    ["/v1/payment_intents/pi_LocalRenewal", { amount: 66634 }],
    ["/v1/payment_intents/pi_LocalRenewal", { amount_received: 1 }],
    ["/v1/payment_intents/pi_LocalRenewal", { client_secret: "pi_Foreign_secret_SYNTHETIC" }],
    ["/v1/charges/ch_LocalCheckout", { disputed: true }],
    ["/v1/subscriptions/sub_LocalCheckout", { cancel_at: 1 }],
  ] as [string, Body][]) {
    const bad = harness((b, p) => p === path ? { ...b, ...change } : b);
    await expect(bad.bank.readChallenge(reservationId, ids.buyer, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(bad.stripeWrites()).toEqual([]);
  }
  // The public key is server configuration; a mismatch never releases a secret.
  const mismatched = harness(undefined, "pk_live_SYNTHETIC");
  await expect(mismatched.bank.readChallenge(reservationId, ids.buyer, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(mismatched.stripeWrites()).toEqual([]);
  expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toEqual([]);
});

test("bank late stop blocks capability release but still accounts for the already-admitted capture", async () => {
  const eventId = await seedBank(true); await harness().bank.observeInvoice(reservationId, ids.buyer, "in_LocalRenewal", eventId);
  let stopped = false;
  const h = harness(async (b, path) => {
    if (!stopped && path === "/v1/payment_intents/pi_LocalRenewal") {
      stopped = true; await db.exec("commit; begin");
      await db.query("insert into exact_installment_collection_holds(agreement_id,reason,request_id,requested_by) values($1,'cancellation_review',gen_random_uuid(),$2)", [reservationId, ids.creator]);
    }
    return b;
  });
  await expect(h.bank.readChallenge(reservationId, ids.buyer, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR); expect(stopped).toBe(true);
  completeSyntheticBank(); expect(await h.bank.checkPayment(reservationId, ids.buyer, "in_LocalRenewal")).toMatchObject({ status: "credited" });
  expect(await stopHolds()).toHaveLength(2); expect(h.stripeWrites()).toEqual([]);
});

test("bank replacement event mismatches and stale comparisons cannot manufacture action or another retry", async () => {
  const eventId = await seedBank(true), before = await financialSnapshot();
  for (const changed of [{ api_version: "1900-01-01" }, { livemode: true }, { created: Math.floor(Date.now() / 1000) + 1000 },
    { data: { object: { ...objects.get("/v1/invoices/in_LocalRenewal"), customer: "cus_Foreign" } } }]) {
    const bad = harness((b, path) => path === `/v1/events/${eventId}` ? { ...b, ...changed } : b);
    await expect(bad.bank.observeInvoice(reservationId, ids.buyer, "in_LocalRenewal", eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(bad.stripeWrites()).toEqual([]);
  }
  let intercepted = false;
  const stale = harness(async (b, path) => {
    if (!intercepted && path === "/v1/payment_intents/pi_LocalRenewal") {
      intercepted = true;
      await harness().bank.observeInvoice(reservationId, ids.buyer, "in_LocalRenewal", eventId);
    }
    return b;
  });
  expect(await stale.bank.observeInvoice(reservationId, ids.buyer, "in_LocalRenewal", eventId)).toMatchObject({ status: "reconciliation_required" });
  expect(await financialSnapshot()).toEqual(before); expect(stale.stripeWrites()).toEqual([]);
  expect(await retryRows()).toEqual([{ admissions: 1, confirmations: 1, credits: 0 }]);
});

test("bank lost credit acknowledgement is reconciled without submitting another payment", async () => {
  const eventId = await seedBank(true); await harness().bank.observeInvoice(reservationId, ids.buyer, "in_LocalRenewal", eventId); completeSyntheticBank();
  let lost = false;
  const h = harness((b, path) => {
    if (!lost && path.endsWith("run_exact_context_buyer_retry_v2")) { lost = true; throw Error("Synthetic lost credit acknowledgement"); } return b;
  });
  await expect(h.bank.checkPayment(reservationId, ids.buyer, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(lost).toBe(true); const paid = await financialSnapshot();
  expect(await h.bank.checkPayment(reservationId, ids.buyer, "in_LocalRenewal")).toMatchObject({ status: "already_credited" });
  expect(await financialSnapshot()).toEqual(paid); expect(h.stripeWrites()).toEqual([]);
});

test("bank owned SQL entry and private guard remain service-only without direct legacy access", async () => {
  const eventId = await seedBank(); await harness().bank.observeInvoice(reservationId, ids.buyer, "in_LocalRenewal", eventId);
  await expect(rpc("read_exact_installment_bank_context", [reservationId, "in_LocalRenewal", ids.buyer, true])).rejects.toThrow("Context-scoped payment entry required");
  await expect(rpc("read_exact_context_bank_v2", [reservationId, ids.creator, JSON.stringify(config.approvedContext), "in_LocalRenewal", true])).rejects.toThrow("Owned buyer bank context required");
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await db.query("select has_function_privilege($1,'public.read_exact_context_bank_v2(uuid,uuid,jsonb,text,boolean)','EXECUTE') allowed", [role])).rows).toEqual([{ allowed: role === "service_role" }]);
    expect((await db.query("select has_table_privilege($1,'exact_context_sql_admissions_v2','INSERT,UPDATE,DELETE') allowed", [role])).rows).toEqual([{ allowed: false }]);
  }
});
async function seedBuyerRetry(number: 2 | 3 = 2) {
  await seedCard(number); const h = harness();
  await h.card.saveCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest, cardConsent); completeSyntheticCard();
  await h.card.verifyCard(reservationId, ids.buyer, "in_LocalRenewal", cardRequest);
}
async function retryRows() {
  return (await db.query(`select (select count(*)::int from exact_installment_retry_admissions) admissions,
    (select count(*)::int from exact_installment_payment_confirmations where confirmed_at is not null) confirmations,
    (select count(*)::int from exact_installment_receipts where payment_number=2 and counted_at is not null) credits`)).rows;
}
test.each(["test", "live"] as const)("retry %s review never charges; explicit payment credits once without changing future billing", async mode => {
  if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await seedBuyerRetry(); objects.get("/v1/subscriptions/sub_LocalCheckout")!.status = "past_due";
  const before = await financialSnapshot(), sub = structuredClone(objects.get("/v1/subscriptions/sub_LocalCheckout")), holds = await stopHolds(), h = harness();
  let review, paid;
  try {
    review = await h.retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
    expect(await h.retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote)).toEqual(review);
    expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toEqual([]);
    paid = await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent);
  } catch { throw Error(`Local retry error: ${localSqlErrors.join("; ")}; last paths: ${h.requests.slice(-12).map(q => q.method + " " + q.path).join(", ")}`); }
  expect(review).toMatchObject({ status: "payment_review_ready", quote: { amountCents: 66633, paymentNumber: 2, confirmed: false, consentVersion: PAY_NOW_CONSENT_VERSION } });
  expect(paid).toMatchObject({ status: "credited", publicationAllowed: false });
  for (let i = 0; i < 2; i++) expect(await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).toMatchObject({ status: "already_credited" });
  expect(h.stripeWrites()).toEqual([{ method: "POST", path: "/v1/invoices/in_LocalRenewal/pay" }]);
  expect(await retryRows()).toEqual([{ admissions: 1, confirmations: 1, credits: 1 }]);
  expect(await stopHolds()).toEqual(holds); expect(objects.get("/v1/subscriptions/sub_LocalCheckout")).toEqual(sub);
  expect((await db.query("select paid_count,target_months from purchases")).rows).toEqual([{ paid_count: 2, target_months: 3 }]);
});

test("retry consent and owner boundary cannot manufacture admission", async () => {
  await seedBuyerRetry(); const before = await financialSnapshot(), h = harness();
  await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  await expect(h.retry.reviewPayment(reservationId, ids.creator, "in_LocalRenewal", retryQuote)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  await h.retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  for (const consent of [null, { ...retryConsent, accepted: false }, { accepted: true, consentVersion: "single-invoice-retry-v1" },
    { ...retryConsent, amountCents: 1 }])
    await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, consent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await h.retry.reconcile(reservationId, ids.buyer, "in_LocalRenewal", retryQuote)).toMatchObject({ status: "reconciliation_required" });
  expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
  expect(await retryRows()).toEqual([{ admissions: 0, confirmations: 0, credits: 0 }]);
});

test.each(["admission", "capture", "credit"])("retry lost %s response cannot repeat a payment or credit", async stage => {
  await seedBuyerRetry(); await harness().retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  let lost = false;
  const h = harness((body, path, method) => {
    const match = stage === "capture" ? method === "POST" && path === "/v1/invoices/in_LocalRenewal/pay" :
      path === rpcPrefix + "run_exact_context_buyer_retry_v2" && (stage === "admission" ? body.admitted === true : body.credit !== null);
    if (!lost && match) { lost = true; throw Error("Synthetic acknowledgement lost"); } return body;
  });
  if (stage === "capture") expect(await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).toMatchObject({ status: "credited" });
  else await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(lost).toBe(true); const next = harness(), status = stage === "admission" ? "reconciliation_required" : "already_credited";
  expect(await next.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).toMatchObject({ status });
  expect(await next.retry.reconcile(reservationId, ids.buyer, "in_LocalRenewal", retryQuote)).toMatchObject({ status });
  expect(next.stripeWrites()).toEqual([]); expect(h.stripeWrites()).toHaveLength(stage === "admission" ? 0 : 1);
  expect(await retryRows()).toEqual([{ admissions: 1, confirmations: 1, credits: stage === "admission" ? 0 : 1 }]);
});

test("retry unresolved authentication, processing and decline never resend; late capture credits once", async () => {
  await seedBuyerRetry(); await harness().retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  const before = await financialSnapshot(); let captured: Array<[string, Body]> = [];
  const h = harness((body, path, method) => {
    if (method === "POST" && path === "/v1/invoices/in_LocalRenewal/pay") {
      captured = [...objects].map(([k, v]) => [k, structuredClone(v)]);
      const inv = objects.get("/v1/invoices/in_LocalRenewal")!, pi = objects.get("/v1/payment_intents/pi_LocalRenewal")!;
      Object.assign(inv, { status: "open", amount_paid: 0, amount_remaining: inv.total });
      Object.assign(pi, { status: "requires_action", amount_received: 0, latest_charge: null });
      Object.assign((objects.get("/v1/invoice_payments")!.data as Body[])[0], { status: "open", amount_paid: 0 });
      return structuredClone(inv);
    } return body;
  });
  expect(await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).toMatchObject({ status: "reconciliation_required" });
  for (const status of ["requires_action", "processing", "requires_payment_method"]) {
    objects.get("/v1/payment_intents/pi_LocalRenewal")!.status = status;
    expect(await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).toMatchObject({ status: "reconciliation_required" });
  }
  expect(await financialSnapshot()).toEqual(before); expect(await retryRows()).toEqual([{ admissions: 1, confirmations: 1, credits: 0 }]);
  objects = new Map(captured);
  expect(await h.retry.reconcile(reservationId, ids.buyer, "in_LocalRenewal", retryQuote)).toMatchObject({ status: "credited" });
  expect(await h.retry.reconcile(reservationId, ids.buyer, "in_LocalRenewal", retryQuote)).toMatchObject({ status: "already_credited" });
  expect(h.stripeWrites()).toEqual([{ method: "POST", path: "/v1/invoices/in_LocalRenewal/pay" }]);
});

test("retry captured evidence must match replacement card, fee, balance and admission time", async () => {
  await seedBuyerRetry(); await harness().retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  const before = await financialSnapshot(); let captured: Array<[string, Body]> = [];
  const h = harness((body, path, method) => {
    if (method === "POST" && path === "/v1/invoices/in_LocalRenewal/pay") {
      captured = [...objects].map(([k, v]) => [k, structuredClone(v)]);
      objects.get("/v1/payment_intents/pi_LocalRenewal")!.payment_method = "pm_Foreign";
    } return body;
  });
  await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  for (const fault of ["card", "fee", "balance", "time"]) {
    objects = new Map(captured.map(([k, v]) => [k, structuredClone(v)]));
    if (fault === "card") objects.get("/v1/charges/ch_LocalRenewal")!.payment_method = "pm_Foreign";
    if (fault === "fee") objects.get("/v1/payment_intents/pi_LocalRenewal")!.application_fee_amount = 1;
    if (fault === "balance") objects.get("/v1/balance_transactions/txn_LocalRenewal")!.net = 1;
    if (fault === "time") objects.get("/v1/charges/ch_LocalRenewal")!.created = 1;
    await expect(h.retry.reconcile(reservationId, ids.buyer, "in_LocalRenewal", retryQuote)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  }
  expect(await financialSnapshot()).toEqual(before); expect(await retryRows()).toEqual([{ admissions: 1, confirmations: 1, credits: 0 }]);
  expect(h.stripeWrites()).toHaveLength(1);
});

test("retry overlapping explicit requests share one admission and one charge", async () => {
  await seedBuyerRetry(); await harness().retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  let interleaved = false; const second = harness();
  const h = harness(async (body, path) => {
    if (!interleaved && path === rpcPrefix + "run_exact_context_buyer_retry_v2" && body.admitted === true) {
      interleaved = true;
      expect(await second.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).toMatchObject({ status: "reconciliation_required" });
    } return body;
  });
  expect(await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).toMatchObject({ status: "credited" });
  expect(interleaved).toBe(true); expect([...h.stripeWrites(), ...second.stripeWrites()]).toEqual([{ method: "POST", path: "/v1/invoices/in_LocalRenewal/pay" }]);
  expect(await retryRows()).toEqual([{ admissions: 1, confirmations: 1, credits: 1 }]);
});

test.each(["before", "after"])("retry stop %s admission prevents a new permission but preserves captured accounting", async timing => {
  await seedBuyerRetry(); await harness().retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  async function addHold() {
    await db.exec("commit; begin");
    await db.query(`insert into exact_installment_collection_holds(agreement_id,reason,request_id,requested_by)
      values($1,'cancellation_review',gen_random_uuid(),$2)`, [reservationId, ids.creator]);
  }
  if (timing === "before") await addHold(); let intervened = false;
  const h = harness(async (body, path, method) => {
    if (timing === "after" && !intervened && path === "/v1/invoices/in_LocalRenewal/pay" && method === "POST") { intervened = true; await addHold(); }
    return body;
  });
  if (timing === "before") await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  else expect(await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).toMatchObject({ status: "credited" });
  expect(h.stripeWrites()).toHaveLength(timing === "before" ? 0 : 1);
  expect(await retryRows()).toEqual([{ admissions: timing === "before" ? 0 : 1, confirmations: timing === "before" ? 0 : 1, credits: timing === "before" ? 0 : 1 }]);
  expect(await stopHolds()).toHaveLength(2);
});

test("retry prior refund, dispute, changed default or subscription cannot admit payment", async () => {
  await seedBuyerRetry(); await harness().retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  const before = await financialSnapshot(), baseline = [...objects].map(([k, v]) => [k, structuredClone(v)] as const), h = harness();
  for (const fault of ["refund", "dispute", "default", "subscription"]) {
    objects = new Map(baseline.map(([k, v]) => [k, structuredClone(v)]));
    if (fault === "refund") objects.get("/v1/charges/ch_LocalCheckout")!.amount_refunded = 1;
    if (fault === "dispute") objects.get("/v1/charges/ch_LocalCheckout")!.disputed = true;
    if (fault === "default") objects.get("/v1/customers/cus_LocalCheckout")!.invoice_settings = { default_payment_method: "pm_Foreign" };
    if (fault === "subscription") objects.get("/v1/subscriptions/sub_LocalCheckout")!.cancel_at = 1;
    await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, retryConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  }
  expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
  expect(await retryRows()).toEqual([{ admissions: 0, confirmations: 0, credits: 0 }]);
});

test("retry SQL denies browser roles, foreign context and legacy confirmation/admission bypass", async () => {
  await seedBuyerRetry(); await harness().retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  for (const signature of ["read_exact_context_buyer_retry_v2(uuid,uuid,jsonb,text,uuid)", "run_exact_context_buyer_retry_v2(uuid,uuid,jsonb,text,uuid,text,jsonb)"])
    for (const role of ["anon", "authenticated"]) expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, "public." + signature])).rows).toEqual([{ allowed: false }]);
  await expect(rpc("run_exact_context_buyer_retry_v2", [reservationId, ids.buyer, JSON.stringify({ ...context, mode: "live" }),
    "in_LocalRenewal", retryQuote, "pay", JSON.stringify(retryConsent)])).rejects.toThrow();
  await expect(rpc("run_exact_context_buyer_retry_v2", [reservationId, ids.buyer, JSON.stringify(context),
    "in_LocalRenewal", retryQuote, "pay", JSON.stringify({ ...retryConsent, accepted: false })])).rejects.toThrow();
  for (const [sql, values] of [
    ["select public.quote_exact_installment_retry($1,$2,$3,'single-invoice-pay-now-v1')", [retryQuote, cardRequest, ids.buyer]],
    ["select public.confirm_exact_installment_retry($1,$2,'single-invoice-pay-now-v1')", [retryQuote, ids.buyer]],
    ["select public.admit_exact_installment_retry($1,$2)", [retryQuote, ids.buyer]],
    ["select public.record_exact_installment_retry_receipt($1,'in_LocalRenewal','pi_LocalRenewal',66633,9958,now())", [retryQuote]],
  ] as const) {
    await db.exec("savepoint retry_denied; set local role service_role");
    await expect(db.query(sql, [...values])).rejects.toThrow("Context-scoped payment entry required");
    await db.exec("rollback to savepoint retry_denied; reset role; release savepoint retry_denied");
  }
  expect(await retryRows()).toEqual([{ admissions: 0, confirmations: 0, credits: 0 }]);
  expect((await db.query("select count(*)::int count from exact_context_sql_admissions_v2")).rows).toEqual([{ count: 0 }]);
});

const futureConsent = { ...retryConsent, futureCardConsentVersion: FUTURE_CARD_CONSENT_VERSION };
const futureChoices = async () => (await db.query("select * from exact_installment_future_card_choices")).rows;
test.each([{ mode: "test", accepted: false }, { mode: "test", accepted: true }, { mode: "live", accepted: true }] as const)(
  "future $mode choice $accepted stays separate and immutable; exact schedule and defaults remain unchanged", async ({ mode, accepted }) => {
  if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await seedBuyerRetry(); const h = harness(), before = await financialSnapshot(), holds = await stopHolds();
  const sub = structuredClone(objects.get("/v1/subscriptions/sub_LocalCheckout")), customer = structuredClone(objects.get("/v1/customers/cus_LocalCheckout"));
  const reviewed = await h.retry.reviewWithFutureCardChoice(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  const periods = (await db.query("select payment_number,amount_cents,due_at,period_end from exact_installment_periods where payment_number=3")).rows[0] as Body;
  expect(reviewed).toMatchObject({ status: "payment_review_ready", quote: { confirmed: false, remainingPayments: [{ paymentNumber: 3,
    amountCents: 66634, dueAt: periods.due_at, periodEnd: periods.period_end }] } });
  expect(reviewed.quote).not.toHaveProperty("futureCardAccepted"); expect(await futureChoices()).toEqual([]);
  expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toEqual([]);
  const consent = accepted ? futureConsent : retryConsent;
  expect(await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, consent)).toMatchObject({ status: "credited", quote: { futureCardAccepted: accepted } });
  const choice = await futureChoices(); expect(choice).toMatchObject([{ accepted, confirmation_id: retryQuote, agreement_id: reservationId,
    consent_version: FUTURE_CARD_CONSENT_VERSION, consent_text: FUTURE_CARD_CONSENT_TEXT, first_payment_number: 3,
    remaining_periods: reviewed.quote!.remainingPayments }]);
  expect(await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, consent)).toMatchObject({ status: "already_credited" });
  await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, accepted ? retryConsent : futureConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  // Calendar is real: an early next-month claim must fail and roll back any
  // attempted recovery-hold archival. No fake clock or shortened period.
  await expect(rpc("claim_exact_context_invoice_v2", [reservationId, ids.creator, JSON.stringify(config.approvedContext),
    "in_LocalFuture", "sub_LocalCheckout", periods.due_at, periods.period_end])).rejects.toThrow();
  expect(await futureChoices()).toEqual(choice); expect(await stopHolds()).toEqual(holds);
  expect((await db.query("select count(*)::int n from exact_installment_resolved_card_holds")).rows).toEqual([{ n: 0 }]);
  expect((await db.query("select count(*)::int n from exact_installment_invoice_cards")).rows).toEqual([{ n: 0 }]);
  expect(objects.get("/v1/subscriptions/sub_LocalCheckout")).toEqual(sub); expect(objects.get("/v1/customers/cus_LocalCheckout")).toEqual(customer);
  expect(h.stripeWrites()).toEqual([{ method: "POST", path: "/v1/invoices/in_LocalRenewal/pay" }]);
});

test("future old review and missing current-payment consent cannot gain future authority", async () => {
  await seedBuyerRetry(); const h = harness(), before = await financialSnapshot();
  await h.retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  await expect(h.retry.reviewWithFutureCardChoice(reservationId, ids.buyer, "in_LocalRenewal", retryQuote)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, futureConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const nextQuote = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await h.retry.reviewWithFutureCardChoice(reservationId, ids.buyer, "in_LocalRenewal", nextQuote);
  for (const proof of [{ futureCardConsentVersion: FUTURE_CARD_CONSENT_VERSION }, { ...futureConsent, accepted: false },
    { ...futureConsent, futureCardConsentVersion: "wrong-version" }])
    await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", nextQuote, proof)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await futureChoices()).toEqual([]); expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});

test("future final installment cannot offer an additional-card schedule", async () => {
  await seedBuyerRetry(3); const h = harness();
  await expect(h.retry.reviewWithFutureCardChoice(reservationId, ids.buyer, "in_LocalRenewal", retryQuote)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await h.retry.reviewPayment(reservationId, ids.buyer, "in_LocalRenewal", retryQuote)).toMatchObject({ quote: { amountCents: 66634, paymentNumber: 3 } });
  expect(await futureChoices()).toEqual([]); expect(h.stripeWrites()).toEqual([]);
});

test.each(["admission", "capture"])("future lost %s response preserves choice without a second permission", async stage => {
  await seedBuyerRetry(); await harness().retry.reviewWithFutureCardChoice(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  let lost = false; const h = harness((body, path, method) => {
    if (!lost && (stage === "admission" ? path === rpcPrefix + "run_exact_context_buyer_retry_v2" && body.admitted === true :
      path.endsWith("/pay") && method === "POST")) { lost = true; throw Error("Synthetic response lost"); } return body;
  });
  if (stage === "admission") await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, futureConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  else expect(await h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, futureConsent)).toMatchObject({ status: "credited" });
  expect(lost).toBe(true); const choice = await futureChoices(); expect(choice).toMatchObject([{ accepted: true }]);
  const next = harness(); expect(await next.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, futureConsent))
    .toMatchObject({ status: stage === "admission" ? "reconciliation_required" : "already_credited" });
  expect(await futureChoices()).toEqual(choice); expect(next.stripeWrites()).toEqual([]);
  expect(await retryRows()).toEqual([{ admissions: 1, confirmations: 1, credits: stage === "admission" ? 0 : 1 }]);
});

test("future changed returned schedule or choice is rejected before further action", async () => {
  await seedBuyerRetry(); await harness().retry.reviewWithFutureCardChoice(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  const before = await financialSnapshot();
  for (const fault of ["amount", "date", "count"]) {
    const h = harness((body, path) => {
      if (path === rpcPrefix + "read_exact_context_buyer_retry_v2") {
        const q = body.quote as Body, p = (q.future_card_periods as Body[])[0];
        if (fault === "amount") p.amountCents = 1;
        if (fault === "date") p.dueAt = Number(p.dueAt) + 1;
        if (fault === "count") q.future_card_periods = [];
      } return body;
    });
    await expect(h.retry.payNow(reservationId, ids.buyer, "in_LocalRenewal", retryQuote, futureConsent)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(h.stripeWrites()).toEqual([]);
  }
  expect(await futureChoices()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});

test("future context and original-function guards prevent consent bypass", async () => {
  await seedBuyerRetry(); const h = harness();
  await expect(h.retry.reviewWithFutureCardChoice(reservationId, ids.creator, "in_LocalRenewal", retryQuote)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  await h.retry.reviewWithFutureCardChoice(reservationId, ids.buyer, "in_LocalRenewal", retryQuote);
  for (const [sql, values] of [
    ["select public.quote_exact_installment_future_card($1,$2,$3)", [retryQuote, cardRequest, ids.buyer]],
    ["select public.confirm_exact_installment_future_card($1,$2,true,'same-plan-remaining-card-v1')", [retryQuote, ids.buyer]],
  ] as const) {
    await db.exec("savepoint future_denied; set local role service_role");
    await expect(db.query(sql, [...values])).rejects.toThrow("Context-scoped payment entry required");
    await db.exec("rollback to savepoint future_denied; reset role; release savepoint future_denied");
  }
  await expect(rpc("run_exact_context_buyer_retry_v2", [reservationId, ids.buyer, JSON.stringify({ ...context, mode: "live" }),
    "in_LocalRenewal", retryQuote, "pay", JSON.stringify(futureConsent)])).rejects.toThrow();
  expect(await futureChoices()).toEqual([]); expect(await retryRows()).toEqual([{ admissions: 0, confirmations: 0, credits: 0 }]);
});

function observedFinancialEvent(kind: "refund" | "dispute", amount = 10000, suffix = "Checkout") {
  const charge = objects.get(`/v1/charges/ch_Local${suffix}`)!;
  const eventId = kind === "refund" ? "evt_LocalRefund" : "evt_LocalDispute";
  const objectId = kind === "refund" ? "re_LocalRefund" : "du_LocalDispute";
  const resource: Body = { object: kind, id: objectId, charge: charge.id, payment_intent: charge.payment_intent,
    amount, currency: "usd", status: kind === "refund" ? "succeeded" : "under_review", metadata: {} };
  if (kind === "refund") {
    charge.amount_refunded = amount; charge.refunded = amount === charge.amount;
    objects.set("/v1/refunds", { object: "list", has_more: false, data: [resource] });
  } else { resource.livemode = config.approvedContext.mode === "live"; charge.disputed = true; }
  objects.set(`/v1/${kind === "refund" ? "refunds" : "disputes"}/${objectId}`, resource);
  objects.set(`/v1/events/${eventId}`, { object: "event", id: eventId, api_version: config.expectedApiVersion,
    livemode: config.approvedContext.mode === "live", created: Math.floor(Date.now() / 1000),
    type: kind === "refund" ? "refund.updated" : "charge.dispute.updated", data: { object: structuredClone(resource) } });
  return { eventId, objectId, resource, charge };
}
async function refundLedger() {
  return (await db.query("select stripe_payment_intent_id,status,refunded_amount_cents,earnings_reversed_cents from payment_fee_ledger order by stripe_payment_intent_id")).rows;
}
test.each(["2025-09-30.clover", "2025-10-29.clover"])("financial partial refund from original %s Event observes the original first payment once without changing access or debt", async version => {
  await seedCreditedActivation(); const { eventId } = observedFinancialEvent("refund");
  objects.get(`/v1/events/${eventId}`)!.api_version = version;
  const before = await financialSnapshot(), h = harness();
  try { expect(await h.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "refund_reconciled" }); }
  catch { throw Error(`Local financial failure: ${localSqlErrors.join("; ")}; last paths: ${h.requests.slice(-9).map(r => r.path).join(", ")}`); }
  const after = await refundLedger(); expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ stripe_payment_intent_id: "pi_LocalCheckout", refunded_amount_cents: 10000 });
  expect(await h.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "refund_reconciled" });
  expect(await refundLedger()).toEqual(after); expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toHaveLength(0);
});
test("financial later full refund reverses only its own receipt and holds the next collection", async () => {
  await seedInvoicePrecursor(); const setup = harness(); await setup.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal");
  const { eventId } = observedFinancialEvent("refund", 66633, "Renewal"), before = await financialSnapshot(), h = harness();
  expect(await h.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "refund_reconciled" });
  expect(await refundLedger()).toEqual([
    { stripe_payment_intent_id: "pi_LocalCheckout", status: "paid", refunded_amount_cents: 0, earnings_reversed_cents: 0 },
    { stripe_payment_intent_id: "pi_LocalRenewal", status: "refunded", refunded_amount_cents: 66633, earnings_reversed_cents: 56675 },
  ]);
  expect((await db.query("select reason,stripe_payment_intent_id from exact_installment_collection_holds")).rows)
    .toEqual([{ reason: "verified_refund", stripe_payment_intent_id: "pi_LocalRenewal" }]);
  expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toHaveLength(0);
});
test.each(["pending", "failed", "sum-mismatch"])("financial %s refund keeps a hold without reversing earnings", async fault => {
  await seedCreditedActivation(); const { eventId, resource } = observedFinancialEvent("refund");
  if (fault === "sum-mismatch") resource.amount = 9999; else resource.status = fault;
  const before = await refundLedger(), h = harness();
  expect(await h.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "reconciliation_required" });
  expect(await refundLedger()).toEqual(before); expect(h.stripeWrites()).toHaveLength(0);
  expect((await db.query("select count(*)::int n from exact_installment_collection_holds")).rows).toEqual([{ n: 1 }]);
});
test.each(["hold", "apply"])("financial lost %s response safely reconciles without a second earnings reversal", async stage => {
  await seedCreditedActivation(); const { eventId } = observedFinancialEvent("refund"); let lost = false;
  const h = harness((b, path) => { if (!lost && path === rpcPrefix + `${stage}_exact_context_financial_event_v2`) { lost = true; throw Error("Synthetic lost response"); } return b; });
  await expect(h.financial.reconcileEvent(reservationId, ids.creator, eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR); expect(lost).toBe(true);
  const retry = harness(); expect(await retry.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "refund_reconciled" });
  const once = await refundLedger(); await retry.financial.reconcileEvent(reservationId, ids.creator, eventId);
  expect(await refundLedger()).toEqual(once); expect(h.stripeWrites().concat(retry.stripeWrites())).toHaveLength(0);
});
test.each(["mode", "account", "api", "unbound-payment", "owner", "balance"])("financial %s mismatch cannot apply foreign or unverified evidence", async fault => {
  await seedCreditedActivation(); const { eventId, charge } = observedFinancialEvent("refund");
  const e = objects.get(`/v1/events/${eventId}`)!;
  if (fault === "mode") e.livemode = true;
  if (fault === "account") e.account = context.platformAccountId;
  if (fault === "api") e.api_version = "2020-08-27";
  if (fault === "unbound-payment") { charge.payment_intent = "pi_Unbound"; ((e.data as Body).object as Body).payment_intent = "pi_Unbound"; }
  if (fault === "balance") objects.get("/v1/balance_transactions/txn_LocalCheckout")!.fee = 1963;
  const h = harness(), before = await refundLedger();
  await expect(h.financial.reconcileEvent(reservationId, fault === "owner" ? ids.buyer : ids.creator, eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await refundLedger()).toEqual(before); expect(h.stripeWrites()).toHaveLength(0);
  expect(h.requests.some(q => q.path.endsWith("/apply_exact_context_financial_event_v2"))).toBe(false);
});
test("financial dispute with nullable PI uses charge linkage, current status and revision, never allocates fees", async () => {
  await seedCreditedActivation(); const { eventId, resource } = observedFinancialEvent("dispute", 60000);
  resource.payment_intent = null; const e = objects.get(`/v1/events/${eventId}`)!; ((e.data as Body).object as Body).payment_intent = null;
  // Snapshot intentionally differs. Only the current retrieved dispute is audited.
  ((e.data as Body).object as Body).status = "needs_response";
  const before = await financialSnapshot(), ledger = await refundLedger(), h = harness();
  const observed = await h.financial.reconcileEvent(reservationId, ids.creator, eventId).catch(() => {
    throw Error(`Local dispute failure: ${localSqlErrors.join("; ")}; last paths: ${h.requests.slice(-9).map(q => q.path).join(", ")}`);
  });
  expect(observed).toMatchObject({ status: "lifecycle_observed" });
  expect((await db.query("select dispute_status,disputed_amount_cents from payment_fee_ledger")).rows).toEqual([{ dispute_status: "under_review", disputed_amount_cents: 60000 }]);
  resource.status = "won";
  expect(await h.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_observed" });
  resource.status = "lost";
  expect(await h.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_review_recorded" });
  expect((await db.query("select dispute_status from payment_fee_ledger")).rows).toEqual([{ dispute_status: "won" }]);
  expect(await refundLedger()).toEqual(ledger); expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toHaveLength(0);
});
test("financial dispute read outage leaves collection held without changing the prior audit", async () => {
  await seedCreditedActivation(); const { eventId } = observedFinancialEvent("dispute");
  const h = harness((b, path) => { if (path.startsWith("/v1/disputes/")) throw Error("Synthetic provider outage"); return b; });
  await expect(h.financial.reconcileEvent(reservationId, ids.creator, eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect((await db.query("select reason from exact_installment_collection_holds")).rows).toEqual([{ reason: "verified_dispute" }]);
  expect((await db.query("select count(*)::int n from payment_dispute_state")).rows).toEqual([{ n: 0 }]);
  expect(h.stripeWrites()).toHaveLength(0);
});
test("financial dispute concurrent fresh observation defeats the stale compare-and-swap", async () => {
  await seedCreditedActivation(); const { eventId, resource } = observedFinancialEvent("dispute"); let interleaved = false;
  const newer = harness(); const old = harness(async (b, path) => {
    if (!interleaved && path === "/v1/disputes/du_LocalDispute") {
      interleaved = true; resource.status = "won";
      expect(await newer.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_observed" });
    }
    return b;
  });
  expect(await old.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "reconciliation_required" });
  expect((await db.query("select status from payment_dispute_state")).rows).toEqual([{ status: "won" }]);
  expect(old.stripeWrites().concat(newer.stripeWrites())).toHaveLength(0);
});
test("financial dispute of a dispatched uncredited payment holds it without creating a receipt", async () => {
  await seedInvoicePrecursor(); let captured = false;
  const setup = harness((b, path) => {
    if (path.endsWith("/pay")) { captured = true; throw Error("Synthetic response lost after capture"); }
    if (captured && path === "/v1/payment_intents/pi_LocalRenewal") throw Error("Synthetic receipt read outage");
    return b;
  });
  await expect(setup.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const { eventId } = observedFinancialEvent("dispute", 10000, "Renewal"), h = harness(), before = await financialSnapshot();
  expect(await h.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "reconciliation_required" });
  expect((await db.query("select reason,stripe_payment_intent_id from exact_installment_collection_holds")).rows)
    .toEqual([{ reason: "verified_dispute", stripe_payment_intent_id: "pi_LocalRenewal" }]);
  expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toHaveLength(0);
});
test("financial synthetic live context observes charge.refunded without issuing a provider write", async () => {
  config = { ...config, approvedContext: { ...context, mode: "live", siteOrigin: "https://synthetic-checkout.example" },
    configuredSiteOrigin: "https://synthetic-checkout.example", vercelEnvironment: "production", stripePublishableKeyMode: "live", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL" };
  await seedCreditedActivation(); const { eventId, charge } = observedFinancialEvent("refund");
  const e = objects.get(`/v1/events/${eventId}`)!; e.type = "charge.refunded"; e.data = { object: JSON.parse(JSON.stringify(charge)) };
  const h = harness(); expect(await h.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "refund_reconciled", providerOperationsAllowed: false });
  expect(h.stripeWrites()).toHaveLength(0);
});
test("financial delivery confirmation matches existing admin refund ID or exact operation metadata only", async () => {
  await seedCreditedActivation(); const adminId = "66666666-6666-4666-8666-666666666666";
  await db.exec("commit; begin");
  // Structural catalog includes the real table/constraints, but this fixture
  // creator was not a dependency of 040-057. Use its existing source unchanged.
  const createOperation = readFileSync(join(process.cwd(), "supabase/schema/021-admin-refund-operations.sql"), "utf8")
    .match(/create or replace function public\.create_refund_operation\([\s\S]*?\$\$;/)?.[0];
  if (!createOperation) throw Error("Missing synthetic refund fixture constructor");
  await db.exec(createOperation);
  await db.query("insert into auth.users(id) values($1)", [adminId]);
  await db.query("insert into profiles(id,role) values($1,'admin')", [adminId]);
  const operations = ["77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999"];
  const ledgerId = (await db.query<{ id: string }>("select id from payment_fee_ledger")).rows[0].id;
  for (const [i, op] of operations.entries()) await db.query(`select create_refund_operation($1,$2,$3,'creator_discretionary','creator',null,$4,$5,
    'ch_LocalCheckout','fee_LocalCheckout',0,0,1962)`, [op, ledgerId, i === 2 ? 5000 : 2500, `local-admin-${op}`, adminId]);
  // Synthetic request-worker bindings. No existing hosted operation is edited.
  await db.query("update refund_operations set stripe_refund_id='re_Different' where id=$1", [operations[1]]);
  await db.query("update refund_operations set stripe_refund_id='re_LocalThird' where id=$1", [operations[2]]);
  const { eventId, resource } = observedFinancialEvent("refund");
  resource.amount = 2500; resource.metadata = { creatornet_refund_operation_id: operations[0] };
  (objects.get("/v1/refunds")!.data as Body[]).push({ ...resource, id: "re_LocalSecond", metadata: { creatornet_refund_operation_id: operations[1] } },
    { ...resource, id: "re_LocalThird", amount: 5000, metadata: {} });
  const h = harness(); await h.financial.reconcileEvent(reservationId, ids.creator, eventId);
  expect((await db.query("select id,webhook_confirmed_at is not null confirmed,status from refund_operations order by id")).rows)
    .toEqual(operations.map((id, i) => ({ id, confirmed: i !== 1, status: "pending" })));
  expect(h.stripeWrites()).toHaveLength(0);
});
test("financial larger-than-charge dispute records review without weakening the original ledger limit", async () => {
  await seedCreditedActivation(); const { eventId } = observedFinancialEvent("dispute", 70000), h = harness(), before = await refundLedger();
  expect(await h.financial.reconcileEvent(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_review_recorded" });
  expect((await db.query("select disposition,details->>'reason' reason,(details->>'disputedCents')::int amount from exact_installment_lifecycle_observations")).rows)
    .toEqual([{ disposition: "review_required", reason: "dispute_amount_exceeds_ledger_gross", amount: 70000 }]);
  expect((await db.query("select disputed_amount_cents from payment_fee_ledger")).rows).toEqual([{ disputed_amount_cents: 0 }]);
  expect((await db.query("select reason from exact_installment_collection_holds")).rows).toEqual([{ reason: "verified_dispute" }]);
  expect(await refundLedger()).toEqual(before); expect(h.stripeWrites()).toHaveLength(0);
});
test("financial grants and private entry guards block malformed or direct legacy context writes", async () => {
  await seedCreditedActivation(); const { eventId } = observedFinancialEvent("refund"); const h = harness();
  await h.financial.reconcileEvent(reservationId, ids.creator, eventId);
  for (const name of ["read_exact_context_financial_event_v2", "hold_exact_context_financial_event_v2", "apply_exact_context_financial_event_v2"]) {
    const signature = `${name}(uuid,uuid,jsonb,jsonb${name.startsWith("apply") ? ",jsonb" : ""})`;
    expect((await db.query("select has_function_privilege('anon',$1,'execute') a,has_function_privilege('authenticated',$1,'execute') u,has_function_privilege('service_role',$1,'execute') s", [signature])).rows)
      .toEqual([{ a: false, u: false, s: true }]);
  }
  const snapshot = await refundLedger();
  for (const sql of [
    "hold_exact_installment_refund_event($1,'evt_Direct','pi_LocalCheckout','ch_LocalCheckout',66633)",
    "apply_exact_installment_refund_event($1,'evt_Direct','pi_LocalCheckout','ch_LocalCheckout',66633,66633)",
    "hold_exact_installment_lifecycle_event($1,'evt_Direct','du_Direct','pi_LocalCheckout')",
    "finish_exact_installment_lifecycle($1,'evt_Direct','du_Direct',0,'{}','review_required','{}')",
    "apply_exact_installment_dispute_event($1,'evt_Direct','du_Direct',0,'{}','pi_LocalCheckout','ch_LocalCheckout',66633,1000,'lost',1)",
  ]) {
    await db.exec("savepoint direct_guard; set local role service_role");
    await expect(db.query(`select public.${sql}`, [reservationId])).rejects.toMatchObject({ message: "Context-scoped payment entry required" });
    await db.exec("rollback to savepoint direct_guard; reset role; release savepoint direct_guard");
  }
  const invalid = { id: "evt_Direct", kind: null, type: null, objectId: null, paymentIntentId: "pi_LocalCheckout", chargeId: "ch_LocalCheckout", created: Math.floor(Date.now() / 1000) };
  await expect(rpc("read_exact_context_financial_event_v2", [reservationId, ids.creator, JSON.stringify(config.approvedContext), JSON.stringify(invalid)])).rejects.toMatchObject({ message: "Unsupported context financial event" });
  expect(await refundLedger()).toEqual(snapshot);
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
  expect(h.stripeWrites()).toHaveLength(0);
});

test.each(["test", "live"] as const)("credit connection %s: reuse the existing ledger/purchase/delivery once", async mode => {
  if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  const result = await h.credit.creditFirstPayment(reservationId, ids.creator);
  expect(result).toMatchObject({ status: "first_payment_fulfilled", credited: true, agreementId: reservationId,
    publicationAllowed: false, collectionAllowed: false });
  expect(await h.credit.creditFirstPayment(reservationId, ids.creator)).toEqual({ ...result, credited: false });
  expect((await db.query("select total_earnings_cents::int cents from profiles where id=$1", [ids.creator])).rows).toEqual([{ cents: 56675 }]);
  expect((await db.query("select paid_count,access_granted,status,first_access_at from purchases")).rows).toEqual([
    { paid_count: 1, access_granted: true, status: "active", first_access_at: null }]);
  expect((await db.query("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{ n: 1 }]);
  expect((await db.query("select installment_collection_version,link_url,status from booking_payments")).rows).toEqual([
    { installment_collection_version: "exact-cents-context-v2", link_url: null, status: "completed" }]);
  expect((await db.query("select terms->>'version' version,status,first_fulfilled_at is not null fulfilled from exact_installment_agreements")).rows).toEqual([
    { version: "exact-cents-context-v2", status: "awaiting_first", fulfilled: true }]);
  expect(h.stripeWrites()).toHaveLength(1); // Seed Checkout only; credit never writes Stripe.
});

test("credit connection lost response: committed credit and delivery are reconciled without replaying earnings", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  const lost = harness((body, path) => { if (path.endsWith("credit_exact_context_first_payment_v2")) throw Error("private marker lost response"); return body; });
  await expect(lost.credit.creditFirstPayment(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await h.credit.creditFirstPayment(reservationId, ids.creator)).toMatchObject({ status: "first_payment_fulfilled", credited: false });
  expect((await db.query("select total_earnings_cents::int cents from profiles where id=$1", [ids.creator])).rows).toEqual([{ cents: 56675 }]);
  expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{ n: 1 }]);
  expect(lost.stripeWrites()).toHaveLength(0);
});

test("credit connection delivery failure: roll back every financial effect; repair only the new fixture delivery", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  await db.query("update products set discord_invite_url='javascript:invalid' where id=$1", [ids.product]);
  const before = await financialSnapshot();
  await expect(h.credit.creditFirstPayment(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await financialSnapshot()).toEqual(before);
  expect((await db.query("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{ n: 0 }]);
  expect((await db.query("select count(*)::int n from exact_context_accounting_links_v2")).rows).toEqual([{ n: 0 }]);
  // The read-only provider evidence was saved separately; it is not a credit.
  expect((await db.query("select count(*)::int n from exact_context_first_receipts_v2")).rows).toEqual([{ n: 1 }]);
  await db.query("update products set discord_invite_url='https://discord.gg/SYNTHETIC' where id=$1", [ids.product]);
  expect(await h.credit.creditFirstPayment(reservationId, ids.creator)).toMatchObject({ credited: true });
  expect((await db.query("select fulfillment,fulfillment_url,first_access_at from purchases")).rows).toEqual([
    { fulfillment: "discord", fulfillment_url: "https://discord.gg/SYNTHETIC", first_access_at: null }]);
});

test("credit connection existing purchase: never adopt or overwrite earlier buyer evidence", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  await db.query("insert into purchases(buyer_id,creator_id,post_id,product_id,status,currency,access_granted) values($1,$2,$3,$4,'active','usd',true)",
    [ids.buyer, ids.creator, ids.post, ids.product]);
  const before = await financialSnapshot();
  await expect(h.credit.creditFirstPayment(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await financialSnapshot()).toEqual(before);
});

test.each(["refund", "dispute"])("credit connection local %s: stale unrefunded provider view cannot grant access", async kind => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  if (kind === "refund") await db.query("select record_payment_refund_state('pi_LocalCheckout','ch_LocalCheckout',66633,1)");
  else await db.query("select record_payment_dispute_state('du_LocalCheckout','pi_LocalCheckout','ch_LocalCheckout',66633,'usd','needs_response',$1)",
    [Math.floor(Date.now() / 1000)]);
  const before = await financialSnapshot();
  await expect(h.credit.creditFirstPayment(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await financialSnapshot()).toEqual(before);
  expect((await db.query("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{ n: 0 }]);
});

test("credit connection admission: no unbacked v2 payment, no legacy collision, ordinary free/sales booking preserved", async () => {
  await seedHeld();
  const insert = "insert into booking_payments(booking_id,product_id,buyer_id,closer_user_id,plan_type,status,currency,amount_total_cents,installment_collection_version) values($1,$2,$3,$4,'installment','pending','usd',199900,$5)";
  for (const version of [null, "exact-cents-context-v2"]) {
    await db.exec("savepoint admission");
    await expect(db.query(insert, [ids.booking, ids.product, ids.buyer, ids.creator, version])).rejects.toThrow();
    await db.exec("rollback to savepoint admission; release savepoint admission");
  }
  const other = "55555555-5555-4555-8555-555555555556";
  await db.query("insert into bookings(id,post_id,creator_id,buyer_id,status) values($1,$2,$3,$4,'booked')", [other, ids.post, ids.creator, ids.buyer]);
  await db.query(insert, [other, ids.product, ids.buyer, ids.creator, null]);
  expect((await db.query("select booking_id,installment_collection_version from booking_payments")).rows).toEqual([
    { booking_id: other, installment_collection_version: null }]);
});

test("credit connection SQL authority and immutability: no direct client/link write or payment conversion", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  await h.credit.creditFirstPayment(reservationId, ids.creator);
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await db.query("select has_table_privilege($1,'public.exact_context_accounting_links_v2','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role])).rows).toEqual([{ allowed: false }]);
  }
  for (const sql of ["update booking_payments set installment_collection_version=null", "update booking_payments set installment_amount_cents=1",
    "update booking_payments set link_url='https://checkout.stripe.com/invalid'", "delete from exact_context_accounting_links_v2"]) {
    await db.exec("savepoint denied"); await expect(db.exec(sql)).rejects.toThrow();
    await db.exec("rollback to savepoint denied; release savepoint denied");
  }
  for (const role of ["anon", "authenticated"]) {
    expect((await db.query("select has_function_privilege($1,'public.credit_exact_context_first_payment_v2(uuid,uuid,jsonb,jsonb)','EXECUTE') allowed", [role])).rows).toEqual([{ allowed: false }]);
  }
  expect(await h.credit.creditFirstPayment(reservationId, ids.creator)).toMatchObject({ credited: false });
});

test("credit connection response mismatch is not success and reconciliation retains its one credit", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  const changed = harness((body, path) => path.endsWith("credit_exact_context_first_payment_v2") ? { ...body, agreement_id: ids.buyer } : body);
  await expect(changed.credit.creditFirstPayment(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await h.credit.creditFirstPayment(reservationId, ids.creator)).toMatchObject({ credited: false });
  expect((await db.query("select paid_count from purchases")).rows).toEqual([{ paid_count: 1 }]);
});

test("credit connection rechecks bound customer and subscription on the existing correspondence", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  await h.credit.creditFirstPayment(reservationId, ids.creator);
  for (const column of ["stripe_customer_id", "stripe_subscription_id"]) {
    await db.exec("savepoint corrupt_owner_fixture");
    await db.query(`update exact_installment_agreements set ${column}=$1 where id=$2`, [column.includes("customer") ? "cus_Unrelated" : "sub_Unrelated", reservationId]);
    await expect(h.credit.creditFirstPayment(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    await db.exec("rollback to savepoint corrupt_owner_fixture; release savepoint corrupt_owner_fixture");
  }
  expect((await db.query("select paid_count from purchases")).rows).toEqual([{ paid_count: 1 }]);
});

test.each(["test", "live"] as const)("activation connection %s: same card/calendar, exact final-cent period, collection remains held", async mode => {
  if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  await h.credit.creditFirstPayment(reservationId, ids.creator);
  const before = await financialSnapshot();
  const result = await h.activation.activateHeld(reservationId, ids.creator).catch(() => {
    throw Error(`Local activation failure: ${localSqlErrors.join("; ")}; last paths: ${h.requests.slice(-5).map(r => r.path).join(", ")}`);
  });
  expect(result).toMatchObject({ status: "activated_held", collectionAllowed: false, publicationAllowed: false });
  expect(await h.activation.activateHeld(reservationId, ids.creator)).toEqual(result);
  if (mode === "test") {
    // The new explicit buyer-retry exception must not relax normal activation.
    const sub = objects.get("/v1/subscriptions/sub_LocalCheckout")!, originalStatus = sub.status;
    sub.status = "past_due";
    await expect(h.activation.activateHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    sub.status = originalStatus;
  }
  const paidAt = objects.get("/v1/charges/ch_LocalCheckout")!.created as number;
  const dates = exactActivationDates(paidAt, 3);
  expect(result).toMatchObject(dates);
  const periods = (await db.query("select payment_number,amount_cents::int,application_fee_cents::int,due_at::bigint from exact_installment_periods order by payment_number")).rows;
  expect(periods).toMatchObject([{ payment_number: 2, amount_cents: 66633, application_fee_cents: 9958, due_at: dates.firstRenewalAt },
    { payment_number: 3, amount_cents: 66634, application_fee_cents: 9958 }]);
  expect(h.stripeWrites().map(q => q.path)).toEqual(["/v1/checkout/sessions", "/v1/subscriptions/sub_LocalCheckout"]);
  const after = await financialSnapshot();
  expect(after.filter(r => r.kind !== "agreement")).toEqual(before.filter(r => r.kind !== "agreement"));
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
});

async function seedCreditedActivation() {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  await h.credit.creditFirstPayment(reservationId, ids.creator); return h;
}

function subscriptionEvent(type = "customer.subscription.updated") {
  objects.set("/v1/events/evt_LocalSubscription", { object: "event", id: "evt_LocalSubscription", type, api_version: config.expectedApiVersion,
    livemode: config.approvedContext.mode === "live", created: Math.floor(Date.now() / 1000),
    data: { object: structuredClone(objects.get("/v1/subscriptions/sub_LocalCheckout")) } });
  return "evt_LocalSubscription";
}
async function subscriptionRows() {
  return (await db.query("select revision,stripe_event_id,disposition from exact_installment_lifecycle_observations where stripe_object_id='sub_LocalCheckout'")).rows;
}
test.each((["test", "live"] as const).flatMap(mode => ["2025-09-30.clover", "2025-10-29.clover"].map(version => ({ mode, version }))))(
  "subscription $mode original $version Event uses current held/activated state without money/access changes or new holds", async ({ mode, version }) => {
  if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  const setup = await seedCreditedActivation(), eventId = subscriptionEvent("customer.subscription.created"), before = await financialSnapshot(), h = harness();
  objects.get(`/v1/events/${eventId}`)!.api_version = version;
  try {
    expect(await h.subscription.observeSubscription(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_observed", disposition: "expected_held_schedule" });
    expect(await stopHolds()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
    await setup.activation.activateHeld(reservationId, ids.creator);
    const active = await financialSnapshot(); // Activation itself advances the agreement, not this observer.
    // Delayed creation payload is still preactivation; the fresh subscription governs.
    for (let i = 0; i < 2; i++) expect(await h.subscription.observeSubscription(reservationId, ids.creator, eventId))
      .toMatchObject({ status: "lifecycle_observed", disposition: "expected_held_schedule", providerOperationsAllowed: false, collectionAllowed: false });
    expect(await financialSnapshot()).toEqual(active);
  } catch (e) { throw Error(`Local subscription error: ${String(e)}; SQL: ${localSqlErrors.join("; ")}; paths: ${h.requests.slice(-8).map(r => r.path).join(", ")}`); }
  expect(await subscriptionRows()).toMatchObject([{ revision: 3, disposition: "expected_held_schedule" }]);
  expect(await stopHolds()).toEqual([]); expect(h.stripeWrites()).toEqual([]);
});

test("subscription schedule drift is held for review; a later normal observation cannot release that hold", async () => {
  const setup = await seedCreditedActivation(); await setup.activation.activateHeld(reservationId, ids.creator);
  const eventId = subscriptionEvent(), before = await financialSnapshot(), sub = objects.get("/v1/subscriptions/sub_LocalCheckout")!;
  for (const change of [
    { pause_collection: null }, { cancel_at: Number(sub.cancel_at) + 1 }, { default_payment_method: "pm_Foreign" },
    { application_fee_percent: 12 }, { status: "past_due" }, { status: "paused" },
    { metadata: { ...(sub.metadata as Body), terms_hash: "wrong" } }, { items: { has_more: false, data: [] } },
  ]) {
    const h = harness((b, path) => path === "/v1/subscriptions/sub_LocalCheckout" ? { ...b, ...change } : b);
    expect(await h.subscription.observeSubscription(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_review_recorded", disposition: "review_required" });
    expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
  }
  expect(await stopHolds()).toHaveLength(1);
  expect(await harness().subscription.observeSubscription(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_observed", disposition: "expected_held_schedule" });
  expect(await stopHolds()).toHaveLength(1); expect(await financialSnapshot()).toEqual(before);
});

test("subscription owner, mode, event source and API mismatches cannot be observed", async () => {
  await seedCreditedActivation(); const eventId = subscriptionEvent(), before = await financialSnapshot();
  await expect(harness().subscription.observeSubscription(reservationId, ids.buyer, eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  for (const [path, change] of [
    ["/v1/account", { id: "acct_Foreign" }], ["/v1/subscriptions/sub_LocalCheckout", { customer: "cus_Foreign" }],
    ["/v1/subscriptions/sub_LocalCheckout", { livemode: true }],
    [`/v1/events/${eventId}`, { account: "acct_Foreign" }], [`/v1/events/${eventId}`, { context: "foreign" }],
    [`/v1/events/${eventId}`, { api_version: "1900-01-01" }], [`/v1/events/${eventId}`, { type: "invoice.paid" }],
    [`/v1/events/${eventId}`, { created: Math.floor(Date.now() / 1000) + 300 }],
    [`/v1/events/${eventId}`, { data: { object: { ...objects.get("/v1/subscriptions/sub_LocalCheckout"), id: "sub_Foreign" } } }],
  ] as [string, Body][]) {
    const bad = harness((b, p) => p === path ? { ...b, ...change } : b);
    await expect(bad.subscription.observeSubscription(reservationId, ids.creator, eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(bad.stripeWrites()).toEqual([]);
  }
  expect(await subscriptionRows()).toEqual([]); expect(await stopHolds()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
});

test("subscription approved stop is observed, while an early unapproved cancellation is review only", async () => {
  await seedStop(); const before = await financialSnapshot(), setup = harness();
  expect(await setup.stop.stopBilling(reservationId, stopActor, stopRequest)).toMatchObject({ status: "collection_stopped" });
  const h = harness(), eventId = subscriptionEvent("customer.subscription.deleted");
  expect(await h.subscription.observeSubscription(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_observed", disposition: "billing_stop_observed" });
  const wrong = harness((b, path) => path === "/v1/subscriptions/sub_LocalCheckout" ? { ...b, canceled_at: Number(b.canceled_at) - 1 } : b);
  expect(await wrong.subscription.observeSubscription(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_review_recorded", disposition: "review_required" });
  expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toEqual([]); expect(wrong.stripeWrites()).toEqual([]);
});

test("subscription overlapping event observations cannot overwrite a newer revision", async () => {
  const setup = await seedCreditedActivation(); await setup.activation.activateHeld(reservationId, ids.creator);
  const eventId = subscriptionEvent(), before = await financialSnapshot(); let intervened = false;
  const h = harness(async (b, path) => {
    if (!intervened && path === "/v1/subscriptions/sub_LocalCheckout") {
      intervened = true; const other = harness((x, p) => p === path ? { ...x, pause_collection: null } : x);
      expect(await other.subscription.observeSubscription(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_review_recorded" });
    }
    return b;
  });
  expect(await h.subscription.observeSubscription(reservationId, ids.creator, eventId)).toMatchObject({ status: "reconciliation_required" });
  expect(await subscriptionRows()).toMatchObject([{ revision: 1, disposition: "review_required" }]);
  expect(await stopHolds()).toHaveLength(1); expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toEqual([]);
});

test("subscription activation changing during the read is not acknowledged against the old basis", async () => {
  const setup = await seedCreditedActivation(), eventId = subscriptionEvent(); let activated = false;
  const h = harness(async (b, path) => {
    if (!activated && path === "/v1/subscriptions/sub_LocalCheckout") { activated = true; await setup.activation.activateHeld(reservationId, ids.creator); }
    return b;
  });
  expect(await h.subscription.observeSubscription(reservationId, ids.creator, eventId)).toMatchObject({ status: "reconciliation_required" });
  expect(await subscriptionRows()).toEqual([]); expect(await stopHolds()).toEqual([]); expect(h.stripeWrites()).toEqual([]);
  expect(await h.subscription.observeSubscription(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_observed" });
});

test("subscription lost audit acknowledgement and provider outages never send a subscription mutation", async () => {
  await seedCreditedActivation(); const eventId = subscriptionEvent(), before = await financialSnapshot(); let lost = false;
  const h = harness((b, path) => { if (!lost && path.endsWith("observe_exact_context_subscription_v2")) { lost = true; throw Error("Synthetic lost audit response"); } return b; });
  await expect(h.subscription.observeSubscription(reservationId, ids.creator, eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await subscriptionRows()).toHaveLength(1); expect(await h.subscription.observeSubscription(reservationId, ids.creator, eventId)).toMatchObject({ status: "lifecycle_observed" });
  const rows = await subscriptionRows();
  const outage = harness((b, path) => { if (path === "/v1/subscriptions/sub_LocalCheckout") throw Error("Synthetic unavailable private read"); return b; });
  await expect(outage.subscription.observeSubscription(reservationId, ids.creator, eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await subscriptionRows()).toEqual(rows); expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toEqual([]); expect(outage.stripeWrites()).toEqual([]);
});

test("subscription SQL is owner/context-bound and service-only; uncredited plans stay outside this post-credit entry", async () => {
  await seedHeld(); const eventId = subscriptionEvent(), h = harness();
  await expect(h.subscription.observeSubscription(reservationId, ids.creator, eventId)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.requests.some(r => r.path === `/v1/events/${eventId}`)).toBe(false);
  await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession(); await h.credit.creditFirstPayment(reservationId, ids.creator);
  const wrong = { ...config.approvedContext, platformAccountId: "acct_Foreign" };
  await expect(rpc("read_exact_context_subscription_v2", [reservationId, ids.creator, JSON.stringify(wrong)])).rejects.toThrow();
  for (const role of ["anon", "authenticated", "service_role"]) for (const sig of ["read_exact_context_subscription_v2(uuid,uuid,jsonb)",
    "observe_exact_context_subscription_v2(uuid,uuid,jsonb,jsonb,jsonb,text,jsonb)"]) {
    expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, `public.${sig}`])).rows).toEqual([{ allowed: role === "service_role" }]);
  }
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
});

const stopActor = "66666666-6666-4666-8666-666666666666", stopRequest = "77777777-7777-4777-8777-777777777777";
async function seedStop() {
  await seedCreditedActivation(); await db.exec("commit; begin");
  await db.query("insert into auth.users(id) values($1)", [stopActor]);
  await db.query("insert into profiles(id,role) values($1,'admin')", [stopActor]);
  objects.set("/v1/subscriptions", { object: "list", has_more: false, data: [objects.get("/v1/subscriptions/sub_LocalCheckout")] });
  objects.set("/v1/invoiceitems", { object: "list", has_more: false, data: [] });
}
const stopHolds = async () => (await db.query("select reason,request_id,requested_by from exact_installment_collection_holds order by reason")).rows;
test("ordering persisted binding stays uncredited before the first receipt and becomes credited once", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator);
  const resolve = async (kind: string, providerId: string, hint: string | null = null) =>
    (await db.query<{ binding: Body }>("select resolve_exact_context_event_v2($1,$2,$3) binding", [kind, providerId, hint])).rows[0].binding;
  expect(await resolve("subscription", "sub_LocalCheckout")).toMatchObject({ reservationId, buyerId: ids.buyer, firstCredited: false, firstIntentId: null });
  expect(await resolve("intent", "pi_LocalCheckout", reservationId)).toMatchObject({ reservationId, firstCredited: false, paymentNumber: null });
  expect((await db.query("select id from purchases")).rows).toEqual([]);
  paySyntheticSession(); await h.credit.creditFirstPayment(reservationId, ids.creator);
  const before = await financialSnapshot();
  expect(await resolve("intent", "pi_LocalCheckout")).toMatchObject({ reservationId, firstCredited: true, paymentNumber: 1 });
  expect(await resolve("session", "cs_test_LocalCheckout")).toMatchObject({ reservationId, firstCredited: true });
  expect(await financialSnapshot()).toEqual(before);
  await db.exec("savepoint mismatch");
  await expect(resolve("session", "cs_test_LocalCheckout", ids.product)).rejects.toThrow("conflicts");
  await db.exec("rollback to savepoint mismatch; release savepoint mismatch");
  for (const role of ["anon", "authenticated"]) expect((await db.query("select has_function_privilege($1,'public.resolve_exact_context_event_v2(text,text,uuid)','EXECUTE') allowed", [role])).rows).toEqual([{ allowed: false }]);
});
test.each(["zero", "nonzero", "foreign"])("ordering bootstrap invoice %s cannot manufacture first credit", async fault => {
  await seedHeld();
  objects.set("/v1/invoices/in_LocalBootstrap", { object: "invoice", id: "in_LocalBootstrap", livemode: false,
    parent: { subscription_details: { subscription: "sub_LocalCheckout" } }, customer: fault === "foreign" ? "cus_Foreign" : "cus_LocalCheckout",
    currency: "usd", billing_reason: "subscription_create", total: fault === "nonzero" ? 1 : 0, subtotal: 0, amount_due: 0,
    amount_paid: 0, amount_overpaid: 0, amount_remaining: 0, starting_balance: 0, discounts: [], total_discount_amounts: [], total_taxes: [] });
  const h = harness(), result = h.runtime.inspectBootstrapInvoice(reservationId, ids.creator, "in_LocalBootstrap");
  if (fault === "zero") expect(await result).toMatchObject({ status: "bootstrap_zero" });
  else await expect(result).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toEqual([]); expect((await db.query("select id from purchases")).rows).toEqual([]);
});

async function seedAdminRefund() {
  await seedStop();
  const charge = objects.get("/v1/charges/ch_LocalCheckout")!;
  charge.transfer_data = { destination: "acct_LocalCreator" }; charge.application_fee = "fee_LocalCheckout";
  objects.set("/v1/application_fees/fee_LocalCheckout", { object: "application_fee", id: "fee_LocalCheckout", livemode: config.approvedContext.mode === "live",
    charge: "ch_LocalCheckout", account: "acct_LocalCreator", currency: "usd", amount: expectedFirstFee, amount_refunded: 0,
    refunds: { object: "list", has_more: false, data: [] } });
  const ledgerId = (await db.query<{ id: string }>("select id from payment_fee_ledger where stripe_payment_intent_id='pi_LocalCheckout'")).rows[0].id;
  const input = { paymentFeeLedgerId: ledgerId, amountCents: 10000, reasonCode: "creator_non_delivery" as const,
    responsibility: "creator" as const, internalNotes: "Synthetic context connection only", idempotencyKey: "local-context-refund-1" };
  return { ledgerId, input };
}
test("refund existing engine completes partial then remainder and replay never creates a third refund", async () => {
  const { ledgerId, input } = await seedAdminRefund(), h = harness();
  const run = (action: Parameters<typeof h.adminRefund.run>[3]) => h.adminRefund.run(reservationId, stopActor, ledgerId, action);
  expect(await run({ kind: "preview", input })).toMatchObject({ paymentFeeLedgerId: ledgerId, grossAmountCents: 66633 });
  expect(h.stripeWrites()).toEqual([]);
  const first = await run({ kind: "create", input });
  expect(first).toMatchObject({ disposition: "completed", operation: { customerRefundAmountCents: 10000 } });
  if (!("operation" in first)) throw Error("Expected operation");
  expect(await run({ kind: "retry", operationId: first.operation.id })).toMatchObject({ disposition: "completed" });
  expect(await run({ kind: "create", input: { ...input, amountCents: 56633, idempotencyKey: "local-context-refund-2" } }))
    .toMatchObject({ disposition: "completed", operation: { cumulativeCustomerRefundTargetCents: 66633, remainingRefundableCents: 0 } });
  expect(h.stripeWrites().filter(r => r.path === "/v1/refunds")).toHaveLength(2);
  expect((await db.query("select status from refund_operations")).rows).toEqual([{ status: "completed" }, { status: "completed" }]);
  expect((await stopHolds()).filter(r => (r as Body).reason === "admin_refund")).toHaveLength(2);
  expect((await db.query("select count(*)::int n from refund_operations where webhook_confirmed_at is not null")).rows).toEqual([{ n: 0 }]);
});
test.each(["actor", "ledger", "context", "mode", "destination", "charge", "fee"])("refund refuses mismatched %s before reserving or sending", async fault => {
  const { ledgerId, input } = await seedAdminRefund();
  if (fault === "mode") objects.get("/v1/charges/ch_LocalCheckout")!.livemode = true;
  if (fault === "destination") objects.get("/v1/charges/ch_LocalCheckout")!.transfer_data = { destination: "acct_Foreign" };
  if (fault === "charge") objects.get("/v1/charges/ch_LocalCheckout")!.payment_intent = "pi_Foreign";
  if (fault === "fee") objects.get("/v1/application_fees/fee_LocalCheckout")!.account = "acct_Foreign";
  if (fault === "context") config = { ...config, approvedContext: { ...context, platformAccountId: "acct_Foreign" } };
  const h = harness();
  await expect(h.adminRefund.run(reservationId, fault === "actor" ? ids.buyer : stopActor,
    fault === "ledger" ? ids.product : ledgerId, { kind: "create", input })).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toEqual([]); expect((await db.query("select id from refund_operations")).rows).toEqual([]);
});
test("refund lost fee response resumes the same operation without a second customer refund", async () => {
  const { ledgerId, input } = await seedAdminRefund(); let lost = false;
  const h = harness((b, path, method) => {
    if (!lost && method === "POST" && path.endsWith("/fee_LocalCheckout/refunds")) { lost = true; throw Error("Synthetic lost response"); } return b;
  });
  const first = await h.adminRefund.run(reservationId, stopActor, ledgerId, { kind: "create", input });
  expect(first).toMatchObject({ disposition: "needs_reconciliation" });
  if (!("operation" in first)) throw Error("Expected operation");
  expect(await h.adminRefund.run(reservationId, stopActor, ledgerId, { kind: "retry", operationId: first.operation.id }))
    .toMatchObject({ disposition: "completed" });
  expect(lost).toBe(true); expect(h.stripeWrites()).toHaveLength(2);
});
test("refund expanded Stripe fee and balance objects work in a synthetic live context", async () => {
  config = { ...config, approvedContext: { ...context, mode: "live", siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  const { ledgerId, input } = await seedAdminRefund();
  const charge = objects.get("/v1/charges/ch_LocalCheckout")!;
  charge.application_fee = objects.get("/v1/application_fees/fee_LocalCheckout");
  charge.balance_transaction = objects.get("/v1/balance_transactions/txn_LocalCheckout");
  const h = harness();
  expect(await h.adminRefund.run(reservationId, stopActor, ledgerId, { kind: "create", input })).toMatchObject({ disposition: "completed" });
  expect(h.stripeWrites()).toHaveLength(2);
});
test("refund context SQL rejects browser roles and unrelated operation IDs", async () => {
  const { ledgerId } = await seedAdminRefund();
  const sql = "select run_exact_context_admin_refund_v2($1,$2,$3::jsonb,$4,'source','{}')";
  const params = [reservationId, stopActor, JSON.stringify(context), ledgerId];
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`savepoint denied_refund; set local role ${role}`);
    await expect(db.query(sql, params)).rejects.toThrow(/permission denied/);
    await db.exec("rollback to savepoint denied_refund; reset role; release savepoint denied_refund");
  }
  await expect(harness().adminRefund.run(reservationId, stopActor, ledgerId, { kind: "retry", operationId: ids.product }))
    .rejects.toThrow(CONTEXT_RUNTIME_ERROR);
});

test("stop denies non-admin and different request without changing the original hold", async () => {
  await seedStop(); const h = harness(), before = await financialSnapshot();
  await expect(h.stop.stopBilling(reservationId, ids.creator, stopRequest)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await stopHolds()).toEqual([]); expect(h.stripeWrites()).toEqual([]);
  await h.stop.stopBilling(reservationId, stopActor, stopRequest);
  await expect(h.stop.stopBilling(reservationId, stopActor, "77777777-7777-4777-8777-777777777778")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await stopHolds()).toEqual([{ reason: "cancellation_review", request_id: stopRequest, requested_by: stopActor }]);
  expect(await financialSnapshot()).toEqual(before); expect(h.stripeWrites()).toHaveLength(1);
});
test.each(["shared customer", "pending items", "subscription metadata", "customer mode", "unaccounted invoice", "unsettled payment"])(
  "stop refuses %s and retains the administrator hold before any cancellation", async fault => {
    await seedStop(); const before = await financialSnapshot();
    if (fault === "shared customer") (objects.get("/v1/subscriptions")!.data as Body[]).push({ id: "sub_Unrelated" });
    if (fault === "pending items") (objects.get("/v1/invoiceitems")!.data as Body[]).push({ id: "ii_LocalPending" });
    if (fault === "subscription metadata") objects.get("/v1/subscriptions/sub_LocalCheckout")!.metadata = {};
    if (fault === "customer mode") objects.get("/v1/customers/cus_LocalCheckout")!.livemode = true;
    if (fault === "unaccounted invoice" || fault === "unsettled payment") {
      const inv = { object: "invoice", id: "in_LocalStop", livemode: false, customer: "cus_LocalCheckout", currency: "usd",
        parent: { subscription_details: { subscription: "sub_LocalCheckout" } }, status: fault === "unsettled payment" ? "open" : "paid",
        auto_advance: false, total: 66633, amount_paid: fault === "unsettled payment" ? 0 : 66633 };
      objects.set("/v1/invoices", { object: "list", has_more: false, data: [inv] });
      objects.set("/v1/invoice_payments", { object: "list", has_more: false, data: [{ object: "invoice_payment", id: "inpay_LocalStop", invoice: inv.id,
        livemode: false, is_default: true, currency: "usd", status: "open", amount_paid: 0, amount_requested: 66633,
        payment: { type: "payment_intent", payment_intent: "pi_LocalStop" } }] });
      objects.set("/v1/payment_intents/pi_LocalStop", { object: "payment_intent", id: "pi_LocalStop", livemode: false,
        customer: "cus_LocalCheckout", currency: "usd", status: "processing", amount: 66633, amount_received: 0, amount_capturable: 0 });
    }
    const h = harness(); await expect(h.stop.stopBilling(reservationId, stopActor, stopRequest)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(h.stripeWrites()).toEqual([]); expect(await financialSnapshot()).toEqual(before);
    expect(await stopHolds()).toEqual([{ reason: "cancellation_review", request_id: stopRequest, requested_by: stopActor }]);
  });
test.each(["ready", "authorized", "collection_stopped"])("stop lost %s SQL response never resends a cancellation", async status => {
  await seedStop(); const before = await financialSnapshot(); let lost = false;
  const h = harness((body, path) => {
    if (!lost && path.endsWith("run_exact_context_stop_v2") && body.status === status) { lost = true; throw Error("SYNTHETIC lost response"); }
    return body;
  });
  await expect(h.stop.stopBilling(reservationId, stopActor, stopRequest)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(lost).toBe(true);
  expect(await h.stop.stopBilling(reservationId, stopActor, stopRequest)).toMatchObject({ status: status === "collection_stopped" ? "collection_stopped" : "busy" });
  expect(h.stripeWrites()).toHaveLength(status === "collection_stopped" ? 1 : 0); expect(await financialSnapshot()).toEqual(before);
  expect(await stopHolds()).toHaveLength(1);
});
test("stop lost provider response uses actual terminal state without another DELETE", async () => {
  await seedStop(); const before = await financialSnapshot();
  const h = harness((body, _path, method) => { if (method === "DELETE") throw Error("SYNTHETIC lost cancellation response"); return body; });
  expect(await h.stop.stopBilling(reservationId, stopActor, stopRequest)).toMatchObject({ status: "collection_stopped" });
  expect(await h.stop.stopBilling(reservationId, stopActor, stopRequest)).toMatchObject({ status: "collection_stopped" });
  expect(h.stripeWrites()).toHaveLength(1); expect(await financialSnapshot()).toEqual(before);
});
test("stop rechecks administrator role immediately before its provider operation", async () => {
  await seedStop(); const before = await financialSnapshot();
  const h = harness(async (body, path) => {
    if (path.endsWith("run_exact_context_stop_v2") && body.status === "ready") await db.query("update profiles set role='user' where id=$1", [stopActor]);
    return body;
  });
  await expect(h.stop.stopBilling(reservationId, stopActor, stopRequest)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toEqual([]); expect(await stopHolds()).toHaveLength(1); expect(await financialSnapshot()).toEqual(before);
});
test("stop SQL rejects wrong context, forged completion, legacy bypass and client execution", async () => {
  await seedStop(); const before = await financialSnapshot();
  for (const role of ["anon", "authenticated"]) for (const signature of ["read_exact_context_stop_v2(uuid,uuid,jsonb)", "run_exact_context_stop_v2(uuid,uuid,jsonb,uuid,uuid,text,jsonb)"]) {
    expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, `public.${signature}`])).rows).toEqual([{ allowed: false }]);
  }
  const denied = async (sql: string, values: unknown[]) => {
    await db.exec("savepoint stop_denied; set local role service_role"); await expect(db.query(sql, values)).rejects.toThrow();
    await db.exec("rollback to savepoint stop_denied; reset role; release savepoint stop_denied");
  };
  await denied("select public.read_exact_context_stop_v2($1,$2,$3::jsonb)", [reservationId, stopActor, JSON.stringify({ ...config.approvedContext, platformAccountId: "acct_Foreign" })]);
  await denied("select public.claim_exact_installment_billing_stop($1,$2,$3,$4)", [reservationId, stopRequest, stopActor, ids.product]);
  await denied("select public.run_exact_context_stop_v2($1,$2,$3::jsonb,$4,$5,'complete',$6::jsonb)", [reservationId, stopActor,
    JSON.stringify(config.approvedContext), stopRequest, ids.product, JSON.stringify({ subscriptionId: "sub_LocalCheckout", sessionId: "cs_test_LocalCheckout",
      canceledAt: Math.floor(Date.now() / 1000), checkoutStatus: "complete", firstPaymentIntentId: "pi_LocalCheckout" })]);
  expect(await financialSnapshot()).toEqual(before); expect(await stopHolds()).toEqual([]);
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
});
test("stop waits for an admitted capture, then reuses its receipt without paying again", async () => {
  await seedInvoicePrecursor(); let captured = false;
  const setup = harness((body, path) => {
    if (path.endsWith("/pay")) { captured = true; throw Error("Synthetic capture response lost"); }
    if (captured && path === "/v1/payment_intents/pi_LocalRenewal") throw Error("Synthetic payment read outage");
    return body;
  });
  await expect(setup.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  await db.exec("commit; begin");
  await db.query("insert into auth.users(id) values($1)", [stopActor]);
  await db.query("insert into profiles(id,role) values($1,'admin')", [stopActor]);
  objects.set("/v1/subscriptions", { object: "list", has_more: false, data: [objects.get("/v1/subscriptions/sub_LocalCheckout")] });
  objects.set("/v1/invoiceitems", { object: "list", has_more: false, data: [] });
  objects.set("/v1/invoices", { object: "list", has_more: false, data: [objects.get("/v1/invoices/in_LocalRenewal")] });
  const before = await financialSnapshot(), h = harness();
  expect(await h.stop.stopBilling(reservationId, stopActor, stopRequest)).toMatchObject({ status: "reconciliation_required" });
  expect(h.stripeWrites()).toHaveLength(0); expect(await financialSnapshot()).toEqual(before); expect(await stopHolds()).toHaveLength(1);
  expect(await h.collection.reconcileInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "credited" });
  const credited = await financialSnapshot();
  expect(await h.stop.stopBilling(reservationId, stopActor, stopRequest)).toMatchObject({ status: "collection_stopped" });
  expect(await financialSnapshot()).toEqual(credited);
  expect(h.stripeWrites()).toEqual([{ method: "DELETE", path: "/v1/subscriptions/sub_LocalCheckout" }]);
  expect(setup.stripeWrites().filter(r => r.path.endsWith("/pay"))).toHaveLength(1);
});
test.each(["test", "live"] as const)("stop connection %s: one owned administrator stop, unchanged money/access, exact replay", async mode => {
  if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await seedStop(); const before = await financialSnapshot(), h = harness();
  let result;
  try { result = await h.stop.stopBilling(reservationId, stopActor, stopRequest); }
  catch { throw Error(`Local stop failure: ${localSqlErrors.join("; ")}; last paths: ${h.requests.slice(-10).map(r => r.path).join(", ")}`); }
  if (result.status !== "collection_stopped") throw Error(`Local stop status ${result.status}; paths: ${h.requests.map(r => r.method + " " + r.path).join(", ")}; SQL: ${localSqlErrors.join("; ")}`);
  expect(result).toMatchObject({ status: "collection_stopped", publicationAllowed: false });
  expect(await h.stop.stopBilling(reservationId, stopActor, stopRequest)).toEqual(result);
  expect(h.stripeWrites()).toEqual([{ method: "DELETE", path: "/v1/subscriptions/sub_LocalCheckout" }]);
  expect(await financialSnapshot()).toEqual(before);
  expect(await stopHolds()).toEqual([{ reason: "cancellation_review", request_id: stopRequest, requested_by: stopActor }]);
  expect((await db.query("select status,checkout_terminal_status from exact_installment_billing_stops")).rows).toEqual([{ status: "complete", checkout_terminal_status: "complete" }]);
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
});

async function seedInvoicePrecursor(number: 2 | 3 = 2, includePriorClaim = false, serviceMonths?: number) {
  // LOCAL SYNTHETIC PRECURSOR ONLY, not a historical provider/payment record.
  // Take shapes from the already-tested setup, then create a fresh in-memory
  // database with a past agreement as INITIAL INSERTS. Never update immutable
  // evidence, replace SQL time/guards, or advance a provider/signature clock.
  // This proves current invoice preparation, not the preceding month's capture.
  const setup = await seedCreditedActivation(); await setup.activation.activateHeld(reservationId, ids.creator);
  await db.exec("commit; begin");
  const tables = ["auth.users", "profiles", "products", "posts", "bookings", "exact_installment_context_pin_v2",
    "exact_installment_context_reservations_v2", "exact_installment_context_customer_operations_v2", "exact_context_customer_attempts_v2",
    "exact_context_customer_bindings_v2", "exact_context_held_steps_v2", "exact_context_held_results_v2", "exact_context_checkout_attempts_v2",
    "exact_context_checkout_results_v2", "exact_context_first_receipts_v2", "exact_context_accounting_links_v2", "booking_payments",
    "purchases", "exact_installment_agreements", "exact_installment_operations", "payment_fee_ledger", "exact_installment_receipts",
    "exact_installment_activations", "exact_installment_periods", "exact_installment_invoice_claims",
    ...(serviceMonths === undefined ? [] : ["fixed_purchase_service_contracts_v1"])];
  const template = new Map<string, Body[]>();
  for (const table of tables) template.set(table, (await db.query<{ row: Body }>(`select to_jsonb(t) row from ${table} t`)).rows.map(x => x.row));
  const delta = (number === 2 ? 40 : 70) * 86400;
  const paidAt = Number(template.get("exact_context_first_receipts_v2")![0].paid_at) - delta;
  const dates = exactActivationDates(paidAt, 3);
  const timeKeys = new Set(["anchor_seconds", "customer_created", "paid_at", "firstPaidAt", "expires_at", "created", "trial_end", "cancel_at", "billing_cycle_anchor",
    ...(serviceMonths === undefined ? [] : ["service_start_at"])]);
  function historical(value: unknown, key = ""): unknown {
    if (typeof value === "string" && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:/.test(value)) return new Date(Date.parse(value) - delta * 1000).toISOString();
    if (typeof value === "number" && timeKeys.has(key)) return value - delta;
    if (Array.isArray(value)) return value.map(v => historical(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, historical(v, k)]));
    return value;
  }
  for (const [table, rows] of template) template.set(table, rows.map(row => historical(row) as Body));
  if (serviceMonths !== undefined) {
    for (const row of template.get("fixed_purchase_service_contracts_v1")!) {
      row.service_end_at = fixedServiceEndAt(Number(row.service_start_at), Number(row.service_months));
    }
  }
  for (const row of template.get("exact_context_held_steps_v2")!) if (row.stage === "subscription") {
    const params = (row.request as { params: Body }).params;
    params.cancel_at = installmentMonthBoundary(Number(params.trial_end), 2);
  }
  const activation = template.get("exact_installment_activations")![0];
  Object.assign(activation.activation_snapshot as Body, dates);
  for (const row of template.get("exact_installment_periods")!) {
    row.due_at = installmentMonthBoundary(dates.firstRenewalAt, Number(row.payment_number) - 2);
    row.period_end = installmentMonthBoundary(dates.firstRenewalAt, Number(row.payment_number) - 1);
  }
  if (number === 3) {
    const ledger: Body = { ...template.get("payment_fee_ledger")![0], id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      stripe_payment_intent_id: "pi_LocalPrevious", stripe_invoice_id: "in_LocalPrevious", stripe_checkout_session_id: null,
      stripe_charge_id: "ch_LocalPrevious", stripe_balance_transaction_id: "txn_LocalPrevious" };
    const priorPaid = dates.firstRenewalAt + 60;
    ledger.earnings_credited_at = new Date(priorPaid * 1000).toISOString();
    template.get("payment_fee_ledger")!.push(ledger);
    template.get("exact_installment_receipts")!.push({ ...template.get("exact_installment_receipts")![0], payment_number: 2,
      stripe_invoice_id: "in_LocalPrevious", stripe_payment_intent_id: "pi_LocalPrevious", ledger_id: ledger.id,
      paid_at: ledger.earnings_credited_at, counted_at: ledger.earnings_credited_at });
    template.get("purchases")![0].paid_count = 2;
    template.get("profiles")!.find(p => p.id === ids.creator)!.total_earnings_cents = 113350;
    if (includePriorClaim) template.get("exact_installment_invoice_claims")!.push({ agreement_id: reservationId, payment_number: 2,
      stripe_invoice_id: "in_LocalPrevious", stripe_payment_intent_id: "pi_LocalPrevious", status: "paid", claim_token: ids.creator,
      first_started_at: new Date(priorPaid * 1000).toISOString(), lease_until: new Date((priorPaid + 60) * 1000).toISOString(),
      dispatch_started_at: new Date(priorPaid * 1000).toISOString() });
  }
  await db.exec("rollback"); await db.close(); await installDatabase(); await db.exec("begin"); committedFixture = true;
  if (serviceMonths !== undefined) await installFixedServiceDuration();
  for (const table of tables) for (const row of template.get(table)!) {
    await db.query(`insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`, [JSON.stringify(row)]);
  }
  await db.exec("commit; begin");
  for (const [path, object] of objects) objects.set(path, historical(object) as Body);
  if (number === 3) {
    objects.set("/v1/payment_intents/pi_LocalPrevious", { ...objects.get("/v1/payment_intents/pi_LocalCheckout"),
      id: "pi_LocalPrevious", latest_charge: "ch_LocalPrevious" });
    objects.set("/v1/charges/ch_LocalPrevious", { ...objects.get("/v1/charges/ch_LocalCheckout"),
      id: "ch_LocalPrevious", payment_intent: "pi_LocalPrevious", created: dates.firstRenewalAt + 60, balance_transaction: "txn_LocalPrevious" });
  }
  const sub = objects.get("/v1/subscriptions/sub_LocalCheckout")!;
  Object.assign(sub, { status: "active", trial_end: dates.firstRenewalAt, billing_cycle_anchor: dates.firstRenewalAt, cancel_at: dates.cancelAt });
  const period = template.get("exact_installment_periods")!.find(p => p.payment_number === number)!;
  expect(Number(period.due_at)).toBeLessThan(Date.now() / 1000); expect(Number(period.period_end)).toBeGreaterThan(Date.now() / 1000);
  const live = config.approvedContext.mode === "live";
  const line = { id: "il_LocalRenewal", amount: 66633, livemode: live, currency: "usd", quantity: 1, invoice: "in_LocalRenewal",
    period: { start: period.due_at, end: period.period_end }, discounts: [], discount_amounts: [], taxes: [], pretax_credit_amounts: [],
    parent: { type: "subscription_item_details", subscription_item_details: { proration: false, subscription: "sub_LocalCheckout", subscription_item: "si_LocalCheckout" } } };
  objects.set("/v1/invoices/in_LocalRenewal", { object: "invoice", id: "in_LocalRenewal", livemode: live, customer: "cus_LocalCheckout", currency: "usd",
    parent: { subscription_details: { subscription: "sub_LocalCheckout" } }, status: "draft", auto_advance: false, next_payment_attempt: null,
    automatically_finalizes_at: null, attempted: false, attempt_count: 0, collection_method: "charge_automatically", billing_reason: "subscription_cycle",
    amount_due: 66633, amount_remaining: 66633, total: 66633, subtotal: 66633, amount_paid: 0, amount_overpaid: 0, starting_balance: 0,
    pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, automatic_tax: { enabled: false }, discounts: [], total_discount_amounts: [],
    total_taxes: [], total_pretax_credit_amounts: [], lines: { data: [line], has_more: false } });
  objects.set("/v1/invoice_payments", { object: "list", has_more: false, data: [{ invoice: "in_LocalRenewal", livemode: live, is_default: true, currency: "usd",
    amount_requested: 66633, amount_paid: null, status: "open", payment: { type: "payment_intent", payment_intent: "pi_LocalRenewal" } }] });
  objects.set("/v1/payment_intents/pi_LocalRenewal", { object: "payment_intent", id: "pi_LocalRenewal", livemode: live, customer: "cus_LocalCheckout", currency: "usd",
    amount: 66633, amount_received: 0, latest_charge: null, status: "requires_payment_method", application_fee_amount: 9958,
    payment_method_types: ["card"], transfer_data: { destination: "acct_LocalCreator" }, client_secret: "SYNTHETIC-NOT-FOR-OUTPUT" });
  return { period, sub };
}

test.each([2, 3] as const)("collection connection: installment %i is charged and credited once with fixed end unchanged", async number => {
  const { sub } = await seedInvoicePrecursor(number, true); const end = sub.cancel_at; const h = harness();
  const result = await h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal").catch(() => {
    throw Error(`Local collection failure: ${localSqlErrors.join("; ")}; last paths: ${h.requests.slice(-8).map(r => r.path).join(", ")}`);
  });
  expect(result).toMatchObject({ status: "credited", paymentNumber: number, agreementStatus: number === 3 ? "complete" : "active", publicationAllowed: false });
  const retry = harness();
  expect(await retry.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "already_credited" });
  expect(await retry.collection.reconcileInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "already_credited" });
  expect(retry.stripeWrites()).toHaveLength(0);
  expect(h.stripeWrites().filter(q => q.path.endsWith("/pay"))).toHaveLength(1);
  expect((await db.query("select paid_count,access_granted,status from purchases")).rows).toEqual([
    { paid_count: number, access_granted: true, status: number === 3 ? "complete" : "active" }]);
  expect((await db.query("select total_earnings_cents::int cents from profiles where id=$1", [ids.creator])).rows)
    .toEqual([{ cents: number === 3 ? 170026 : 113350 }]);
  expect((await db.query("select count(*)::int n,sum(amount_cents)::int cents from exact_installment_receipts")).rows)
    .toEqual([{ n: number, cents: number === 3 ? 199900 : 133266 }]);
  expect((await db.query("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{ n: number }]);
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
  expect(sub).toMatchObject({ cancel_at: end, pause_collection: { behavior: "keep_as_draft", resumes_at: null } });
  expect(JSON.stringify(result)).not.toMatch(/client_secret|SYNTHETIC|checkout\.stripe/);
  if (number === 3) {
    // A different invoice cannot reuse the completed period as payment four.
    objects.set("/v1/invoices/in_Extra", { ...objects.get("/v1/invoices/in_LocalRenewal"), id: "in_Extra" });
    const extra = harness();
    await expect(extra.collection.collectInvoice(reservationId, ids.creator, "in_Extra")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(extra.stripeWrites()).toHaveLength(0);
    expect(extra.requests.some(q => q.path.includes("admit_exact_context_invoice"))).toBe(false);
  }
});

test("collection final completion mismatch rolls back receipt and credit together without retrying payment", async () => {
  // Intentionally incomplete predecessor fixture, not altered financial history.
  await seedInvoicePrecursor(3, false); const before = await financialSnapshot(); const h = harness();
  await expect(h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(localSqlErrors).toContain("all exact installment receipts must be credited");
  expect(h.stripeWrites().filter(q => q.path.endsWith("/pay"))).toHaveLength(1);
  expect(await financialSnapshot()).toEqual(before);
  expect((await db.query("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{ n: 2 }]);
  expect((await db.query("select status from exact_installment_invoice_claims where stripe_invoice_id='in_LocalRenewal'")).rows).toEqual([{ status: "dispatching" }]);
  const retry = harness();
  await expect(retry.collection.reconcileInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(retry.stripeWrites()).toHaveLength(0); expect(await financialSnapshot()).toEqual(before);
});

test.each(["admission", "capture", "credit"])("collection lost %s response: no second dispatch or double credit", async stage => {
  await seedInvoicePrecursor(); let lost = false;
  const target = stage === "admission" ? rpcPrefix + "admit_exact_context_invoice_dispatch_v2" :
    stage === "credit" ? rpcPrefix + "credit_exact_context_invoice_v2" : "/v1/invoices/in_LocalRenewal/pay";
  const h = harness((b, path) => { if (!lost && path === target) { lost = true; throw Error("Synthetic lost response"); } return b; });
  if (stage === "capture") expect(await h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "credited" });
  else await expect(h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(lost).toBe(true);
  const retry = harness();
  expect(await retry.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal"))
    .toMatchObject({ status: stage === "admission" ? "reconciliation_required" : "already_credited" });
  expect(retry.stripeWrites()).toHaveLength(0);
  expect(retry.requests.some(q => q.path.includes("admit_exact_context_invoice"))).toBe(false);
  expect(h.stripeWrites().filter(q => q.path.endsWith("/pay"))).toHaveLength(stage === "admission" ? 0 : 1);
  expect((await db.query("select paid_count from purchases")).rows).toEqual([{ paid_count: stage === "admission" ? 1 : 2 }]);
  expect((await db.query("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{ n: stage === "admission" ? 1 : 2 }]);
});

test.each(["decline", "authentication"])("collection %s remains held and cannot retry the debit", async fault => {
  await seedInvoicePrecursor(); const before = await financialSnapshot();
  const h = harness((b, path) => {
    if (path.endsWith("/pay")) {
      Object.assign(objects.get("/v1/invoices/in_LocalRenewal")!, { status: "open", amount_paid: 0, amount_remaining: 66633 });
      Object.assign(objects.get("/v1/payment_intents/pi_LocalRenewal")!, {
        status: fault === "decline" ? "requires_payment_method" : "requires_action", amount_received: 0, latest_charge: null });
      throw Error("Synthetic card failure, no raw response should escape");
    }
    return b;
  });
  expect(await h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "reconciliation_required" });
  const retry = harness();
  expect(await retry.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "reconciliation_required" });
  expect(await retry.collection.reconcileInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "reconciliation_required" });
  expect(retry.stripeWrites()).toHaveLength(0); expect(h.stripeWrites().filter(q => q.path.endsWith("/pay"))).toHaveLength(1);
  expect(await financialSnapshot()).toEqual(before);
});

test.each(["prior-refund", "prior-dispute", "card-owner"])("collection %s prevents admission even with a prepared invoice", async fault => {
  await seedInvoicePrecursor(); const before = await financialSnapshot();
  if (fault === "card-owner") objects.get("/v1/payment_methods/pm_LocalCheckout")!.customer = "cus_Other";
  else objects.get("/v1/charges/ch_LocalCheckout")![fault === "prior-refund" ? "amount_refunded" : "disputed"] = fault === "prior-refund" ? 1 : true;
  const h = harness(); await expect(h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.requests.some(q => q.path.includes("admit_exact_context_invoice") || q.path.endsWith("/pay"))).toBe(false);
  expect(await financialSnapshot()).toEqual(before);
});

test.each(["fee", "balance"])("collection captured %s mismatch cannot create accounting evidence", async fault => {
  await seedInvoicePrecursor(); const before = await financialSnapshot();
  const h = harness((b, path) => {
    if (path.endsWith("/pay")) {
      if (fault === "fee") objects.get("/v1/payment_intents/pi_LocalRenewal")!.application_fee_amount = 9957;
      else objects.get("/v1/balance_transactions/txn_LocalRenewal")!.net = 0;
    }
    return b;
  });
  await expect(h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.requests.some(q => q.path.endsWith("/credit_exact_context_invoice_v2"))).toBe(false);
  const retry = harness(); await expect(retry.collection.reconcileInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(retry.stripeWrites()).toHaveLength(0); expect(await financialSnapshot()).toEqual(before);
});

test("collection reconciliation without admission cannot prepare or charge; wrong owner and legacy entry points stay closed", async () => {
  await seedInvoicePrecursor(); const before = await financialSnapshot(); const h = harness();
  expect(await h.collection.reconcileInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "reconciliation_required" });
  expect(h.stripeWrites()).toHaveLength(0);
  expect(h.requests.some(q => /claim_exact_context_invoice|admit_exact_context_invoice|credit_exact_context_invoice/.test(q.path))).toBe(false);
  await expect(h.collection.collectInvoice(reservationId, ids.buyer, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  await expect(h.collection.collectInvoice(reservationId, ids.creator, "in_Unknown")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const args = [reservationId, ids.creator, JSON.stringify(config.approvedContext), "in_LocalRenewal"];
  await expect(rpc("read_exact_context_invoice_collection_v2", args, true)).rejects.toThrow("read-only transaction");
  await expect(rpc("credit_exact_context_invoice_v2", [...args, JSON.stringify({})])).rejects.toThrow("Original admitted context receipt required");
  await expect(rpc("record_exact_installment_renewal_receipt", [reservationId, "in_LocalRenewal", "pi_LocalRenewal", 66633, 9958, new Date().toISOString()]))
    .rejects.toThrow("Context-scoped payment entry required");
  await expect(rpc("complete_exact_installment_agreement", [reservationId])).rejects.toThrow("Context-scoped payment entry required");
  const acl = (await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(`select
    has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated,
    has_function_privilege('service_role',p.oid,'execute') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('read_exact_context_invoice_collection_v2','admit_exact_context_invoice_dispatch_v2','credit_exact_context_invoice_v2')`)).rows;
  expect(acl).toHaveLength(3); expect(acl.every(row => !row.anon && !row.authenticated && row.service)).toBe(true);
  expect(await financialSnapshot()).toEqual(before);
});

test("collection synthetic live context checks the real mode without any network or credential", async () => {
  config = { ...config, approvedContext: { ...context, mode: "live", siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await seedInvoicePrecursor(); const h = harness();
  expect(await h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "credited", context: { mode: "live" } });
  expect(h.stripeWrites().filter(q => q.path.endsWith("/pay"))).toHaveLength(1);
});

test.each([2, 3] as const)("invoice connection: installment %i is prepared with exact fee and collection off", async number => {
  await seedInvoicePrecursor(number); const before = await financialSnapshot(); const h = harness();
  const result = await h.invoice.prepareInvoice(reservationId, ids.creator, "in_LocalRenewal").catch(() => {
    throw Error(`Local invoice failure: ${localSqlErrors.join("; ")}; last paths: ${h.requests.slice(-7).map(r => r.path).join(", ")}`);
  });
  expect(result).toMatchObject({ status: "prepared_unpaid", paymentNumber: number, collectionAllowed: false, publicationAllowed: false });
  expect(h.stripeWrites().map(r => r.path)).toEqual([...(number === 3 ? ["/v1/invoices/in_LocalRenewal/add_lines"] : []),
    "/v1/invoices/in_LocalRenewal", "/v1/invoices/in_LocalRenewal/finalize"]);
  expect(objects.get("/v1/invoices/in_LocalRenewal")).toMatchObject({ status: "open", auto_advance: false, amount_due: number === 3 ? 66634 : 66633 });
  expect((await db.query("select status,stripe_payment_intent_id,dispatch_started_at from exact_installment_invoice_claims")).rows)
    .toEqual([{ status: "prepared", stripe_payment_intent_id: "pi_LocalRenewal", dispatch_started_at: null }]);
  expect(await financialSnapshot()).toEqual(before);
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC-NOT-FOR-OUTPUT");
});

test("invoice synthetic live context: same owned unpaid operation, without pretending it is Sandbox", async () => {
  config = { ...config, approvedContext: { ...context, mode: "live", siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await seedInvoicePrecursor(); const h = harness();
  expect(await h.invoice.prepareInvoice(reservationId, ids.creator, "in_LocalRenewal"))
    .toMatchObject({ status: "prepared_unpaid", context: { mode: "live" }, collectionAllowed: false, publicationAllowed: false });
  expect(objects.get("/v1/invoices/in_LocalRenewal")).toMatchObject({ livemode: true, status: "open", auto_advance: false });
  expect(h.stripeWrites()).toHaveLength(2);
  expect((await db.query("select paid_count from purchases")).rows).toEqual([{ paid_count: 1 }]);
});

test("invoice ownership: wrong actor, account mode, customer, subscription, item or period cannot claim", async () => {
  await seedInvoicePrecursor(); const original = JSON.stringify(objects.get("/v1/invoices/in_LocalRenewal"));
  for (const fault of ["actor", "mode", "customer", "subscription", "item", "period"]) {
    const changed = JSON.parse(original); objects.set("/v1/invoices/in_LocalRenewal", changed);
    if (fault === "mode") changed.livemode = true;
    if (fault === "customer") changed.customer = "cus_Other";
    if (fault === "subscription") changed.parent.subscription_details.subscription = "sub_Other";
    if (fault === "item") changed.lines.data[0].parent.subscription_item_details.subscription_item = "si_Other";
    if (fault === "period") changed.lines.data[0].period.start += 1;
    const h = harness();
    await expect(h.invoice.prepareInvoice(reservationId, fault === "actor" ? ids.buyer : ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(h.stripeWrites()).toHaveLength(0);
    expect(h.requests.some(r => r.path.endsWith("claim_exact_context_invoice_v2"))).toBe(false);
  }
  expect((await db.query("select count(*)::int n from exact_installment_invoice_claims")).rows).toEqual([{ n: 0 }]);
});

test.each(["hold-before-send", "fee-response", "claimed-amount", "account-drift"])("invoice stop: %s cannot bind a prepared payment", async fault => {
  await seedInvoicePrecursor(); let claimed = false;
  const h = harness(async (b, path) => {
    if (path.endsWith("claim_exact_context_invoice_v2")) {
      claimed = true;
      if (fault === "hold-before-send") await db.query("insert into exact_installment_collection_holds(agreement_id,reason,request_id,requested_by) values($1,'cancellation_review',gen_random_uuid(),$2)", [reservationId, ids.creator]);
      if (fault === "claimed-amount") ((b.claim as Body).authorization as Body).totalCents = 200000;
    }
    if (fault === "account-drift" && claimed && path === "/v1/account") b.id = "acct_Other";
    if (fault === "fee-response" && path === "/v1/payment_intents/pi_LocalRenewal") b.application_fee_amount = 9959;
    return b;
  });
  await expect(h.invoice.prepareInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toHaveLength(fault === "fee-response" ? 2 : 0);
  expect((await db.query("select status,dispatch_started_at from exact_installment_invoice_claims")).rows).toEqual([{ status: "preparing", dispatch_started_at: null }]);
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
  expect((await db.query("select paid_count from purchases")).rows).toEqual([{ paid_count: 1 }]);
});

test.each(["claim", "adjustment", "finalization", "binding"])("invoice lost %s response: reuse the same unpaid invoice, never add another cent or pay", async stage => {
  await seedInvoicePrecursor(3); const before = await financialSnapshot();
  const h = harness((b, path, method) => {
    if (stage === "claim" && path.endsWith("claim_exact_context_invoice_v2") ||
      stage === "adjustment" && method === "POST" && path.endsWith("/add_lines") ||
      stage === "finalization" && method === "POST" && path.endsWith("/finalize") ||
      stage === "binding" && path.endsWith("bind_exact_context_invoice_preparation_v2")) throw Error("Synthetic lost response");
    return b;
  });
  await expect(h.invoice.prepareInvoice(reservationId, ids.creator, "in_LocalRenewal")).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const retry = harness(); expect(await retry.invoice.prepareInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "busy" });
  expect(retry.stripeWrites()).toHaveLength(0);
  // Only expire this local preparation lease. Preserve first_started_at,
  // original dates, immutable receipt and provider operation identities.
  await db.exec("update exact_installment_invoice_claims set lease_until=clock_timestamp()");
  expect(await retry.invoice.prepareInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "prepared_unpaid", collectionAllowed: false });
  const paths = [...h.stripeWrites(), ...retry.stripeWrites()].map(r => r.path);
  expect(paths.filter(p => p.endsWith("/add_lines"))).toHaveLength(1);
  expect(paths.filter(p => p.endsWith("/finalize"))).toHaveLength(1);
  expect(paths.some(p => p.endsWith("/pay") || p.endsWith("/confirm"))).toBe(false);
  expect(await financialSnapshot()).toEqual(before);
});

test("invoice SQL boundary: POST locks, owned-only RPC grants and no legacy dispatch admission", async () => {
  const { period } = await seedInvoicePrecursor();
  const args = [reservationId, ids.creator, JSON.stringify(config.approvedContext), "in_LocalRenewal"];
  await expect(rpc("read_exact_context_invoice_v2", args, true)).rejects.toThrow("read-only transaction");
  expect(await rpc("read_exact_context_invoice_v2", args)).toMatchObject({ agreement_id: reservationId, claim: null });
  await expect(rpc("claim_exact_installment_invoice", [reservationId, "in_LocalRenewal", "sub_LocalCheckout", period.due_at, period.period_end, ids.creator])).rejects.toThrow("Context-scoped payment entry required");
  await expect(rpc("prepare_exact_installment_dispatch", [reservationId, "in_LocalRenewal", "pi_LocalRenewal", ids.creator])).rejects.toThrow("Context-scoped payment entry required");
  await expect(rpc("admit_exact_installment_dispatch", [reservationId, "in_LocalRenewal", ids.creator])).rejects.toThrow("Context-scoped payment entry required");
  await expect(rpc("read_exact_context_invoice_v2", [reservationId, ids.buyer, args[2], args[3]])).rejects.toThrow();
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of ["read_exact_context_invoice_v2(uuid,uuid,jsonb,text)", "claim_exact_context_invoice_v2(uuid,uuid,jsonb,text,text,bigint,bigint)",
      "assert_exact_context_invoice_preparation_v2(uuid,uuid,jsonb,text,uuid)", "bind_exact_context_invoice_preparation_v2(uuid,uuid,jsonb,text,uuid,text)"])
      expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, `public.${signature}`])).rows).toEqual([{ allowed: role === "service_role" }]);
    expect((await db.query("select has_table_privilege($1,'exact_context_sql_admissions_v2','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') allowed", [role])).rows).toEqual([{ allowed: false }]);
  }
  // Non-context old calls still reach their original validator.
  await expect(rpc("claim_exact_installment_invoice", [ids.booking, "in_LocalRenewal", "sub_LocalCheckout", period.due_at, period.period_end, ids.creator])).rejects.toThrow("renewal subscription mismatch");
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
});

test("invoice timing: the next unpaid future period is not prepared early", async () => {
  const setup = await seedCreditedActivation(); await setup.activation.activateHeld(reservationId, ids.creator);
  const p = (await db.query<{ due_at: number; period_end: number }>("select due_at,period_end from exact_installment_periods where payment_number=2")).rows[0];
  await expect(rpc("claim_exact_context_invoice_v2", [reservationId, ids.creator, JSON.stringify(config.approvedContext),
    "in_LocalRenewal", "sub_LocalCheckout", p.due_at, p.period_end])).rejects.toThrow("outside its authorized period");
  expect((await db.query("select count(*)::int n from exact_installment_invoice_claims")).rows).toEqual([{ n: 0 }]);
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
});

test("activation admission: a captured but uncredited first payment cannot activate", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  await h.runtime.recordFirstPayment(reservationId, ids.creator);
  await expect(h.activation.activateHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toHaveLength(1);
  expect((await db.query("select count(*)::int n from exact_installment_activations")).rows).toEqual([{ n: 0 }]);
});

test("activation provider admission: changed card, hold, mode, price, dates or invoice list cannot dispatch", async () => {
  await seedCreditedActivation();
  const baseline = [...objects.entries()].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))] as const);
  for (const fault of ["card-owner", "customer-default", "hold", "mode", "price", "dates", "invoice-amount", "invoice-pages"]) {
    objects = new Map(baseline.map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
    const sub = objects.get("/v1/subscriptions/sub_LocalCheckout")!;
    if (fault === "card-owner") objects.get("/v1/payment_methods/pm_LocalCheckout")!.customer = "cus_Other";
    if (fault === "customer-default") objects.get("/v1/customers/cus_LocalCheckout")!.invoice_settings = { default_payment_method: "pm_Other" };
    if (fault === "hold") sub.pause_collection = null;
    if (fault === "mode") sub.livemode = true;
    if (fault === "price") ((sub.items as { data: Array<{ price: Body }> }).data[0].price).unit_amount = 66634;
    if (fault === "dates") sub.cancel_at = Number(sub.cancel_at) + 1;
    if (fault === "invoice-pages") objects.get("/v1/invoices")!.has_more = true;
    if (fault === "invoice-amount") objects.get("/v1/invoices")!.data = [{ object: "invoice", livemode: false,
      parent: { subscription_details: { subscription: "sub_LocalCheckout" } }, customer: "cus_LocalCheckout", currency: "usd", total: 1 }];
    const h = harness();
    await expect(h.activation.activateHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(h.stripeWrites()).toHaveLength(0);
    expect(h.requests.filter(r => r.path.endsWith("claim_exact_context_activation_v2"))).toHaveLength(0);
  }
});

test.each(["refund-before-claim", "hold-before-send", "refund-before-complete"])("activation concurrent stop: %s prevents a completed activation", async stage => {
  await seedCreditedActivation();
  async function refund() {
    // A concurrent refund is a separate write request, not part of the last
    // activation read-only RPC transaction on this shared fixture connection.
    await db.exec("commit; begin");
    await db.query("select record_payment_refund_state('pi_LocalCheckout','ch_LocalCheckout',66633,1)");
    await db.exec("commit; begin");
  }
  if (stage === "refund-before-claim") await refund();
  const h = harness(async (b, path, method) => {
    if (stage === "hold-before-send" && path.endsWith("claim_exact_context_activation_v2"))
      await db.query("insert into exact_installment_collection_holds(agreement_id,reason,request_id,requested_by) values($1,'cancellation_review',gen_random_uuid(),$2)", [reservationId, ids.creator]);
    if (stage === "refund-before-complete" && path === "/v1/subscriptions/sub_LocalCheckout" && method === "POST") await refund();
    return b;
  });
  await expect(h.activation.activateHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toHaveLength(stage === "refund-before-complete" ? 1 : 0);
  expect((await db.query("select count(*)::int n from exact_installment_periods")).rows).toEqual([{ n: 0 }]);
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
  expect(objects.get("/v1/subscriptions/sub_LocalCheckout")!.pause_collection).toEqual({ behavior: "keep_as_draft", resumes_at: null });
});

test.each(["claim", "provider", "completion"])("activation lost %s response: preserve one subscription operation and reconcile original dates", async stage => {
  await seedCreditedActivation();
  const h = harness((b, path, method) => {
    if (stage === "claim" && path.endsWith("claim_exact_context_activation_v2") ||
      stage === "provider" && method === "POST" && path === "/v1/subscriptions/sub_LocalCheckout" ||
      stage === "completion" && path.endsWith("complete_exact_context_activation_v2")) throw Error("Synthetic lost response");
    return b;
  });
  await expect(h.activation.activateHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const retry = harness();
  if (stage !== "completion") {
    expect(await retry.activation.activateHeld(reservationId, ids.creator)).toMatchObject({ status: "busy" });
    // Simulate ONLY expiration of this local fixture's lease, without changing
    // paid_at, first_started_at, the immutable authorization or Stripe dates.
    await db.exec("update exact_installment_activations set lease_until=clock_timestamp()");
  }
  expect(await retry.activation.activateHeld(reservationId, ids.creator)).toMatchObject({ status: "activated_held", collectionAllowed: false });
  expect([...h.stripeWrites(), ...retry.stripeWrites()]).toHaveLength(1);
  expect((await db.query("select count(*)::int n from exact_installment_periods")).rows).toEqual([{ n: 2 }]);
  expect((await db.query("select paid_count from purchases")).rows).toEqual([{ paid_count: 1 }]);
});

test("activation immutable authorization: a changed claimed date cannot reach Stripe", async () => {
  await seedCreditedActivation(); const h = harness((b, path) => {
    if (path.endsWith("claim_exact_context_activation_v2")) {
      const claim = b.claim as { authorization: Body }; claim.authorization.firstRenewalAt = Number(claim.authorization.firstRenewalAt) + 1;
    }
    return b;
  });
  await expect(h.activation.activateHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toHaveLength(0);
  expect((await db.query("select count(*)::int n from exact_installment_periods")).rows).toEqual([{ n: 0 }]);
});

test("activation fresh context: account drift after claim prevents the held subscription update", async () => {
  await seedCreditedActivation(); let claimed = false;
  const h = harness((b, path) => {
    if (path.endsWith("claim_exact_context_activation_v2")) claimed = true;
    if (claimed && path === "/v1/account") b.id = "acct_Other";
    return b;
  });
  await expect(h.activation.activateHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toHaveLength(0);
});

test("activation SQL admission rejects a stale-snapshot transaction before claiming", async () => {
  await seedCreditedActivation(); freshRpcTransactions = false;
  await db.exec("commit; begin isolation level repeatable read");
  await expect(rpc("claim_exact_context_activation_v2", [reservationId, ids.creator, JSON.stringify(config.approvedContext),
    "pm_LocalCheckout", "si_LocalCheckout"])).rejects.toThrow("requires READ COMMITTED");
  expect((await db.query("select count(*)::int n from exact_installment_activations")).rows).toEqual([{ n: 0 }]);
});

test("activation SQL entry guards: old service RPCs cannot bypass context; private admission never survives", async () => {
  const h = await seedCreditedActivation();
  const entries: Array<[string, unknown[]]> = [
    ["record_exact_installment_first_receipt", [reservationId, "cs_test_LocalCheckout", "pi_LocalCheckout", 66633, 9958, new Date().toISOString()]],
    ["bind_exact_installment_purchase", [reservationId, ids.buyer]],
    ["credit_exact_installment_receipt", [reservationId, 1, "ch_LocalCheckout", "txn_LocalCheckout", 1962]],
    ["claim_exact_installment_activation", [reservationId, "pm_LocalCheckout", "si_LocalCheckout", ids.creator]],
    ["complete_exact_installment_activation", [reservationId, ids.creator]],
    ["seed_exact_installment_purchase", [reservationId]], ["fulfill_exact_installment_first_payment", [reservationId]],
  ];
  for (const [name, args] of entries) await expect(rpc(name, args)).rejects.toThrow("Context-scoped payment entry required");
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await db.query("select has_table_privilege($1,'public.exact_context_sql_admissions_v2','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role])).rows).toEqual([{ allowed: false }]);
    expect((await db.query("select has_function_privilege($1,'public.guard_exact_context_sql_entry_v2(uuid,text)','EXECUTE') allowed", [role])).rows).toEqual([{ allowed: false }]);
    for (const name of ["read_exact_context_activation_v2(uuid,uuid,jsonb)", "claim_exact_context_activation_v2(uuid,uuid,jsonb,text,text)", "complete_exact_context_activation_v2(uuid,uuid,jsonb,uuid)"])
      expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, `public.${name}`])).rows).toEqual([{ allowed: role === "service_role" }]);
  }
  // The original non-context entry still reaches its original missing-record
  // check; adding the guard did not revoke its existing service grant.
  await expect(rpc("complete_exact_installment_activation", [ids.booking, ids.creator])).rejects.toThrow("agreement missing");
  expect(await h.activation.activateHeld(reservationId, ids.creator)).toMatchObject({ status: "activated_held" });
  expect((await db.query("select count(*)::int n from exact_context_sql_admissions_v2")).rows).toEqual([{ n: 0 }]);
});

test.each(["test", "live"] as const)("%s: Checkout then captured payment verified and saved once; no URL, credit or collection", async mode => {
  if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-checkout.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-checkout.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await seedHeld(); const h = harness(), before = await financialSnapshot();
  const prepared = await h.runtime.prepareCheckout(reservationId, ids.creator).catch(() => {
    throw Error(`Synthetic stages: ${h.requests.slice(-5).map(r => `${r.method} ${r.path}`).join(", ")}`);
  });
  expect(prepared).toMatchObject({ status: "checkout_prepared_unpublished", publicationAllowed: false, accountingOperationsAllowed: false });
  expect(JSON.stringify(prepared)).not.toContain("stripe.com");
  expect(await h.runtime.prepareCheckout(reservationId, ids.creator)).toEqual(prepared); expect(h.stripeWrites()).toHaveLength(1);
  paySyntheticSession();
  expect(await h.runtime.inspectFirstPayment(reservationId, ids.creator)).toMatchObject({ status: "captured_payment_verified" });
  expect(h.receiptWrites()).toHaveLength(0);
  const paid = await h.runtime.recordFirstPayment(reservationId, ids.creator);
  expect(paid).toMatchObject({ status: "receipt_recorded", receipt: { amount_cents: 66633, application_fee_cents: 9958,
    actual_stripe_fee_cents: 1962 }, accountingOperationsAllowed: false, collectionAllowed: false });
  expect(await h.runtime.recordFirstPayment(reservationId, ids.creator)).toEqual(paid);
  expect((await db.query("select count(*)::int n from public.exact_context_first_receipts_v2")).rows).toEqual([{ n: 1 }]);
  expect(h.stripeWrites()).toHaveLength(1); expect(await financialSnapshot()).toEqual(before);
});

test.each(["claim_exact_context_checkout_v2", "/v1/checkout/sessions", "bind_exact_context_checkout_v2"])("lost %s response never recreates a Checkout", async fault => {
  await seedHeld(); let enabled = true;
  const h = harness((b, path) => { if (enabled && path === (fault.startsWith("/") ? fault : rpcPrefix + fault)) { enabled = false; throw Error("private-marker lost"); } return b; });
  await expect(h.runtime.prepareCheckout(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const count = h.stripeWrites().length;
  expect(await h.runtime.prepareCheckout(reservationId, ids.creator)).toMatchObject({ status: fault.startsWith("bind_") ? "checkout_prepared_unpublished" : "review_required" });
  expect(h.stripeWrites()).toHaveLength(count);
});

test.each(["mode", "amount", "metadata", "consent", "redirect", "recovered"])("unexpected new Checkout %s cannot bind", async fault => {
  await seedHeld(); const h = harness((b, path, method) => {
    if (path !== "/v1/checkout/sessions" || method !== "POST") return b;
    if (fault === "mode") b.livemode = true;
    if (fault === "amount") b.amount_total = 66634;
    if (fault === "metadata") (b.metadata as Body).terms_hash = "wrong";
    if (fault === "consent") b.consent_collection = null;
    if (fault === "redirect") b.success_url = "https://elsewhere.example";
    if (fault === "recovered") b.recovered_from = "cs_test_Other";
    return b;
  });
  await expect(h.runtime.prepareCheckout(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect((await db.query("select count(*)::int n from public.exact_context_checkout_results_v2")).rows).toEqual([{ n: 0 }]);
  expect(await h.runtime.prepareCheckout(reservationId, ids.creator)).toMatchObject({ status: "review_required" });
  expect(h.stripeWrites()).toHaveLength(1);
});

test.each(["unpaid", "intent-mode", "fee", "destination", "uncaptured", "refund", "dispute", "balance-source", "balance-fee", "card"])("reject %s first payment without recording evidence", async fault => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  const session = [...objects.values()].find(b => b.object === "checkout.session")!, pi = objects.get("/v1/payment_intents/pi_LocalCheckout")!,
    charge = objects.get("/v1/charges/ch_LocalCheckout")!, balance = objects.get("/v1/balance_transactions/txn_LocalCheckout")!;
  if (fault === "unpaid") session.payment_status = "unpaid";
  if (fault === "intent-mode") pi.livemode = true;
  if (fault === "fee") pi.application_fee_amount = 9959;
  if (fault === "destination") (pi.transfer_data as Body).destination = "acct_Other";
  if (fault === "uncaptured") charge.captured = false;
  if (fault === "refund") charge.amount_refunded = 1;
  if (fault === "dispute") charge.disputed = true;
  if (fault === "balance-source") balance.source = "ch_Other";
  if (fault === "balance-fee") balance.net = 1;
  if (fault === "card") charge.payment_method = "pm_Other";
  await expect(h.runtime.recordFirstPayment(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.receiptWrites()).toHaveLength(0); expect(h.stripeWrites()).toHaveLength(1);
});

test("lost receipt commit response reconciles the same saved payment without another Checkout", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  const lost = harness((b, p) => { if (p.endsWith("record_exact_context_first_receipt_v2")) throw Error("private-marker lost"); return b; });
  await expect(lost.runtime.recordFirstPayment(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(await h.runtime.recordFirstPayment(reservationId, ids.creator)).toMatchObject({ status: "receipt_recorded" });
  expect((await db.query("select count(*)::int n from public.exact_context_first_receipts_v2")).rows).toEqual([{ n: 1 }]);
  expect(lost.stripeWrites()).toHaveLength(0); expect(h.stripeWrites()).toHaveLength(1);
});

test("wrong actor, changed quote and lifted hold cannot create Checkout", async () => {
  await seedHeld(); const h = harness();
  await expect(h.runtime.prepareCheckout(reservationId, ids.buyer)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const s = objects.get("/v1/subscriptions/sub_LocalCheckout")!; s.pause_collection = null;
  await expect(h.runtime.prepareCheckout(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  s.pause_collection = { behavior: "keep_as_draft", resumes_at: null };
  await db.query("update products set amount_cents=199901 where id=$1", [ids.product]);
  await expect(h.runtime.prepareCheckout(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toHaveLength(0);
});

test("SQL receipt amounts, immutable bindings and service/client boundaries", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  const paid = await h.runtime.recordFirstPayment(reservationId, ids.creator); expect(paid).toHaveProperty("receipt");
  if (!("receipt" in paid)) throw Error("Missing test receipt");
  const args = [reservationId, ids.creator, JSON.stringify(config.approvedContext)];
  await expect(rpc("record_exact_context_first_receipt_v2", [...args, JSON.stringify({ ...paid.receipt, amount_cents: 66634 })])).rejects.toThrow("binding/amount/time");
  await expect(rpc("record_exact_context_first_receipt_v2", [...args, JSON.stringify({ ...paid.receipt, charge_id: "ch_Other" })])).rejects.toThrow("recorded differently");
  for (const table of ["exact_context_checkout_attempts_v2", "exact_context_checkout_results_v2", "exact_context_first_receipts_v2"]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await db.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role, `public.${table}`])).rows).toEqual([{ allowed: false }]);
    }
    await db.exec("savepoint immutable"); await expect(db.exec(`delete from public.${table}`)).rejects.toThrow("immutable");
    await db.exec("rollback to savepoint immutable; release savepoint immutable");
  }
});

test("disabled first processing schedule stays distinct from renewal and records actual fee evidence", async () => {
  expectedFirstFee = 7996;
  await seedHeld({ ...fee, enabled: false }); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator);
  expect(createParams.get("metadata[processing_fee_cents]")).toBe("0");
  expect(createParams.get("metadata[processing_fee_bps]")).toBe("0");
  paySyntheticSession();
  expect(await h.runtime.recordFirstPayment(reservationId, ids.creator)).toMatchObject({ status: "receipt_recorded",
    receipt: { amount_cents: 66633, application_fee_cents: 7996, actual_stripe_fee_cents: 1962 } });
});

test.each([31_000, -1_000])("Checkout claim clock change %sms prevents send and preserves uncertainty", async delta => {
  await seedHeld(); let claimed = false;
  const now = Date.now.bind(Date), clock = jest.spyOn(Date, "now").mockImplementation(() => now() + (claimed ? delta : 0));
  const h = harness((b, p) => { if (p.endsWith("claim_exact_context_checkout_v2")) claimed = true; return b; });
  try {
    await expect(h.runtime.prepareCheckout(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(h.stripeWrites()).toHaveLength(0);
  } finally { clock.mockRestore(); }
  expect(await h.runtime.prepareCheckout(reservationId, ids.creator)).toMatchObject({ status: "review_required" });
  expect(h.stripeWrites()).toHaveLength(0);
});

test("complete saved request, not its claimed hash or origin alone, controls the outgoing fee", async () => {
  await seedHeld(); const h = harness((b, p) => {
    if (p.endsWith("claim_exact_context_checkout_v2")) {
      const a = b.attempt as { request: { params: { payment_intent_data: Body } } };
      a.request.params.payment_intent_data.application_fee_amount = 9999;
    } return b;
  });
  await expect(h.runtime.prepareCheckout(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.stripeWrites()).toHaveLength(0);
});

test("receipt inspection remains read-only after legitimate post-Checkout customer and subscription changes", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  objects.get("/v1/customers/cus_LocalCheckout")!.email = "synthetic@example.invalid";
  objects.get("/v1/subscriptions/sub_LocalCheckout")!.status = "active";
  expect(await h.runtime.inspectFirstPayment(reservationId, ids.creator)).toMatchObject({ status: "captured_payment_verified" });
  expect(h.receiptWrites()).toHaveLength(0); expect(h.stripeWrites()).toHaveLength(1);
});

/** SQL095 is local and unapplied. These cases run its actual forward function
 * bodies on the existing 040-074 accounting harness, with synthetic native
 * responses. They do not establish a hosted Stripe checkbox or legal approval. */
async function installFixedPurchaseConsent() {
  const source = readFileSync(join(process.cwd(), "supabase/proposals/095-fixed-total-purchase-consent.sql"), "utf8");
  await db.exec(source.slice(source.indexOf("begin;") + 6, source.lastIndexOf("commit;")));
  // Production COMMIT clears SET LOCAL. This test keeps the outer fixture
  // transaction open, so restore only its assertion lookup path explicitly.
  await db.exec("set local search_path=public");
}
test("purchase consent new SQL snapshot, native checkbox, saved evidence and existing credit agree", async () => {
  await installFixedPurchaseConsent(); await seedHeld();
  const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator);
  const reservation = (await db.query<{ terms: Body }>("select terms from exact_installment_context_reservations_v2 where id=$1", [reservationId])).rows[0];
  expect(reservation.terms).toMatchObject({ purchaseConsentVersion: FIXED_PURCHASE_CONSENT_VERSION, totalCents: 199900, paymentCount: 3 });
  expect(createParams.get("consent_collection[terms_of_service]")).toBe("required");
  expect(createParams.get("custom_text[submit][message]")).toContain(FIXED_PURCHASE_CONSENT_TEXT);
  paySyntheticSession();
  const inspected = await h.runtime.inspectFirstPayment(reservationId, ids.creator);
  expect(inspected).toMatchObject({ status: "captured_payment_verified", receipt: { purchase_consent_version: FIXED_PURCHASE_CONSENT_VERSION } });
  expect(h.receiptWrites()).toHaveLength(0);
  const first = await h.credit.creditFirstPayment(reservationId, ids.creator);
  expect(first).toMatchObject({ status: "first_payment_fulfilled", credited: true });
  expect(await h.credit.creditFirstPayment(reservationId, ids.creator)).toMatchObject({ ...first, credited: false });
  const saved = (await db.query<{ purchase_consent_version: string; paid_at: number }>(
    "select purchase_consent_version,paid_at from exact_context_first_receipts_v2 where reservation_id=$1", [reservationId])).rows[0];
  expect(saved.purchase_consent_version).toBe(FIXED_PURCHASE_CONSENT_VERSION);
  expect(saved.paid_at).toBe(objects.get("/v1/charges/ch_LocalCheckout")!.created);
  expect((await db.query("select amount_total_cents,installment_months from booking_payments")).rows)
    .toEqual([{ amount_total_cents: 199900, installment_months: 3 }]);
  expect((await db.query("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{ n: 1 }]);
  expect(h.stripeWrites()).toHaveLength(1);
});
test.each([null, {}, { terms_of_service: null }, { terms_of_service: "rejected" }, { promotions: "opt_in" }])(
  "purchase consent missing native acceptance %p cannot record or credit payment", async consent => {
    await installFixedPurchaseConsent(); await seedHeld();
    const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
    objects.get("/v1/checkout/sessions/cs_test_LocalCheckout")!.consent = consent;
    const before = await financialSnapshot();
    await expect(h.credit.creditFirstPayment(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(await financialSnapshot()).toEqual(before);
    expect((await db.query("select count(*)::int n from exact_context_first_receipts_v2")).rows).toEqual([{ n: 0 }]);
  });
test.each([null, {}, { payment_method_reuse_agreement: { position: "auto" }, terms_of_service: "none" }])(
  "purchase consent missing required native checkbox %p is not rescued by accepted metadata", async collection => {
    await installFixedPurchaseConsent(); await seedHeld();
    const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
    const session = objects.get("/v1/checkout/sessions/cs_test_LocalCheckout")!;
    session.consent_collection = collection; session.consent = { terms_of_service: "accepted" };
    await expect(h.runtime.recordFirstPayment(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect((await db.query("select count(*)::int n from exact_context_first_receipts_v2")).rows).toEqual([{ n: 0 }]);
  });
test("purchase consent SQL refuses missing, wrong or extra acceptance evidence before first accounting", async () => {
  await installFixedPurchaseConsent(); await seedHeld();
  const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  const result = await h.runtime.inspectFirstPayment(reservationId, ids.creator);
  if (!("receipt" in result)) throw Error("Missing test receipt");
  const original = result.receipt, absent = { ...original } as Body; delete absent.purchase_consent_version;
  for (const receipt of [absent, { ...original, purchase_consent_version: null },
    { ...original, purchase_consent_version: "accepted" }, { ...original, fabricated_click_at: 1 }]) {
    await expect(rpc("record_exact_context_first_receipt_v2",
      [reservationId, ids.creator, JSON.stringify(config.approvedContext), JSON.stringify(receipt)])).rejects.toThrow();
  }
  expect((await db.query("select count(*)::int n from exact_context_first_receipts_v2")).rows).toEqual([{ n: 0 }]);
  expect(await h.runtime.recordFirstPayment(reservationId, ids.creator)).toMatchObject({
    receipt: { purchase_consent_version: FIXED_PURCHASE_CONSENT_VERSION } });
});
test.each([false, true])("purchase consent preserves a preexisting request and receipt without backfill (already recorded=%s)", async recorded => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator);
  paySyntheticSession(); if (recorded) await h.runtime.recordFirstPayment(reservationId, ids.creator);
  const before = (await db.query("select terms from exact_installment_context_reservations_v2")).rows;
  const requests = (await db.query("select request,idempotency_key from exact_context_checkout_attempts_v2")).rows;
  await installFixedPurchaseConsent();
  const repeated = await db.query<{ terms: Body }>("select terms from public.reserve_exact_installment_context_v2($1,$2,3,$3::jsonb,$4::jsonb,$4::jsonb)",
    [ids.booking, ids.creator, JSON.stringify(config.approvedContext), JSON.stringify(fee)]);
  expect(repeated.rows).toEqual(before);
  expect(repeated.rows[0].terms).not.toHaveProperty("purchaseConsentVersion");
  const saved = await h.runtime.recordFirstPayment(reservationId, ids.creator);
  if (!("receipt" in saved)) throw Error("Missing test receipt");
  expect(saved.receipt).not.toHaveProperty("purchase_consent_version");
  expect((await db.query("select request,idempotency_key from exact_context_checkout_attempts_v2")).rows).toEqual(requests);
  expect(await h.credit.creditFirstPayment(reservationId, ids.creator)).toMatchObject({ status: "first_payment_fulfilled", credited: true });
  expect((await db.query("select purchase_consent_version from exact_context_first_receipts_v2")).rows).toEqual([{ purchase_consent_version: null }]);
  expect(h.stripeWrites()).toHaveLength(1);
});
test("purchase consent evidence stays private and immutable and a repeated migration cannot overwrite it", async () => {
  await installFixedPurchaseConsent(); await seedHeld();
  const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  await h.runtime.recordFirstPayment(reservationId, ids.creator);
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await db.query("select has_column_privilege($1,'public.exact_context_first_receipts_v2','purchase_consent_version','SELECT') allowed",
      [role])).rows).toEqual([{ allowed: false }]);
  }
  for (const action of [
    () => db.exec("update exact_context_first_receipts_v2 set purchase_consent_version=null"),
    installFixedPurchaseConsent,
  ]) {
    await db.exec("savepoint consent_immutable");
    await expect(action()).rejects.toThrow();
    await db.exec("rollback to savepoint consent_immutable; release savepoint consent_immutable");
  }
  expect(await h.runtime.recordFirstPayment(reservationId, ids.creator)).toMatchObject({
    receipt: { purchase_consent_version: FIXED_PURCHASE_CONSENT_VERSION } });
});

async function installFixedServiceDuration() {
  const checkoutSchema = readFileSync(join(process.cwd(), "supabase/schema/020-product-checkout-idempotency.sql"), "utf8");
  await db.exec(checkoutSchema.slice(checkoutSchema.indexOf("begin;") + 6, checkoutSchema.lastIndexOf("commit;")));
  await installFixedPurchaseConsent();
  const source = readFileSync(join(process.cwd(), "supabase/proposals/096-independent-fixed-service.sql"), "utf8");
  await db.exec(source.slice(source.indexOf("begin;") + 6, source.lastIndexOf("commit;")));
  await db.exec("set local search_path=public");
}
async function timedProduct(months: number) {
  await installFixedServiceDuration();
  await db.query("update public.products set fixed_service_months=$1 where id=$2", [months, ids.product]);
}
async function fixedEntitlement(buyer = ids.buyer) {
  const purchase = (await db.query<{ id: string }>("select id from public.purchases")).rows[0];
  return (await db.query<{ value: Body }>("select public.read_fixed_service_entitlement_v1($1,$2) value", [purchase.id, buyer])).rows[0].value;
}
test("service duration captures ten months independently of three installments and preserves the original start on replay", async () => {
  await timedProduct(10); await seedHeld(); const h = harness();
  await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  expect(createParams.get("custom_text[submit][message]")).toContain(fixedServiceDescription(10));
  const result = await h.credit.creditFirstPayment(reservationId, ids.creator).catch(error => {
    throw Error(`Local duration credit: ${String(error)}; SQL: ${localSqlErrors.join("; ")}`);
  });
  expect(result).toMatchObject({ status: "first_payment_fulfilled", credited: true });
  const row = (await db.query<{ service_months: number; service_start_at: number; service_end_at: number; financial_access: boolean }>(
    "select service_months,service_start_at,service_end_at,financial_access from public.fixed_purchase_service_contracts_v1")).rows[0];
  expect(row.service_months).toBe(10);
  expect(row.service_start_at).toBe(objects.get("/v1/charges/ch_LocalCheckout")!.created);
  expect(row.service_end_at).toBe(fixedServiceEndAt(row.service_start_at, 10));
  expect(row.financial_access).toBe(true);
  expect((await db.query("select access_granted,paid_count,target_months from public.purchases")).rows)
    .toEqual([{ access_granted: false, paid_count: 1, target_months: 3 }]);
  expect(await fixedEntitlement()).toMatchObject({ applicable: true, agreementId: reservationId,
    serviceMonths: 10, financialAccess: true, allowed: true, maxAgeSeconds: 3600 });
  expect(await fixedEntitlement(ids.creator)).toEqual({ applicable: false, allowed: false, maxAgeSeconds: 0 });
  expect(await h.credit.creditFirstPayment(reservationId, ids.creator)).toMatchObject({ ...result, credited: false });
  expect((await db.query("select service_months,service_start_at,service_end_at,financial_access from public.fixed_purchase_service_contracts_v1")).rows).toEqual([row]);
  expect(h.stripeWrites()).toHaveLength(1);
});
test("service duration forwards accounting grant/revoke but unrelated updates do not erase the grant", async () => {
  await timedProduct(10); await seedHeld(); const h = harness();
  await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession(); await h.credit.creditFirstPayment(reservationId, ids.creator);
  await db.exec("update public.purchases set title=title");
  expect(await fixedEntitlement()).toMatchObject({ financialAccess: true, allowed: true });
  await db.exec("update public.purchases set access_granted=false");
  expect(await fixedEntitlement()).toMatchObject({ financialAccess: false, allowed: false, maxAgeSeconds: 0 });
  await db.exec("update public.purchases set access_granted=true");
  expect((await db.query("select access_granted from public.purchases")).rows).toEqual([{ access_granted: false }]);
  expect(await fixedEntitlement()).toMatchObject({ financialAccess: true, allowed: true });
});
test("service duration legacy requests and permanent-access purchases are not retroactively shortened", async () => {
  await seedHeld(); const h = harness(); await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  await h.credit.creditFirstPayment(reservationId, ids.creator);
  await installFixedServiceDuration();
  await db.query("update public.products set fixed_service_months=1 where id=$1", [ids.product]);
  expect((await db.query("select access_granted from public.purchases")).rows).toEqual([{ access_granted: true }]);
  expect((await db.query("select count(*)::int n from public.fixed_purchase_service_contracts_v1")).rows).toEqual([{ n: 0 }]);
  expect(await fixedEntitlement()).toEqual({ applicable: false, allowed: true, maxAgeSeconds: 3600 });
  expect(await h.credit.creditFirstPayment(reservationId, ids.creator)).toMatchObject({ credited: false });
});
test.each([
  ["2028-01-31T14:15:16Z", 1], ["2027-01-31T14:15:16Z", 1],
  ["2028-02-29T14:15:16Z", 12], ["2028-12-31T23:59:59Z", 25],
] as const)("service duration SQL and JS preserve calendar anchor %s plus %i months", async (date, months) => {
  await installFixedServiceDuration(); const anchor = Date.parse(date) / 1000;
  const result = await db.query<{ end_at: number }>("select public.fixed_service_end_v1($1,$2) end_at", [anchor, months]);
  expect(result.rows[0].end_at).toBe(fixedServiceEndAt(anchor, months));
});
test("service duration terms stay private and immutable", async () => {
  await timedProduct(10); await seedHeld(); const h = harness();
  await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession(); await h.credit.creditFirstPayment(reservationId, ids.creator);
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await db.query("select has_table_privilege($1,'public.fixed_purchase_service_contracts_v1','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') allowed", [role])).rows)
      .toEqual([{ allowed: false }]);
  }
  for (const statement of ["update public.fixed_purchase_service_contracts_v1 set service_months=1",
    "delete from public.fixed_purchase_service_contracts_v1", "truncate public.fixed_purchase_service_contracts_v1"]) {
    await db.exec("savepoint fixed_immutable"); await expect(db.exec(statement)).rejects.toThrow();
    await db.exec("rollback to savepoint fixed_immutable; release savepoint fixed_immutable");
  }
  expect(await fixedEntitlement()).toMatchObject({ serviceMonths: 10, allowed: true });
});
test("invoice service duration expiry does not waive the next unpaid installment", async () => {
  await timedProduct(1); await seedInvoicePrecursor(2, false, 1);
  expect(await fixedEntitlement()).toMatchObject({ serviceMonths: 1, financialAccess: true, allowed: false, maxAgeSeconds: 0 });
  const before = (await db.query("select service_start_at,service_end_at from public.fixed_purchase_service_contracts_v1")).rows;
  const h = harness();
  expect(await h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal").catch(error => {
    throw Error(`Local duration collection: ${String(error)}; SQL: ${localSqlErrors.join("; ")}`);
  })).toMatchObject({ status: "credited" });
  expect((await db.query("select paid_count,target_months,access_granted from public.purchases")).rows)
    .toEqual([{ paid_count: 2, target_months: 3, access_granted: false }]);
  expect(await fixedEntitlement()).toMatchObject({ financialAccess: true, allowed: false, maxAgeSeconds: 0 });
  expect((await db.query("select service_start_at,service_end_at from public.fixed_purchase_service_contracts_v1")).rows).toEqual(before);
  expect(h.stripeWrites().filter(r => r.path.endsWith("/pay"))).toHaveLength(1);
});
test("invoice service duration outlasts the final installment without a renewal or service-date reset", async () => {
  await timedProduct(10); await seedInvoicePrecursor(3, true, 10);
  const before = (await db.query("select service_start_at,service_end_at from public.fixed_purchase_service_contracts_v1")).rows;
  const h = harness();
  expect(await h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "credited" });
  expect((await db.query("select status,paid_count,target_months,access_granted from public.purchases")).rows)
    .toEqual([{ status: "complete", paid_count: 3, target_months: 3, access_granted: false }]);
  expect(await fixedEntitlement()).toMatchObject({ serviceMonths: 10, financialAccess: true, allowed: true, maxAgeSeconds: 3600 });
  expect((await db.query("select service_start_at,service_end_at from public.fixed_purchase_service_contracts_v1")).rows).toEqual(before);
  expect(await h.collection.collectInvoice(reservationId, ids.creator, "in_LocalRenewal")).toMatchObject({ status: "already_credited" });
  expect(h.stripeWrites().filter(r => r.path.endsWith("/pay"))).toHaveLength(1);
});

async function installOneTimeDuration() {
  await installFixedServiceDuration();
  for (const file of ["077-versioned-purchase-consent.sql", "097-fixed-service-one-time.sql"]) {
    const sql = readFileSync(join(process.cwd(), "supabase/proposals", file), "utf8");
    await db.exec(sql.slice(sql.indexOf("begin;") + 6, sql.lastIndexOf("commit;")));
  }
  await db.exec("set local search_path=public");
}
async function seedOneTimeDuration(months = 10, ageDays = 0) {
  await installOneTimeDuration();
  await db.query("update public.products set fixed_service_months=$1 where id=$2", [months, ids.product]);
  const quote = productPurchaseTerms({ id: ids.product, creator_id: ids.creator, title: "Local Checkout",
    type: "mentorship", amount_cents: 199900, fixed_service_months: months }, ids.buyer, ids.post);
  // Historical fixtures are inserted with their ORIGINAL accepted time; no
  // existing purchase or immutable service dates are modified to fake expiry.
  let captured = Math.floor(Date.now() / 1000) - ageDays * 86400;
  const consent = ageDays === 0 ? (await db.query<{ id: string }>(
    "select public.record_product_purchase_consent_v1($1,$2,$3,$4,$5,$6) id",
    [ids.buyer, ids.creator, ids.product, ids.post, JSON.stringify(quote.terms), quote.fingerprint])).rows[0].id
    : (await db.query<{ id: string }>(`insert into public.product_purchase_consents_v1
    (buyer_id,creator_id,product_id,post_id,policy_version,terms,fingerprint,accepted_at)
    values($1,$2,$3,$4,$5,$6,$7,to_timestamp($8)) returning id`,
    [ids.buyer, ids.creator, ids.product, ids.post, quote.terms.version, JSON.stringify(quote.terms), quote.fingerprint, captured - 5])).rows[0].id;
  // A real capture follows consent. Sampling before its insert could cross a
  // second boundary and correctly fail the database's capture-after-consent guard.
  if (ageDays === 0) captured = Number((await db.query<{ captured: number }>(
    "select floor(extract(epoch from clock_timestamp())) captured")).rows[0].captured);
  const order = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await db.query("insert into public.orders(id) values($1)", [order]);
  const attempt = (await db.query<{ attempt_key: string }>(`insert into public.product_checkout_attempts
    (buyer_id,creator_id,product_id,post_id,purchase_identity,order_id,terms_fingerprint,purchase_consent_id,stripe_checkout_session_id,status)
    values($1,$2,$3,$4,'one-time',$5,$6,$7,'cs_test_OneTime','open') returning attempt_key`,
    [ids.buyer, ids.creator, ids.product, ids.post, order, quote.fingerprint, consent])).rows[0].attempt_key;
  const purchase = (await db.query<{ id: string }>(`insert into public.purchases
    (buyer_id,creator_id,product_id,post_id,order_id,session_id,status,amount_cents,currency,access_granted)
    values($1,$2,$3,$4,$5,'cs_test_OneTime','pending',199900,'usd',false) returning id`,
    [ids.buyer, ids.creator, ids.product, ids.post, order])).rows[0].id;
  const bind = (at = captured) => db.query<{ bound: boolean }>(
    "select public.bind_fixed_service_one_time_v1($1,$2,$3,'pi_OneTime','ch_OneTime',$4,199900,'usd') bound",
    [purchase, consent, attempt, at]);
  const credit = async () => {
    await db.query("update public.purchases set status='paid',access_granted=true,payment_intent_id='pi_OneTime' where id=$1", [purchase]);
    await db.query(`insert into public.payment_fee_ledger
      (purchase_id,creator_id,stripe_payment_intent_id,stripe_charge_id,gross_amount_cents,platform_fee_cents,
       processing_fee_cents,total_creator_deduction_cents,creator_net_cents,fee_schedule_version,currency,status)
       values($1,$2,'pi_OneTime','ch_OneTime',199900,23988,0,23988,175912,'local-v1','usd','paid')`, [purchase, ids.creator]);
    // The catalog harness has no legacy credit RPC body. Seed its recorded
    // output here; the real app's invocation/order is covered in route tests.
    await db.query("update public.purchases set earnings_credited_at=now(),earnings_credited_cents=175912 where id=$1", [purchase]);
  };
  return { purchase, consent, attempt, captured, bind, credit, quote };
}
async function expectSqlReject(run: () => Promise<unknown>, message?: string) {
  await db.exec("savepoint duration_reject");
  try { await expect(run()).rejects.toThrow(message); }
  finally { await db.exec("rollback to savepoint duration_reject; release savepoint duration_reject"); }
}
test("service duration one-time checkout stays inaccessible until credited capture and replays preserve the start", async () => {
  const h = await seedOneTimeDuration(10, 1);
  expect(await fixedEntitlement()).toMatchObject({ applicable: true, allowed: false });
  expect((await db.query("select * from public.fixed_purchase_service_contracts_v1")).rows).toHaveLength(0);
  await expectSqlReject(() => h.bind(), "Captured one-time service binding differs");
  await h.credit(); expect(await fixedEntitlement()).toMatchObject({ allowed: false });
  expect((await h.bind()).rows).toEqual([{ bound: true }]);
  expect(await fixedEntitlement()).toMatchObject({ serviceMonths: 10, serviceStartAt: h.captured,
    serviceEndAt: fixedServiceEndAt(h.captured, 10), financialAccess: true, allowed: true });
  const before = (await db.query("select * from public.fixed_purchase_service_contracts_v1")).rows;
  await h.bind(); expect((await db.query("select * from public.fixed_purchase_service_contracts_v1")).rows).toEqual(before);
  await expectSqlReject(() => h.bind(h.captured - 1), "replay differs");
  expect((await db.query("select access_granted from public.purchases")).rows).toEqual([{ access_granted: false }]);
  expect(await fixedEntitlement(ids.creator)).toMatchObject({ allowed: false });
});
test("service duration one-time expiry uses the original calendar end and does not alter accounting", async () => {
  const h = await seedOneTimeDuration(1, 40); await h.credit(); await h.bind();
  expect(await fixedEntitlement()).toMatchObject({ financialAccess: true, allowed: false, maxAgeSeconds: 0 });
  expect((await db.query("select status,earnings_credited_cents,access_granted from public.purchases")).rows)
    .toEqual([{ status: "paid", earnings_credited_cents: 175912, access_granted: false }]);
});
test("service duration one-time catalog changes cannot shorten the accepted promise", async () => {
  const h = await seedOneTimeDuration(); await db.query("update public.products set fixed_service_months=1 where id=$1", [ids.product]);
  await h.credit(); await h.bind();
  expect(await fixedEntitlement()).toMatchObject({ serviceMonths: 10, allowed: true });
});
test("service duration one-time financial revocation survives replay and unrelated purchase updates", async () => {
  const h = await seedOneTimeDuration(); await h.credit(); await h.bind();
  await db.query("update public.purchases set access_granted=false where id=$1", [h.purchase]);
  await h.bind(); await db.query("update public.purchases set paid_at=now() where id=$1", [h.purchase]);
  expect(await fixedEntitlement()).toMatchObject({ financialAccess: false, allowed: false });
});
test("service duration one-time rejects missing consent and keeps the service terms private and immutable", async () => {
  const h = await seedOneTimeDuration(); await h.credit(); await h.bind();
  await expectSqlReject(() => db.query("update public.product_checkout_attempts set purchase_consent_id=null where attempt_key=$1", [h.attempt]), "immutable");
  for (const statement of ["update public.fixed_purchase_service_contracts_v1 set service_start_at=service_start_at+1",
    "delete from public.fixed_purchase_service_contracts_v1", "truncate public.fixed_purchase_service_contracts_v1"]) {
    await expectSqlReject(() => db.exec(statement), "immutable");
  }
  for (const role of ["anon", "authenticated"]) {
    expect((await db.query("select has_function_privilege($1,'public.bind_fixed_service_one_time_v1(uuid,uuid,uuid,text,text,bigint,bigint,text)','EXECUTE') allowed", [role])).rows).toEqual([{ allowed: false }]);
  }
});
test("service duration one-time existing permanent purchases never acquire today's product duration", async () => {
  await installOneTimeDuration();
  const purchase = (await db.query<{ id: string }>(`insert into public.purchases
    (buyer_id,creator_id,product_id,post_id,session_id,status,access_granted,amount_cents,currency)
    values($1,$2,$3,$4,'cs_test_Legacy','paid',true,199900,'usd') returning id`,
    [ids.buyer, ids.creator, ids.product, ids.post])).rows[0].id;
  await db.query("update public.products set fixed_service_months=1 where id=$1", [ids.product]);
  await db.query("update public.purchases set access_granted=true where id=$1", [purchase]);
  expect(await fixedEntitlement()).toMatchObject({ applicable: false, allowed: true });
  expect((await db.query("select * from public.fixed_purchase_service_contracts_v1")).rows).toHaveLength(0);
});
test("service duration context first credit removes its private admission and still rejects direct legacy fulfillment", async () => {
  await timedProduct(10); await seedHeld(); const h = harness();
  await h.runtime.prepareCheckout(reservationId, ids.creator); paySyntheticSession();
  await h.credit.creditFirstPayment(reservationId, ids.creator);
  expect((await db.query("select * from public.exact_context_sql_admissions_v2")).rows).toHaveLength(0);
  await expectSqlReject(() => db.query("select public.fulfill_exact_installment_first_payment($1)", [reservationId]), "Context-scoped payment entry required");
});

test("service duration one-time durable consent rejects missing or stale service terms", async () => {
  const h = await seedOneTimeDuration();
  const record = (terms: Body) => db.query("select public.record_product_purchase_consent_v1($1,$2,$3,$4,$5,$6)",
    [ids.buyer, ids.creator, ids.product, ids.post, JSON.stringify(terms), "a".repeat(64)]);
  const missing: Body = { ...h.quote.terms }; delete missing.serviceMonths;
  await expectSqlReject(() => record(missing), "does not match");
  await db.query("update public.products set fixed_service_months=4 where id=$1", [ids.product]);
  await expectSqlReject(() => record(h.quote.terms), "does not match");
});
test("service duration one-time wrong ownership and payment identifiers cannot bind access", async () => {
  const h = await seedOneTimeDuration(); await h.credit();
  for (const [consent, attempt, pi, charge, amount] of [
    [ids.buyer, h.attempt, "pi_OneTime", "ch_OneTime", 199900],
    [h.consent, ids.buyer, "pi_OneTime", "ch_OneTime", 199900],
    [h.consent, h.attempt, "pi_Other", "ch_OneTime", 199900],
    [h.consent, h.attempt, "pi_OneTime", "ch_Other", 199900],
    [h.consent, h.attempt, "pi_OneTime", "ch_OneTime", 50],
  ]) await expectSqlReject(() => db.query(
    "select public.bind_fixed_service_one_time_v1($1,$2,$3,$4,$5,$6,$7,'usd')",
    [h.purchase, consent, attempt, pi, charge, h.captured, amount]));
  expect(await fixedEntitlement()).toMatchObject({ allowed: false });
});
test("service duration one-time pending rotation can accept a new duration without changing an existing paid contract", async () => {
  const h = await seedOneTimeDuration();
  await db.query("update public.products set fixed_service_months=4 where id=$1", [ids.product]);
  const quote = productPurchaseTerms({ id: ids.product, creator_id: ids.creator, title: "Local Checkout",
    type: "mentorship", amount_cents: 199900, fixed_service_months: 4 }, ids.buyer, ids.post);
  const consent = (await db.query<{ id: string }>("select public.record_product_purchase_consent_v1($1,$2,$3,$4,$5,$6) id",
    [ids.buyer, ids.creator, ids.product, ids.post, JSON.stringify(quote.terms), quote.fingerprint])).rows[0].id;
  await db.query("update public.product_checkout_attempts set attempt_key=gen_random_uuid(),purchase_consent_id=$1,stripe_checkout_session_id='cs_test_Rotated' where attempt_key=$2", [consent, h.attempt]);
  await db.query("update public.purchases set session_id='cs_test_Rotated' where id=$1", [h.purchase]);
  expect((await db.query("select fixed_service_consent_id,access_granted from public.purchases")).rows)
    .toEqual([{ fixed_service_consent_id: consent, access_granted: false }]);
});
