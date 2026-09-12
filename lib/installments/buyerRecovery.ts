import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId, operationHash, type ExactAgreementStore } from "./agreementStore";
import { assertExactInstallmentEnvironment } from "./checkoutPreparation";
import { calculateInstallmentPlan } from "../installmentPlan";
import { parseRenewalAuthorization } from "./invoiceStore";
import { prepareExactCardSetupSandbox, readExactCardSetupRedirectSandbox, verifyExactCardSetupSandbox,
  type ExactCardSetupStore } from "./cardRecovery";
import { CARD_SETUP_CONSENT_VERSION, RETRY_CONSENT_VERSION, PAY_NOW_CONSENT_VERSION, FUTURE_CARD_CONSENT_VERSION, type PaymentConsentVersion,
  type BuyerPaymentQuote, type BuyerRecoveryView } from "./buyerRecoveryView";
import { collectExactBuyerRetrySandbox } from "./paymentRetry";
import { parseExactFutureCardQuote } from "./paymentRetryStore";
import { readExactBankChallengeSandbox, checkExactBankPaymentSandbox, type ExactBankVerificationStore } from "./bankVerification";
import { exactContextServerConfig } from "./contextServer";
import type { ProcessingFeeSchedule } from "../money";

type Env = Record<string, string | undefined>;
function check(value: unknown): asserts value { if (!value) throw new Error("Payment recovery needs review"); }
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function buyerRecoveryEnabled(env: Env) {
  try {
    if (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RECOVERY_READY === "true" &&
      env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY === "true") { exactContextServerConfig(env); return true; }
    assertExactInstallmentEnvironment(env, env.NEXT_PUBLIC_SITE_URL || "");
    return [env.CREATOR_EXACT_INSTALLMENTS_BUYER_RECOVERY_READY, env.CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_READY,
      env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY, env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY]
      .every(v => v === "true");
  } catch { return false; }
}

export type BuyerRecoveryInput = { agreementId: string } & (
  { action: "save_card"; requestId: string; accepted: true; consentVersion: typeof CARD_SETUP_CONSENT_VERSION } |
  { action: "verify_card" } |
  { action: "verify_bank" } | { action: "check_bank_payment" } |
  { action: "review_payment"; quoteId: string } |
  { action: "review_pay_now"; quoteId: string } |
  { action: "confirm_payment"; quoteId: string; accepted: true; consentVersion: typeof RETRY_CONSENT_VERSION } |
  { action: "pay_now"; quoteId: string; accepted: true; consentVersion: typeof PAY_NOW_CONSENT_VERSION;
    futureCardConsentVersion?:typeof FUTURE_CARD_CONSENT_VERSION });
export function parseBuyerRecoveryInput(value: unknown): BuyerRecoveryInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (!uuid(r.agreementId)) return null;
  let keys: string[];
  if (r.action === "save_card" && uuid(r.requestId) && r.accepted === true && r.consentVersion === CARD_SETUP_CONSENT_VERSION)
    keys = ["agreementId", "action", "requestId", "accepted", "consentVersion"];
  else if (["verify_card", "verify_bank", "check_bank_payment"].includes(r.action as string)) keys = ["agreementId", "action"];
  else if (["review_payment", "review_pay_now"].includes(r.action as string) && uuid(r.quoteId)) keys = ["agreementId", "action", "quoteId"];
  else if (r.action === "confirm_payment" && uuid(r.quoteId) && r.accepted === true && r.consentVersion === RETRY_CONSENT_VERSION)
    keys = ["agreementId", "action", "quoteId", "accepted", "consentVersion"];
  else if (r.action === "pay_now" && uuid(r.quoteId) && r.accepted === true && r.consentVersion === PAY_NOW_CONSENT_VERSION) {
    keys = ["agreementId", "action", "quoteId", "accepted", "consentVersion"];
    if(r.futureCardConsentVersion===FUTURE_CARD_CONSENT_VERSION) keys.push("futureCardConsentVersion");
  }
  else return null;
  return Object.keys(r).length === keys.length && Object.keys(r).every(k => keys.includes(k)) ? r as BuyerRecoveryInput : null;
}

