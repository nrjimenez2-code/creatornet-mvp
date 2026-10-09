"use client";
import {useRef,useState} from "react";
export default function ReconcileRefund({eventId,revision}:{eventId:string;revision:number}){
  const busy=useRef(false);
  const [confirmed,setConfirmed]=useState(false),[pending,setPending]=useState(false),[message,setMessage]=useState("");
  async function reconcile(){
    if(!confirmed||busy.current)return;
    busy.current=true;setPending(true);setMessage("");
    try{
      const response=await fetch("/api/admin/full-refund-review/reconcile",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({eventId,revision,confirmOriginalOnly:true})});
      const result=await response.json();
      if(!response.ok||result.status!=="original_reconciled_hold_retained"||result.holdRetained!==true)throw Error("unavailable");
      setMessage("Original observation reconciled. Refresh the saved state before reviewing it. The financial hold remains active.");
    }catch{setMessage("The original still needs review. Refresh its saved state; missing provenance or uncertainty cannot release the financial hold.");}
    finally{busy.current=false;setPending(false);setConfirmed(false);}
  }
  return <div className="space-y-2 border-t pt-3">
    <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={pending} onChange={e=>setConfirmed(e.target.checked)}/>
      Re-read this original refund and reconcile its saved accounting, keeping its financial hold.</label>
    <button type="button" disabled={!confirmed||pending} onClick={reconcile} className="rounded border px-3 py-2 disabled:opacity-50">
      {pending?"Reconciling original…":"Reconcile original refund"}</button>
    <p role="status">{message}</p>
  </div>;
}
