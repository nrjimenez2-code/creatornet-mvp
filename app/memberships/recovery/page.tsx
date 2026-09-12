"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { CheckoutRecoveryResult } from "@/lib/membershipCheckoutRecovery";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (cents: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100);
const messages: Record<CheckoutRecoveryResult["status"], string> = {
  paid: "Your first payment is recorded. Access follows the recorded paid term and any refund or dispute restrictions.",
  payment_pending: "Payment is not confirmed yet. Retry this check; do not make a second purchase.",
  checkout_open: "Your original checkout is available. Continuing uses the original accepted terms, not a new purchase.",
  resumable: "The original checkout can be resumed with its saved agreement and payment-operation identities.",
  expired_unpaid: "The original checkout expired without a confirmed payment. Close this unpaid attempt below, if available, or contact support before purchasing again.",
  abandon_pending: "Your close-out request is recorded, but the original payment state still needs reconciliation. Do not make a replacement purchase yet.",
  abandoned: "This unpaid checkout is closed. No first payment or access was recorded. You can review the current offer and separately accept its terms before making a new purchase.",
  review_required: "The original checkout needs support review. No replacement payment or new purchase has been created.",
};
async function request(id: string, action: "reconcile" | "resume" | "abandon", signal?: AbortSignal) {
  const response = await fetch("/api/memberships/" + id + "/recovery", { method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...(action !== "reconcile" ? { confirmed: true } : {}) }) });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || "Recovery needs retry or support review.");
  if (body.membershipId !== id || !Object.hasOwn(messages, body.status) || typeof body.canResume !== "boolean" ||
    typeof body.firstPaymentRecorded !== "boolean" || typeof body.accessGranted !== "boolean" || typeof body.title !== "string" ||
    !Number.isSafeInteger(body.monthlyPriceCents) || body.monthlyPriceCents < 50 || !Number.isInteger(body.minimumMonths) ||
    body.minimumMonths < 1 || body.minimumMonths > 24 || body.minimumTotalCents !== body.minimumMonths * body.monthlyPriceCents ||
    typeof body.autoRenew !== "boolean" || !Number.isInteger(body.completedStages) || body.completedStages < 0 || body.completedStages > 5 ||
    body.canResume && !["resumable", "checkout_open"].includes(body.status) || body.firstPaymentRecorded !== (body.status === "paid") ||
    body.canAbandon !== undefined && typeof body.canAbandon !== "boolean" ||
    body.status === "abandoned" && (body.canAbandon || body.accessGranted || body.canResume) ||
    body.canAbandon && body.firstPaymentRecorded)
    throw Error("Recovery evidence needs review.");
  if (body.reviewUrl !== undefined) {
    const url = new URL(body.reviewUrl, window.location.origin);
    if (!body.reviewUrl.startsWith("/memberships/review?") || url.origin !== window.location.origin ||
      url.pathname !== "/memberships/review" || !uuid.test(url.searchParams.get("product_id") || "") ||
      !uuid.test(url.searchParams.get("post_id") || "") || [...url.searchParams.keys()].sort().join(",") !== "post_id,product_id" || url.hash)
      throw Error("Invalid current-offer review destination.");
  }
  return body as CheckoutRecoveryResult & { url?: string };
}
function RecoveryContent() {
  const params = useSearchParams(), id = params.get("membership_id") || "";
  const [attempt, setAttempt] = useState(0), [accepted, setAccepted] = useState(false), [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; result?: CheckoutRecoveryResult; error?: string } | null>(null);
  const [destination, setDestination] = useState<string | null>(null), key = id + ":" + attempt;
  const [abandonAccepted, setAbandonAccepted] = useState(false);
  useEffect(() => {
    if (!uuid.test(id)) return;
    const controller = new AbortController();
    void request(id, "reconcile", controller.signal).then(result => { if (!controller.signal.aborted) setLoaded({ key, result }); })
      .catch(error => { if (!controller.signal.aborted) setLoaded({ key, error: error instanceof Error ? error.message : "Recovery needs retry." }); });
    return () => controller.abort();
  }, [id, key]);
  const current = loaded?.key === key ? loaded : null, result = current?.result;
  async function resume() {
    if (!accepted || busy || !result?.canResume) return;
    setBusy(true); setDestination(null);
    try {
      const next = await request(id, "resume"), url = new URL(next.url || "", window.location.origin);
      if (!next.url || url.protocol !== "https:" && url.origin !== window.location.origin ||
        !(url.origin === "https://checkout.stripe.com" || url.origin === window.location.origin && url.pathname === "/memberships/complete" &&
          url.searchParams.get("membership_id") === id)) throw Error("Invalid recovered payment destination.");
      setDestination(url.href); setLoaded({ key, result: next });
    } catch (error) { setLoaded({ key, error: error instanceof Error ? error.message : "Recovery needs retry." }); }
    finally { setBusy(false); setAccepted(false); }
  }
  async function abandon() {
    if (!abandonAccepted || busy || !result?.canAbandon) return;
    setBusy(true); setDestination(null); setAccepted(false);
    try { setLoaded({ key, result: await request(id, "abandon") }); }
    catch (error) { setLoaded({ key, error: error instanceof Error ? error.message : "Close-out needs retry or support review." }); }
    finally { setBusy(false); setAbandonAccepted(false); }
  }
  return <main className="mx-auto max-w-2xl space-y-6 px-4 py-10 text-white">
    <Link href="/memberships" className="text-sm underline">Back to monthly mentorships</Link>
    <h1 className="text-3xl font-semibold">Recover your first checkout</h1>
    <p className="text-sm text-white/65">This checks your existing accepted purchase. It does not accept a different offer, change its minimum or create a replacement payment.</p>
    {!uuid.test(id) ? <p role="alert">Select an owned membership to recover.</p> : !current ? <p role="status">Checking the original payment journal...</p> :
      current.error ? <p role="alert">{current.error}</p> : result && <section className="space-y-4 rounded-2xl border border-white/20 p-5">
        <h2 className="text-xl font-semibold">{result.title}</h2>
        <p>{money(result.monthlyPriceCents)} for the first month. Minimum {result.minimumMonths} month(s), {money(result.minimumTotalCents)} total.</p>
        <p className="text-sm text-white/65">{result.autoRenew ? "Renews monthly after the minimum unless stopped." : "No renewal after the minimum."}</p>
        <p role="status">{messages[result.status]}</p>
        <p className="text-sm text-white/60">Original provider stages confirmed: {result.completedStages} / 5.</p>
        {result.firstPaymentRecorded && <Link href={"/memberships/complete?membership_id=" + id} className="underline">View recorded first payment</Link>}
        {result.canResume && !destination && <div className="space-y-4 border-t border-white/15 pt-4">
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} className="mt-1" />
            <span>Continue my original first-month checkout under the accepted price and minimum above. This is not a new purchase or a changed payment agreement.</span></label>
          <button disabled={busy || !accepted} onClick={() => void resume()} className="rounded-lg bg-white px-4 py-3 font-semibold text-black disabled:opacity-40">
            {busy ? "Resuming original checkout..." : "Resume original checkout"}</button>
        </div>}
        {destination && <a href={destination} className="inline-block rounded-lg bg-white px-4 py-3 font-semibold text-black">Continue to secure payment or confirmation</a>}
        {result.canAbandon && <div className="space-y-4 border-t border-white/15 pt-4">
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={abandonAccepted} disabled={busy}
            onChange={event => setAbandonAccepted(event.target.checked)} className="mt-1" />
            <span>Close this original checkout only if no payment or access has been recorded and it can no longer collect money. This does not refund a payment or cancel an active mentorship or fixed-total installment plan.</span></label>
          <button disabled={busy || !abandonAccepted} onClick={() => void abandon()} className="rounded-lg border border-white/30 px-4 py-3 disabled:opacity-40">
            {busy ? "Checking unpaid close-out..." : "Close unpaid checkout"}</button>
        </div>}
        {result.status === "abandoned" && result.reviewUrl && <Link href={result.reviewUrl} className="inline-block underline">Review current offer and terms</Link>}
      </section>}
    {uuid.test(id) && <button disabled={busy} onClick={() => { setAccepted(false); setAbandonAccepted(false); setDestination(null); setAttempt(n => n + 1); }} className="text-sm underline disabled:opacity-40">Check again</button>}
    <p className="text-sm text-white/65">For an uncertain or expired payment, contact <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a> with your membership reference: {uuid.test(id) ? id : "not selected"}.</p>
  </main>;
}
export default function CheckoutRecoveryPage() {
  return <Suspense fallback={<p className="p-8 text-white">Loading checkout recovery...</p>}><RecoveryContent /></Suspense>;
}
