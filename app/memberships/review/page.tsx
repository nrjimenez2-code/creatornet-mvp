"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { MembershipAgreement } from "@/lib/membershipAgreement";
type Quote = { agreement: MembershipAgreement; fingerprint: string };
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
function Review() {
  const search = useSearchParams(), productId = search.get("product_id") || "", postId = search.get("post_id") || "";
  const [reload, setReload] = useState(0), key = JSON.stringify([productId, postId, reload]);
  const [loaded, setLoaded] = useState<{ key: string; quote?: Quote; error?: string } | null>(null);
  const [accepted, setAccepted] = useState(false), [busy, setBusy] = useState(false), [paymentError, setPaymentError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/memberships/quote?" + new URLSearchParams({ product_id: productId, post_id: postId }),
      { credentials: "include", cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw Error(body.error || "Could not load this membership.");
      if (!controller.signal.aborted) { setLoaded({ key, quote: body }); setAccepted(false); setPaymentError(""); }
    }).catch(error => { if (!controller.signal.aborted) setLoaded({ key, error: error instanceof Error ? error.message : "Could not load this membership." }); });
    return () => controller.abort();
  }, [productId, postId, key]);
  const current = loaded?.key === key ? loaded : null, quote = current?.quote, t = quote?.agreement;
  function reloadOffer() { setAccepted(false); setPaymentError(""); setReload(value => value + 1); }
  async function checkout() {
    if (!accepted || !quote || busy) return;
    setBusy(true); setPaymentError("");
    try {
      const response = await fetch("/api/memberships/checkout", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: productId, post_id: postId,
          consent: { accepted: true, version: quote.agreement.version, fingerprint: quote.fingerprint } }) });
      const body = await response.json();
      if (!response.ok || typeof body.url !== "string") throw Error(body.error || "Review the current membership before payment.");
      const url = new URL(body.url);
      if (url.username || url.password || !(url.protocol === "https:" && url.origin === "https://checkout.stripe.com" ||
        url.origin === window.location.origin && url.pathname === "/memberships/complete")) throw Error("Invalid checkout destination.");
      window.location.assign(url.toString());
    } catch (error) { setPaymentError(error instanceof Error ? error.message : "Checkout needs retry or review."); setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <Link href="/dashboard" className="text-sm underline">Back to CreatorNet</Link>
    <h1 className="text-2xl font-semibold">Review your monthly mentorship</h1>
    {!current ? <p role="status">Loading the current membership...</p> : current.error ? <>
      <p role="alert">{current.error}</p><button onClick={reloadOffer} className="underline">Reload offer</button>
    </> : t && <>
      <section className="space-y-3 rounded-xl border border-gray-500 p-5">
        <h2 className="text-xl font-semibold">{t.title}</h2>
        <p className="text-xl">{usd(t.monthlyPriceCents)} today, then monthly during the agreed term</p>
        <p>{t.minimumMonths === 1 ? "One paid month, with no additional minimum." : `${t.minimumMonths}-month minimum: ${usd(t.minimumTotalCents)} total minimum.`}</p>
        <p>{t.billing}</p>{t.description && <p className="whitespace-pre-wrap">{t.description}</p>}
      </section>
      <section className="space-y-3 text-sm leading-relaxed">
        <h2 className="text-lg font-semibold">Cancellation, access and support</h2>
        <p>Before the minimum is paid, early exit requires the exact unpaid minimum balance. We will show that amount and ask for separate confirmation before a payoff charge.</p>
        <p>After the minimum is met, cancellation stops future renewal. Access and mentor support continue through the term you have already paid for, including a minimum term paid off early.</p>
        <p>A request to stop automatic debits is separate from whether a valid balance remains owed. It does not waive refund rights or other rights provided by law.</p>
        <p>This is ongoing monthly mentorship service, not a fixed-price purchase divided into installments.</p>
        <h2 className="text-lg font-semibold">Refunds and service terms</h2>
        <p>{t.policy.refunds}</p><p>{t.policy.eligibility}</p><p>{t.policy.refundFees}</p>
        <p><Link href="/legal/purchase-agreement" target="_blank" rel="noopener noreferrer" className="underline">Complete purchase agreement ({t.policyVersion})</Link></p>
      </section>
      <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
        <input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} className="mt-1" />
        <span>I agree to this membership&apos;s displayed price, minimum, renewal, cancellation, delivery and refund terms and the linked agreement. I authorize its scheduled monthly card payments. This does not authorize a separate early-exit payoff charge.</span>
      </label>
      {paymentError && <><p role="alert">{paymentError}</p><button onClick={reloadOffer} disabled={busy} className="underline">Review current offer</button></>}
      <button disabled={!accepted || busy} onClick={() => void checkout()} className="rounded-lg bg-white px-5 py-3 font-semibold text-black disabled:opacity-40">
        {busy ? "Opening checkout..." : "Agree and continue to payment"}</button>
    </>}
    <p className="text-sm">Questions? <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a></p>
  </main>;
}
export default function MembershipReviewPage() { return <Suspense fallback={<p role="status">Loading your membership...</p>}><Review /></Suspense>; }
