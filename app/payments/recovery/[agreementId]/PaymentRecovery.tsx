"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { completeBankVerification } from "@/lib/installments/bankVerificationClient";
import { CARD_SETUP_CONSENT_TEXT, CARD_SETUP_CONSENT_VERSION, RETRY_CONSENT_VERSION, PAY_NOW_CONSENT_VERSION, retryConsentText,
  FUTURE_CARD_CONSENT_TEXT,FUTURE_CARD_CONSENT_VERSION,type BuyerPaymentQuote, type BuyerRecoveryView } from "@/lib/installments/buyerRecoveryView";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const primary = "min-h-11 rounded-xl bg-[#7250df] px-5 py-3 font-semibold text-white transition hover:bg-[#8362e8] disabled:cursor-not-allowed disabled:opacity-40";
const secondary = "min-h-11 rounded-xl border border-white/20 px-5 py-3 text-sm text-white hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40";
const statusCopy: Record<string, string> = {
  action_required: "Your bank requires verification. No payment is confirmed yet. Use the secure verification step if available, or contact support.",
  payment_method_required: "The installment was not paid. You can review the available recovery steps below.",
  payment_pending: "The payment outcome is pending. Do not submit another payment while it is being checked.",
  terminal_unpaid: "This installment needs support review before any further payment attempt.",
  paid_accounted: "This installment payment has been verified and recorded. Future billing remains under review.",
  review_required: "Your payment needs support review. No payment retry is available here.",
};

/** No mount/redirect-triggered mutation. Each action requires a deliberate click,
 * stable request identity, and a new checkbox for actual payment consent. */