type Quote = BuyerPaymentQuote & { agreementId: string; buyerId: string; setupId: string };
export interface BuyerRecoverySource {
  view(agreementId: string, buyerId: string): Promise<unknown>;
  invoice(agreementId: string, paymentNumber: number): Promise<string>;
  quote(id: string, setupId: string, buyerId: string, version?: PaymentConsentVersion): Promise<unknown>;
  loadQuote(id: string, agreementId: string, buyerId: string): Promise<unknown>;
  confirm(id: string, buyerId: string, version?: PaymentConsentVersion): Promise<unknown>;
  quoteFuture?(id:string,setupId:string,buyerId:string):Promise<unknown>;
  confirmFuture?(id:string,buyerId:string,accepted:boolean):Promise<unknown>;
}
/** Service-role client is constructed only after authenticated-user and Preview
 * checks. Ownership is also enforced by RPCs; no client-supplied buyer is used. */
export function createBuyerRecoverySource(admin: SupabaseClient): BuyerRecoverySource {
  const rpc = async (name: string, params: Record<string, unknown>, row = false) => {
    const query = admin.rpc(name, params);
    const { data, error } = await (row ? query.single() : query);
    if (error) throw new Error("Payment recovery state unavailable");
    return data as unknown;
  };
  return {
    view: (agreement, buyer) => rpc("read_exact_buyer_recovery", { p_agreement_id: agreement, p_buyer_id: buyer }),
    async invoice(agreement, number) {
      const { data, error } = await admin.from("exact_installment_invoice_claims").select("stripe_invoice_id")
        .eq("agreement_id", agreement).eq("payment_number", number).single();
      check(!error && data && /^in_[a-zA-Z0-9]+$/.test(data.stripe_invoice_id));
      return data.stripe_invoice_id as string;
    },
    quote: (id, setup, buyer, version = RETRY_CONSENT_VERSION) => rpc("quote_exact_installment_retry", {
      p_id: id, p_setup_id: setup, p_buyer_id: buyer,
      ...(version === PAY_NOW_CONSENT_VERSION ? { p_consent_version: version } : {}),
    }, true),
    async loadQuote(id, agreement, buyer) {
      const { data, error } = await admin.from("exact_installment_payment_confirmations").select("*")
        .eq("id", id).eq("agreement_id", agreement).eq("buyer_id", buyer).single();
      check(!error && data); return data as unknown;
    },
    confirm: (id, buyer, version = RETRY_CONSENT_VERSION) => rpc("confirm_exact_installment_retry", {
      p_id: id, p_buyer_id: buyer, p_consent_version: version }, true),
    quoteFuture:(id,setup,buyer)=>rpc("quote_exact_installment_future_card",{p_id:id,p_setup_id:setup,p_buyer_id:buyer},true),
    confirmFuture:(id,buyer,accepted)=>rpc("confirm_exact_installment_future_card",{
      p_id:id,p_buyer_id:buyer,p_accepted:accepted,p_consent_version:FUTURE_CARD_CONSENT_VERSION},true),
  };
}

type CardInput = Parameters<typeof prepareExactCardSetupSandbox>[0];
type RetryInput = Parameters<typeof collectExactBuyerRetrySandbox>[0];
export type BuyerRecoveryDependencies = { source: BuyerRecoverySource; agreementStore: ExactAgreementStore;
  cardStore: ExactCardSetupStore; stripe: RetryInput["stripe"]; env: Env; now?: () => number;
  bankStore?: ExactBankVerificationStore;
  retry?: Pick<RetryInput, "invoiceStore" | "creditStore" | "retryStore"> };
export type BuyerRecoveryResult = { status: "card_setup_ready"; url: string } |
  { status: "setup_pending" | "card_saved_payment_not_attempted" } |
  { status: "payment_review_ready"; quote: BuyerPaymentQuote } |
  { status: "payment_confirmation_recorded"; quote: BuyerPaymentQuote } |
  { status: "payment_attempt_checked"; quote: BuyerPaymentQuote; outcome: "paid_accounted" | "review_required" } |
  Awaited<ReturnType<typeof readExactBankChallengeSandbox>> | Awaited<ReturnType<typeof checkExactBankPaymentSandbox>>;
const publicQuote = (q: Quote): BuyerPaymentQuote => ({ id: q.id, amountCents: q.amountCents, paymentNumber: q.paymentNumber,
  paymentCount: q.paymentCount, expiresAt: q.expiresAt, confirmed: q.confirmed,
  ...(q.consentVersion === PAY_NOW_CONSENT_VERSION ? { consentVersion: q.consentVersion } : {}),
  ...(q.remainingPayments ? {remainingPayments:q.remainingPayments,...q.confirmed ? {futureCardAccepted:q.futureCardAccepted} : {}} : {}) });

/** #3: shared read-only presentation checks; protocol ownership is validated by
 * each controller before reaching this parser. No Stripe/SQL mutation here. */
