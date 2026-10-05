"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import ManualMentorshipPayment from "@/components/ManualMentorshipPayment";
import { PaymentDetailSkeleton } from "@/components/loading/Skeletons";
import type { MembershipPayoffTerms } from "@/lib/membershipPayoff";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString("en-US",
  { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
type Owned = { membershipId: string; selectionId: string | null; buyerId: string;
  productId: string; title: string; amountCents: number; currency: "usd";
  payoffId: string | null; status: string; terms: MembershipPayoffTerms;
  fingerprint: string; acceptanceExpiresAt: number | null; newPaymentAllowed: boolean;
  acceptanceAllowed: boolean; manualAvailable: boolean };

function ManualPayoff() {
  const membershipId = useSearchParams().get("membership_id") || "";
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; owned?: Owned; error?: string } | null>(null);
  const [accepted, setAccepted] = useState(false), [busy, setBusy] = useState(false), [actionError, setActionError] = useState("");
  const key = `${membershipId}:${reload}`;
  useEffect(() => {
    if (!uuid.test(membershipId)) return;
    const controller = new AbortController();
    void fetch(`/api/memberships/${encodeURIComponent(membershipId)}/manual-payoff`,
      { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw Error(body.error || "Your original payoff needs review.");
        if (body.membershipId !== membershipId || !uuid.test(body.buyerId) ||
          !uuid.test(body.productId) || body.selectionId !== null && !uuid.test(body.selectionId) ||
          body.payoffId !== null && !uuid.test(body.payoffId) ||
          !Number.isSafeInteger(body.amountCents) || body.amountCents < 50 ||
          body.currency !== "usd" || typeof body.title !== "string" ||
          typeof body.fingerprint !== "string" || !body.terms ||
          body.terms.amountCents !== body.amountCents ||
          typeof body.newPaymentAllowed !== "boolean" ||
          typeof body.acceptanceAllowed !== "boolean" ||
          typeof body.manualAvailable !== "boolean") throw Error("Your payoff details need review.");
        if (!controller.signal.aborted) setLoaded({ key, owned: body });
      }).catch(error => {
        if (!controller.signal.aborted) setLoaded({ key,
          error: error instanceof Error ? error.message : "Your payoff needs review." });
      });
    return () => controller.abort();
  }, [membershipId, key]);
  const current = loaded?.key === key ? loaded : null, owned = current?.owned;
  function refresh() { setAccepted(false); setActionError(""); setReload(n => n + 1); }
  async function acceptPayoff() {
    if (!owned || !owned.acceptanceAllowed || !accepted || busy) return;
    setBusy(true); setActionError("");
    try {
      const response = await fetch(`/api/memberships/${encodeURIComponent(membershipId)}/manual-payoff`,
        { method: "POST", credentials: "include", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "accept", consent: { accepted: true,
            version: owned.terms.version, fingerprint: owned.fingerprint } }) });
      const body = await response.json();
      if (!response.ok || body.requestId !== membershipId || body.status !== "payoff_selected" ||
        !uuid.test(body.selectionId)) throw Error(body.error || "Your original payoff needs review.");
      refresh();
    } catch (error) { setActionError(error instanceof Error ? error.message : "Your payoff needs review."); }
    finally { setBusy(false); }
  }
  const t = owned?.terms;
  return <main className="mx-auto max-w-2xl space-y-5 p-6 text-white">
    <Link href="/memberships" className="text-sm underline">Back to monthly mentorships</Link>
    <h1 className="text-2xl font-semibold">Minimum-term payoff</h1>
    {!uuid.test(membershipId) ? <p role="alert">Open the payoff from your owned membership.</p> :
      !current ? <PaymentDetailSkeleton label="Checking your original payoff…" /> :
      current.error ? <p role="alert">{current.error}</p> : owned && t && <>
        <section className="space-y-3 rounded-xl border p-5">
          <h2 className="text-xl font-semibold">{owned.title}</h2>
          <p className="text-2xl">{usd(owned.amountCents)} once</p>
          <p>This covers the remaining {t.remainingMonths} month(s) of your existing minimum,
            through {when(t.periodEnd)}. It does not start another membership.</p>
          <p>After a verified payoff, future renewal stops. Paid access and mentor support
            continue through the covered term.</p>
          <p className="text-sm">{t.policy.refunds} {t.policy.refundFees}</p>
          <Link href="/legal/purchase-agreement" target="_blank" rel="noopener noreferrer" className="underline">
            Purchase agreement ({t.policyVersion})</Link>
        </section>
        {owned.status === "captured" ? <p role="status">Your payoff is recorded. Review your membership for paid access and renewal-stop status.</p> :
          owned.status === "abandoned" ? <p role="status">This unpaid payoff was closed. Your existing membership terms remain in place.</p> :
          owned.selectionId ? <>
            {!owned.newPaymentAllowed && <p role="status">New card actions are paused for this payoff. You can check or stop the original payment.</p>}
            <ManualMentorshipPayment requestId={membershipId} buyerId={owned.buyerId}
              productId={owned.productId} mode="monthly_payoff" selectionId={owned.selectionId}
              amountCents={owned.amountCents} allowNewPayment={owned.newPaymentAllowed}
              onReleased={refresh} onPayoffAbandoned={refresh} />
          </> : owned.acceptanceAllowed ? <>
            <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
              <input type="checkbox" checked={accepted} disabled={busy}
                onChange={event => setAccepted(event.target.checked)} className="mt-1" />
              <span>I separately authorize this exact {usd(owned.amountCents)} one-time payoff,
                its displayed service period and refund terms. This is not consent to another monthly payment.</span>
            </label>
            <button disabled={!accepted || busy} onClick={() => void acceptPayoff()}
              className="rounded-lg bg-white px-5 py-3 font-semibold text-black disabled:opacity-40">
              {busy ? "Saving payoff…" : "Confirm this payoff"}</button>
          </> : <p role="status">New payoff payment is unavailable. Recover the existing payment or contact support.</p>}
      </>}
    {actionError && <p role="alert">{actionError}</p>}
    {uuid.test(membershipId) && <button onClick={refresh} className="text-sm underline">Refresh saved payoff details</button>}
    <p className="text-sm">For an uncertain result, contact <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a> with membership reference {uuid.test(membershipId) ? membershipId : "not selected"}.</p>
  </main>;
}
export default function MembershipManualPayoffPage() {
  return <Suspense fallback={<PaymentDetailSkeleton label="Loading payoff…" />}><ManualPayoff /></Suspense>;
}
