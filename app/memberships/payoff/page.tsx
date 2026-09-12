"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { MembershipPayoffTerms } from "@/lib/membershipPayoff";
type Quote = { terms: MembershipPayoffTerms; fingerprint: string; payoffId: string | null; status: string; checkoutEnabled?: boolean };
type Confirmation = { payoffId: string; payoffRecorded: boolean; accessGranted: boolean; paidThrough: number | null; providerStopped: boolean };
type View = { key: string; quote?: Quote; confirmation?: Confirmation; error?: string; abandoned?: boolean; mayResume?: boolean };
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function Payoff() {
  const search = useSearchParams(), membershipId = search.get("membership_id") || "", payoffId = search.get("payoff_id") || "";
  const confirm = search.get("confirm") === "1", [reload, setReload] = useState(0), key = JSON.stringify([membershipId, payoffId, confirm, reload]);
  const [view, setView] = useState<View | null>(null), [accepted, setAccepted] = useState(false), [abandonAccepted, setAbandonAccepted] = useState(false);
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState("");
  const endpoint = `/api/memberships/${membershipId}/payoff`;
  useEffect(() => {
    if (!uuid.test(membershipId) || confirm && !uuid.test(payoffId)) return;
    const controller = new AbortController();
    void fetch(endpoint, { credentials: "include", cache: "no-store", signal: controller.signal,
      ...(confirm ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm", payoff_id: payoffId }) } : {}) })
      .then(async response => { const body = await response.json(); if (!response.ok) throw Error(body.error || "Payoff needs review.");
        if (!controller.signal.aborted) { setView({ key, ...(confirm ? { confirmation: body } : { quote: body }) }); setAccepted(false); setAbandonAccepted(false); setActionError(""); } })
      .catch(error => { if (!controller.signal.aborted) setView({ key, error: error instanceof Error ? error.message : "Payoff needs review." }); });
    return () => controller.abort();
  }, [membershipId, payoffId, confirm, key, endpoint]);
  const current = view?.key === key ? view : null, q = current?.quote, t = q?.terms;
  function refresh() { setAccepted(false); setAbandonAccepted(false); setActionError(""); setReload(value => value + 1); }
  async function act(action: "checkout" | "abandon") {
    if (!q || busy || action === "checkout" && (!accepted || q.checkoutEnabled === false) || action === "abandon" && (!abandonAccepted || !q.payoffId)) return;
    setBusy(true); setActionError("");
    try {
      const payload = action === "checkout" ? { action, consent: { accepted: true, version: q.terms.version, fingerprint: q.fingerprint } } :
        { action, payoff_id: q.payoffId, confirmed: true };
      const response = await fetch(endpoint, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json(); if (!response.ok) throw Error(body.error || "Payoff action needs review.");
      if (action === "abandon") {
        if (body.status === "already_paid" && body.payoffRecorded === true) setView({ key, confirmation: body });
        else if (body.status === "abandoned") setView({ key, abandoned: true, mayResume: body.originalMonthlyPaymentsMayResume });
        else throw Error("Payoff abandonment was not confirmed.");
        setBusy(false); return;
      }
      if (typeof body.url !== "string") throw Error("Invalid checkout destination.");
      const url = new URL(body.url);
      if (url.username || url.password || !(url.protocol === "https:" && url.origin === "https://checkout.stripe.com" ||
        url.origin === window.location.origin && url.pathname === "/memberships/payoff")) throw Error("Invalid checkout destination.");
      window.location.assign(url.toString());
    } catch (error) { setActionError(error instanceof Error ? error.message : "Payoff action needs review."); setBusy(false); }
  }
  async function retryConfirmation() {
    const id = current?.confirmation?.payoffId || payoffId;
    if (busy || !uuid.test(id)) return;
    setBusy(true); setActionError("");
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", payoff_id: id }) });
      const body = await response.json();
      if (!response.ok || typeof body.payoffRecorded !== "boolean") throw Error(body.error || "Payoff confirmation needs review.");
      setView({ key, confirmation: body });
    } catch (error) { setActionError(error instanceof Error ? error.message : "Payoff confirmation needs review."); }
    finally { setBusy(false); }
  }
  const invalid = !uuid.test(membershipId) || confirm && !uuid.test(payoffId), result = current?.confirmation;
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <Link href="/dashboard" className="text-sm underline">Back to CreatorNet</Link>
    <h1 className="text-2xl font-semibold">Minimum-term payoff</h1>
    {invalid ? <p role="alert">Open the payoff from your owned membership.</p> : !current ? <p role="status">Loading your payoff...</p> :
      current.error ? <><p role="alert">{current.error}</p><button onClick={refresh} className="underline">{confirm ? "Retry confirmation" : "Reload payoff"}</button></> :
      current.abandoned ? <section className="space-y-3 rounded-xl border p-5">
        <h2 className="text-xl font-semibold">Payoff abandoned</h2><p>This did not cancel your membership or waive its agreed minimum.</p>
        <p>{current.mayResume === true ? "Your original monthly payments may resume on their agreed schedule." :
          current.mayResume === false ? "Your existing automatic-debit or renewal stop remains in place." : "Your existing membership settings were preserved."}</p>
        <p>A later payoff needs a fresh quote and separate acceptance.</p>
      </section> : result ? <section className="space-y-3 rounded-xl border p-5">
        <h2 className="text-xl font-semibold">{result.payoffRecorded ? "Your payoff payment is recorded" : "Payoff payment has not been confirmed yet"}</h2>
        {result.payoffRecorded ? <>
          <p>{result.providerStopped ? "Future membership renewal is stopped." : "CreatorNet has blocked future renewal. Provider stop confirmation is still pending."}</p>
          <p>{result.accessGranted ? "Your current paid access is available." : "Current access is not confirmed; contact support if you need help."}</p>
          {result.paidThrough && <p>Recorded paid access and mentor support through {when(result.paidThrough)}.</p>}
        </> : <p>Do not purchase again to resolve a pending payment. Retry confirmation or contact support.</p>}
        <button disabled={busy} onClick={() => void retryConfirmation()} className="underline">Retry confirmation</button>
      </section> : t && q ? <>
        <section className="space-y-3 rounded-xl border border-gray-500 p-5">
          <h2 className="text-xl font-semibold">{t.title}</h2><p className="text-2xl">{usd(t.amountCents)} once</p>
          <p>This pays the remaining {t.remainingMonths} month(s) of your existing minimum, not a new membership.</p>
          <p>Remaining minimum service: {when(t.periodStart)} through {when(t.periodEnd)}.</p>
          <p>Future membership renewal stops after the payoff is recorded. Paid access and mentor support continue through the paid minimum end.</p>
          <p>Monthly collection is held while this payoff is pending. Opening checkout is not payment.</p>
        </section>
        <section className="space-y-3 text-sm leading-relaxed">
          <p>{t.policy.refunds}</p><p>{t.policy.refundFees}</p>
          <p>This separate one-time authorization does not reinstate revoked automatic debits. Refund rights are preserved.</p>
          <Link href="/legal/purchase-agreement" target="_blank" rel="noopener noreferrer" className="underline">Purchase agreement ({t.policyVersion})</Link>
        </section>
        {q.status === "captured" && q.payoffId ? <Link href={`/memberships/payoff?membership_id=${membershipId}&payoff_id=${q.payoffId}&confirm=1`} className="underline">View recorded payoff</Link> : <>
          <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
            <input type="checkbox" checked={accepted} disabled={busy || q.checkoutEnabled === false} onChange={event => setAccepted(event.target.checked)} className="mt-1" />
            <span>I separately authorize this exact {usd(t.amountCents)} one-time payoff, its displayed service period and refund terms. This is not consent to an extra monthly payment.</span>
          </label>
          {q.checkoutEnabled === false && <p role="status">New payoff checkout is paused. You can still abandon this pending payoff or contact support.</p>}
          <button disabled={!accepted || busy || q.checkoutEnabled === false} onClick={() => void act("checkout")} className="rounded-lg bg-white px-5 py-3 font-semibold text-black disabled:opacity-40">
            {busy ? "Processing..." : "Confirm payoff and open payment"}</button>
          {q.payoffId && <p><Link href={`/memberships/payoff?membership_id=${membershipId}&payoff_id=${q.payoffId}&confirm=1`} className="underline">Check existing payoff payment</Link></p>}
          {q.payoffId && <section className="space-y-3 rounded-xl border p-5">
            <h2 className="font-semibold">Keep the membership instead</h2>
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={abandonAccepted} disabled={busy}
              onChange={event => setAbandonAccepted(event.target.checked)} className="mt-1" />
              <span>I understand abandoning this payoff keeps my membership and its original monthly schedule unless I separately stopped automatic debits or renewal.</span></label>
            <button disabled={!abandonAccepted || busy} onClick={() => void act("abandon")} className="underline disabled:opacity-40">Abandon payoff and keep membership</button>
          </section>}
        </>}
      </> : null}
    {actionError && <><p role="alert">{actionError}</p><button disabled={busy} onClick={refresh} className="underline">Review current payoff</button></>}
    <p><Link href="/memberships" className="underline">Manage your monthly mentorships</Link></p>
    <p className="text-sm">Questions or a request to stop automatic debits? <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a></p>
  </main>;
}
export default function MembershipPayoffPage() { return <Suspense fallback={<p role="status">Loading your payoff...</p>}><Payoff /></Suspense>; }
