"use client";
import {useEffect,useRef,useState} from "react";
import {createClient} from "@/lib/supabaseClient";
import {getActionSession} from "@/lib/actionSession";
import {prepareSessionNavigation} from "@/lib/browserSession";
import {useTeamApi} from "@/lib/salesTeams/client";
import type {TeamRetryQuote} from "@/lib/salesTeams/collection";
import type {PaymentResponse} from "./TeamBuyerPayment";
export default function TeamBuyerRetry({saleId,userId,originalObligationId,refreshKey,showReview,onPayment}:{saleId:string;userId:string;originalObligationId:string|null;refreshKey:number;showReview:boolean;onPayment:(data:PaymentResponse)=>void}){
 const api=useTeamApi(),[quote,setQuote]=useState<TeamRetryQuote|null>(null),[enabled,setEnabled]=useState(false),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[refresh,setRefresh]=useState(0);
 const mounted=useRef(true),busyRef=useRef(false),path=`/api/sales-team/sales/${encodeURIComponent(saleId)}/retry`,query=originalObligationId?`?obligation_id=${encodeURIComponent(originalObligationId)}`:"";
 useEffect(()=>{mounted.current=true;const controller=new AbortController();void api(path+query,undefined,controller.signal).then(data=>{if(!controller.signal.aborted){setQuote(data.status==="ready"?data.quote:null);setEnabled(data.collectionEnabled===true);setAccepted(false);setError(null);}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>{mounted.current=false;controller.abort();};},[api,path,query,refresh,refreshKey]);
 const prepare=async()=>{
  if(busyRef.current||!quote||!accepted)return;busyRef.current=true;setBusy(true);setError(null);
  try{const client=createClient();if(!await prepareSessionNavigation(client))throw Error("Sign in again before preparing a manual payment.");const session=await getActionSession();if(session.error||session.data.session?.user.id!==userId||!mounted.current)throw Error("Your signed-in account changed. Reload this purchase.");
   const data=await api(path,{action:"prepare_retry",request_id:crypto.randomUUID(),original_obligation_id:quote.originalObligationId,fingerprint:quote.fingerprint,accepted:true});if(mounted.current){setAccepted(false);onPayment(data);}
  }catch(e){if(mounted.current){setError(e instanceof Error?e.message:"The original manual attempt needs review.");setAccepted(false);}}finally{busyRef.current=false;if(mounted.current)setBusy(false);}
 };
 const original=async()=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setError(null);try{const data=await api(`/api/sales-team/sales/${encodeURIComponent(saleId)}/payment`);if(mounted.current)onPayment(data);}catch(e){if(mounted.current)setError(e instanceof Error?e.message:"The original payment needs review.");}finally{busyRef.current=false;if(mounted.current)setBusy(false);}};
 if(!quote&&!showReview&&!error)return null;
 return <section className="space-y-3" aria-busy={busy}><h2>Manual payment review</h2>{error?<p role="alert">{error}</p>:null}
  {quote?<><p>{quote.authorization}</p><p>Payment {quote.periodNumber}: {new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(quote.amountCents/100)}. {quote.periodEnd?`This review applies before ${new Date(quote.periodEnd).toLocaleString()}.`:"Your accepted purchase amount and schedule stay fixed."}</p><p>The payment window lasts up to 24 hours after you accept this review and can end sooner at the displayed service boundary.</p>
   <label><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)}/> I confirm this exact new manual attempt. Automatic debits stay stopped.</label>
   <button disabled={busy||!enabled||!accepted} onClick={()=>void prepare()}>Prepare manual payment</button></>:<p role="status">Use Stop and refresh the current payment first. A new manual attempt is available only after the previous payment is canceled or confirmed not to have been sent, and its financial review is clear.</p>}
  <button disabled={busy} onClick={()=>setRefresh(n=>n+1)}>Refresh manual review</button><button disabled={busy} onClick={()=>void original()}>View current original payment</button>
 </section>;
}
