"use client";
import {useEffect,useState} from "react";
import {BookingSlotsSkeleton} from "@/components/loading/Skeletons";
type Slot={start:string;end:string};
type Reservation=Slot & {id:string;status:string;revision:number;desiredStart?:string|null;desiredEnd?:string|null};
export default function GoogleReschedulePicker({id,revision,token,onChanged,onClose}:{id:string;revision:number;token?:string;onChanged:(reservation:Reservation)=>void;onClose:()=>void}) {
 const [week,setWeek]=useState(0),[base]=useState(()=>Date.now()),[slots,setSlots]=useState<Slot[]>([]),[selected,setSelected]=useState("");
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[reload,setReload]=useState(0);
 const headers:Record<string,string>=token?{Authorization:`Bearer ${token}`} : {};
 useEffect(()=>{
  let active=true;setLoading(true);setSelected("");setError(null);setSlots([]);
  void(async()=>{try{
   const start=base+week*7*86400000;const query=new URLSearchParams({start:new Date(start).toISOString(),end:new Date(start+7*86400000).toISOString()});
   const response=await fetch(`/api/scheduling/google/reservations/${id}/times?${query}`,{credentials:"include",cache:"no-store",headers:token?{Authorization:`Bearer ${token}`}:{}});
   const body=await response.json();if(!response.ok||body.revision!==revision)throw new Error(body.error||"Your booking changed. Close this form and check its status.");
   if(active)setSlots(body.slots);
  }catch(cause){if(active)setError(cause instanceof Error?cause.message:"Could not check times");}finally{if(active)setLoading(false);}})();
  return()=>{active=false;};
 },[id,revision,token,week,base,reload]);
 async function submit(){
  const slot=slots.find(value=>value.start===selected);if(!slot)return;setBusy(true);setError(null);
  try{
   const response=await fetch(`/api/scheduling/google/reservations/${id}/times`,{method:"POST",credentials:"include",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({...slot,revision})});
   const body=await response.json();if(!response.ok||!body.reservation)throw new Error(body.error||"Could not request the new time");
   onChanged(body.reservation);
  }catch(cause){setError(cause instanceof Error?cause.message:"Could not request the new time");}finally{setBusy(false);}
 }
 const format=(value:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:"full",timeStyle:"short"}).format(new Date(value));
 return <section aria-label="Choose a new booking time" className="space-y-3 rounded-lg border border-white/20 p-4">
  <h3 className="font-semibold">Choose a new time</h3><p>Your current time stays confirmed until Google accepts the change. Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
  {error&&<p role="alert">{error}</p>}
  {loading?<BookingSlotsSkeleton/>:<fieldset disabled={busy} className="space-y-2"><legend>Available times</legend>{slots.map(slot=><label className="flex gap-3 p-2" key={slot.start}><input type="radio" name="new-time" checked={selected===slot.start} onChange={()=>setSelected(slot.start)}/>{format(slot.start)}</label>)}{!slots.length&&!error&&<p>No available times this week.</p>}</fieldset>}
  <div className="flex flex-wrap gap-3"><button type="button" disabled={busy||loading||week===0} className="underline" onClick={()=>setWeek(value=>value-1)}>Previous week</button><button type="button" disabled={busy||loading||week>=51} className="underline" onClick={()=>setWeek(value=>value+1)}>Next week</button><button type="button" disabled={busy||loading} className="underline" onClick={()=>setReload(value=>value+1)}>Refresh times</button></div>
  <button type="button" disabled={!selected||busy||loading} className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" onClick={()=>void submit()}>{busy?"Requesting change…":"Request new time"}</button><button type="button" disabled={busy} className="ml-3 underline" onClick={onClose}>Keep current time</button>
 </section>;
}
