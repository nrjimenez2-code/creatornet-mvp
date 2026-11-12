"use client";
import Link from "next/link";
import {useSearchParams} from "next/navigation";
import {useCallback,useEffect,useRef,useState} from "react";
import {useUser} from "@/lib/useUser";
import {getActionSession} from "@/lib/actionSession";
import {useTeamApi} from "@/lib/salesTeams/client";
import {teamMoney,teamPayoutObservationStatus} from "@/lib/salesTeams/statements";
import {bankExceptionReasons} from "@/lib/salesTeams/bankExceptions";
import type {BankAlerts} from "@/lib/salesTeams/bankAlerts";
import styles from "../app/dashboard/closers/bookings.module.css";

export default function SalesTeamBankAlerts(){
 const {userId,loading}=useUser(),params=useSearchParams(),creator=params.get("creator_id")||userId||"";
 if(loading)return <main aria-busy="true" className={styles.page}>Loading payout alerts…</main>;
 if(!userId)return <main className={styles.page}><h1>Payout alerts</h1><p>Sign in to view your own financial history.</p><Link href="/auth">Sign in</Link></main>;
 return <AlertHistory key={JSON.stringify([userId,creator])} creator={creator} userId={userId}/>;
}
function AlertHistory({creator,userId}:{creator:string;userId:string}){
 const api=useTeamApi(),active=useRef<AbortController|null>(null),mounted=useRef(false),working=useRef(false),snapshot=useRef<BankAlerts|null>(null);
 const [data,setData]=useState<BankAlerts|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const read=useCallback(async(cursor:string|null)=>{
  active.current?.abort();const current=new AbortController();active.current=current;setLoading(true);setError(null);
  try{
   const result:BankAlerts=await api(`/api/sales-team/bank-alerts?creator_id=${encodeURIComponent(creator)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,undefined,current.signal);
   if(current.signal.aborted)return;
   const previous=snapshot.current;
   if(cursor&&previous&&(previous.scope!==result.scope||previous.membershipStatus!==result.membershipStatus))throw Error("Your access changed. Refresh the payout alerts.");
   const next=cursor&&previous?{...result,entries:[...previous.entries,...result.entries.filter(e=>!previous.entries.some(old=>old.alertId===e.alertId))]}:result;
   snapshot.current=next;setData(next);
  }catch(reason){if(!current.signal.aborted){snapshot.current=null;setData(null);setError(reason instanceof Error?reason.message:"Could not read payout alerts.");}}
  finally{if(!current.signal.aborted)setLoading(false);}
 },[api,creator]);
 useEffect(()=>{mounted.current=true;const timer=window.setTimeout(()=>void read(null),0);return()=>{mounted.current=false;window.clearTimeout(timer);active.current?.abort();};},[read]);
 const markRead=async(alertId:string)=>{
  if(working.current||loading||!snapshot.current?.canMarkRead)return;working.current=true;setBusy(true);setError(null);
  try{
   const current=await getActionSession();
   if(current.error||current.data.session?.user.id!==userId)throw Error("Your signed-in account changed. Reload the payout alerts.");
   if(!mounted.current)return;
   const response=await fetch("/api/sales-team/bank-alerts",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json",Authorization:`Bearer ${current.data.session.access_token}`},body:JSON.stringify({creator_id:creator,alert_id:alertId})});
   const result=await response.json();if(!mounted.current)return;
   if(!response.ok||result.alertId!==alertId||typeof result.readAt!=="string")throw Error(result.error||"The read status is uncertain. Refresh or explicitly retry this same alert.");
   // Fresh authorization also governs the resulting view; do not patch stale rows.
   await read(null);
  }catch(reason){if(mounted.current){snapshot.current=null;setData(null);setError(reason instanceof Error?reason.message:"Could not mark this alert read.");}}
  finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 return <main className={styles.page}><div className={styles.content}>
  <Link href={`/dashboard/closers/earnings?creator_id=${encodeURIComponent(creator)}`}>← Commission statements</Link><h1>Payout alerts</h1>
  <p>Recorded changes and reviews for your payout history. Bank receipt remains unconfirmed. Marking an alert read changes only your read history; the payout remains outstanding.</p>
  <p>Refresh reads saved alerts and does not check Stripe or your bank.</p>
  <Link href={`/dashboard/closers/bank-review?creator_id=${encodeURIComponent(creator)}`}>Payout review history</Link>
  {error?<p role="alert">{error}</p>:null}<button disabled={loading||busy} onClick={()=>void read(null)}>Refresh payout alerts</button>
  {loading?<p role="status">Loading payout alerts…</p>:null}
  {data?<>{data.membershipStatus==="removed"?<p>Team access was removed. Only your own financial history remains available.</p>:null}
   {data.entries.length?data.entries.map(entry=><article className={styles.panel} key={entry.alertId}>
    <h2>{entry.kind==="escalated"?"Payout review escalated":entry.kind==="acknowledged"?"Payout review acknowledged":"Payout observation changed"}</h2>
    <p>{bankExceptionReasons[entry.state.reason]||"Review required"}. Bank receipt unconfirmed.</p>
    <p>{entry.state.beneficiary==="creator"?"Creator":"Closer"} transfer recorded: {teamMoney(entry.state.transferredCents)}. Stripe payout: {teamPayoutObservationStatus[entry.state.payoutStatus]||"Review required"}.</p>
    <p>{entry.appliesToCurrentState?"Applies to the recorded state.":"Historical alert; the recorded state has changed."} · {new Date(entry.createdAt).toLocaleString()}</p>
    {entry.readAt?<p>Read by you · {new Date(entry.readAt).toLocaleString()}</p>:<button disabled={loading||busy||!data.canMarkRead} onClick={()=>void markRead(entry.alertId)}>Mark alert read</button>}
   </article>):<p>No alerts recorded for your current access. This does not confirm bank receipt or complete historical coverage.</p>}
   {data.hasMore&&data.nextCursor?<button disabled={loading||busy} onClick={()=>void read(data.nextCursor)}>Load older alerts</button>:null}
  </>:null}
 </div></main>;
}
