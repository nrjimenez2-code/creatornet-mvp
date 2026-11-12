"use client";
import {Suspense,useEffect,useState} from "react";
import {useRouter,useSearchParams} from "next/navigation";
function Return(){
  const search=useSearchParams(),attempt=search.get("attempt"),router=useRouter();const [message,setMessage]=useState("Recovering your original payment…");
  useEffect(()=>{
    const controller=new AbortController();
    // Never consume a redirect status or client secret as payment evidence.
    window.history.replaceState(null,"",window.location.pathname+(attempt?"?"+new URLSearchParams({attempt}):""));
    if(!attempt||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attempt)){
      setMessage("Invalid original payment link. Reopen your saved checkout.");return;
    }
    void fetch(`/api/checkout/manual/resolve?${new URLSearchParams({attempt_id:attempt??""})}`,{credentials:"include",cache:"no-store",signal:controller.signal})
      .then(async response=>{
        const body=await response.json();if(!response.ok||!['full','installments'].includes(body.mode)||typeof body.requestId!=="string"||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))throw Error();
        if(!controller.signal.aborted)router.replace(`/purchase/manual?${new URLSearchParams({request_id:body.requestId,mode:body.mode})}`);
      }).catch(()=>{if(!controller.signal.aborted)setMessage("Your payment needs a status check. Reopen the original checkout or contact support before starting another payment.");});
    return()=>controller.abort();
  },[attempt,router]);
  return <main className="mx-auto max-w-3xl space-y-4 p-6"><h1 className="text-2xl">Payment recovery</h1><p role="status">{message}</p><a href="mailto:support@creatornet.net">support@creatornet.net</a></main>;
}
export default function PaymentReturnPage(){return <Suspense fallback={<p>Recovering payment…</p>}><Return/></Suspense>;}
