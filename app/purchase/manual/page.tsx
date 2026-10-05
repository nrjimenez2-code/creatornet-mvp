"use client";
import {Suspense,useEffect,useState} from "react";
import Link from "next/link";
import {useSearchParams} from "next/navigation";
import ManualMentorshipPayment from "@/components/ManualMentorshipPayment";
import {clearReleasedManualSelection} from "@/lib/manualPaymentBrowser";
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function Recovery(){
  const search=useSearchParams(),requestId=search.get("request_id"),productId=search.get("product_id"),mode=search.get("mode");
  const key=JSON.stringify([requestId,productId,mode]);
  const [loaded,setLoaded]=useState<{key:string;body:any}|null>(null),[error,setError]=useState(""),[revision,setRevision]=useState(0);
  const saved=loaded?.key===key?loaded.body:null;
  useEffect(()=>{
    const controller=new AbortController();setLoaded(null);setError("");
    if(Boolean(requestId)===Boolean(productId)||!uuid(requestId??productId)||!["full","installments"].includes(mode??"")){setError("Invalid original payment link.");return;}
    const endpoint=mode==="full"?`/api/checkout/manual?${requestId?"request_id="+requestId:"product_id="+productId}`:
      requestId?`/api/installments/reservations/${requestId}`:`/api/installments/reservations?product_id=${productId}`;
    void fetch(endpoint,{credentials:"include",cache:"no-store",signal:controller.signal}).then(async response=>{
      const body=await response.json(),t=body.terms;
      if(!response.ok||!uuid(body.requestId)||(requestId&&body.requestId!==requestId)||!uuid(t?.buyerId)||!uuid(t.productId)||!uuid(t.postId)||
        (productId&&t.productId!==productId)||
        body.providerOperationsAllowed!==false||typeof t.title!=="string"||!Number.isSafeInteger(t.amountCents)||t.amountCents<50||
        typeof body.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(body.fingerprint)||
        t.currency!=="usd"||(mode==="full"?t.kind!=="one_time"||!["saved_selection","released"].includes(body.status)||body.buyerId!==t.buyerId||body.productId!==t.productId:
          body.status!=="reserved"||t.kind!=="fixed_total_installments"||!Number.isInteger(t.paymentCount)||t.paymentCount<2||t.paymentCount>24||
          !Array.isArray(t.payments)||t.payments.length!==t.paymentCount||t.payments.some((p:any,i:number)=>p.number!==i+1||!Number.isSafeInteger(p.amountCents)||p.amountCents<50)||
          t.payments.reduce((sum:number,p:any)=>sum+p.amountCents,0)!==t.amountCents))throw Error("Your original payment could not be verified.");
      if(body.releasedAt!=null&&(typeof body.releasedAt!=="string"||!Number.isFinite(Date.parse(body.releasedAt))||Date.parse(body.releasedAt)<=0||Date.parse(body.releasedAt)>Date.now()+5000))throw Error("Your release needs review.");
      if(mode==="full"&&(body.releasedAt?(body.status!=="released"||body.canSwitchPaymentMode!==true):(body.status!=="saved_selection"||body.canSwitchPaymentMode!==false)))throw Error("Your release needs review.");
      if(!controller.signal.aborted){
        if(body.releasedAt)try{clearReleasedManualSelection(localStorage,{requestId:body.requestId,buyerId:t.buyerId,productId:t.productId,
          mode:mode as "full"|"installments",amountCents:t.amountCents});}catch{/* Keep historical server release readable. */}
        setLoaded({key,body});
      }
    }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:"Your payment needs review.");});
    return()=>controller.abort();
  },[requestId,productId,mode,revision,key]);
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <Link href="/dashboard" className="underline">Back to CreatorNet</Link><h1 className="text-2xl font-semibold">Your original payment</h1>
    {error?<p role="alert">{error}</p>:!saved?<p role="status">Loading your saved purchase…</p>:<>
      <h2 className="text-xl">{saved.terms.title}</h2><p>{saved.terms.billing}</p><p>{saved.terms.serviceDescription}</p>
      {saved.releasedAt?<><p role="status">This unpaid checkout was released.</p><Link className="underline" href={`/purchase/review?${new URLSearchParams({product_id:saved.terms.productId,post_id:saved.terms.postId})}`}>Review the current offer</Link></>:
        <ManualMentorshipPayment key={saved.requestId} requestId={saved.requestId} buyerId={saved.terms.buyerId} productId={saved.terms.productId}
          mode={mode as "full"|"installments"} amountCents={mode==="full"?saved.terms.amountCents:saved.terms.payments[0].amountCents}
          onReleased={at=>{try{clearReleasedManualSelection(localStorage,{requestId:saved.requestId,buyerId:saved.terms.buyerId,
            productId:saved.terms.productId,mode:mode as "full"|"installments",amountCents:saved.terms.amountCents});}catch{}
            setLoaded({key,body:{...saved,releasedAt:at}});}}/>}
      <Link className="block underline" href={`/purchase/manual?${new URLSearchParams({request_id:saved.requestId,mode:mode!})}`}>Open this original payment</Link>
      {mode==="installments"&&<Link className="block underline" href={`/payments/mentorship/${saved.requestId}`}>View your payment plan</Link>}
    </>}
    <button onClick={()=>setRevision(v=>v+1)} className="rounded-lg border px-4 py-2">Reload original payment</button>
    <a className="block underline" href="mailto:support@creatornet.net">support@creatornet.net</a>
  </main>;
}
export default function ManualRecoveryPage(){return <Suspense fallback={<p>Loading payment…</p>}><Recovery/></Suspense>;}
