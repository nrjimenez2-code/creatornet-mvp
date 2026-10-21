"use client";
import Link from "next/link";
import {useEffect,useRef,useState} from "react";
import {useUser} from "@/lib/useUser";
import {useTeamApi} from "@/lib/salesTeams/client";
import type {publicTeamSaleTerms} from "@/lib/salesTeams/agreement";

type Review={terms:ReturnType<typeof publicTeamSaleTerms>;fingerprint:string;status:string};
export default function TeamBuyerReview({saleId}:{saleId:string}){
 const {userId,loading:authLoading}=useUser(),api=useTeamApi();const [review,setReview]=useState<Review|null>(null),[error,setError]=useState<string|null>(null),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false);
 const busyRef=useRef(false),[refresh,setRefresh]=useState(0),[loadedFor,setLoadedFor]=useState("");
 const scope=JSON.stringify([saleId,userId]);
 useEffect(()=>{if(!userId||authLoading)return;const controller=new AbortController();void api(`/api/sales-team/sales/${encodeURIComponent(saleId)}`,undefined,controller.signal)
  .then(data=>{if(!controller.signal.aborted){setReview(data);setError(null);setAccepted(false);setLoadedFor(JSON.stringify([saleId,userId]));}})
  .catch(e=>{if(!controller.signal.aborted){setReview(null);setError(e.message);setLoadedFor(JSON.stringify([saleId,userId]));}});return()=>controller.abort();},[api,saleId,userId,authLoading,refresh]);
 const confirm=async()=>{
  if(!review||!accepted||busyRef.current)return;busyRef.current=true;setBusy(true);setError(null);
  try{await api(`/api/sales-team/sales/${encodeURIComponent(saleId)}`,{accepted:true,version:review.terms.version,fingerprint:review.fingerprint});setReview({...review,status:"accepted"});}
  catch(e){setError(e instanceof Error?e.message:"Review needs refreshing.");}finally{busyRef.current=false;setBusy(false);}
 };
 const money=(cents:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);
 if(authLoading)return <main aria-busy="true">Loading your account…</main>;
 if(!userId)return <main className="mx-auto max-w-2xl space-y-4 p-6"><h1>Review your purchase</h1><p>Sign in to the buyer account for this booking.</p><Link href={`/auth?next=${encodeURIComponent(`/purchase/team/${saleId}`)}`}>Sign in</Link></main>;
 if(loadedFor!==scope)return <main aria-busy="true">Loading the approved purchase…</main>;
 return <main className="mx-auto max-w-2xl space-y-5 p-6"><Link href="/dashboard">← CreatorNet</Link><h1>{review?.terms.title||"Review your purchase"}</h1>
  {error?<p role="alert">{error}</p>:null}{!review?<button onClick={()=>setRefresh(n=>n+1)}>Refresh review</button>:<>
   <p>{review.terms.description}</p><p>{review.terms.billing}</p>{"serviceDescription" in review.terms?<p>{String(review.terms.serviceDescription)}</p>:null}
   <p>{review.terms.paymentKind==="monthly"?"Monthly price":"Purchase total"}: <strong>{money(review.terms.amountCents)}</strong></p>
   {review.terms.paymentKind==="installments"?<ol>{review.terms.payments.map(p=><li key={p.number}>Payment {p.number}: {money(p.amountCents)}{p.number===1?" at checkout":" monthly"}</li>)}</ol>:null}
   <h2>Purchase and refund terms</h2><p>{review.terms.policy.refunds}</p><p>{review.terms.policy.eligibility}</p><p>{review.terms.policy.delivery}</p><p>{review.terms.policy.refundFees}</p><p>{review.terms.policy.authorization}</p>
   {review.terms.paymentKind==="installments"?<p>{review.terms.policy.installments}</p>:null}
   {review.terms.paymentKind==="monthly"?<p>{review.terms.policy.memberships}</p>:null}
   {review.terms.purchaseKind==="paid_call"?<p>{review.terms.policy.calls}</p>:null}
   {review.status!=="accepted"?<><label><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)} /> I have reviewed and accept this offer, payment schedule, and purchase terms.</label>
    <button disabled={!accepted||busy} onClick={()=>void confirm()}>{busy?"Recording acceptance…":"Accept purchase terms"}</button></>:<p role="status">Your purchase terms are accepted. Payment is not yet recorded.</p>}
  </>}
 </main>;
}