export function PaymentRecovery({ initial }: { initial: BuyerRecoveryView }) {
  const [view, setView] = useState(initial);
  const [quote, setQuote] = useState<BuyerPaymentQuote | null>(null);
  const [cardAccepted, setCardAccepted] = useState(false);
  const [paymentAccepted, setPaymentAccepted] = useState(false);
  const [futureCardAccepted,setFutureCardAccepted]=useState(false);
  const [bankAccepted, setBankAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const [time, setTime] = useState(() => Math.floor(Date.now() / 1000));
  const lock = useRef(false), setupId = useRef<string | null>(initial.setupRequestId), quoteId = useRef<string | null>(null);
  useEffect(() => {
    if (!quote) return;
    const timer = window.setInterval(() => setTime(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [quote]);
  const confirmed = Boolean(view.confirmedQuoteId || quote?.confirmed);
  const disabled = busy || uncertain || confirmed;

  async function bankAction(verify: boolean) {
    if (lock.current || verify && (uncertain || !bankAccepted || !view.canVerifyBank) || !verify && !view.canCheckBankPayment) return;
    lock.current = true; setBusy(true); setMessage(verify ? "Opening secure bank verification…" : "Checking the payment receipt…");
    setBankAccepted(false);
    const post = async (action: string) => {
      const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 65000);
      try {
        const response = await fetch("/api/installments/recovery", { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agreementId: view.agreementId, action }), signal: controller.signal });
        if (!response.ok) throw new Error("Review required"); return await response.json();
      } finally { window.clearTimeout(timer); }
    };
    try {
      if (verify) {
        const challenge = await post("verify_bank");
        if (challenge.status !== "bank_verification_ready" || challenge.amountCents !== view.amountCents ||
          challenge.paymentNumber !== view.paymentNumber || typeof challenge.publishableKey !== "string" || typeof challenge.clientSecret !== "string")
          throw new Error("Invalid bank review");
        // No mount effect, redirect handler, or refresh opens the bank challenge.
        await completeBankVerification(challenge.publishableKey, challenge.clientSecret);
      }
      const receipt = await post("check_bank_payment");
      if (receipt.status !== "bank_payment_checked" || !["paid_accounted", "review_required"].includes(receipt.outcome))
        throw new Error("Receipt unavailable");
      setUncertain(true); // Refresh before offering any additional bank action.
      if (receipt.outcome === "paid_accounted") {
        setView(current => ({ ...current, outcome: "paid_accounted", canVerifyBank: false, canAttemptPayment: false,
          canConfirmPayment: false, canSaveCard: false, setupEligible: false }));
        setMessage("Your installment payment has been verified and recorded. Future billing remains under review.");
      } else setMessage("Payment is not yet verified. No new payment request was sent. Refresh records or contact support before continuing.");
    } catch {
      setUncertain(true);
      setMessage("We could not verify the payment result. Check payment receipt or contact support. Do not submit another payment.");
    } finally { lock.current = false; setBusy(false); }
  }

  async function request(action: "refresh" | "save_card" | "verify_card" | "review_payment" | "confirm_payment") {
    if (lock.current || action !== "refresh" && disabled) return;
    if (action === "save_card" && (!cardAccepted || !view.canSaveCard) ||
      action === "confirm_payment" && (!paymentAccepted || !view.canConfirmPayment || !quote || quote.expiresAt <= Date.now() / 1000)) return;
    lock.current = true; setBusy(true); setMessage("");
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 65000);
    const expectedConsent = action === "review_payment" ? (view.canAttemptPayment ? PAY_NOW_CONSENT_VERSION : RETRY_CONSENT_VERSION) :
      quote?.consentVersion === PAY_NOW_CONSENT_VERSION ? PAY_NOW_CONSENT_VERSION : RETRY_CONSENT_VERSION;
    try {
      let response: Response;
      if (action === "refresh") {
        response = await fetch(`/api/installments/recovery?agreementId=${encodeURIComponent(view.agreementId)}`,
          { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      } else {
        const body: Record<string, unknown> = { agreementId: view.agreementId, action };
        if (action === "save_card") {
          setupId.current ||= view.setupRequestId || crypto.randomUUID();
          Object.assign(body, { requestId: setupId.current, accepted: true, consentVersion: CARD_SETUP_CONSENT_VERSION });
        }
        if (action === "review_payment") {
          if (quote && quote.expiresAt <= Date.now() / 1000) quoteId.current = null;
          quoteId.current ||= crypto.randomUUID(); Object.assign(body, { quoteId: quoteId.current,
            action: expectedConsent === PAY_NOW_CONSENT_VERSION ? "review_pay_now" : "review_payment" });
        }
        if (action === "confirm_payment") Object.assign(body, { quoteId: quote!.id, accepted: true, consentVersion: expectedConsent,
          action: expectedConsent === PAY_NOW_CONSENT_VERSION ? "pay_now" : "confirm_payment",
          ...(expectedConsent===PAY_NOW_CONSENT_VERSION && quote?.remainingPayments && futureCardAccepted ?
            {futureCardConsentVersion:FUTURE_CARD_CONSENT_VERSION} : {}) });
        response = await fetch("/api/installments/recovery", { method: "POST", headers: { "Content-Type": "application/json" },
          credentials: "same-origin", cache: "no-store", body: JSON.stringify(body), signal: controller.signal });
      }
      if (!response.ok) throw new Error("Review required");
      const result = await response.json();
      if (action === "refresh") {
        if (!result.view || result.view.agreementId !== view.agreementId) throw new Error("Invalid recovery view");
        setView(result.view); setupId.current = result.view.setupRequestId || setupId.current;
        // A successful owner-scoped refresh reveals any recorded confirmation.
        // A new REVIEW is harmless; the database admits only one confirmation.
        // This also recovers from a lost/expired review response, not a payment.
        quoteId.current = null;
        setQuote(null); setCardAccepted(false); setPaymentAccepted(false); setBankAccepted(false); setFutureCardAccepted(false); setUncertain(false);
        setMessage("Payment records refreshed. No payment request was sent.");
      } else if (result.status === "card_setup_ready" && action === "save_card") {
        const url = new URL(result.url);
        if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password || url.port || !url.pathname.startsWith("/c/"))
          throw new Error("Invalid card setup destination");
        window.location.assign(url.href);
      } else if (result.status === "card_saved_payment_not_attempted" && action === "verify_card") {
        setMessage("Your replacement card is saved. No payment has been attempted. Refresh records to review the next step.");
        setUncertain(true);
      } else if (result.status === "setup_pending" && action === "verify_card") {
        setMessage("Card setup is not complete. No payment has been attempted.");
      } else if ((result.status === "payment_review_ready" && action === "review_payment") ||
        (["payment_confirmation_recorded", "payment_attempt_checked"].includes(result.status) && action === "confirm_payment")) {
        const q = result.quote as BuyerPaymentQuote;
        if (!q || q.id !== quoteId.current || q.amountCents !== view.amountCents || q.paymentNumber !== view.paymentNumber ||
          q.paymentCount !== view.paymentCount || !Number.isSafeInteger(q.expiresAt) || typeof q.confirmed !== "boolean" ||
          q.confirmed !== (action === "confirm_payment") || (q.consentVersion || RETRY_CONSENT_VERSION) !== expectedConsent ||
          result.status === "payment_attempt_checked" && (expectedConsent !== PAY_NOW_CONSENT_VERSION ||
            !["paid_accounted", "review_required"].includes(result.outcome)) ||
          result.status === "payment_confirmation_recorded" && expectedConsent !== RETRY_CONSENT_VERSION) throw new Error("Invalid payment review");
        if(q.remainingPayments) {
          if(expectedConsent!==PAY_NOW_CONSENT_VERSION || !Array.isArray(q.remainingPayments) ||
            q.remainingPayments.length!==q.paymentCount-q.paymentNumber || !q.remainingPayments.length ||
            q.remainingPayments.some((p,i)=>p.paymentNumber!==q.paymentNumber+i+1 || !Number.isSafeInteger(p.amountCents) || p.amountCents<=0 ||
              !Number.isSafeInteger(p.dueAt) || !Number.isSafeInteger(p.periodEnd) || p.dueAt>=p.periodEnd) ||
            action==="confirm_payment" && (q.futureCardAccepted!==futureCardAccepted || JSON.stringify(q.remainingPayments)!==JSON.stringify(quote?.remainingPayments)))
            throw new Error("Invalid remaining payment review");
        } else if(action==="confirm_payment" && quote?.remainingPayments) throw new Error("Future card review missing");
        setTime(Math.floor(Date.now() / 1000)); setQuote(q); setPaymentAccepted(false); setFutureCardAccepted(false);
        if (result.status === "payment_attempt_checked") {
          setView(current => ({ ...current, confirmedQuoteId: q.id, canAttemptPayment: false, canConfirmPayment: false, setupEligible: false,
            ...(q.futureCardAccepted!==undefined ? {futureCardAccepted:q.futureCardAccepted} : {}),
            ...(result.outcome === "paid_accounted" ? { outcome: "paid_accounted" } : {}) }));
          setMessage(result.outcome === "paid_accounted" ? (q.futureCardAccepted ?
            "Your installment payment has been verified and recorded. Your separate card authorization is saved for the remaining scheduled payments on this plan, subject to account checks." :
            "Your installment payment has been verified and recorded. Future billing remains under review.") :
            "Your payment attempt needs verification. Do not submit another payment. Refresh records for its status.");
        } else if (q.confirmed) setMessage("Your confirmation is recorded. This is not a payment receipt. Collection has not been restarted.");
      } else throw new Error("Unexpected payment status");
    } catch {
      setUncertain(true); setPaymentAccepted(false); setFutureCardAccepted(false);
      setMessage("We could not confirm this request’s result. Refresh records before continuing. Do not submit another payment or change cards while the result is uncertain.");
    } finally { window.clearTimeout(timeout); lock.current = false; setBusy(false); }
  }

  return <main className="min-h-screen bg-black px-5 py-8 text-white sm:px-8 sm:py-12">
    <div className="mx-auto max-w-2xl">
      <Link href="/library" className="inline-flex min-h-11 items-center gap-2 text-sm text-gray-300 hover:text-white">← Back to library</Link>
      <header className="mb-7 mt-6">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#b6a0ff]">CreatorNet · Staging payment review</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-normal">Review your installment</h1>
        <p className="mt-3 text-sm leading-6 text-gray-400">Save a card, review the amount, then confirm separately. Your original plan total stays the same.</p>
      </header>
      <section aria-label="Installment details" className="rounded-2xl border border-white/15 bg-[#111014] p-5 sm:p-6">
        <h2 className="break-words text-lg font-semibold">{view.title}</h2>
        <div className="mt-5 flex flex-wrap justify-between gap-5">
          <div><p className="text-sm text-gray-400">{view.paymentNumber ? `Installment ${view.paymentNumber} of ${view.paymentCount}` : "Installment status"}</p>
            <p className="mt-1 text-3xl font-semibold">{view.amountCents === null ? "Under review" : money(view.amountCents)}</p></div>
          <div><p className="text-sm text-gray-400">Original plan total</p><p className="mt-2 text-lg">{money(view.totalCents)}</p></div>
        </div>
        <p className="mt-5 border-t border-white/10 pt-4 text-sm leading-6 text-gray-300">
          {view.outcome === "paid_accounted" ? statusCopy.paid_accounted : view.outcome === "action_required" ? statusCopy.action_required :
            confirmed ? "Your payment confirmation is recorded. This is not a payment receipt. Collection remains paused." :
            statusCopy[view.outcome || ""] || "No payment recovery action is available for this plan."}</p>
      </section>
      {view.futureCardAccepted===true && <p className="mt-4 text-sm leading-6 text-[#c5b4ff]">Your separate card authorization is recorded for the remaining installments on this plan only. Future collection requires this payment to be verified and the account checks to pass; the original amounts and dates do not change.</p>}
      {!confirmed && view.outcome === "payment_method_required" && <section aria-label="Recovery steps" className="mt-5 space-y-5 rounded-2xl border border-white/15 p-5 sm:p-6">
        <div>
          <h2 className="font-semibold">1. Save a replacement card</h2>
          {view.setupState === "verified" ? <p className="mt-2 text-sm text-[#c5b4ff]">Card verified. Saving it did not make a payment.</p> : <>
            <p className="mt-2 text-sm leading-6 text-gray-400">Card details are entered securely on Stripe, not on this page.</p>
            <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6 text-gray-300">
              <input type="checkbox" checked={cardAccepted} disabled={disabled || !view.canSaveCard} onChange={e => setCardAccepted(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#9370DB]" />
              <span>{CARD_SETUP_CONSENT_TEXT}</span>
            </label>
            <button className={`${primary} mt-4`} disabled={disabled || !view.canSaveCard || !cardAccepted} onClick={() => void request("save_card")}>Continue to secure card setup</button>
            {view.setupState === "started" && <button className={`${secondary} mt-3 sm:ml-3`} disabled={disabled || !view.setupEligible} onClick={() => void request("verify_card")}>Check saved card</button>}
          </>}
        </div>
        <div className="border-t border-white/10 pt-5">
          <h2 className="font-semibold">2. Review the payment</h2>
          <p className="mt-2 text-sm leading-6 text-gray-400">Reviewing does not charge your card. A payment review expires after at most five minutes.</p>
          <button className={`${secondary} mt-4`} disabled={disabled || !view.canConfirmPayment} onClick={() => void request("review_payment")}>Review installment amount</button>
        </div>
        {quote && !quote.confirmed && <div className="border-t border-white/10 pt-5">
          <h2 className="font-semibold">3. Confirm {money(quote.amountCents)}</h2>
          <p className="mt-2 text-sm text-gray-400">Installment {quote.paymentNumber} of {quote.paymentCount}. No extra buyer fee is added.</p>
          {quote.expiresAt <= time ? <p role="status" className="mt-3 text-sm text-amber-200">This review expired. Review the installment amount again before confirming.</p> : <>
            <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6 text-gray-300">
              <input type="checkbox" checked={paymentAccepted} disabled={disabled} onChange={e => setPaymentAccepted(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#9370DB]" />
              <span>{retryConsentText(money(quote.amountCents),Boolean(quote.remainingPayments))}</span>
            </label>
            {quote.consentVersion===PAY_NOW_CONSENT_VERSION && quote.remainingPayments && <div className="mt-5 rounded-xl border border-white/15 bg-white/[0.03] p-4">
              <h3 className="text-sm font-semibold">Card for your remaining installments</h3>
              <ul className="mt-3 space-y-2 text-sm text-gray-300" aria-label="Remaining scheduled payments">
                {quote.remainingPayments.map(p=><li key={p.paymentNumber} className="flex flex-wrap justify-between gap-2">
                  <span>Installment {p.paymentNumber} · {new Date(p.dueAt*1000).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"})} (UTC)</span>
                  <span>{money(p.amountCents)}</span></li>)}
              </ul>
              <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6 text-gray-300">
                <input type="checkbox" checked={futureCardAccepted} disabled={disabled} onChange={e=>setFutureCardAccepted(e.target.checked)}
                  className="mt-1 h-5 w-5 shrink-0 accent-[#9370DB]" />
                <span>{FUTURE_CARD_CONSENT_TEXT}</span>
              </label>
              <p className="mt-3 text-xs leading-5 text-gray-400">Leave unchecked to use this card for the payment above only. Future collection stays paused for review; the remaining balance is not waived.</p>
            </div>}
            <p className="mt-3 text-xs leading-5 text-gray-400">{quote.consentVersion === PAY_NOW_CONSENT_VERSION ?
              (quote.remainingPayments ? "Pay submits only the installment shown above. Your bank may require verification. Any future payments remain on the original schedule and require the separate option and account checks." :
              "This sends one payment attempt using your saved card. Your bank may require verification. Future automatic collection stays paused.") :
              "Staging review: this version records your confirmation only. It does not yet submit the payment."}</p>
            <button className={`${primary} mt-4`} disabled={disabled || !paymentAccepted || !view.canConfirmPayment} onClick={() => void request("confirm_payment")}>
              {quote.consentVersion === PAY_NOW_CONSENT_VERSION ? `Pay ${money(quote.amountCents)}` : "Confirm payment request"}</button>
          </>}
        </div>}
        {!view.setupEligible && <p className="text-sm leading-6 text-gray-400">Recovery is currently on hold. Contact support before attempting another payment.</p>}
      </section>}
      {view.canVerifyBank && view.amountCents !== null && <section aria-label="Bank verification" className="mt-5 rounded-2xl border border-white/15 p-5 sm:p-6">
        <h2 className="font-semibold">Verify with your bank</h2>
        <p className="mt-2 text-sm leading-6 text-gray-400">Stripe will open your bank’s secure verification for this existing installment payment. It does not create a second charge or restart future automatic payments.</p>
        <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6 text-gray-300">
          <input type="checkbox" checked={bankAccepted} disabled={busy || uncertain} onChange={e => setBankAccepted(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#9370DB]" />
          <span>Continue bank verification for my existing {money(view.amountCents)} installment payment. Completing verification may finish this payment.</span>
        </label>
        <button className={`${primary} mt-4`} disabled={busy || uncertain || !bankAccepted} onClick={() => void bankAction(true)}>Verify {money(view.amountCents)} with bank</button>
      </section>}
      <div aria-live="polite" aria-atomic="true" className="mt-5 text-sm leading-6 text-[#d2c5ff]">{busy ? message || "Checking securely…" : message}</div>
      <footer className="mt-6 flex flex-wrap items-center gap-5 text-sm">
        <button className={secondary} disabled={busy} onClick={() => void request("refresh")}>Refresh records</button>
        {view.canCheckBankPayment && view.outcome !== "paid_accounted" && <button className={secondary} disabled={busy} onClick={() => void bankAction(false)}>Check payment receipt</button>}
        <a href="mailto:support@creatornet.net" className="inline-flex min-h-11 items-center text-gray-300 underline underline-offset-4">Contact support</a>
      </footer>
    </div>
  </main>;
}
