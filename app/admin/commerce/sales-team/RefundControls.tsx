"use client";
import {useEffect,useRef,useState} from "react";
import {useRouter} from "next/navigation";
import {REFUND_REASON_OPTIONS,isRefundReasonCode,isRefundResponsibility,reasonMatchesResponsibility,type RefundReasonCode,type RefundResponsibility} from "@/lib/refundAllocation";
import {teamMoney} from "@/lib/salesTeams/statements";
import type {TeamRefundRequestSummary} from "@/lib/salesTeams/financialAdmin";
type Create={action:"create";receiptId:string;requestId:string;expectedRevision:number;amountCents:number;responsibility:RefundResponsibility;reasonCode:RefundReasonCode;confirm:true};
type Preview={receiptId:string;revision:number;amountCents:number;responsibility:RefundResponsibility;reasonCode:RefundReasonCode;originalProcessingShareCents:number};
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const cents=(value:string)=>{if(!/^\d{1,6}(\.\d{1,2})?$/.test(value))return null;const [whole,fraction=""]=value.split(".");return Number(BigInt(whole)*100n+BigInt(fraction.padEnd(2,"0")));};
function validSaved(v:unknown,actorId:string,receiptId:string,mode:string):Create|null{
 if(!v||typeof v!=="object")return null;const c=v as Record<string,unknown>,b=c.request as Record<string,unknown>|null;
 if(c.version!=="team-admin-refund-v1"||c.actorId!==actorId||c.mode!==mode||!b||b.action!=="create"||b.receiptId!==receiptId||!uuid(b.requestId)||!Number.isSafeInteger(b.expectedRevision)||Number(b.expectedRevision)<0||!Number.isSafeInteger(b.amountCents)||Number(b.amountCents)<1||Number(b.amountCents)>99999999||b.confirm!==true||!isRefundResponsibility(b.responsibility)||!isRefundReasonCode(b.reasonCode)||!reasonMatchesResponsibility(b.reasonCode,b.responsibility)||Object.keys(b).some(k=>!["action","receiptId","requestId","expectedRevision","amountCents","responsibility","reasonCode","confirm"].includes(k)))return null;
 return b as Create;
}
export default function RefundControls({actorId,receiptId,mode,enabled,requests}:{actorId:string;receiptId:string;mode:string;enabled:boolean;requests:TeamRefundRequestSummary[]}){
 const router=useRouter(),busy=useRef(false),original=useRef<Create|null>(null),key=`cn:team-admin-refund:v1:${mode}:${actorId}:${receiptId}`;
 const [ready,setReady]=useState(false),[saved,setSaved]=useState<Create|null>(null),[blocked,setBlocked]=useState(false),[amount,setAmount]=useState(""),[responsibility,setResponsibility]=useState<RefundResponsibility|"">(""),[reason,setReason]=useState(""),[preview,setPreview]=useState<Preview|null>(null),[confirmed,setConfirmed]=useState(false),[pending,setPending]=useState(false),[message,setMessage]=useState("");
 useEffect(()=>{const timer=window.setTimeout(()=>{
  try{const text=sessionStorage.getItem(key);if(text){const value=validSaved(JSON.parse(text),actorId,receiptId,mode);if(!value){setBlocked(true);setMessage("The saved request needs review. Use the original server requests below.");}else{original.current=value;setSaved(value);setAmount((value.amountCents/100).toFixed(2));setResponsibility(value.responsibility);setReason(value.reasonCode);setMessage("An original refund request is saved. Recover its outcome before starting another request.");}}}
  catch{setBlocked(true);setMessage("The saved request could not be read. Review the original server requests below.");}setReady(true);
 },0);return()=>window.clearTimeout(timer);},[actorId,receiptId,mode,key]);
 const api=async(body:Record<string,unknown>)=>{const response=await fetch("/api/admin/sales-team/refunds",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error("Original refund needs review");return result;};
 const run=async(action:()=>Promise<void>)=>{if(busy.current)return;busy.current=true;setPending(true);setMessage("");try{await action();}catch{setMessage(original.current?"The original refund needs review. Its saved identity is retained; recover the original outcome.":"This action could not be completed. Refresh the financial records and review the current totals before trying again.");}finally{busy.current=false;setPending(false);}};
 const observe=(result:{requestId?:string;held?:boolean;disposition?:string;providerStatus?:string|null},requestId:string)=>{
  if(result.requestId!==requestId||typeof result.held!=="boolean"||typeof result.disposition!=="string")throw Error("Unverified result");
  const finished=!result.held&&["refund_observed","refund_not_completed","canceled_before_dispatch"].includes(result.disposition);
  if(finished&&original.current?.requestId===requestId){const stored=sessionStorage.getItem(key);if(stored&&validSaved(JSON.parse(stored),actorId,receiptId,mode)?.requestId===requestId)sessionStorage.removeItem(key);original.current=null;setSaved(null);setPreview(null);setConfirmed(false);}
  setMessage(result.disposition==="refund_observed"?`Original refund observed${result.held?"; financial review remains":""}. Bank receipt is not confirmed.`:result.disposition==="refund_not_completed"?`The original refund did not complete. ${result.held?"Its principal and costs still need financial review.":"Its principal and costs have been reconciled."}`:result.disposition==="canceled_before_dispatch"?`The original request was canceled before provider dispatch.${result.held?" Financial review remains.":""}`:"Original outcome still needs recovery or financial review.");router.refresh();
 };
 const loadPreview=()=>void run(async()=>{const value=cents(amount);if(value===null||value<1||!isRefundResponsibility(responsibility)||!isRefundReasonCode(reason)||!reasonMatchesResponsibility(reason,responsibility))throw Error("Invalid amount or responsibility");const result=await api({action:"preview",receiptId,amountCents:value,responsibility,reasonCode:reason});if(result.receiptId!==receiptId||result.amountCents!==value||result.responsibility!==responsibility||result.reasonCode!==reason||!Number.isSafeInteger(result.revision)||!Number.isSafeInteger(result.originalProcessingShareCents))throw Error("Invalid preview");setPreview(result);setConfirmed(false);});
 const dispatch=()=>void run(async()=>{
  if(!confirmed||!enabled||blocked)return;
  if(!original.current){if(!preview)throw Error("Preview required");const body:Create={action:"create",receiptId,requestId:crypto.randomUUID(),expectedRevision:preview.revision,amountCents:preview.amountCents,responsibility:preview.responsibility,reasonCode:preview.reasonCode,confirm:true};
   const stored=JSON.stringify({version:"team-admin-refund-v1",actorId,mode,request:body});sessionStorage.setItem(key,stored);if(sessionStorage.getItem(key)!==stored)throw Error("Original request not saved");original.current=body;setSaved(body);
  }
  observe(await api(original.current),original.current.requestId);
 });
 const recover=(requestId:string)=>void run(async()=>observe(await api({action:"recover",requestId}),requestId));
 const cancel=(requestId:string)=>void run(async()=>observe(await api({action:"cancel_unsent",requestId,confirm:true}),requestId));
 if(!ready)return <p aria-busy="true">Loading saved refund request…</p>;
 return <section className="space-y-3 border-t pt-3"><h3 className="font-semibold">Team refund</h3>
  {(enabled||saved)&&!blocked?<><fieldset disabled={pending||!!saved||!enabled} className="space-y-2"><legend>Review a new refund</legend>
   <label className="block">Refund USD<input inputMode="decimal" value={amount} onChange={e=>{setAmount(e.target.value);setPreview(null);setConfirmed(false);}}/></label>
   <label className="block">Processing cost responsibility<select value={responsibility} onChange={e=>{setResponsibility(e.target.value as RefundResponsibility|"");setReason("");setPreview(null);setConfirmed(false);}}><option value="">Choose responsibility</option><option value="creator">Creator</option><option value="platform">CreatorNet</option></select></label>
   <label className="block">Reason<select value={reason} onChange={e=>{setReason(e.target.value);setPreview(null);setConfirmed(false);}}><option value="">Choose a reason</option>{REFUND_REASON_OPTIONS.filter(r=>r.responsibility==="either"||r.responsibility===responsibility).map(r=><option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
   <button type="button" disabled={!amount||!responsibility||!reason} onClick={loadPreview}>Preview current refund</button>
  </fieldset>
  {preview||saved?<><p>Refund {teamMoney(saved?.amountCents??preview!.amountCents)} to the original buyer. {responsibility==="platform"?"CreatorNet":"The creator"} bears its processing share and actual refund costs.</p>
   {preview?<p>Original processing share: {teamMoney(preview.originalProcessingShareCents)}. Additional actual fees and credits are reconciled after the refund.</p>:null}
   <p>Paid commissions may require recovery within this creator relationship. Separate transfers are reconciled independently.</p>
   <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={pending||!enabled} onChange={e=>setConfirmed(e.target.checked)}/>I confirm this exact refund amount and cost responsibility.</label>
   <button type="button" disabled={!confirmed||pending||!enabled} onClick={dispatch}>{saved?"Retry reviewed request":"Send reviewed refund"}</button>
  </>:null}</>:null}
  {saved?<button type="button" disabled={pending} onClick={()=>recover(original.current!.requestId)}>Recover saved original outcome</button>:null}
  {requests.map(q=><article key={q.requestId} className="space-y-2 rounded border p-3"><p>Request {q.requestId} · {teamMoney(q.amountCents)} · {q.responsibility==="platform"?"CreatorNet":"Creator"} processing responsibility</p>
   <p>Saved provider status: {(q.providerStatus??q.dispatchState).replaceAll("_"," ")}{q.refundId?` · ${q.refundId}`:""}</p>
   <button type="button" disabled={pending} onClick={()=>recover(q.requestId)}>Refresh original refund</button>
   {q.dispatchState==="not_dispatched"&&q.providerStatus!=="canceled_before_dispatch"?<button type="button" disabled={pending} onClick={()=>cancel(q.requestId)}>Cancel this unstarted request</button>:null}
  </article>)}
  <p role="status">{message}</p>
 </section>;
}
