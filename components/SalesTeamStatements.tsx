"use client";
import Link from "next/link";
import {useRouter,useSearchParams} from "next/navigation";
import {useCallback,useEffect,useRef,useState} from "react";
import {useUser} from "@/lib/useUser";
import {useTeamApi} from "@/lib/salesTeams/client";
import {teamMoney,teamStatementStatus,teamPayoutObservationStatus,type TeamStatement} from "@/lib/salesTeams/statements";
import styles from "../app/dashboard/closers/bookings.module.css";
type Relationship={creator_id:string;role:string;status:string};
export default function SalesTeamStatements(){
 const {userId,loading:authLoading}=useUser(),api=useTeamApi(),params=useSearchParams(),router=useRouter();
 const creator=params.get("creator_id")||userId||"",scope=JSON.stringify([userId,creator]);
 const [data,setData]=useState<TeamStatement|null>(null),[relationships,setRelationships]=useState<Relationship[]>([]),[loadedScope,setLoadedScope]=useState("");
 const [loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null);const controller=useRef<AbortController|null>(null),busy=useRef(false);
 const load=useCallback(async(cursor:string|null,signal:AbortSignal)=>{
  if(!userId||!creator||busy.current)return;busy.current=true;setLoading(true);setError(null);
  try{
   const path=`/api/sales-team/statements?creator_id=${encodeURIComponent(creator)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`;
   const [statement,list]=await Promise.all([api(path,undefined,signal),cursor?Promise.resolve(null):api("/api/sales-team/statements",undefined,signal)]);
   if(signal.aborted)return;
   setData(previous=>cursor&&previous?.creatorId===creator?{...statement,entries:[...previous.entries,...statement.entries]}:statement);
   if(list)setRelationships(list.relationships);setLoadedScope(JSON.stringify([userId,creator]));
  }catch(reason){if(!signal.aborted){if(!cursor)setData(null);setError(reason instanceof Error?reason.message:"Could not load the statement.");setLoadedScope(JSON.stringify([userId,creator]));}}
  finally{busy.current=false;if(!signal.aborted)setLoading(false);}
 },[api,userId,creator]);
 useEffect(()=>{
  const current=new AbortController();controller.current=current;busy.current=false;
  const timer=window.setTimeout(()=>{if(!authLoading&&userId)void load(null,current.signal);},0);
  return()=>{window.clearTimeout(timer);current.abort();};
 },[load,authLoading,userId]);
 const refresh=()=>{if(controller.current)void load(null,controller.current.signal);};
 if(authLoading||userId&&loadedScope!==scope)return <main className={styles.page} aria-busy="true">Loading commission statements…</main>;
 if(!userId)return <main className={styles.page}><h1>Commission statements</h1><p>Sign in to view your own team earnings.</p><Link href="/auth">Sign in</Link></main>;
 return <main className={styles.page}><div className={styles.content}><Link href="/dashboard/closers">← Bookings</Link><h1>Commission statements</h1>
  <Link href="/dashboard/closers/payouts">Your payout setup</Link><label>Creator relationship<select value={creator} disabled={loading} onChange={event=>router.push(`/dashboard/closers/earnings?creator_id=${encodeURIComponent(event.target.value)}`)}>
   <option value={userId}>Your creator account</option>{relationships.filter(r=>r.creator_id!==userId).map(r=><option key={r.creator_id} value={r.creator_id}>{r.creator_id} · {r.status}</option>)}
  </select></label>
  <p>Statements show recorded commission obligations. Transfer completion, Stripe payout status and confirmed bank receipt are separate. Bank receipt is unconfirmed.</p>
  {error?<p role="alert">{error}</p>:null}<button disabled={loading} onClick={refresh}>Refresh statement</button>
  {data?<>{data.membershipStatus==="removed"?<p>Team access was removed. Your existing commission agreements and this statement remain available.</p>:null}
   <section className={styles.panel}><h2>{data.scope==="creator"?"Team commission totals":"Your commission totals"}</h2>
    <p>Earned: {teamMoney(data.totals.earnedCents)} · Unpaid: {teamMoney(data.totals.unpaidCents)} · Recovery due: {teamMoney(data.totals.recoveryCents)}</p>
    <p>Transfers recorded: {teamMoney(data.totals.releasedCents)} · Transfer reversals: {teamMoney(data.totals.reversedCents)}</p>
    {data.payoutEvidenceAsOf?<p>Statement read at {new Date(data.payoutEvidenceAsOf).toLocaleString()}. Each payout observation has its own recorded time; refreshing the statement does not check Stripe or your bank.</p>:<p>Additional bank-payout evidence is not yet recorded here.</p>}
   </section>
   {data.entries.length?data.entries.map(entry=><article key={entry.receiptId} className={styles.panel}><h2>{entry.title} · Payment {entry.periodNumber}</h2>
    <p>{teamStatementStatus[entry.status]||"Review required"} · Hold until {new Date(entry.holdUntil).toLocaleString()}</p>
    <p>Earned {teamMoney(entry.earnedCents)} · Unpaid {teamMoney(entry.unpaidCents)} · Recovery {teamMoney(entry.recoveryCents)}</p>
    {entry.payoutEvidence?<section aria-label="Recorded payout observations"><h3>Recorded payout observations</h3>
     {entry.payoutEvidence.length?entry.payoutEvidence.map((evidence,index)=><div key={`${evidence.beneficiary}:${evidence.transferredAt}:${index}`}>
      <p>{evidence.beneficiary==="creator"?"Creator":"Closer"} transfer recorded: {teamMoney(evidence.transferredCents)} · {new Date(evidence.transferredAt).toLocaleString()}</p>
      <p>Stripe payout: {teamPayoutObservationStatus[evidence.payoutStatus]||"Review required"}{evidence.observedAt?` · Observed ${new Date(evidence.observedAt).toLocaleString()}`:""}. Bank receipt unconfirmed.</p>
      {evidence.reversedCents!=="0"?<p>Transfer reversals recorded: {teamMoney(evidence.reversedCents)}. The payout observation is historical and does not establish remaining funds.</p>:null}
     </div>):<p>No completed transfer evidence recorded for this receipt.</p>}
     {entry.hasMorePayoutEvidence?<p>Only the latest 20 completed transfers are shown for this receipt. Older transfer evidence is omitted; commission totals above include all recorded entries.</p>:null}
    </section>:null}
    {data.scope==="creator"&&entry.creatorAccounting?<details><summary>Creator accounting</summary>
     <p>Sale subtotal {teamMoney(entry.creatorAccounting.saleSubtotalCents)} · Creator proceeds {teamMoney(entry.creatorAccounting.creatorProceedsCents)} · Platform revenue {teamMoney(entry.creatorAccounting.platformRevenueCents)}</p>
     <p>Recorded processing cost {teamMoney(entry.creatorAccounting.actualProcessingCostCents)} · Processing reserve {teamMoney(entry.creatorAccounting.processingReserveCents)} · Payout-cost reserve {teamMoney(entry.creatorAccounting.payoutCostReserveCents)}</p>
     {entry.creatorAccounting.actualFinancialAdjustmentCostCents!==undefined?<p>Refund and dispute cost adjustment {teamMoney(entry.creatorAccounting.actualFinancialAdjustmentCostCents)} · Total platform processing credit {teamMoney(entry.creatorAccounting.platformProcessingCreditCents)} · Refund and dispute processing credit {teamMoney(entry.creatorAccounting.financialProcessingCreditCents??0)}</p>:null}
     <p>Creator deficit {teamMoney(entry.creatorAccounting.creatorDeficitCents)} · Tax reserve {teamMoney(entry.creatorAccounting.taxReserveCents)}</p>
    </details>:null}
   </article>):<p>No commission receipts recorded for this relationship.</p>}
   {data.nextCursor?<button disabled={loading} onClick={()=>{if(controller.current)void load(data.nextCursor,controller.current.signal);}}>Load older receipts</button>:null}
  </>:null}
 </div></main>;
}
