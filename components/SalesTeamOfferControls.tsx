"use client";
import { useEffect,useRef,useState,type FormEvent } from "react";
import { useTeamApi } from "@/lib/salesTeams/client";

type Offer={id:string;title:string;type:string;amount_cents:number;membership_terms:unknown};
type Approval={product_id:string;amount_cents:number;revision:number};
type Option={product_id:string;kind:string;payment_count:number};
export default function SalesTeamOfferControls({creatorId,enabled,refreshToken=0}:{creatorId:string;enabled:boolean;refreshToken?:number}){
 const api=useTeamApi();const [opened,setOpened]=useState(false),[offers,setOffers]=useState<Offer[]>([]),[approvals,setApprovals]=useState<Approval[]>([]),[options,setOptions]=useState<Option[]>([]);
 const [selected,setSelected]=useState(""),[price,setPrice]=useState(""),[counts,setCounts]=useState(""),[error,setError]=useState<string|null>(null),[status,setStatus]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const busyRef=useRef(false),request=useRef<Record<string,unknown>|null>(null);const [saved,setSaved]=useState(false);
 useEffect(()=>{if(!opened)return;const controller=new AbortController();void api(`/api/sales-team/offers?creator_id=${encodeURIComponent(creatorId)}`,undefined,controller.signal)
 .then(data=>{if(!controller.signal.aborted){setOffers(data.offers);setApprovals(data.approvals);setOptions(data.options);}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[api,creatorId,opened,refreshToken]);
 const choose=(id:string)=>{
  setSelected(id);const offer=offers.find(o=>o.id===id),approval=approvals.find(a=>a.product_id===id);
  setPrice(String((approval?.amount_cents??offer?.amount_cents??0)/100));
  setCounts(options.filter(o=>o.product_id===id&&o.kind==="installments").map(o=>o.payment_count).sort((a,b)=>a-b).join(", "));
 };
 const save=async(event:FormEvent)=>{
  event.preventDefault();if(busyRef.current)return;busyRef.current=true;setBusy(true);setError(null);setStatus(null);
  if(!request.current)request.current={creator_id:creatorId,product_id:selected,request_id:crypto.randomUUID(),amount_cents:Math.round(Number(price)*100),
   installment_counts:counts.trim()?counts.split(",").map(c=>Number(c.trim())):[]};
  setSaved(true);
  try{await api("/api/sales-team/offers",request.current);request.current=null;setSaved(false);setStatus("Approved options saved. Changed approvals apply to future buyer acceptance.");}
  catch(e){setError(e instanceof Error?e.message:"Approval needs review.");}finally{busyRef.current=false;setBusy(false);}
 };
 const monthly=!!offers.find(o=>o.id===selected)?.membership_terms;
 return <section><h2>Approved sales offers</h2><p>Set the sales price and permitted plans for offers attached to sales-call bookings. Closers select from these saved options.</p>
  <button type="button" disabled={busy} onClick={()=>setOpened(o=>!o)}>{opened?"Hide offer settings":"Manage approved offers"}</button>
  {error?<p role="alert">{error}</p>:null}{status?<p role="status">{status}</p>:null}
  {opened&&offers.length?<form onSubmit={event=>void save(event)}>
   <label>Booked offer<select value={selected} required disabled={busy||saved} onChange={e=>choose(e.target.value)}><option value="">Choose an offer</option>{offers.map(o=><option key={o.id} value={o.id}>{o.title} · {o.type}</option>)}</select></label>
   <label>{monthly?"Approved monthly USD price":"Approved total USD price"}<input type="number" min="0.50" step="0.01" required value={price} disabled={busy||saved} onChange={e=>setPrice(e.target.value)} /></label>
   {!monthly?<label>Approved payment counts<input value={counts} disabled={busy||saved} onChange={e=>setCounts(e.target.value)} placeholder="Leave empty for full payment only" /><span>Use ascending counts, such as 2, 3, 6. The purchase total and service duration stay separate.</span></label>:<p>Ongoing monthly service uses its saved minimum commitment and renewal terms.</p>}
   <button type="submit" disabled={busy||!enabled||!selected}>{saved?"Retry saved approval":"Approve sales options"}</button>
  </form>:null}
 </section>;
}
