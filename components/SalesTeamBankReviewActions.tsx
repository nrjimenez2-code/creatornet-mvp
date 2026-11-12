"use client";
import {useEffect,useRef,useState} from "react";
import {getActionSession} from "@/lib/actionSession";
import {TeamApiError,useTeamApi} from "@/lib/salesTeams/client";
import {bankReviewStorageKey,readBankReviewIntent,bankReviewBody,bankReviewResultMatches,type BankReviewIntent,type BankReviewAction} from "@/lib/salesTeams/bankReviewIntent";

export default function SalesTeamBankReviewActions({userId,creator,request,stateSha256,canReview,onRecorded}:{
 userId:string;creator:string;request:string;stateSha256:string;canReview:boolean;onRecorded:()=>void
}){
 const api=useTeamApi(),scope={actor:userId,creator,request},storageKey=bankReviewStorageKey(scope);
 const mounted=useRef(false),working=useRef(false),original=useRef<BankReviewIntent|null>(null);
 const [ready,setReady]=useState(false),[pending,setPending]=useState<BankReviewIntent|null>(null),[busy,setBusy]=useState(false);
 const [error,setError]=useState<string|null>(null),[storageError,setStorageError]=useState<string|null>(null),[blockedHash,setBlockedHash]=useState<string|null>(null);
 useEffect(()=>{
  mounted.current=true;
  const timer=window.setTimeout(()=>{
   try{const saved=readBankReviewIntent(window.sessionStorage.getItem(storageKey),{actor:userId,creator,request});original.current=saved;setPending(saved);}
   catch{setStorageError("A saved review request is unavailable or needs reconciliation. New reviews are held.");}
   setReady(true);
  },0);
  return()=>{mounted.current=false;window.clearTimeout(timer);};
 },[storageKey,userId,creator,request]);
 const submit=async(action?:BankReviewAction)=>{
  if(!ready||!canReview||storageError||working.current||!pending&&blockedHash===stateSha256)return;
  if(action&&original.current)return;
  working.current=true;setBusy(true);setError(null);
  let intent:BankReviewIntent|null=null;
  try{
   const current=await getActionSession();
   if(current.error||current.data.session?.user.id!==userId)throw Error("Your signed-in account changed. Reload this history before reviewing it.");
   if(!mounted.current)return;
   const saved=readBankReviewIntent(window.sessionStorage.getItem(storageKey),scope);
   if(original.current&&(!saved||JSON.stringify(bankReviewBody(saved))!==JSON.stringify(bankReviewBody(original.current))))
    throw Error("The saved original review request changed. Reconcile it before continuing.");
   if(!original.current&&saved){original.current=saved;setPending(saved);throw Error("Resume the saved original review request before choosing another action.");}
   intent=original.current;
   if(!intent){
    if(!action)throw Error("Refresh this history before choosing a review.");
    intent=readBankReviewIntent(JSON.stringify({...scope,version:1,reviewId:crypto.randomUUID(),action,stateSha256}),scope)!;
    // Persist the immutable intent before dispatch. A storage failure sends no POST.
    window.sessionStorage.setItem(storageKey,JSON.stringify(intent));original.current=intent;setPending(intent);
   }
   const result=await api("/api/sales-team/bank-review",bankReviewBody(intent));
   if(!mounted.current)return;
   if(!bankReviewResultMatches(result,intent))throw Error("The review outcome is uncertain. Retry only the saved original request.");
   window.sessionStorage.removeItem(storageKey);original.current=null;setPending(null);onRecorded();
  }catch(reason){
   if(!mounted.current)return;
   // Only the read-committed wrapper's distinct rejection proves non-commit.
   // Legacy state errors and ambiguous outcomes retain the original intent.
   if(intent&&reason instanceof TeamApiError&&reason.code==="BANK_REVIEW_ACTION_STATE_CHANGED"&&reason.status===409){
    try{window.sessionStorage.removeItem(storageKey);original.current=null;setPending(null);setBlockedHash(intent.stateSha256);
     setError("The recorded payout state changed and this review was not recorded. Refresh the selected history before choosing a new review.");}
    catch{setError("The original review request could not be cleared. Keep it for reconciliation.");}
   }else setError(reason instanceof Error?reason.message:"The review outcome needs reconciliation. Retry only the saved original request.");
  }finally{working.current=false;if(mounted.current)setBusy(false);}
 };
 const held=!ready||busy||!canReview||!!storageError,stale=blockedHash===stateSha256;
 return <section aria-label="Record payout review"><h3>Record a review</h3>
  <p>Acknowledgement records that you reviewed this observation. Escalation records that it needs further review. Both leave bank receipt unconfirmed and the item outstanding.</p>
  {storageError?<p role="alert">{storageError}</p>:null}{error?<p role="alert">{error}</p>:null}
  {!canReview?<p>Recording reviews is currently held or unavailable to your account. Recorded history remains readable.</p>:null}
  {pending?<><p>The original {pending.action==="escalated"?"escalation":"acknowledgement"} request needs reconciliation. A retry uses the same saved intent.</p>
   <button disabled={held} onClick={()=>void submit()}>Retry original review request</button></>:<>
   <button disabled={held||stale} onClick={()=>void submit("acknowledged")}>Acknowledge observation</button>
   <button disabled={held||stale} onClick={()=>void submit("escalated")}>Escalate observation</button></>}
 </section>;
}
