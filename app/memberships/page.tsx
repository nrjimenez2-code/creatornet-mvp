"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MembershipManagementItem, MembershipManagementPage as ManagementResponse, MembershipView } from "@/lib/membershipManagement";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (cents: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100);
const date = (seconds: number | null) => seconds == null ? "Not confirmed" : new Date(seconds * 1000).toLocaleString();
function validPage(value: ManagementResponse, view: MembershipView) {
  return value?.view === view && Array.isArray(value.items) && value.items.length <= 12 &&
    (value.nextCursor === null || typeof value.nextCursor === "string" && /^[A-Za-z0-9_-]+$/.test(value.nextCursor)) &&
    value.items.every(item => uuid.test(item.id) && uuid.test(item.postId) && uuid.test(item.counterpartyId) &&
      typeof item.title === "string" && Number.isSafeInteger(item.monthlyPriceCents) && item.monthlyPriceCents >= 50 &&
      (item.initialAbandoned === undefined || typeof item.initialAbandoned === "boolean") &&
      (!item.initialAbandoned || !item.firstPaymentRecorded && !item.access?.allowed && !item.payoff) &&
      typeof item.firstPaymentRecorded === "boolean" && typeof item.access?.allowed === "boolean" &&
      item.quote?.membershipId === item.id && item.quote.version === "monthly-exit-quote-v1" &&
      Array.isArray(item.quote.reviewReasons) && typeof item.exitStatus?.providerStopped === "boolean" &&
      Array.isArray(item.exitStatus.requests) && (!item.payoff || uuid.test(item.payoff.id)));
}
function MembershipCard({ item, view, onBusy, onResult }: { item: MembershipManagementItem; view: MembershipView;
  onBusy: (busy: boolean) => void; onResult: (message: string) => void }) {
  const [cancelAccepted, setCancelAccepted] = useState(false), [revokeAccepted, setRevokeAccepted] = useState(false);
  const [busy, setBusy] = useState(false), active = useRef(false), q = item.quote;
  async function exit(kind: "stop_renewal" | "revoke_debits") {
    if (view !== "buyer" || active.current || !(kind === "stop_renewal" ? cancelAccepted : revokeAccepted)) return;
    active.current = true; setBusy(true); onBusy(true);
    try {
      const response = await fetch(`/api/memberships/${item.id}/exit`, { method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, accepted: true, ...(kind === "stop_renewal" ? { quote: q } : {}) }) });
      const result = await response.json();
      if (!response.ok || !uuid.test(result.requestId || "") || result.kind !== kind || result.billingBlocked !== true ||
        result.balanceWaived !== false || typeof result.providerStopped !== "boolean" ||
        result.providerStopped !== (result.status === "provider_stopped") ||
        !["provider_stopped", "provider_review_required"].includes(result.status)) throw Error();
      onResult(result.providerStopped ?
        "Your request is recorded and the provider stop is confirmed. Paid-term access and any remaining agreed balance are unchanged." :
        "Your request is recorded. CreatorNet has blocked future billing, but the provider stop still needs reconciliation. Paid-term access and any remaining agreed balance are unchanged.");
    } catch {
      onResult("The request outcome needs refresh or support review. Do not assume cancellation or a balance waiver.");
    } finally { active.current = false; setBusy(false); onBusy(false); }
  }
  const canCancel = !q.renewalStopped && q.payoffAmountCents === 0 && q.reviewReasons.length === 0 && item.firstPaymentRecorded;
  return <article className="space-y-4 rounded-2xl border border-white/15 bg-black p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h2 className="break-words text-lg font-semibold">{item.title}</h2>
        <p className="text-sm text-white/60">{view === "buyer" ? "Creator" : "Buyer"}: {item.counterpartyName || item.counterpartyUsername || item.counterpartyId}</p>
      </div>
      <span className="rounded-full border border-white/20 px-3 py-1 text-xs">{item.initialAbandoned ? "Unpaid checkout closed" : item.access.allowed ? "Paid-period access available" : "Access not currently available"}</span>
    </div>
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div><dt className="text-white/50">Accepted monthly price</dt><dd className="mt-1 font-medium">{money(item.monthlyPriceCents)} / month</dd></div>
      <div><dt className="text-white/50">Minimum commitment</dt><dd className="mt-1">{item.minimumMonths === 1 ? "First month only; no extra minimum months" :
        `${item.minimumMonths} months, ${money(q.minimumTotalCents)} total`}</dd></div>
      <div><dt className="text-white/50">Recorded paid term ends</dt><dd className="mt-1">{date(q.paidThrough)}</dd></div>
      <div><dt className="text-white/50">Remaining minimum</dt><dd className="mt-1">{item.initialAbandoned ? "No first payment or access recorded" : q.payoffAmountCents == null ? "Needs payment/support review" :
        q.remainingMonths === 0 ? "Minimum settled" : `${q.remainingMonths} months, ${money(q.payoffAmountCents)}`}</dd></div>
    </dl>
    <p className="text-sm text-white/70">{item.autoRenew ? "Monthly renewal after the minimum, unless stopped." : "No monthly renewal after the minimum term."}
      {" "}Canceling does not remove access or mentor support already paid for; refund and dispute controls still apply.</p>
    {item.exitStatus.billingBlocked && !item.initialAbandoned && <p role="status" className="rounded-lg border border-white/15 p-3 text-sm">
      {item.exitStatus.providerStopped ? "Future billing is stopped and provider cancellation is confirmed." :
        "Future billing is blocked in CreatorNet. Provider cancellation is not confirmed yet; recovery or support review is still required."}
      {" "}A stop request does not waive an unpaid minimum.</p>}
    {!item.initialAbandoned && (item.billingReview || q.reviewReasons.length > 0) && <p className="text-sm text-amber-200">
      Payment details need review. Do not make a second purchase to resolve an uncertain payment.</p>}
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
      <Link href={`/watch/${item.postId}`} className="underline">Open offer and available content</Link>
      {view === "buyer" && <Link href={item.counterpartyUsername ? `/profile/${encodeURIComponent(item.counterpartyUsername)}` :
        `/creators/${item.counterpartyId}`} className="underline">Creator profile</Link>}
      {view === "buyer" && !item.firstPaymentRecorded && !item.initialAbandoned && <Link href={`/memberships/complete?membership_id=${item.id}`} className="underline">Check first payment</Link>}
      {view === "buyer" && !item.firstPaymentRecorded && <Link href={`/memberships/recovery?membership_id=${item.id}`} className="underline">{item.initialAbandoned ? "Review closed checkout" : "Recover original checkout"}</Link>}
      {view === "buyer" && item.firstPaymentRecorded && <Link href={`/memberships/renewal-recovery?membership_id=${item.id}`} className="underline">Recover a monthly payment</Link>}
      {view === "buyer" && item.payoff && <Link href={`/memberships/payoff?membership_id=${item.id}&payoff_id=${item.payoff.id}&confirm=1`} className="underline">
        Check existing payoff payment</Link>}
      {view === "buyer" && !item.initialAbandoned && (item.payoff || q.payoffAmountCents != null && q.payoffAmountCents > 0 && q.reviewReasons.length === 0) &&
        <Link href={`/memberships/payoff?membership_id=${item.id}`} className="underline">{item.payoff ? "Review payoff or keep membership" : "Review early-exit payoff"}</Link>}
    </div>
    {view === "buyer" && !item.initialAbandoned && <div className="space-y-4 border-t border-white/10 pt-4">
      {canCancel && <section className="space-y-3">
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={cancelAccepted} disabled={busy}
          onChange={event => setCancelAccepted(event.target.checked)} className="mt-1" />
          <span>I want to stop renewal. My minimum is settled and I keep access and support through the recorded paid term.</span></label>
        <button disabled={busy || !cancelAccepted} onClick={() => void exit("stop_renewal")} className="rounded-lg border border-white/30 px-4 py-2 text-sm disabled:opacity-40">
          Stop renewal</button>
      </section>}
      {!q.debitsRevoked && <section className="space-y-3">
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={revokeAccepted} disabled={busy}
          onChange={event => setRevokeAccepted(event.target.checked)} className="mt-1" />
          <span>I want to stop future automatic debits. This is not a refund, a payoff or a waiver of any remaining minimum; the balance may need support review.</span></label>
        <button disabled={busy || !revokeAccepted} onClick={() => void exit("revoke_debits")} className="rounded-lg border border-white/30 px-4 py-2 text-sm disabled:opacity-40">
          Stop automatic debits</button>
      </section>}
    </div>}
    {item.exitStatus.requests.length > 0 && <details className="text-sm text-white/65">
      <summary className="cursor-pointer">Recorded stop requests</summary>
      <ul className="mt-3 space-y-2">{item.exitStatus.requests.map(request => <li key={request.id} className="break-words">
        {request.kind === "stop_renewal" ? "Renewal cancellation" : "Automatic-debit revocation"}: {request.status === "provider_stopped" ? "Provider stop confirmed" : "Provider stop pending / review"}.
        {" "}Reference: {request.id}
      </li>)}</ul>
    </details>}
  </article>;
}
export default function MembershipManagementPage() {
  const [view, setView] = useState<MembershipView>("buyer"), [cursor, setCursor] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  const [activeRequests, setActiveRequests] = useState(0), [notice, setNotice] = useState("");
  const busy = activeRequests > 0;
  const key = JSON.stringify([view, cursor, refresh]);
  const [loaded, setLoaded] = useState<{ key: string; page?: ManagementResponse; error?: string; signIn?: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController(), search = new URLSearchParams({ view }); if (cursor) search.set("cursor", cursor);
    void fetch(`/api/memberships?${search}`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) {
          if (!controller.signal.aborted) setLoaded({ key, error: body.error || "Membership details need refresh or support review.", signIn: response.status === 401 });
          return;
        }
        if (!validPage(body, view)) throw Error("Membership details need review.");
        if (!controller.signal.aborted) setLoaded({ key, page: body });
      }).catch(error => { if (!controller.signal.aborted) setLoaded({ key, error: error instanceof Error ? error.message : "Membership details need refresh." }); });
    return () => controller.abort();
  }, [view, cursor, key]);
  const current = loaded?.key === key ? loaded : null;
  function result(message: string) { setNotice(message); setRefresh(n => n + 1); }
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 text-white sm:px-6">
    <Link href="/library" className="text-sm text-white/60 underline">Back to Library</Link>
    <header className="space-y-2"><h1 className="text-3xl font-semibold">Monthly mentorships</h1>
      <p className="max-w-2xl text-sm text-white/65">Manage ongoing mentorship billing and paid-period access here. Fixed-total installment purchases are separate payment plans.</p>
      <Link href="/payments" className="inline-block text-sm underline">View fixed-total payment plans</Link></header>
    <div className="flex flex-wrap items-center gap-3">
      {(["buyer", "creator"] as const).map(role => <button key={role} disabled={busy} aria-pressed={view === role}
        onClick={() => { setView(role); setCursor(null); setNotice(""); }} className={`rounded-full border px-4 py-2 text-sm disabled:opacity-40 ${view === role ? "border-white bg-white text-black" : "border-white/20 text-white/70"}`}>
        {role === "buyer" ? "My mentorships" : "My customers"}</button>)}
      <button disabled={busy} onClick={() => setRefresh(n => n + 1)} className="text-sm underline disabled:opacity-40">Refresh details</button>
    </div>
    {notice && <p role="status" className="rounded-xl border border-white/20 p-4 text-sm">{notice}</p>}
    {!current ? <p role="status">Loading owned memberships and payment status...</p> : current.error ? <section className="space-y-3">
      <p role="alert">{current.error}</p>{current.signIn && <Link href="/auth" className="underline">Sign in</Link>}
    </section> : current.page && <>
      {!current.page.items.length && <p className="rounded-xl border border-white/15 p-6 text-white/65">
        {view === "buyer" ? "No monthly mentorships are recorded for your account." : "No monthly mentorship customers are recorded for your account."}</p>}
      <div className="space-y-5">{current.page.items.map(item => <MembershipCard key={`${key}:${item.id}`} item={item} view={view}
        onBusy={value => setActiveRequests(n => Math.max(0, n + (value ? 1 : -1)))} onResult={result} />)}</div>
      <div className="flex gap-5 text-sm">{cursor && <button disabled={busy} onClick={() => setCursor(null)} className="underline">First page</button>}
        {current.page.nextCursor && <button disabled={busy} onClick={() => setCursor(current.page!.nextCursor)} className="underline">Next page</button>}</div>
    </>}
    <p className="text-sm text-white/60">Need help with access, a payment, a refund or a remaining balance? <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a></p>
  </main>;
}
