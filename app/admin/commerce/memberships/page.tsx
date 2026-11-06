import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/server";
import { membershipAdminReady, readMembershipAdminPage, validMembershipAdminCursor } from "@/lib/membershipAdmin";
import { readMembershipBillingBacklog } from "@/lib/membershipBillingBacklog";
import { buyerMentorshipAdminReady } from "@/lib/mentorshipInstallmentAdmin";

export const dynamic = "force-dynamic";
const time = (value: string | null) => value === "infinity" ? "Not scheduled" :
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "Not recorded";
const label = (value: string | null) => value ? value.replaceAll("_", " ") : "Not yet run";

export default async function MembershipReviewPage({ searchParams }: {
  searchParams: Promise<{ after?: string | string[] }>;
}) {
  // The layout and page can render concurrently; enforce auth before any read.
  const { admin } = await requireAdmin();
  if (!membershipAdminReady()) notFound();
  const after = (await searchParams).after ?? null;
  if (after !== null && !validMembershipAdminCursor(after)) notFound();
  let page: Awaited<ReturnType<typeof readMembershipAdminPage>>;
  const [pageResult, backlogResult] = await Promise.allSettled([
    readMembershipAdminPage(admin, after), readMembershipBillingBacklog(admin),
  ]);
  try { if (pageResult.status === "rejected") throw pageResult.reason; page = pageResult.value; }
  catch { return <div role="alert">Monthly billing records could not be loaded. <Link href="/admin/commerce/memberships">Try again</Link></div>; }
  const backlog = backlogResult.status === "fulfilled" ? backlogResult.value : null;
  return <div className="space-y-5">
    <Link href="/admin/commerce" className="text-sm underline">← Commerce</Link>
    <h1 className="text-2xl font-bold">Monthly billing review</h1>
    {buyerMentorshipAdminReady() && <Link href="/admin/commerce/buyer-installments" className="inline-block underline">Review buyer installment billing</Link>}
    <p className="text-sm text-gray-600">{page.mode === "live" ? "Live" : "Test"} records · Observed {page.observedAt} (UTC)</p>
    <p className="rounded-xl border p-4 text-sm">Saved billing and cancellation records. A due attempt is not proof that a payment should be collected.
      Review the original operation before retrying. Holds, refunds, access and remaining obligations retain their existing policies.</p>
    <Link href={`/admin/commerce/memberships${after ? `?after=${encodeURIComponent(after)}` : ""}`} className="inline-block underline">Refresh records</Link>
    {backlog ? <section aria-label="Billing backlog across all pages" className="space-y-3 rounded-xl border p-4">
      <h2 className="text-lg font-semibold">Billing backlog across all pages</h2>
      <p className="text-sm">Snapshot {time(backlog.observedAt)} · {backlog.agreementCount} agreements · {backlog.exitCount} cancellation requests</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt>Billing work due</dt><dd>{backlog.billingDueCount} · Oldest due: {backlog.billingOldestDueAt ? time(backlog.billingOldestDueAt) : "None"}</dd></div>
        <div><dt>Cancellation requests due</dt><dd>{backlog.exitDueCount} · Oldest due: {backlog.exitOldestDueAt ? time(backlog.exitOldestDueAt) : "None"}</dd></div>
        <div><dt>Billing review holds / financial holds</dt><dd>{backlog.billingReviewCount} / {backlog.financialHoldCount}</dd></div>
        <div><dt>Cancellation provider review</dt><dd>{backlog.exitReviewCount}</dd></div>
        <div><dt>Billing retries / active leases</dt><dd>{backlog.billingRetryCount} / {backlog.billingLeasedCount}</dd></div>
        <div><dt>Cancellation retries / active leases</dt><dd>{backlog.exitRetryCount} / {backlog.exitLeasedCount}</dd></div>
      </dl>
      <p className="text-xs text-gray-600">Counts can overlap. Due work excludes active leases and follows worker eligibility rules. It may include activation or reconciliation; it does not authorize a charge.</p>
    </section> : <p role="status" className="rounded-xl border p-4">{backlogResult.status === "rejected"
      ? "Billing backlog totals could not be loaded. Records below remain available; a missing total does not mean the queue is empty."
      : "Billing backlog totals are not configured. The records below cover this page only."}</p>}
    {!page.memberships.length && <p>No monthly agreements on this page.</p>}
    {page.memberships.map(plan => <section key={plan.id} className="space-y-3 rounded-xl border bg-white p-5">
      <h2 className="text-lg font-semibold">{plan.title}</h2>
      <p>${(plan.monthlyCents / 100).toFixed(2)} USD/month · {plan.coveredMonths} paid months recorded · {plan.minimumMonths}-month minimum · {plan.autoRenew ? "Renews after minimum" : "No renewal after minimum"}</p>
      <p className="break-all text-xs text-gray-500">Agreement {plan.id}</p>
      <p className="font-medium">{plan.holds.length ? plan.holds.join(" · ") : "No saved collection hold"}</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt>Worker outcome</dt><dd>{label(plan.workerStatus)}</dd></div>
        <div><dt>Next attempt (UTC)</dt><dd>{time(plan.nextAttemptAt)}</dd></div>
        <div><dt>Last attempt (UTC)</dt><dd>{time(plan.lastAttemptAt)}</dd></div>
        <div><dt>Lease expires (UTC)</dt><dd>{time(plan.leaseUntil)}</dd></div>
      </dl>
      {plan.exits.map(exit => <div key={exit.id} className="rounded-lg border p-3 text-sm">
        <p className="font-semibold">{label(exit.kind)}: {label(exit.status)}</p>
        <p>Recovery: {label(exit.workerStatus)} · Next attempt: {time(exit.nextAttemptAt)}</p>
        <p>Requested: {time(exit.requestedAt)} · Last attempt: {time(exit.lastAttemptAt)}</p>
        <p className="break-all text-xs text-gray-500">Original request {exit.id}</p>
      </div>)}
    </section>)}
    <nav aria-label="Monthly billing pages" className="flex gap-5">
      {after && <Link href="/admin/commerce/memberships" className="underline">First page</Link>}
      {page.nextCursor && <Link href={`/admin/commerce/memberships?after=${encodeURIComponent(page.nextCursor)}`} className="underline">Next page</Link>}
    </nav>
  </div>;
}
