"use client";
import {useEffect,useRef,useState} from "react";
import {createClient} from "@/lib/supabaseClient";
import {prepareSessionNavigation} from "@/lib/browserSession";
import {useTeamApi} from "@/lib/salesTeams/client";
import type {TeamExitQuote} from "@/lib/salesTeams/collection";
import type {PaymentResponse} from "./TeamBuyerPayment";
const money=(cents:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);
export default function TeamBuyerLifecycle({saleId,userId,paymentPhase,refreshKey,onPayment}:{saleId:string;userId:string;paymentPhase?:string;refreshKey?:number;onPayment:(data:PaymentResponse)=>void}){
 const api=useTeamApi(),[quote,setQuote]=useState<TeamExitQuote|null>(null),[enabled,setEnabled]=useState(false),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[refresh,setRefresh]=useState(0);
 const mounted=useRef(true),busyRef=useRef(false),path=`/api/sales-team/sales/${encodeURIComponent(saleId)}/lifecycle`;
 useEffect(()=>{mounted.current=true;const controller=new AbortController();void api(path,undefined,controller.signal).then(data=>{if(!controller.signal.aborted){setQuote(data.quote);setEnabled(data.payoffCollectionEnabled===true);setAccepted(false);setError(null);}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>{mounted.current=false;controller.abort();};},[api,path,refresh,paymentPhase,refreshKey]);
 const freshSession=async()=>{const client=createClient();if(!await prepareSessionNavigation(client))throw Error("Sign in again before managing this payment plan.");const session=await client.auth.getSession();if(session.error||session.data.session?.user.id!==userId||!mounted.current)throw Error("Your signed-in account changed. Reload this purchase.");};
 const act=async(action:"stop_renewal"|"revoke_debits"|"prepare_payoff")=>{
  if(busyRef.current||!quote)return;busyRef.current=true;setBusy(true);setError(null);
  try{await freshSession();if(action==="prepare_payoff"&&!accepted)throw Error("Review and confirm this one-time payoff first.");
   const data=await api(path,{action,request_id:crypto.randomUUID(),accepted:true,...(action==="prepare_payoff"?{fingerprint:quote.fingerprint}:{})});
   if(mounted.current){setQuote(data.quote);setAccepted(false);onPayment(data);}
  }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"The payment plan needs review.");}finally{busyRef.current=false;if(mounted.current)setBusy(false);}
 };
 const showOriginal=async()=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setError(null);try{const data=await api(`/api/sales-team/sales/${encodeURIComponent(saleId)}/payment`);if(mounted.current)onPayment(data);}catch(e){if(mounted.current)setError(e instanceof Error?e.message:"The original payoff needs review.");}finally{busyRef.current=false;if(mounted.current)setBusy(false);}};
 if(quote&&(quote.coveredPeriods<1||quote.paymentKind==="full"))return null;
 return <section className="space-y-3" aria-busy={busy}><h2>Manage your payment plan</h2>
  {error?<p role="alert">{error}</p>:null}{!quote?<button disabled={busy} onClick={()=>setRefresh(n=>n+1)}>Refresh payment plan</button>:<>
   <p>{quote.authorization}</p>
   {quote.paymentKind==="monthly"?<p>{quote.coveredPeriods} paid month(s); accepted minimum {quote.minimumMonths} month(s).</p>:null}
   {quote.automaticDebitsStopped?<p>Future automatic debits are stopped. Any contractual balance remains separate.</p>:<button disabled={busy} onClick={()=>void act("revoke_debits")}>Stop future automatic debits</button>}
   {quote.paymentKind==="monthly"?(quote.renewalStopped?<p>Renewal is stopped after your accepted minimum and paid period.</p>:<button disabled={busy} onClick={()=>void act("stop_renewal")}>Stop renewal after the minimum</button>):null}
   {quote.reviewReasons.length?<p role="status">An original payment or financial observation needs review before a payoff can be prepared. Refresh its payment status.</p>:null}
   {quote.payoff?.completed&&!quote.reviewReasons.length?<p>The accepted minimum is paid. Renewal has stopped. Paid access and promised support continue through {quote.minimumEnd?new Date(quote.minimumEnd).toLocaleString():"the accepted minimum end"}.</p>:quote.payoff?<button disabled={busy} onClick={()=>void showOriginal()}>View original payoff</button>:null}
   {quote.canAcceptPayoff&&quote.payoffAmountCents!==null?<><p>One-time payoff: {money(quote.payoffAmountCents)} for the remaining {quote.remainingMonths} month(s). Paid access and promised support continue through {quote.minimumEnd?new Date(quote.minimumEnd).toLocaleString():"the accepted minimum end"}. Payment details are confirmed separately.</p>
    <label><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)}/> I confirm this exact one-time payoff and its terms.</label>
    <button disabled={busy||!enabled||!accepted} onClick={()=>void act("prepare_payoff")}>Prepare one-time payoff of {money(quote.payoffAmountCents)}</button></>:null}
   <button disabled={busy} onClick={()=>setRefresh(n=>n+1)}>Refresh payment plan</button>
  </>}
 </section>;
}