export function parseBuyerRecoveryView(raw: unknown, a: { id: string; status: string; terms: { title: string; totalCents: number;
  paymentCount: number; firstPaymentFeeSchedule: ProcessingFeeSchedule; renewalFeeSchedule: ProcessingFeeSchedule } },
  controls: { card: boolean; confirm: boolean; pay: boolean; bank: boolean }): BuyerRecoveryView {
  check(raw && typeof raw === "object" && !Array.isArray(raw)); const r = raw as Record<string, unknown>;
  check(r.agreementId === a.id && r.title === a.terms.title && r.totalCents === a.terms.totalCents && r.paymentCount === a.terms.paymentCount);
  check(r.outcome === null || ["action_required", "payment_method_required", "payment_pending", "terminal_unpaid", "paid_accounted", "review_required"].includes(r.outcome as string));
  check(r.observedAt === null || typeof r.observedAt === "string" && Number.isFinite(Date.parse(r.observedAt)));
  check(typeof r.setupEligible === "boolean" && ["not_started", "reserved", "started", "verified"].includes(r.setupState as string));
  check((r.setupRequestId === null || uuid(r.setupRequestId)) && (r.confirmedQuoteId === null || uuid(r.confirmedQuoteId)));
  check((r.setupState === "not_started") === (r.setupRequestId === null));
  if(r.futureCardAccepted!==undefined) check(typeof r.futureCardAccepted==="boolean" && r.confirmedQuoteId!==null);
  if (r.paymentNumber === null) check(r.amountCents === null && r.outcome === null);
  else {
    check(Number.isInteger(r.paymentNumber) && (r.paymentNumber as number) >= 2);
    const payment = calculateInstallmentPlan(a.terms.totalCents, a.terms.paymentCount, a.terms.renewalFeeSchedule,
      a.terms.firstPaymentFeeSchedule).payments[(r.paymentNumber as number) - 1];
    check(payment && payment.amountCents === r.amountCents);
  }
  const eligible = r.setupEligible && r.outcome === "payment_method_required" && r.confirmedQuoteId === null && a.status === "active";
  return Object.freeze({ agreementId: a.id, title: a.terms.title, totalCents: a.terms.totalCents, paymentCount: a.terms.paymentCount,
    paymentNumber: r.paymentNumber as number | null, amountCents: r.amountCents as number | null, outcome: r.outcome as string | null,
    observedAt: r.observedAt as string | null, setupRequestId: r.setupRequestId as string | null,
    setupState: r.setupState as BuyerRecoveryView["setupState"], setupEligible: eligible,
    confirmedQuoteId: r.confirmedQuoteId as string | null,
    canSaveCard: eligible && r.setupState !== "verified" && controls.card,
    canConfirmPayment: eligible && r.setupState === "verified" && controls.confirm,
    canAttemptPayment: eligible && r.setupState === "verified" && controls.confirm && controls.pay,
    canVerifyBank: controls.bank && a.status === "active" && r.outcome === "action_required",
    canCheckBankPayment: controls.bank && r.paymentNumber !== null,
    ...(r.futureCardAccepted!==undefined ? {futureCardAccepted:r.futureCardAccepted as boolean} : {}) });
}

/** Sandbox candidate. Old confirmation is forever record-only. Only a separate
 * pay-now action with matching new consent can invoke the once-admitted retry.
 * GET, refresh, review and old confirmations never dispatch payment. */
