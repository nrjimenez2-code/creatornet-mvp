"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PURCHASE_POLICY_VERSION } from "@/lib/purchasePolicies";
import type { ProductPurchaseTerms } from "@/lib/purchaseConsent";

function Review() {
  const search = useSearchParams();
  const productId = search.get("product_id") || "", postId = search.get("post_id") || "";
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([productId, postId, revision]);
  const [loaded, setLoaded] = useState<{ key: string; quote?: ProductPurchaseTerms; error?: string } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ product_id: productId });
    if (postId) query.set("post_id", postId);
    void fetch("/api/purchase-consent?" + query, { credentials: "include", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw Error(body.error || "Could not load the offer.");
        if (!controller.signal.aborted) { setLoaded({ key, quote: body }); setAccepted(false); setPaymentError(""); }
      }).catch(error => {
        if (!controller.signal.aborted) setLoaded({ key, error: error instanceof Error ? error.message : "Could not load the offer." });
      });
    return () => controller.abort();
  }, [productId, postId, key]);
  const current = loaded?.key === key ? loaded : null;
  const quote = current?.quote;
  function reloadOffer() {
    setAccepted(false); setPaymentError(""); setRevision(value => value + 1);
  }
  async function checkout() {
    if (!accepted || !quote || busy) return;
    setBusy(true); setPaymentError("");
    try {
      const response = await fetch("/api/checkout", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "product", product_id: productId, post_id: postId || undefined,
          purchase_consent: { accepted: true, version: PURCHASE_POLICY_VERSION, fingerprint: quote.fingerprint } }),
      });
      const body = await response.json();
      if (!response.ok || body.requires_consent || typeof body.url !== "string") throw Error(body.error || "Review the current offer before continuing.");
      const url = new URL(body.url);
      if (url.protocol !== "https:" && !(url.origin === window.location.origin && url.protocol === "http:")) throw Error("Invalid checkout destination.");
      window.location.assign(url.toString());
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : "Checkout could not be started."); setBusy(false);
    }
  }
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <Link href="/dashboard" className="text-sm underline">Back to CreatorNet</Link>
    <h1 className="text-2xl font-semibold">Review your purchase</h1>
    {!current ? <p role="status">Loading the current offer...</p> : current.error ? <>
      <p role="alert">{current.error}</p>
      <button onClick={reloadOffer} className="rounded-lg border px-4 py-2">Reload offer</button>
    </> : quote && <>
      <section className="space-y-3 rounded-xl border border-gray-500 p-5">
        <h2 className="text-xl font-semibold">{quote.terms.title}</h2>
        <p className="text-xl">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(quote.terms.amountCents / 100)}</p>
        <p>{quote.terms.billing}</p>
        {quote.terms.serviceDescription && <p>{quote.terms.serviceDescription}</p>}
        {quote.terms.description && <p className="whitespace-pre-wrap">{quote.terms.description}</p>}
        <p>{quote.terms.policy.delivery}</p>
      </section>
      <section className="space-y-3 text-sm leading-relaxed">
        <h2 className="text-lg font-semibold">Refunds and service terms</h2>
        <p>{quote.terms.policy.refunds}</p><p>{quote.terms.policy.eligibility}</p>
        {quote.terms.kind === "paid_call" && <p>{quote.terms.policy.calls}</p>}
        <p>{quote.terms.policy.refundFees}</p>
        <p><Link href="/legal/purchase-agreement" target="_blank" rel="noopener noreferrer" className="underline">Complete purchase agreement ({quote.terms.version})</Link></p>
      </section>
      <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
        <input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} className="mt-1" />
        <span>I agree to the displayed offer, its price, delivery and refund rules, and the linked purchase agreement. This is not consent to an automatic monthly membership or an early-exit payoff.</span>
      </label>
      {paymentError && <>
        <p role="alert">{paymentError}</p>
        <button onClick={reloadOffer} disabled={busy} className="rounded-lg border px-4 py-2">Review current offer</button>
      </>}
      <button disabled={!accepted || busy} onClick={() => void checkout()} className="rounded-lg bg-white px-5 py-3 font-semibold text-black disabled:opacity-40">{busy ? "Opening checkout..." : "Agree and continue to payment"}</button>
    </>}
    <p className="text-sm">Questions? <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a></p>
  </main>;
}
export default function PurchaseReviewPage() { return <Suspense fallback={<p role="status">Loading your purchase...</p>}><Review /></Suspense>; }
