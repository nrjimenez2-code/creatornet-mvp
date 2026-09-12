"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import MonthlyBankVerification from "@/components/MonthlyBankVerification";
import { useSearchParams } from "next/navigation";
import { MONTHLY_CARD_SETUP_CONSENT_TEXT, MONTHLY_CARD_SETUP_CONSENT_VERSION } from "@/lib/membershipCardSetupConsent";
import type { MembershipRenewalRecoveryResult } from "@/lib/membershipRenewalRecovery";
type State = { membershipId: string; renewal: MembershipRenewalRecoveryResult | null;
  setup: { id: string; status: "setup_pending" | "card_saved_payment_not_attempted" | "retry_requested" } | null };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const messages: Record<MembershipRenewalRecoveryResult["outcome"], string> = {
  payment_method_required: "The original monthly payment needs a card. Saving a card below will not retry the payment.",
  action_required: "Your bank requires authentication for the original payment. Contact support if an authentication option is not available.",
  payment_pending: "The original payment is pending. Do not start another payment or purchase.",
  terminal_unpaid: "The original attempt was canceled. This does not waive any agreed balance. Contact support to review recovery.",
  paid_accounted: "The original payment has been recorded through the existing payment ledger.",
  review_required: "This payment needs support review. No automatic catch-up charge or new payment has been authorized.",
};
async function request(id: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch("/api/memberships/" + id + "/renewal-recovery", { method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Error(typeof value?.error === "string" ? value.error : "Monthly recovery needs review.");
  if (value?.membershipId !== id) throw Error("Monthly recovery ownership differs.");
  return value;
}
function state(value: State, id: string): State {
  if (value.membershipId !== id || value.renewal !== null && (!value.renewal || value.renewal.membershipId !== id ||
    !Object.hasOwn(messages, value.renewal.outcome) || !/^in_[A-Za-z0-9]+$/.test(value.renewal.invoiceId) ||
    !Number.isSafeInteger(value.renewal.month) || value.renewal.month < 2 ||
    !Number.isSafeInteger(value.renewal.amountCents) || value.renewal.amountCents < 50 ||
    !Number.isSafeInteger(value.renewal.periodStart) || !Number.isSafeInteger(value.renewal.periodEnd) ||
    value.renewal.periodEnd <= value.renewal.periodStart) ||
    value.setup !== null && (!value.setup || !uuid.test(value.setup.id) || !["setup_pending", "card_saved_payment_not_attempted", "retry_requested"].includes(value.setup.status)))
    throw Error("Monthly recovery evidence needs review.");
  return value;
}
function RecoveryPanel({ id }: { id: string }) {
  const [attempt, setAttempt] = useState(0), [accepted, setAccepted] = useState(false), [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<{ attempt: number; value?: State; error?: string } | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const current = loaded?.attempt === attempt ? loaded : null, value = current?.value;
  useEffect(() => {
    if (!uuid.test(id)) return;
    const controller = new AbortController();
    void request(id, { action: "status" }, controller.signal).then(body => { if (!controller.signal.aborted) setLoaded({ attempt, value: state(body, id) }); })
      .catch(error => { if (!controller.signal.aborted) setLoaded({ attempt, error: error instanceof Error ? error.message : "Recovery needs retry." }); });
    return () => controller.abort();
  }, [id, attempt]);
  async function act(action: "setup" | "verify") {
    if (busy || action === "setup" && !accepted || action === "verify" && !value?.setup) return;
    setBusy(true); setDestination(null);
    try {
      const result = await request(id, action === "setup" ? { action, accepted: true, consentVersion: MONTHLY_CARD_SETUP_CONSENT_VERSION } :
        { action, setupId: value!.setup!.id });
      if (!uuid.test(result.setupId) || !["setup_pending", "card_saved_payment_not_attempted"].includes(result.status) ||
        action === "verify" && result.setupId !== value!.setup!.id) throw Error("Saved-card evidence differs.");
      const next = state(await request(id, { action: "status" }), id);
      if (result.url) {
        const url = new URL(result.url);
        if (action !== "setup" || result.status !== "setup_pending" || url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" ||
          url.username || url.password || url.port || !url.pathname.startsWith("/c/")) throw Error("Invalid secure card setup destination.");
        if (next.renewal?.outcome === "payment_method_required" && next.setup?.id === result.setupId) setDestination(url.href);
      }
      setLoaded({ attempt, value: next });
    } catch (error) { setLoaded({ attempt, error: error instanceof Error ? error.message : "Card setup needs retry." }); }
    finally { setBusy(false); setAccepted(false); }
  }
  return <main className="mx-auto max-w-2xl space-y-6 px-4 py-10 text-white">
    <Link href="/memberships" className="text-sm underline">Back to monthly mentorships</Link>
    <h1 className="text-3xl font-semibold">Recover a monthly payment</h1>
    <p className="text-sm text-white/65">Check the original renewal or securely save a card. These actions do not change your minimum, service dates or balance, and do not authorize a payment retry.</p>
    {!uuid.test(id) ? <p role="alert">Select an owned membership to recover.</p> : !current ? <p role="status">Checking the original payment...</p> :
      current.error ? <p role="alert">{current.error}</p> : value && <section className="space-y-4 rounded-2xl border border-white/20 p-5">
        {!value.renewal ? <p role="status">No original renewal attempt is currently available for recovery. This does not cancel your mentorship or waive a balance.</p> : <>
          <h2 className="text-xl font-semibold">Month {value.renewal.month}</h2>
          <p>{new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value.renewal.amountCents / 100)} for the original service period:
            {" "}{new Date(value.renewal.periodStart * 1000).toLocaleDateString()} to {new Date(value.renewal.periodEnd * 1000).toLocaleDateString()}.</p>
          <p role="status">{messages[value.renewal.outcome]}</p>
          {value.renewal.outcome === "action_required" && <MonthlyBankVerification key={value.renewal.invoiceId} payment={value.renewal}
            onChecked={renewal => setLoaded({ attempt, value: { ...value, renewal } })} />}
          {value.setup?.status === "retry_requested" ? <p role="status">A retry has already been requested for this original payment. Check its result below; do not start another payment.</p> : value.setup?.status === "card_saved_payment_not_attempted" ? <p role="status">Card saved and verified. No payment was attempted. A payment retry and use for future charges need a separate confirmation; contact support if that option is unavailable.</p> :
            value.renewal.outcome === "payment_method_required" && <>
              <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={accepted} disabled={busy}
                onChange={event => setAccepted(event.target.checked)} className="mt-1" /><span>{MONTHLY_CARD_SETUP_CONSENT_TEXT}</span></label>
              <button disabled={busy || !accepted} onClick={() => void act("setup")} className="rounded-lg bg-white px-4 py-3 font-semibold text-black disabled:opacity-40">
                {busy ? "Checking secure setup..." : "Prepare secure card setup"}</button>
            </>}
          {value.setup && ["card_saved_payment_not_attempted", "retry_requested"].includes(value.setup.status) &&
            <Link href={"/memberships/renewal-retry?membership_id=" + id + "&setup_id=" + value.setup.id} className="block underline">
              {value.setup.status === "retry_requested" ? "Check the original retry" : "Review a separate payment retry"}</Link>}
          {destination && <a href={destination} className="block underline">Continue to Stripe to save a card only</a>}
          {value.setup?.status === "setup_pending" && <button disabled={busy} onClick={() => void act("verify")} className="block text-sm underline disabled:opacity-40">Check saved card</button>}
        </>}
      </section>}
    {uuid.test(id) && <button disabled={busy} onClick={() => { setAccepted(false); setDestination(null); setAttempt(n => n + 1); }} className="text-sm underline disabled:opacity-40">Check payment status again</button>}
    <p className="text-sm text-white/65">Contact <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a> with membership reference {uuid.test(id) ? id : "not selected"} for review.</p>
  </main>;
}
function Content() { const params = useSearchParams(), id = params.get("membership_id") || ""; return <RecoveryPanel key={id} id={id} />; }
export default function MonthlyRenewalRecoveryPage() { return <Suspense fallback={<p className="p-8 text-white">Loading payment recovery...</p>}><Content /></Suspense>; }
