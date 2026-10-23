import Link from "next/link";
import {notFound} from "next/navigation";
import {requireAdmin} from "@/lib/admin/server";
import {teamFinancialReconciliationReady,teamRefundReviewReady} from "@/lib/salesTeams/policy";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {readTeamFinancialAdmin} from "@/lib/salesTeams/financialAdmin";
import {teamMoney} from "@/lib/salesTeams/statements";
import FinancialControls from "./FinancialControls";
export const dynamic="force-dynamic";
const path="/admin/commerce/sales-team";
export default async function TeamFinancialPage({searchParams}:{searchParams:Promise<{after?:string|string[]}>}){
 const {user}=await requireAdmin();if(!teamFinancialReconciliationReady())notFound();
 const after=(await searchParams).after??null;if(after!==null&&(typeof after!=="string"||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(after)))notFound();
 let page:Awaited<ReturnType<typeof readTeamFinancialAdmin>>;
 try{page=await readTeamFinancialAdmin(createTeamPaymentContext(),user.id,after);}catch{return <div role="alert">Team financial records are unavailable. <Link href={path}>Refresh records</Link></div>;}
 return <div className="space-y-5"><Link href="/admin/commerce">← Commerce</Link><h1 className="text-2xl font-bold">Team financial inspections</h1>
  <p>{page.mode==="live"?"Live":"Test"} records. Inspect original payments and record responsibility for existing successful refunds.</p>
  <Link href={`${path}${after?`?after=${encodeURIComponent(after)}`:""}`}>Refresh records</Link>
  {!page.rows.length?<p>No receipts on this page.</p>:null}
  {page.rows.map(row=><section key={row.receiptId} className="space-y-2 rounded-xl border p-4 break-words"><h2 className="font-semibold">Receipt {row.receiptId}</h2>
   <p>Revision {row.revision} · {row.held?"Financial hold":"Current holds clear"} · {row.pendingChecks} pending inspections</p>
   <p>Collected subtotal {teamMoney(row.subtotalCents)} · Refunded {teamMoney(row.refundedCents)} · Combined principal loss {teamMoney(row.lossCents)}</p>
   <p>Original processing {row.processingCostCents===null?"Awaiting evidence":teamMoney(row.processingCostCents)} · Refund/dispute cost adjustment {teamMoney(row.adjustmentCostCents)} · Auxiliary processing credit {teamMoney(row.financialProcessingCreditCents)}</p>
   <p>Payment {row.paymentIntentId} · Charge {row.chargeId}</p>
   {row.reviews.map(r=><p key={r.refundId}>{r.refundId}: {r.responsibility==="platform"?"CreatorNet":"Creator"} responsibility · {r.reasonCode.replaceAll("_"," ")}</p>)}
   <FinancialControls key={`${row.receiptId}:${row.revision}`} receiptId={row.receiptId} revision={row.revision} reviewEnabled={teamRefundReviewReady()} refunds={row.refunds.filter(r=>r.status==="succeeded"&&!row.reviews.some(d=>d.refundId===r.id)).map(r=>({id:r.id,amountCents:r.amountCents}))}/>
  </section>)}
  <nav className="flex gap-5" aria-label="Team financial pages">{after?<Link href={path}>First page</Link>:null}{page.nextCursor?<Link href={`${path}?after=${encodeURIComponent(page.nextCursor)}`}>Next page</Link>:null}</nav>
 </div>;
}
