import Link from "next/link";
import {notFound} from "next/navigation";
import {requireAdmin} from "@/lib/admin/server";
import {validMembershipAdminCursor} from "@/lib/membershipAdmin";
import {buyerMentorshipAdminReady,readBuyerMentorshipAdminPage} from "@/lib/mentorshipInstallmentAdmin";

export const dynamic="force-dynamic";
const path="/admin/commerce/buyer-installments";
const time=(value:string|null)=>value?new Date(value).toISOString():"Not recorded";
const epoch=(value:number|null)=>value?new Date(value*1000).toISOString():"Not scheduled";
const label=(value:string|null)=>value?value.replaceAll("_"," "):"Not recorded";
export default async function BuyerInstallmentReviewPage({searchParams}:{searchParams:Promise<{after?:string|string[]}>}) {
  // Layout and page may run concurrently; do not rely on the layout for auth.
  const {admin}=await requireAdmin();
  if(!buyerMentorshipAdminReady())notFound();
  const after=(await searchParams).after??null;
  if(after!==null && !validMembershipAdminCursor(after))notFound();
  let page:Awaited<ReturnType<typeof readBuyerMentorshipAdminPage>>;
  try {page=await readBuyerMentorshipAdminPage(admin,after);}
  catch {return <div role="alert">Buyer installment records could not be loaded. This does not mean the queue is empty. <Link href={path}>Try again</Link></div>;}
  return <div className="space-y-5">
    <Link href="/admin/commerce" className="text-sm underline">← Commerce</Link>
    <h1 className="text-2xl font-bold">Buyer installment billing review</h1>
    <p className="text-sm">{page.mode==="live"?"Live":"Test"} records · Snapshot {time(page.observedAt)} (UTC)</p>
    <p className="rounded-xl border p-4 text-sm">These plans have a recorded first payment. Review the saved payment outcome before taking action.
      A scheduled attempt is not payment proof or permission to charge. Service duration is independent of the payment schedule.</p>
    <Link href={`${path}${after?`?after=${encodeURIComponent(after)}`:""}`} className="inline-block underline">Refresh records</Link>
    <section aria-label="Buyer installment backlog across all pages" className="space-y-2 rounded-xl border p-4">
      <h2 className="text-lg font-semibold">Backlog across all pages</h2>
      <p>{page.pending} plans with due collection, recovery or review · {page.attention} plans needing attention</p>
      <p>Oldest due (UTC): {page.oldestDueAt?epoch(page.oldestDueAt):"None"}</p>
      <p className="text-xs text-gray-600">Attention includes saved review or retry outcomes, expired job leases and work more than five minutes overdue.
        Counts can overlap and remain visible during retry delays. Due work includes active leases and held work needing review.</p>
    </section>
    {!page.plans.length && <p>No buyer installment plans on this page.</p>}
    {page.plans.map(plan=><section key={plan.id} className="space-y-3 rounded-xl border bg-white p-5">
      <h2 className="text-lg font-semibold">{plan.title}</h2>
      <p>${(plan.amountCents/100).toFixed(2)} USD agreed total · {plan.paidCount} of {plan.paymentCount} payments accounted</p>
      <p>Agreed service duration: {plan.serviceMonths===null?"No fixed month duration recorded":`${plan.serviceMonths} months`} · Service end (UTC): {epoch(plan.serviceEndAt)}</p>
      <p className="font-medium">{plan.holds.length?plan.holds.join(" · "):"No saved collection hold"}</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt>Due work</dt><dd>{plan.dueAction?label(plan.dueAction):"None currently selected"}</dd></div>
        <div><dt>Next agreed payment (UTC)</dt><dd>{epoch(plan.nextPaymentAt)}</dd></div>
        <div><dt>Worker outcome</dt><dd>{label(plan.workerStatus)}</dd></div>
        <div><dt>Next worker attempt (UTC)</dt><dd>{time(plan.nextAttemptAt)}</dd></div>
        <div><dt>Last attempt (UTC)</dt><dd>{time(plan.lastAttemptAt)}</dd></div>
        <div><dt>Job lease expires (UTC)</dt><dd>{time(plan.leaseUntil)}</dd></div>
      </dl>
      {plan.recoveryInvoice && <div className="space-y-1 rounded-lg border p-3 text-sm">
        <p>Latest original payment recovery: payment {plan.recoveryNumber} · {label(plan.recoveryOutcome)}</p>
        <p>Observed (UTC): {time(plan.recoveryObservedAt)}</p>
        <p className="break-all">Original invoice {plan.recoveryInvoice}</p>
        <p>Bank authentication or replacement-card consent must be completed by the buyer through their saved payment-management flow.</p>
      </div>}
      <p className="break-all text-xs text-gray-500">Plan {plan.id} · Original request {plan.requestId}</p>
    </section>)}
    <nav aria-label="Buyer installment billing pages" className="flex gap-5">
      {after && <Link href={path} className="underline">First page</Link>}
      {page.nextCursor && <Link href={`${path}?after=${encodeURIComponent(page.nextCursor)}`} className="underline">Next page</Link>}
    </nav>
  </div>;
}
