"use client";
import Link from "next/link";
import {useSearchParams} from "next/navigation";
import {useCallback,useEffect,useRef,useState} from "react";
import {useUser} from "@/lib/useUser";
import {useTeamApi} from "@/lib/salesTeams/client";
import {teamMoney,teamPayoutObservationStatus} from "@/lib/salesTeams/statements";
import {bankExceptionReasons,type BankExceptionState,type BankExceptionQueue,type BankExceptionDetail} from "@/lib/salesTeams/bankExceptions";
import styles from "../app/dashboard/closers/bookings.module.css";

function Observation({state}:{state:BankExceptionState}){
 return <><p>{bankExceptionReasons[state.reason]||"Review required"}. Bank receipt unconfirmed; this item remains outstanding.</p>
  <p>{state.beneficiary==="creator"?"Creator":"Closer"} transfer recorded: {teamMoney(state.transferredCents)} · {new Date(state.transferredAt).toLocaleString()}</p>
  <p>Stripe payout: {teamPayoutObservationStatus[state.payoutStatus]||"Review required"}{state.observedAt?` · Observed ${new Date(state.observedAt).toLocaleString()}`:""}</p>
  {state.reversedCents!=="0"?<p>Transfer reversals recorded: {teamMoney(state.reversedCents)}. Historical payout observations do not establish remaining funds.</p>:null}</>;
}
export default function SalesTeamBankExceptions(){
 const {userId,loading}=useUser(),params=useSearchParams(),creator=params.get("creator_id")||userId||"";
 if(loading)return <main aria-busy="true" className={styles.page}>Loading payout review history…</main>;
 if(!userId)return <main className={styles.page}><h1>Payout review history</h1><p>Sign in to view your own financial history.</p><Link href="/auth">Sign in</Link></main>;
 return <ExceptionQueue key={JSON.stringify([userId,creator])} creator={creator}/>;
}
function ExceptionQueue({creator}:{creator:string}){
 const api=useTeamApi(),active=useRef<AbortController|null>(null);
 const [data,setData]=useState<BankExceptionQueue|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null),[selected,setSelected]=useState<string|null>(null);
 const read=useCallback(async(cursor:string|null)=>{
  active.current?.abort();const current=new AbortController();active.current=current;setLoading(true);setError(null);
  try{
   const result:BankExceptionQueue=await api(`/api/sales-team/bank-review/queue?creator_id=${encodeURIComponent(creator)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,undefined,current.signal);
   if(current.signal.aborted)return;
   setData(previous=>cursor&&previous?{...result,entries:[...previous.entries,...result.entries.filter(e=>!previous.entries.some(old=>old.state.requestId===e.state.requestId))]}:result);
   if(!cursor)setSelected(null);
  }catch(reason){if(!current.signal.aborted){setData(null);setSelected(null);setError(reason instanceof Error?reason.message:"Could not load payout reviews.");}}
  finally{if(!current.signal.aborted)setLoading(false);}
 },[api,creator]);
 useEffect(()=>{const timer=window.setTimeout(()=>void read(null),0);return()=>{window.clearTimeout(timer);active.current?.abort();};},[read]);
 return <main className={styles.page}><div className={styles.content}>
  <Link href={`/dashboard/closers/earnings?creator_id=${encodeURIComponent(creator)}`}>← Commission statements</Link><h1>Payout review history</h1>
  <p>These completed transfers still await confirmed bank receipt. An acknowledgement or escalation does not confirm a deposit or close an item.</p>
  <p>Refreshing reads recorded history only; it does not check Stripe or your bank.</p>
  {error?<p role="alert">{error}</p>:null}<button disabled={loading} onClick={()=>void read(null)}>Refresh payout reviews</button>
  {loading?<p role="status">Loading payout reviews…</p>:null}
  {data?<>{data.membershipStatus==="removed"?<p>Team access was removed. Only your own financial history remains available.</p>:null}
   <p>List read at {new Date(data.readAt).toLocaleString()}. Newer observations may change review applicability; refresh to see the latest recorded state.</p>
   {data.entries.length?data.entries.map(entry=><article className={styles.panel} key={entry.state.requestId}>
    <h2>{entry.state.beneficiary==="creator"?"Creator":"Closer"} payout observation</h2><Observation state={entry.state}/>
    {entry.latestReview?<p>Latest review: {entry.latestReview.action==="escalated"?"Escalated":"Acknowledged"} by {entry.latestReview.actorRole==="owner"?"creator":"manager"} · {new Date(entry.latestReview.reviewedAt).toLocaleString()}.
     {entry.latestReview.appliesToCurrentState?" Applies to the recorded state.":" Historical review; the recorded state has changed."}</p>:<p>No review recorded.</p>}
    <button onClick={()=>setSelected(entry.state.requestId)} disabled={loading}>View review history</button>
   </article>):<p>No completed transfer originals are recorded for your access to this relationship. This does not confirm a bank deposit.</p>}
   {data.hasMore&&data.nextCursor?<button disabled={loading} onClick={()=>void read(data.nextCursor)}>Load older transfers</button>:null}
   {selected?<ExceptionDetail key={selected} creator={creator} request={selected}/>:null}
  </>:null}
 </div></main>;
}
function ExceptionDetail({creator,request}:{creator:string;request:string}){
 const api=useTeamApi(),active=useRef<AbortController|null>(null),snapshot=useRef<BankExceptionDetail|null>(null);
 const [data,setData]=useState<BankExceptionDetail|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null);
 const read=useCallback(async(cursor:string|null)=>{
  active.current?.abort();const current=new AbortController();active.current=current;setLoading(true);setError(null);
  try{
   const result:BankExceptionDetail=await api(`/api/sales-team/bank-review?creator_id=${encodeURIComponent(creator)}&request_id=${encodeURIComponent(request)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,undefined,current.signal);
   if(current.signal.aborted)return;
   if(cursor&&snapshot.current?.stateSha256!==result.stateSha256)throw Error("The recorded payout state changed. Refresh this history before loading older reviews.");
   const next=cursor&&snapshot.current?{...result,history:[...snapshot.current.history,...result.history.filter(r=>!snapshot.current!.history.some(old=>old.reviewId===r.reviewId))]}:result;
   snapshot.current=next;setData(next);
  }catch(reason){if(!current.signal.aborted){snapshot.current=null;setData(null);setError(reason instanceof Error?reason.message:"Could not read review history.");}}
  finally{if(!current.signal.aborted)setLoading(false);}
 },[api,creator,request]);
 useEffect(()=>{const timer=window.setTimeout(()=>void read(null),0);return()=>{window.clearTimeout(timer);active.current?.abort();};},[read]);
 return <section className={styles.panel} aria-label="Selected payout review history"><h2>Selected payout review history</h2>
  {error?<p role="alert">{error}</p>:null}<button disabled={loading} onClick={()=>void read(null)}>Refresh selected history</button>
  {loading?<p role="status">Loading review history…</p>:null}
  {data?<><Observation state={data.state}/>{data.history.length?<ol>{data.history.map(review=><li key={review.reviewId}>
   {review.action==="escalated"?"Escalated":"Acknowledged"} by {review.actorRole==="owner"?"creator":"manager"} · {new Date(review.reviewedAt).toLocaleString()}.
   {review.appliesToCurrentState?" Applies to the current recorded state.":" Historical review; the recorded state has changed."}
  </li>)}</ol>:<p>No review recorded for this transfer.</p>}
   {data.hasMoreHistory&&data.nextCursor?<button disabled={loading} onClick={()=>void read(data.nextCursor)}>Load older reviews</button>:null}</>:null}
 </section>;
}
