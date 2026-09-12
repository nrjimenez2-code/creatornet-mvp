import "server-only";
import { createClient } from "@supabase/supabase-js";
import { buyerRecoveryEnabled, createBuyerRecoveryController, createBuyerRecoverySource, type BuyerRecoveryInput } from "./buyerRecovery";
import { createExactAgreementStore } from "./agreementStore";
import { createExactCardSetupStore } from "./cardRecovery";
import { getStripe } from "../stripeClient";
import { createExactInvoiceStore } from "./invoiceStore";
import { createExactReceiptCreditStore } from "./receiptCredit";
import { createExactPaymentRetryStore } from "./paymentRetryStore";
import { createExactBankVerificationStore } from "./bankVerification";
import { createContextBuyerRecoveryController } from "./contextBuyerRecoveryApp";
import { assertAgreementId } from "./agreementStore";
import { assertExactInstallmentEnvironment } from "./checkoutPreparation";

/** #3: call only after authentication. Persisted context selection precedes
 * creation of any legacy payment client; each protocol retains its own guards. */
export function buyerRecoveryController() {
  if (!buyerRecoveryEnabled(process.env)) throw new Error("Payment recovery is unavailable");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } });
  async function controller(agreementId: string) {
    assertAgreementId(agreementId);
    if (process.env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY === "true") {
      const result = await admin.from("exact_installment_context_reservations_v2").select("id").eq("id", agreementId).maybeSingle();
      if (result.error) throw Error("Payment context unavailable");
      if (result.data) return createContextBuyerRecoveryController(admin, process.env);
    }
    assertExactInstallmentEnvironment(process.env, process.env.NEXT_PUBLIC_SITE_URL || "");
    return createBuyerRecoveryController({ source: createBuyerRecoverySource(admin), agreementStore: createExactAgreementStore(admin),
    cardStore: createExactCardSetupStore(admin), stripe: getStripe(), env: process.env,
    ...(process.env.CREATOR_EXACT_INSTALLMENTS_BANK_VERIFICATION_READY === "true" ? { bankStore: createExactBankVerificationStore(admin) } : {}),
    ...(process.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY === "true" ? { retry: {
      invoiceStore: createExactInvoiceStore(admin), creditStore: createExactReceiptCreditStore(admin), retryStore: createExactPaymentRetryStore(admin),
    } } : {}) });
  }
  return Object.freeze({
    read: async (agreementId: string, buyerId: string) => (await controller(agreementId)).read(agreementId, buyerId),
    act: async (input: BuyerRecoveryInput, buyerId: string) => (await controller(input.agreementId)).act(input, buyerId),
  });
}
