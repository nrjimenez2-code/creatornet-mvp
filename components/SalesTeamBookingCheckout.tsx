"use client";
import { useEffect,useRef,useState } from "react";
import { useTeamApi } from "@/lib/salesTeams/client";

type Option={id:string;product_id:string;approval_id:string;kind:string;payment_count:number};
export default function SalesTeamBookingCheckout({creatorId,bookingId,enabled}:{creatorId:string;bookingId:string;enabled:boolean}){
 const api=useTeamApi(),[options,setOptions]=useState<Option[]>([]),[approvals,setApprovals]=useState<{id:string;amount_cents:number}[]>([]),[selected,setSelected]=useState("");
 const [offers,setOffers]=useState<{id:string;title:string}[]>([]);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[url,setUrl]=useState<string|null>(null);
 const operation=useRef<{request_id:string;approved_option_id:string}|null>(null),busyRef=useRef(false);
 useEffect(()=>{const controller=new AbortController();void api(`/api/sales-team/offers?creator_id=${encodeURIComponent(creatorId)}&booking_id=${encodeURIComponent(bookingId)}`,undefined,controller.signal)
  .then(data=>{if(!controller.signal.aborted){setOptions(data.options);setApprovals(data.approvals);setOffers(data.offers??[]);setSelected(data.options[0]?.id||"");setLoading(false);}})
  .catch(e=>{if(!controller.signal.aborted){setError(e.message);setLoading(false);}});return()=>controller.abort();},[api,creatorId,bookingId]);
 const prepare=async()=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setError(null);
  if(!operation.current||operation.current.approved_option_id!==selected)operation.current={request_id:crypto.randomUUID(),approved_option_id:selected};
  try{const data=await api(`/api/bookings/${encodeURIComponent(bookingId)}/payment-link`,operation.current);setUrl(data.url);}
  catch(e){setError(e instanceof Error?e.message:"This sale needs review.");}finally{busyRef.current=false;setBusy(false);}
 };
 return <section><h3>Approved checkout</h3>{loading?<p aria-busy="true">Loading approved options…</p>:<>
  {error?<p role="alert">{error}</p>:null}
  {options.length?<><label>Creator-approved option<select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setUrl(null);}}>{options.map(o=>{
   const cents=approvals.find(a=>a.id===o.approval_id)?.amount_cents??0;const money=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);
   const title=offers.find(offer=>offer.id===o.product_id)?.title;
   return <option key={o.id} value={o.id}>{title?`${title} · `:""}{o.kind==="monthly"?`${money} per month`:o.kind==="installments"?`${money} total in ${o.payment_count} payments`:`${money} in full`}</option>;
  })}</select></label><button disabled={busy||!enabled||!selected} onClick={()=>void prepare()}>Prepare buyer review link</button></>:<p>No approved sales option is available for this booking.</p>}
  {url?<label>Buyer review link<input readOnly value={url} onFocus={e=>e.target.select()} /></label>:null}
  <p>The buyer reviews and accepts the selected terms before payment.</p>
 </>}</section>;
}
