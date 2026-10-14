import Link from "next/link";
import {notFound} from "next/navigation";
import {requireAdmin} from "@/lib/admin/server";
import {fullRefundReviewAdminReady,readFullRefundReviewAdmin,validFullRefundReviewCursor} from "@/lib/fullRefundReviewAdmin";
import {fullRefundReviewAcknowledgementReady} from "@/lib/fullRefundReviewAcknowledgement";
import AcknowledgeReview from "./AcknowledgeReview";
import {fullRefundReviewReconciliationReady} from "@/lib/fullRefundReviewReconciliation";
import ReconcileRefund from "./ReconcileRefund";

export const dynamic="force-dynamic";
const path="/admin/commerce/full-refunds";
const time=(v:string|null)=>v?new Date(v).toISOString():"Not recorded";
export default async function FullRefundReviewPage({searchParams}:{searchParams:Promise<{after?:string|string[]}>}){
  const {admin}=await requireAdmin();
  if(!fullRefundReviewAdminReady())notFound();
  const after=(await searchParams).after??null;
  if(after!==null&&!validFullRefundReviewCursor(after))notFound();
  let page:Awaited<ReturnType<typeof readFullRefundReviewAdmin>>;
  try{page=await readFullRefundReviewAdmin(admin,after);}
  catch{return <div role="alert">Refund review is unavailable. This does not mean the queue is empty. <Link href={path}>Try again</Link></div>;}
  return <div className="space-y-5">
    <Link href="/admin/commerce" className="underline">← Commerce</Link>
    <h1 className="text-2xl font-bold">Full-payment refund review</h1>
    <p>{page.mode==="live"?"Live":"Test"} records · Snapshot {time(page.observedAt)} (UTC)</p>
    <p className="rounded-xl border p-4">Financial holds remain active for these originals. A recorded or succeeded refund observation does not resolve a case.
      This view does not confirm support notification delivery.</p>
    <section aria-label="Refund backlog across all pages" className="rounded-xl border p-4">
      <h2 className="font-semibold">Backlog across all pages</h2>
      <p>{page.needsReview} original payments needing review · {page.events} saved refund events</p>
      <p>{page.unapplied} events awaiting observation · {page.reviewRecorded} observations flagged for review</p>
      <p>Oldest event (UTC): {time(page.oldestObservedAt)}</p>
    </section>
    <Link href={`${path}${after?`?after=${encodeURIComponent(after)}`:""}`} className="inline-block underline">Refresh records</Link>
    {!page.rows.length&&<p>No refund events on this page.</p>}
    {page.rows.map(row=><section key={row.eventId} className="space-y-2 rounded-xl border p-4 break-words">
      <h2 className="font-semibold">Refund {row.refundId}</h2>
      <p>Financial hold since {time(row.holdAt)} (UTC) · Revision {row.revision}</p>
      <p>Latest saved refund status: {row.refundStatus?.replaceAll("_"," ")??"Awaiting independent observation"}</p>
      <p>{row.amountCents===null?"Amount not yet independently observed":`$${(row.amountCents/100).toFixed(2)} USD observed refund amount`}</p>
      <p>Observation disposition: {row.disposition?.replaceAll("_"," ")??"Not recorded"} · {row.observations} saved history entries</p>
      <p>Event observed: {time(row.observedAt)} · Observation recorded: {time(row.appliedAt)} (UTC)</p>
      <p className="text-sm">Original attempt {row.attemptId} · Payment {row.paymentIntentId} · Charge {row.chargeId} · Event {row.eventId}</p>
      {row.lastReview&&<p>Operator review recorded {time(row.lastReview.recordedAt)} (UTC) for revision {row.lastReview.revision}.
        {row.lastReview.revision===row.revision?" Hold remains active.":" Original has changed since this review."}</p>}
      {fullRefundReviewAcknowledgementReady()&&<AcknowledgeReview key={`${row.eventId}:${row.revision}`} eventId={row.eventId} revision={row.revision}/>}
      {fullRefundReviewReconciliationReady()&&<ReconcileRefund key={`reconcile:${row.eventId}:${row.revision}`} eventId={row.eventId} revision={row.revision}/>}
    </section>)}
    <nav aria-label="Refund review pages" className="flex gap-5">
      {after&&<Link href={path} className="underline">First page</Link>}
      {page.nextCursor&&<Link href={`${path}?after=${encodeURIComponent(page.nextCursor)}`} className="underline">Next page</Link>}
    </nav>
  </div>;
}
