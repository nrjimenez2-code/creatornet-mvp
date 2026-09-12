import "server-only";
import { randomUUID } from "node:crypto";
import { assertAgreementId, operationHash } from "./agreementStore";
import { assertExactInstallmentEnvironment } from "./checkoutPreparation";
import { verifyExactCardSetupSandbox, type ExactCardSetupStore } from "./cardRecovery";
import { reconcileExactRenewalReceiptSandbox, verifyExactRetryHistorySandbox, type ExactRenewalResult } from "./renewal";
import type { ExactPaymentRetryStore, ExactRetryAuthorization } from "./paymentRetryStore";

type ReceiptInput=Parameters<typeof reconcileExactRenewalReceiptSandbox>[0]&{retryStore:ExactPaymentRetryStore};
type Input=ReceiptInput&{quoteId:string;buyerId:string;cardStore:ExactCardSetupStore;
  stripe:ReceiptInput["stripe"]&Parameters<typeof verifyExactCardSetupSandbox>[0]["stripe"]};
function check(v:unknown):asserts v {if(!v) throw new Error("Installment retry needs reconciliation");}
function gate(args:ReceiptInput) {
  assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  check([args.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY,args.env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY,
    args.env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY].every(v=>v==="true"));
  assertAgreementId(args.agreementId);check(/^in_[a-zA-Z0-9]+$/.test(args.invoiceId));
}
async function bound(args:ReceiptInput,r:ExactRetryAuthorization) {
  const a=await args.store.load(args.agreementId);
  assertExactInstallmentEnvironment(args.env,a.terms.previewOrigin);
  check(r.agreementId===a.id&&r.buyerId===a.terms.buyerId&&r.authorization.invoiceId===args.invoiceId&&
    a.customerId===r.authorization.customerId&&a.subscriptionId===r.authorization.subscriptionId);
  const original=await args.invoiceStore.claim(a.id,args.invoiceId,r.authorization.subscriptionId,
    r.authorization.periodStart,r.authorization.periodEnd,randomUUID());
  check(original.status==="reconcile"&&original.paymentIntentId===r.originalPaymentIntentId&&
    operationHash(original.authorization)===operationHash(r.authorization));
}

/** Read-only Stripe reconciliation. A new card is accepted ONLY when its own
 * durable admission and original immutable claim match. Never adopts a manual
 * Dashboard payment as authorization and never opens another payment attempt. */
export async function reconcileExactRetryReceiptSandbox(args:ReceiptInput):Promise<ExactRenewalResult> {
  try {
    gate(args);const r=await args.retryStore.find(args.agreementId,args.invoiceId);
    check(r&&r.admittedAt!==null&&r.admittedAt<=(args.now??(()=>Math.floor(Date.now()/1000)))());await bound(args,r);
    return await reconcileExactRenewalReceiptSandbox({...args,minimumChargeCreatedAt:r.admittedAt,
      invoiceStore:{...args.invoiceStore,recordReceipt:async(agreementId,receipt)=>{
        check(agreementId===r.agreementId);return args.retryStore.recordReceipt(r.id,receipt);
      }}}, {...r.authorization,paymentMethodId:r.replacementPaymentMethodId},r.originalPaymentIntentId);
  } catch {throw new Error("Installment retry captured-payment reconciliation unavailable");}
}

/** Gated Sandbox candidate. Call only from a trusted authenticated buyer's
 * explicit confirmation action, never a GET, refresh, webhook or worker.
 * Admission consumes exactly one on-session invoice.pay request. Unknown
 * results, SCA, declines and all replays reconcile; no automatic second attempt.
 * Subscription defaults, the original card and all future-collection holds
 * remain unchanged. The client-side bank challenge is a separate release gate. */
export async function collectExactBuyerRetrySandbox(args:Input):Promise<ExactRenewalResult> {
  try {
    gate(args);assertAgreementId(args.quoteId);assertAgreementId(args.buyerId);
    const r=await args.retryStore.load(args.quoteId,args.agreementId,args.buyerId);
    check(r.id===args.quoteId&&r.agreementId===args.agreementId&&r.buyerId===args.buyerId);await bound(args,r);
    if(r.admittedAt!==null) return await reconcileExactRetryReceiptSandbox(args);
    check(args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_BUYER_RETRY==="true");
    const now=()=> (args.now??(()=>Math.floor(Date.now()/1000)))();
    check(r.confirmedAt<=now()&&now()<r.expiresAt);
    const cardArgs={requestId:r.setupId,buyerId:args.buyerId,store:args.cardStore,agreementStore:args.store,
      stripe:args.stripe,env:args.env,now:args.now};
    async function verifyCard() {
      const s=await args.cardStore.current(r.setupId,args.buyerId);
      check(s.agreementId===r.agreementId&&s.invoiceId===args.invoiceId&&s.originalPaymentIntentId===r.originalPaymentIntentId&&
        s.setupIntentId===r.setupIntentId&&s.paymentMethodId===r.replacementPaymentMethodId&&
        operationHash(s.authorization)===operationHash(r.authorization));
      check((await verifyExactCardSetupSandbox(cardArgs)).status==="card_saved_payment_not_attempted");
    }
    await verifyCard();
    // Reuse every prior-payment/refund/dispute/default check. Replacement card
    // ownership was separately verified above; original defaults are NOT edited.
    await verifyExactRetryHistorySandbox(args,r.authorization);
    await verifyCard();
    check(now()<r.expiresAt);
    const admitted=await args.retryStore.admit(r.id,args.buyerId);
    if(admitted) {
      // An uncertain RPC acknowledgement throws above: NO call is made. A
      // later lookup sees the consumed admission and can only reconcile.
      try {
        await args.stripe.invoices.pay(args.invoiceId,{payment_method:r.replacementPaymentMethodId,off_session:false},
          {idempotencyKey:`exact-buyer-retry:${r.id}:v1`,maxNetworkRetries:0});
      } catch { /* Never expose provider errors, or infer that retrying is safe. */ }
    }
    return await reconcileExactRetryReceiptSandbox(args);
  } catch {throw new Error("Installment retry needs review; do not repeat the payment request");}
}