export function createBuyerRecoveryController(d: BuyerRecoveryDependencies) {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const payEnabled = () => Boolean(d.retry && d.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY === "true" &&
    d.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_BUYER_RETRY === "true");
  const bankEnabled = () => Boolean(d.retry && d.bankStore && d.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY === "true" &&
    d.env.CREATOR_EXACT_INSTALLMENTS_BANK_VERIFICATION_READY === "true");
  const futureEnabled=()=>Boolean(payEnabled() && d.source.quoteFuture && d.source.confirmFuture &&
    d.env.CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY==="true");
  async function owned(agreementId: string, buyerId: string) {
    check(buyerRecoveryEnabled(d.env)); assertAgreementId(agreementId); assertAgreementId(buyerId);
    const a = await d.agreementStore.load(agreementId);
    check(a.id === agreementId && a.terms.buyerId === buyerId);
    assertExactInstallmentEnvironment(d.env, a.terms.previewOrigin); return a;
  }
  async function read(agreementId: string, buyerId: string): Promise<BuyerRecoveryView> {
    const a = await owned(agreementId, buyerId);
    const raw = await d.source.view(agreementId, buyerId);
    return parseBuyerRecoveryView(raw, a, { card: d.env.CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_PUBLISH_READY === "true",
      confirm: d.env.CREATOR_EXACT_INSTALLMENTS_PAYMENT_CONFIRMATION_READY === "true", pay: payEnabled(), bank: bankEnabled() });
  }
  async function quote(raw: unknown, agreementId: string, buyerId: string, quoteId: string,
    version: PaymentConsentVersion = RETRY_CONSENT_VERSION): Promise<Quote> {
    const a = await owned(agreementId, buyerId);
    check(raw && typeof raw === "object" && !Array.isArray(raw)); const r = raw as Record<string, unknown>;
    check(r.id === quoteId && r.agreement_id === agreementId && r.buyer_id === buyerId && uuid(r.setup_request_id));
    check(r.consent_version === version && Number.isSafeInteger(r.expires_at));
    const created = typeof r.created_at === "string" ? Math.floor(Date.parse(r.created_at) / 1000) : NaN;
    check(Number.isSafeInteger(created) && created <= now() && (r.expires_at as number) > created && (r.expires_at as number) <= created + 300);
    check(r.confirmed_at === null || typeof r.confirmed_at === "string" && Date.parse(r.confirmed_at) / 1000 >= created && Date.parse(r.confirmed_at) / 1000 < (r.expires_at as number));
    const auth = parseRenewalAuthorization(r.authorization_snapshot);
    check(auth.planId === a.id && auth.invoiceId === r.stripe_invoice_id && auth.bookingPaymentId === a.terms.bookingPaymentId &&
      auth.customerId === a.customerId && auth.subscriptionId === a.subscriptionId && auth.destinationId === a.terms.destinationId &&
      auth.totalCents === a.terms.totalCents && auth.paymentCount === a.terms.paymentCount &&
      operationHash(auth.feeSchedule) === operationHash(a.terms.renewalFeeSchedule));
    const payment = calculateInstallmentPlan(auth.totalCents, auth.paymentCount, auth.feeSchedule).payments[auth.paymentNumber - 1];
    check(payment.amountCents === r.amount_cents && payment.fees.totalCreatorDeductionCents === r.application_fee_cents);
    check(typeof r.original_payment_intent_id === "string" && /^pi_[a-zA-Z0-9]+$/.test(r.original_payment_intent_id) &&
      typeof r.replacement_payment_method_id === "string" && /^pm_[a-zA-Z0-9]+$/.test(r.replacement_payment_method_id) &&
      typeof r.setup_intent_id === "string" && /^seti_[a-zA-Z0-9]+$/.test(r.setup_intent_id));
    const futureChoice=parseExactFutureCardQuote(r,auth,version);
    return { id: quoteId, agreementId, buyerId, setupId: r.setup_request_id, amountCents: payment.amountCents,
      paymentNumber: auth.paymentNumber, paymentCount: auth.paymentCount, expiresAt: r.expires_at as number, confirmed: r.confirmed_at !== null,
      consentVersion: version,...futureChoice };
  }
  async function act(input: BuyerRecoveryInput, buyerId: string): Promise<BuyerRecoveryResult> {
    check(parseBuyerRecoveryInput(input)); const v = await read(input.agreementId, buyerId);
    const version = input.action === "pay_now" || input.action === "review_pay_now" ? PAY_NOW_CONSENT_VERSION : RETRY_CONSENT_VERSION;
    const cardArgs = (requestId: string): CardInput => ({ requestId, buyerId, store: d.cardStore,
      agreementStore: d.agreementStore, stripe: d.stripe, env: d.env, now: d.now });
    if (input.action === "verify_bank" || input.action === "check_bank_payment") {
      check(bankEnabled() && d.retry && d.bankStore && v.paymentNumber !== null);
      if (input.action === "verify_bank") check(v.canVerifyBank);
      const bankArgs = { ...d.retry, bankStore: d.bankStore, buyerId, agreementId: v.agreementId,
        invoiceId: await d.source.invoice(v.agreementId, v.paymentNumber), store: d.agreementStore, stripe: d.stripe, env: d.env, now: d.now };
      return input.action === "verify_bank" ? readExactBankChallengeSandbox(bankArgs) : checkExactBankPaymentSandbox(bankArgs);
    }
    if (input.action === "save_card") {
      check(v.canSaveCard && v.paymentNumber !== null && (!v.setupRequestId || v.setupRequestId === input.requestId));
      const invoice = await d.source.invoice(v.agreementId, v.paymentNumber);
      await d.cardStore.reserve(input.requestId, v.agreementId, invoice, buyerId, input.consentVersion);
      await prepareExactCardSetupSandbox(cardArgs(input.requestId));
      return { status: "card_setup_ready", url: await readExactCardSetupRedirectSandbox(cardArgs(input.requestId)) };
    }
    // Never turn a duplicate HTTP request or a lost confirmation response into
    // dispatch authority. Refresh/reconciliation handles an admitted attempt.
    if (input.action === "pay_now" && v.confirmedQuoteId === input.quoteId) {
      const q = await quote(await d.source.loadQuote(input.quoteId, v.agreementId, buyerId), v.agreementId, buyerId, input.quoteId, version);
      check(q.confirmed);
      if(q.remainingPayments) check(q.futureCardAccepted===(input.futureCardConsentVersion===FUTURE_CARD_CONSENT_VERSION));
      else check(input.futureCardConsentVersion===undefined);
      return { status: "payment_attempt_checked", quote: publicQuote(q), outcome: v.outcome === "paid_accounted" ? "paid_accounted" : "review_required" };
    }
    if (input.action === "confirm_payment" && v.confirmedQuoteId === input.quoteId) {
      const q = await quote(await d.source.loadQuote(input.quoteId, v.agreementId, buyerId), v.agreementId, buyerId, input.quoteId);
      check(q.confirmed); return { status: "payment_confirmation_recorded", quote: publicQuote(q) };
    }
    check(v.setupEligible && v.setupRequestId);
    if (input.action === "verify_card") return verifyExactCardSetupSandbox(cardArgs(v.setupRequestId));
    check(v.canConfirmPayment);
    if (version === PAY_NOW_CONSENT_VERSION) check(v.canAttemptPayment && payEnabled());
    if (input.action === "review_payment" || input.action === "review_pay_now") {
      check((await verifyExactCardSetupSandbox(cardArgs(v.setupRequestId))).status === "card_saved_payment_not_attempted");
      const raw=version===PAY_NOW_CONSENT_VERSION && futureEnabled() && v.paymentNumber!==null && v.paymentNumber<v.paymentCount ?
        await d.source.quoteFuture!(input.quoteId,v.setupRequestId,buyerId) : await d.source.quote(input.quoteId,v.setupRequestId,buyerId,version);
      const q = await quote(raw, v.agreementId, buyerId, input.quoteId, version);
      if(q.remainingPayments) check(futureEnabled());
      check(q.setupId === v.setupRequestId && !q.confirmed && q.expiresAt > now());
      return { status: "payment_review_ready", quote: publicQuote(q) };
    }
    const q = await quote(await d.source.loadQuote(input.quoteId, v.agreementId, buyerId), v.agreementId, buyerId, input.quoteId, version);
    check(q.setupId === v.setupRequestId && !q.confirmed && q.expiresAt > now());
    const futureAccepted=input.action==="pay_now" && input.futureCardConsentVersion===FUTURE_CARD_CONSENT_VERSION;
    if(futureAccepted) check(futureEnabled() && q.remainingPayments);
    if(q.remainingPayments) check(futureEnabled() && input.action==="pay_now");
    check((await verifyExactCardSetupSandbox(cardArgs(v.setupRequestId))).status === "card_saved_payment_not_attempted");
    const rawConfirmed=q.remainingPayments ? await d.source.confirmFuture!(q.id,buyerId,futureAccepted) : await d.source.confirm(q.id,buyerId,version);
    const confirmed = await quote(rawConfirmed, v.agreementId, buyerId, q.id, version);
    check(confirmed.confirmed && confirmed.setupId === q.setupId && confirmed.amountCents === q.amountCents);
    check(operationHash(confirmed.remainingPayments??null)===operationHash(q.remainingPayments??null));
    if(q.remainingPayments) check(confirmed.futureCardAccepted===futureAccepted);
    if (input.action === "pay_now") {
      check(payEnabled() && d.retry && v.paymentNumber !== null);
      const invoiceId = await d.source.invoice(v.agreementId, v.paymentNumber);
      const result = await collectExactBuyerRetrySandbox({ ...d.retry, agreementId: v.agreementId, invoiceId, quoteId: q.id, buyerId,
        store: d.agreementStore, cardStore: d.cardStore, stripe: d.stripe, env: d.env, now: d.now });
      return { status: "payment_attempt_checked", quote: publicQuote(confirmed),
        outcome: result.status === "credited" || result.status === "already_credited" ? "paid_accounted" : "review_required" };
    }
    return { status: "payment_confirmation_recorded", quote: publicQuote(confirmed) };
  }
  return { read, act };
}
