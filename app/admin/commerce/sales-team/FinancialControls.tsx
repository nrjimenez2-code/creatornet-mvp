"use client";
import {useRef,useState} from "react";
import {useRouter} from "next/navigation";
import {REFUND_REASON_OPTIONS,type RefundResponsibility} from "@/lib/refundAllocation";
export default function FinancialControls({receiptId,revision,refunds,reviewEnabled}:{receiptId:string;revision:number;refunds:{id:string;amountCents:number}[];reviewEnabled:boolean}){
 const router=useRouter(),busy=useRef(false),requests=useRef<Record<string,string>>({});
 const [pending,setPending]=useState(false),[message,setMessage]=useState(""),[refundId,setRefundId]=useState(""),[responsibility,setResponsibility]=useState<RefundResponsibility|"">(""),[reason,setReason]=useState("");
 async function run(action:"inspect"|"review_refund"){
  if(busy.current||action==="review_refund"&&(!refundId||!responsibility||!reason))return;
  busy.current=true;setPending(true);setMessage("");
  const key=action==="inspect"?"inspection":refundId;
  requests.current[key]??=crypto.randomUUID();
  try{
   const response=await fetch("/api/admin/sales-team/financial",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,receiptId,requestId:requests.current[key],...(action==="review_refund"?{refundId,expectedRevision:revision,responsibility,reasonCode:reason}:{})})});
   const result=await response.json();if(!response.ok||action==="inspect"&&typeof result.held!=="boolean"||action==="review_refund"&&result.holdRetained!==true)throw Error("Financial review retained");
   if(action==="inspect")setMessage(result.held?"Inspection recorded. Financial evidence still requires review.":"Inspection recorded. Current financial holds are clear. Bank payout is not confirmed.");
   else setMessage("Responsibility recorded. Inspect this receipt again to reconcile current costs and holds.");
   delete requests.current[key];router.refresh();
  }catch{setMessage("The original still needs review. The same request identity is retained for recovery.");}
  finally{busy.current=false;setPending(false);}
 }
 return <div className="space-y-3 border-t pt-3" aria-busy={pending}>
  <button type="button" disabled={pending} onClick={()=>void run("inspect")} className="rounded border px-3 py-2 disabled:opacity-50">{pending?"Working…":"Inspect original payment and costs"}</button>
  {reviewEnabled&&refunds.length>0?<fieldset disabled={pending} className="space-y-2"><legend>Review a successful refund</legend>
   <label className="block">Refund <select value={refundId} onChange={e=>{setRefundId(e.target.value);setReason("");}}><option value="">Choose a refund</option>{refunds.map(r=><option key={r.id} value={r.id}>{r.id} · ${(r.amountCents/100).toFixed(2)}</option>)}</select></label>
   <label className="block">Processing cost responsibility <select value={responsibility} onChange={e=>{setResponsibility(e.target.value as RefundResponsibility|"");setReason("");}}><option value="">Choose responsibility</option><option value="creator">Creator</option><option value="platform">CreatorNet</option></select></label>
   {responsibility?<p>{responsibility==="creator"?"The creator":"CreatorNet"} bears the refund’s original processing share and actual refund costs.</p>:null}
   <label className="block">Reason <select value={reason} onChange={e=>setReason(e.target.value)}><option value="">Choose a reason</option>{REFUND_REASON_OPTIONS.filter(r=>r.responsibility==="either"||r.responsibility===responsibility).map(r=><option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
   <p>This review is permanent and keeps the financial hold until a new inspection reconciles the receipt.</p>
   <button type="button" disabled={!refundId||!responsibility||!reason} onClick={()=>void run("review_refund")} className="rounded border px-3 py-2 disabled:opacity-50">Record responsibility</button>
  </fieldset>:null}
  <p role="status">{message}</p>
 </div>;
}
