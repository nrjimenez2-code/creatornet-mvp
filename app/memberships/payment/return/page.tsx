"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function Return() {
  const search = useSearchParams(), attempt = search.get("attempt"), router = useRouter();
  const [message, setMessage] = useState("Recovering your original monthly payment…");
  useEffect(() => {
    const controller = new AbortController();
    // Remove Stripe redirect parameters without treating any browser status or
    // client secret as evidence of capture, accounting, or service access.
    window.history.replaceState(null, "", window.location.pathname +
      (attempt ? "?" + new URLSearchParams({ attempt }) : ""));
    if (!attempt || !uuid.test(attempt)) {
      setMessage("Invalid original payment link. Reopen your saved monthly payment.");
      return () => controller.abort();
    }
    void fetch(`/api/memberships/manual/resolve?${new URLSearchParams({ attempt_id: attempt })}`,
      { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok || !uuid.test(body.membershipId) || body.selectionId !== attempt ||
          !["first", "payoff"].includes(body.kind)) throw Error();
        if (!controller.signal.aborted) router.replace(body.kind === "payoff" ?
          `/memberships/manual-payoff?membership_id=${encodeURIComponent(body.membershipId)}` :
          `/memberships/manual?membership_id=${encodeURIComponent(body.membershipId)}`);
      }).catch(() => {
        if (!controller.signal.aborted) setMessage("Your original monthly payment needs a status check. Reopen the saved membership or contact support before another payment.");
      });
    return () => controller.abort();
  }, [attempt, router]);
  return <main className="mx-auto max-w-2xl space-y-4 p-6">
    <h1 className="text-2xl font-semibold">Monthly payment recovery</h1>
    <p role="status">{message}</p>
    <p><a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a></p>
  </main>;
}
export default function MembershipManualReturnPage() {
  return <Suspense fallback={<p>Recovering monthly payment…</p>}><Return /></Suspense>;
}
