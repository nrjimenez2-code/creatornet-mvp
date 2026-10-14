"use client";
import {useRef,useState} from "react";
export default function AcknowledgeReview({eventId,revision}:{eventId:string;revision:number}){
  const request=useRef<string|null>(null),busy=useRef(false);
  const [confirmed,setConfirmed]=useState(false),[pending,setPending]=useState(false),[message,setMessage]=useState("");
  async function recordReview(){
    if(!confirmed||busy.current)return;
    busy.current=true;setPending(true);setMessage("");
    try{
      request.current??=crypto.randomUUID();
      const response=await fetch("/api/admin/full-refund-review",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({requestId:request.current,eventId,revision,confirmHoldRetained:true})});
      const result=await response.json();
      if(!response.ok||result.status!=="review_recorded_hold_retained"||typeof result.current!=="boolean")throw Error("unavailable");
      setMessage(result.current?"Review recorded. Financial hold and backlog attention remain active.":"This review was recorded for an older revision. Refresh and review the changed original.");
    }catch{setMessage("Recording needs verification. Refresh this event; retrying here preserves the same review request. The financial hold remains required.");}
    finally{busy.current=false;setPending(false);}
  }
  return <div className="space-y-2 border-t pt-3">
    <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={pending} onChange={e=>setConfirmed(e.target.checked)}/>
      I reviewed this saved event and understand its financial hold remains active.</label>
    <button type="button" disabled={!confirmed||pending} onClick={recordReview} className="rounded border px-3 py-2 disabled:opacity-50">
      {pending?"Recording review…":"Record review — keep hold"}</button>
    <p role="status">{message}</p>
  </div>;
}
