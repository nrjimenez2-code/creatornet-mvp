"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import MonthlyBankVerification from "@/components/MonthlyBankVerification";
import { useSearchParams } from "next/navigation";
import { MONTHLY_RETRY_CONSENT_TEXT, MONTHLY_RETRY_CONSENT_VERSION, MONTHLY_FUTURE_CARD_CONSENT_TEXT,
  MONTHLY_FUTURE_CARD_CONSENT_VERSION, type MonthlyRetryQuote } from "@/lib/membershipRetryConsent";
import type { MembershipRenewalRecoveryResult } from "@/lib/membershipRenewalRecovery";
type View = { membershipId: string; quote: MonthlyRetryQuote; confirmed: boolean; useFutureCard: boolean | null;
  retryRequested: boolean; renewal?: MembershipRenewalRecoveryResult };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const messages: Record<MembershipRenewalRecoveryResult["outcome"], string> = {
  paid_accounted: "Payment recorded for the original service period through the existing payment ledger.",
  payment_method_required: "The original monthly payment is still unpaid. Only an explicitly confirmed retry below can attempt payment.",
  action_required: "Your bank requires authentication for this original payment. Contact support if bank verification is not available. Do not start another purchase.",
  payment_pending: "The original payment is pending. Checking status will not send another payment.",
  terminal_unpaid: "The original payment was canceled and needs support review. This does not waive an agreed balance.",
  review_required: "The original retry needs support review. No additional retry will be sent from this screen.",
};
function read(value: View, id: string, setup: string): View {
  const q = value?.quote, r = value?.renewal;
  if (value?.membershipId !== id || !q || !uuid.test(q.id) || q.membershipId !== id || q.setupId !== setup ||
    q.version !== "monthly-retry-quote-v1" || typeof q.title !== "string" || q.currency !== "usd" ||
    !Number.isSafeInteger(q.amountCents) || q.amountCents < 50 || !Number.isSafeInteger(q.month) || q.month < 2 ||
    !Number.isSafeInteger(q.minimumMonths) || q.minimumMonths < 1 || !Number.isSafeInteger(q.periodStart) ||
    !Number.isSafeInteger(q.periodEnd) || q.periodEnd <= q.periodStart || !Number.isSafeInteger(q.expiresAt) || q.expiresAt > q.periodEnd ||
    typeof q.autoRenew !== "boolean" || q.canUseForFuture !== (q.autoRenew || q.month < q.minimumMonths) ||
    q.consentVersion !== MONTHLY_RETRY_CONSENT_VERSION || q.consentText !== MONTHLY_RETRY_CONSENT_TEXT ||
    q.futureConsentVersion !== MONTHLY_FUTURE_CARD_CONSENT_VERSION || q.futureConsentText !== MONTHLY_FUTURE_CARD_CONSENT_TEXT ||
    typeof value.confirmed !== "boolean" || typeof value.retryRequested !== "boolean" ||
    (value.confirmed ? typeof value.useFutureCard !== "boolean" : value.useFutureCard !== null || value.retryRequested) ||
    (value.useFutureCard && !q.canUseForFuture) ||
    (r && (r.membershipId !== id || r.month !== q.month || r.amountCents !== q.amountCents ||
      r.periodStart !== q.periodStart || r.periodEnd !== q.periodEnd || !Object.hasOwn(messages, r.outcome))))
    throw Error("The original monthly retry evidence needs review.");
  return value;
}
async function request(id: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<View> {
  const response = await fetch("/api/memberships/" + id + "/renewal-retry", { method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Error(typeof value?.error === "string" ? value.error : "Check the original retry status before taking further action.");
  return value;
}
function Panel({ id, setup }: { id: string; setup: string }) {
  const [value, setValue] = useState<View | null>(null), [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false), [future, setFuture] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [attempt, setAttempt] = useState(0), valid = uuid.test(id) && uuid.test(setup);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const expiry = value?.quote.expiresAt;
  useEffect(() => {
    if (!expiry || expiry <= now) return;
    const timer = setTimeout(() => setNow(Math.floor(Date.now() / 1000)), Math.max(0, expiry * 1000 - Date.now()) + 10);
    return () => clearTimeout(timer);
  }, [expiry, now]);
  useEffect(() => {
    if (!valid) return; const controller = new AbortController();
    void request(id, { action: "review", setupId: setup }, controller.signal).then(body => {
      if (controller.signal.aborted) return; const next = read(body, id, setup); setValue(next); setError(null);
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Retry review is unavailable."); });
    return () => controller.abort();
  }, [id, setup, valid, attempt]);
  async function act(pay: boolean) {
    if (!value || busy || pay && (!accepted || uncertain || value.retryRequested || value.quote.expiresAt <= Math.floor(Date.now() / 1000))) return;
    setBusy(true); setError(null);
    const useFutureCard = value.confirmed ? value.useFutureCard! : future;
    try {
      const next = read(await request(id, pay ? { action: "pay", quoteId: value.quote.id, accepted: true,
        consentVersion: MONTHLY_RETRY_CONSENT_VERSION, useFutureCard, futureConsentVersion: useFutureCard ? MONTHLY_FUTURE_CARD_CONSENT_VERSION : null } :
        { action: "status", quoteId: value.quote.id }), id, setup);
      if (next.quote.id !== value.quote.id) throw Error("The original retry identity changed.");
      setValue(next); setUncertain(false);
    } catch (e) { if (pay) setUncertain(true); setError(e instanceof Error ? e.message : "Check the original payment status before taking further action."); }
    finally { setBusy(false); setAccepted(false); setFuture(false); }
  }
  const q = value?.quote, eligible = value && !value.retryRequested && (!value.renewal || value.renewal.outcome === "payment_method_required");
  return <main className="mx-auto max-w-2xl space-y-6 px-4 py-10 text-white">
    <Link href={"/memberships/renewal-recovery?membership_id=" + id} className="text-sm underline">Back to payment recovery</Link>
    <h1 className="text-3xl font-semibold">Review one monthly payment retry</h1>
    <p className="text-sm text-white/65">This pays the original monthly amount for its original service dates. It does not restart your minimum or change any remaining balance.</p>
    {!valid ? <p role="alert">Select your owned membership and verified card setup.</p> : <>
      {error && <p role="alert">{error}</p>}
      {!value ? <>{!error && <p role="status">Loading the exact original retry...</p>}
        <button onClick={() => setAttempt(n => n + 1)} className="text-sm underline">Reload retry review</button></> : q && <>
        <section className="space-y-4 rounded-2xl border border-white/20 p-5">
          <h2 className="text-xl font-semibold">{q.title}: month {q.month}</h2>
          <p className="text-2xl font-semibold">{new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(q.amountCents / 100)}</p>
          <p>{new Date(q.periodStart * 1000).toLocaleDateString()} to {new Date(q.periodEnd * 1000).toLocaleDateString()}, the original service period.</p>
          <p className="text-sm">Minimum: {q.minimumMonths} month{q.minimumMonths === 1 ? "" : "s"}. {q.autoRenew ? "Renews monthly after the minimum." : "Does not renew after the agreed term."}</p>
          {value.renewal && <p role="status">{messages[value.renewal.outcome]}</p>}
          {value.renewal?.outcome === "action_required" && <MonthlyBankVerification key={value.renewal.invoiceId} payment={value.renewal}
            onChecked={renewal => setValue({ ...value, renewal })} />}
          {value.retryRequested && <p role="status">This retry has already been requested. Check its result; another payment will not be sent.</p>}
          {eligible && <>
            {q.expiresAt <= now ? <p role="status">This quote expired. Return to recovery for review; no new charge is authorized.</p> : <>
              {value.confirmed && <p className="text-sm">Your previously confirmed choice is preserved. The original attempt, not a new retry, will be continued.</p>}
              <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={accepted} disabled={busy || uncertain}
                onChange={e => setAccepted(e.target.checked)} className="mt-1" /><span>{MONTHLY_RETRY_CONSENT_TEXT}</span></label>
              {q.canUseForFuture && <label className="flex items-start gap-3 text-sm"><input type="checkbox"
                checked={value.confirmed ? value.useFutureCard! : future} disabled={busy || uncertain || value.confirmed}
                onChange={e => setFuture(e.target.checked)} className="mt-1" /><span>Optional: {MONTHLY_FUTURE_CARD_CONSENT_TEXT}</span></label>}
              <button disabled={busy || !accepted || uncertain} onClick={() => void act(true)}
                className="rounded-lg bg-white px-4 py-3 font-semibold text-black disabled:opacity-40">Confirm original payment retry</button>
            </>}
          </>}
          {uncertain && <p role="status">The result is uncertain. Check the original payment status before doing anything else.</p>}
          <button disabled={busy} onClick={() => void act(false)} className="block text-sm underline disabled:opacity-40">Check original payment status</button>
        </section>
      </>}
    </>}
    <p className="text-sm text-white/65">Support: <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a>. Saving a card alone never authorizes this retry or future-card changes.</p>
  </main>;
}
function Content() { const p = useSearchParams(), id = p.get("membership_id") || "", setup = p.get("setup_id") || ""; return <Panel key={id + ":" + setup} id={id} setup={setup} />; }
export default function MonthlyRenewalRetryPage() { return <Suspense fallback={<p className="p-8 text-white">Loading monthly retry...</p>}><Content /></Suspense>; }
