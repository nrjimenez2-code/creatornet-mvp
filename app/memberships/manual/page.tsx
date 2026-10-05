"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import ManualMentorshipPayment from "@/components/ManualMentorshipPayment";
import { PaymentDetailSkeleton } from "@/components/loading/Skeletons";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Owned = { membershipId: string; selectionId: string; buyerId: string; productId: string;
  title: string; amountCents: number; currency: "usd"; firstPaymentRecorded: boolean;
  initialAbandoned: boolean; initialAbandonedAt: string | null; initialAbandonRequested: boolean;
  newPaymentAllowed: boolean; acceptanceExpiresAt: number };

function ManualFirst() {
  const params = useSearchParams(), id = params.get("membership_id") || "";
  const [attempt, setAttempt] = useState(0), [loaded, setLoaded] = useState<{ key: string; owned?: Owned; error?: string } | null>(null);
  const key = `${id}:${attempt}`;
  useEffect(() => {
    if (!uuid.test(id)) return;
    const controller = new AbortController();
    void fetch(`/api/memberships/${encodeURIComponent(id)}/manual`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw Error(body.error || "Your original monthly payment needs review.");
        if (body.membershipId !== id || !uuid.test(body.selectionId) || !uuid.test(body.buyerId) ||
          !uuid.test(body.productId) || typeof body.title !== "string" ||
          !Number.isSafeInteger(body.amountCents) || body.amountCents < 50 || body.currency !== "usd" ||
          typeof body.firstPaymentRecorded !== "boolean" || typeof body.initialAbandoned !== "boolean" ||
          typeof body.initialAbandonRequested !== "boolean" || typeof body.newPaymentAllowed !== "boolean" ||
          !Number.isSafeInteger(body.acceptanceExpiresAt) || body.acceptanceExpiresAt <= 0)
          throw Error("Your original monthly payment details need review.");
        if (!controller.signal.aborted) setLoaded({ key, owned: body });
      }).catch(error => { if (!controller.signal.aborted) setLoaded({ key, error: error instanceof Error ? error.message : "Payment needs review." }); });
    return () => controller.abort();
  }, [id, key]);
  const current = loaded?.key === key ? loaded : null, owned = current?.owned;
  return <main className="mx-auto max-w-2xl space-y-5 p-6 text-white">
    <Link href="/memberships" className="text-sm underline">Back to monthly mentorships</Link>
    <h1 className="text-2xl font-semibold">Your first monthly payment</h1>
    <p>This page continues the original accepted membership and card payment. A browser result alone does not grant access.</p>
    {!uuid.test(id) ? <p role="alert">Open an owned monthly payment reference.</p> : !current ?
      <PaymentDetailSkeleton label="Checking your original monthly payment…" /> : current.error ? <p role="alert">{current.error}</p> : owned && <>
        <h2 className="text-xl font-semibold">{owned.title}</h2>
        {owned.firstPaymentRecorded ? <p role="status">Your first payment is recorded. <Link href={`/memberships/complete?membership_id=${id}`} className="underline">View your paid term</Link>.</p> :
          owned.initialAbandoned ? <p role="status">This unpaid payment was closed. <Link href="/memberships" className="underline">Review your memberships</Link>.</p> :
          owned.initialAbandonRequested ? <p role="status">Your request to stop this payment needs reconciliation. Keep this original membership reference and contact support.</p> :
            <>
              {!owned.newPaymentAllowed && <p role="status">New card payment actions are unavailable for this acceptance. You can check or stop this original payment.</p>}
              <ManualMentorshipPayment requestId={id} buyerId={owned.buyerId} productId={owned.productId}
                mode="monthly_first" amountCents={owned.amountCents} allowNewPayment={owned.newPaymentAllowed}
                onReleased={() => setAttempt(n => n + 1)} />
            </>}
      </>}
    {uuid.test(id) && <button onClick={() => setAttempt(n => n + 1)} className="text-sm underline">Refresh saved payment details</button>}
    <p className="text-sm">For an uncertain result, contact <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a> with membership reference {uuid.test(id) ? id : "not selected"}.</p>
  </main>;
}
export default function MembershipManualPage() { return <Suspense fallback={<PaymentDetailSkeleton label="Loading monthly payment…" />}><ManualFirst /></Suspense>; }
