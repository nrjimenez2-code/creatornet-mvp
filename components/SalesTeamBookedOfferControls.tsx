"use client";
import {useEffect,useRef,useState} from "react";
import {useTeamApi} from "@/lib/salesTeams/client";
type Offer={id:string;title:string;type:string;revision:number;attached:boolean};
export default function SalesTeamBookedOfferControls({creatorId,bookingId,enabled,onSaved}:{creatorId:string;bookingId:string;enabled:boolean;onSaved?:()=>void}){
 const api=useTeamApi(),[opened,setOpened]=useState(false),[offers,setOffers]=useState<Offer[]>([]),[selected,setSelected]=useState(""),[error,setError]=useState<string|null>(null),[message,setMessage]=useState(""),[pending,setPending]=useState(false);
 const busy=useRef(false),request=useRef<Record<string,unknown>|null>(null),[saved,setSaved]=useState(false);
 const [loaded,setLoaded]=useState(false);
 useEffect(()=>{if(!opened)return;const controller=new AbortController();void api(`/api/sales-team/booking-offers?creator_id=${encodeURIComponent(creatorId)}&booking_id=${encodeURIComponent(bookingId)}`,undefined,controller.signal)
  .then(data=>{if(!controller.signal.aborted){setOffers(data.offers);setLoaded(true);}}).catch(reason=>{if(!controller.signal.aborted){setError(reason instanceof Error?reason.message:"Booked offers need review.");setLoaded(true);}});return()=>controller.abort();},[api,creatorId,bookingId,opened]);
 const current=offers.find(o=>o.id===selected);
 async function save(){
  if(busy.current||!current)return;busy.current=true;setPending(true);setError(null);setMessage("");
  request.current??={creator_id:creatorId,booking_id:bookingId,product_id:current.id,request_id:crypto.randomUUID(),expected_revision:current.revision,attached:!current.attached};setSaved(true);
  try{
   await api("/api/sales-team/booking-offers",request.current);request.current=null;setSaved(false);setMessage("Saved for future buyer reviews. Approve the offer’s price and payment choices in Approved sales offers.");
   const data=await api(`/api/sales-team/booking-offers?creator_id=${encodeURIComponent(creatorId)}&booking_id=${encodeURIComponent(bookingId)}`);setOffers(data.offers);onSaved?.();
  }catch(reason){setError(reason instanceof Error?reason.message:"The original offer change needs review.");}
  finally{busy.current=false;setPending(false);}
 }
 return <section><button type="button" disabled={pending} onClick={()=>{if(!opened)setLoaded(false);setOpened(v=>!v);}}>{opened?"Hide booked sales offers":"Attach sales offers to this booking"}</button>
  {opened?<><p>The creator or a manager chooses offers for this sales-call booking. Price and payment choices require separate approval.</p>
   {!loaded?<p aria-busy="true">Loading sales offers…</p>:offers.length?<><label>Sales offer<select value={selected} disabled={pending||saved} onChange={e=>setSelected(e.target.value)}><option value="">Choose an offer</option>{offers.map(o=><option key={o.id} value={o.id}>{o.title} · {o.attached?"Attached":"Not attached"}</option>)}</select></label>
    <button type="button" disabled={!current||!enabled||pending} onClick={()=>void save()}>{saved?"Retry saved offer change":current?.attached?"Remove from future reviews":"Attach to this booking"}</button></>:<p>No available offers loaded.</p>}
   {error?<p role="alert">{error}</p>:null}{message?<p role="status">{message}</p>:null}
  </>:null}
 </section>;
}
