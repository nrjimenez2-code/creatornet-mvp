import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId } from "./agreementStore";
import { readExactContextReservation } from "./contextReservation";
import { exactContextServerConfig } from "./contextServer";
import { parseBuyerRecoveryInput, parseBuyerRecoveryView, type BuyerRecoveryInput, type BuyerRecoveryResult } from "./buyerRecovery";
import { createExactContextRuntime, createExactContextCardSetup, createExactContextCardSetupPublication,
  createExactContextBuyerRetry, createExactContextBankVerification } from "./contextRuntime";
import { contextStripeId } from "./contextCheckout";

type Env = Record<string, string | undefined>;
function check(v: unknown): asserts v { if (!v) throw Error("Context buyer recovery needs review"); }
/** #3: preserves the existing screen/request/consent contracts. The browser
 * supplies no buyer, invoice, card, price or provider evidence. */
export function createContextBuyerRecoveryController(admin: SupabaseClient, env: Env) {
  check(env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY === "true" && env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RECOVERY_READY === "true");
  const config = exactContextServerConfig(env);
  const payEnabled = env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RETRY_READY === "true";
  const bankEnabled = env.CREATOR_EXACT_INSTALLMENTS_BANK_VERIFICATION_READY === "true";
  async function source(agreementId: string, buyerId: string) {
    assertAgreementId(agreementId); assertAgreementId(buyerId);
    const observed = await createExactContextRuntime(config).observeContext();
    const row = await admin.from("exact_installment_context_reservations_v2").select("id,booking_id,context,terms,status,created_at")
      .eq("id", agreementId).eq("terms->>buyerId", buyerId).maybeSingle();
    check(!row.error && row.data);
    const r = readExactContextReservation(row.data, observed.contextEvidence); check(r.id === agreementId && r.terms.buyerId === buyerId);
    const result = await admin.rpc("read_exact_context_buyer_view_v2", { p_reservation_id: agreementId, p_buyer_id: buyerId, p_context: config.approvedContext });
    check(!result.error && result.data && typeof result.data.agreementStatus === "string");
    const view = parseBuyerRecoveryView(result.data.view, { id: r.id, terms: r.terms, status: result.data.agreementStatus }, {
      card: env.CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_PUBLISH_READY === "true", confirm: payEnabled, pay: payEnabled, bank: bankEnabled });
    const invoiceId = result.data.invoiceId === null ? null : contextStripeId(result.data.invoiceId, "in");
    check((view.paymentNumber === null) === (invoiceId === null));
    return { view, invoiceId };
  }
  return Object.freeze({
    read: async (agreementId: string, buyerId: string) => (await source(agreementId, buyerId)).view,
    async act(input: BuyerRecoveryInput, buyerId: string): Promise<BuyerRecoveryResult> {
      check(parseBuyerRecoveryInput(input)); const { view: v, invoiceId } = await source(input.agreementId, buyerId); check(invoiceId);
      const a = input.agreementId, card = createExactContextCardSetup(config);
      if (input.action === "save_card") {
        check(v.canSaveCard && (!v.setupRequestId || v.setupRequestId === input.requestId));
        check((await card.saveCard(a, buyerId, invoiceId, input.requestId, { accepted: input.accepted, consentVersion: input.consentVersion })).status === "prepared_unpublished");
        const result = await createExactContextCardSetupPublication(config).readRedirect(a, buyerId, invoiceId, input.requestId);
        check(result.status === "card_setup_ready"); return { status: result.status, url: result.url };
      }
      if (input.action === "verify_card") {
        check(v.setupRequestId);
        const result = await card.verifyCard(a, buyerId, invoiceId, v.setupRequestId);
        check(result.status === "setup_pending" || result.status === "card_saved_payment_not_attempted"); return { status: result.status };
      }
      if (input.action === "verify_bank" || input.action === "check_bank_payment") {
        check(bankEnabled);
        const bank = createExactContextBankVerification(config, globalThis.fetch, env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null);
        if (input.action === "verify_bank") { check(v.canVerifyBank); const result = await bank.readChallenge(a, buyerId, invoiceId);
          check(result.status === "bank_verification_ready"); return result; }
        check(v.canCheckBankPayment); const result = await bank.checkPayment(a, buyerId, invoiceId);
        return { status: "bank_payment_checked", outcome: result.status === "credited" || result.status === "already_credited" ? "paid_accounted" : "review_required" };
      }
      const retry = createExactContextBuyerRetry(config);
      if (input.action === "review_pay_now") {
        check(v.canAttemptPayment && v.paymentNumber !== null);
        const result = env.CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY === "true" && v.paymentNumber < v.paymentCount
          ? await retry.reviewWithFutureCardChoice(a, buyerId, invoiceId, input.quoteId) : await retry.reviewPayment(a, buyerId, invoiceId, input.quoteId);
        check(result.status === "payment_review_ready" && result.quote); return { status: result.status, quote: result.quote };
      }
      if (input.action === "pay_now") {
        check(payEnabled);
        let result;
        if (v.confirmedQuoteId) { check(v.confirmedQuoteId === input.quoteId &&
          Boolean(input.futureCardConsentVersion) === (v.futureCardAccepted === true));
          result = await retry.reconcile(a, buyerId, invoiceId, input.quoteId); }
        else { check(v.canAttemptPayment && (!input.futureCardConsentVersion || env.CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY === "true"));
          result = await retry.payNow(a, buyerId, invoiceId, input.quoteId,
          { accepted: input.accepted, consentVersion: input.consentVersion,
            ...(input.futureCardConsentVersion ? { futureCardConsentVersion: input.futureCardConsentVersion } : {}) }); }
        check(result.quote); return { status: "payment_attempt_checked", quote: result.quote,
          outcome: result.status === "credited" || result.status === "already_credited" ? "paid_accounted" : "review_required" };
      }
      // Historical record-only confirmation is not permission for this newer
      // payment path. Its original implementation remains on legacy agreements.
      throw Error("Review the current payment before confirming");
    },
  });
}
