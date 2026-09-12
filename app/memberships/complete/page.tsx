"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
type Confirmation = { membershipId: string; title: string; firstPaymentRecorded: boolean; accessGranted: boolean; paidThrough: string | null };
function Complete() {
  const search = useSearchParams(), id = search.get("membership_id") || "";
  const [attempt, setAttempt] = useState(0), key = JSON.stringify([id, attempt]);
  const [loaded, setLoaded] = useState<{ key: string; value?: Confirmation; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return () => controller.abort();
    void fetch(`/api/memberships/${encodeURIComponent(id)}/confirm`, { method: "POST", credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw Error(body.error || "Payment confirmation needs retry or review.");
        if (body.membershipId !== id || typeof body.firstPaymentRecorded !== "boolean" || typeof body.accessGranted !== "boolean") throw Error("Payment confirmation needs review.");
        if (!controller.signal.aborted) setLoaded({ key, value: body });
      }).catch(error => { if (!controller.signal.aborted) setLoaded({ key, error: error instanceof Error ? error.message : "Payment confirmation needs retry or review." }); });
    return () => controller.abort();
  }, [id, key]);
  const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id), current = loaded?.key === key ? loaded : null;
  const value = current?.value;
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">Your monthly mentorship</h1>
    {!validId ? <p role="alert">Open the confirmation for your membership, or contact support.</p> : !current ?
      <p role="status">Checking payment and paid-period access...</p> : current.error ? <p role="alert">{current.error}</p> : value && <>
        <h2 className="text-xl font-semibold">{value.title}</h2>
        <p role="status">{value.firstPaymentRecorded ? "Your first payment is recorded." : "Payment has not been confirmed yet. A checkout redirect alone does not grant access."}</p>
        <p>{value.accessGranted ? "Your current paid-period access is available." : "Access is not currently available. If you paid, retry confirmation or contact support; do not make a second purchase."}</p>
        {value.paidThrough && <p>Recorded paid term ends: <time dateTime={value.paidThrough}>{new Date(value.paidThrough).toLocaleString()}</time>.</p>}
        <p>Your original minimum and renewal terms remain in effect. A recorded payment is not a cancellation or a waiver of any remaining agreed balance.</p>
      </>}
    {validId && current && <button onClick={() => setAttempt(number => number + 1)} className="rounded-lg border px-4 py-2">Retry confirmation</button>}
    <p><Link href="/dashboard" className="underline">Back to CreatorNet</Link></p>
    <p><Link href="/memberships" className="underline">Manage your monthly mentorships</Link></p>
    <p className="text-sm">Need help? <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a></p>
  </main>;
}
export default function MembershipCompletePage() { return <Suspense fallback={<p role="status">Loading confirmation...</p>}><Complete /></Suspense>; }
