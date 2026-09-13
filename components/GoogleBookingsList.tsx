"use client";
import {useEffect,useState} from "react";
import {useUser} from "@/lib/useUser";
type Booking={id:string;connection_id:string;title:string;counterparty_name:string;status:string;starts_at:string;desired_starts_at:string|null};
type Cursor={before:string;before_id:string};
const statusNames:Record<string,string>={creating:"Confirming booking",confirmed:"Confirmed",rescheduling:"Confirming new time",canceling:"Confirming cancellation",canceled:"Canceled"};
export default function GoogleBookingsList(){const {userId,session}=useUser();return userId?<Bookings key={userId} token={session?.access_token}/>:null;}
function Bookings({token}:{token?:string}){
 const [role,setRole]=useState<'buyer'|'creator'>('buyer');
 return <section aria-label="Google Calendar bookings" className="space-y-3 rounded-xl border border-white/15 bg-white/5 p-4 text-white">
  <h2 className="text-lg font-semibold">Google Calendar bookings</h2>
  <p className="text-sm text-white/70">Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
  <label className="block text-sm">Show<select value={role} onChange={event=>setRole(event.target.value as 'buyer'|'creator')} className="ml-3 rounded bg-neutral-900 p-2"><option value="buyer">Calls I booked</option><option value="creator">Calls booked with me</option></select></label>
  <BookingRows key={role} role={role} token={token}/>
 </section>;
}
function BookingRows({role,token}:{role:'buyer'|'creator';token?:string}){
 const [rows,setRows]=useState<Booking[]>([]),[cursor,setCursor]=useState<Cursor|null>(null),[next,setNext]=useState<Cursor|null>(null);
 const [busy,setBusy]=useState(true),[error,setError]=useState<string|null>(null),[reload,setReload]=useState(0);
 useEffect(()=>{let active=true;setBusy(true);setError(null);
  void(async()=>{try{
   const query=new URLSearchParams({role,...cursor});const response=await fetch(`/api/scheduling/google/bookings?${query}`,{credentials:"include",cache:"no-store",headers:token?{Authorization:`Bearer ${token}`}:{}});
   const body=await response.json();if(!response.ok)throw new Error(body.error||"Could not load bookings");
   if(active){setRows(values=>cursor?[...values,...body.bookings.filter((item:Booking)=>!values.some(value=>value.id===item.id))]:body.bookings);setNext(body.next);}
  }catch(cause){if(active)setError(cause instanceof Error?cause.message:"Could not load bookings");}finally{if(active)setBusy(false);}})();
  return()=>{active=false;};
 },[role,token,cursor,reload]);
 const time=(value:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));
 return <div className="space-y-3">
  {error&&<p role="alert">{error}</p>}
  {rows.map(row=><article key={row.id} className="space-y-1 rounded-lg border border-white/10 p-3"><h3 className="font-medium">{row.title}</h3><p>{role==='buyer'?'With':'Booked by'} {row.counterparty_name}</p><p>{time(row.starts_at)}</p><p>{statusNames[row.status]??'Check booking status'}</p>{row.status==='rescheduling'&&row.desired_starts_at&&<p>Requested new time: {time(row.desired_starts_at)}</p>}
   {role==='buyer'?<a className="text-sm underline" href={`/scheduling/book/${row.connection_id}?reservation_id=${row.id}`}>View or manage booking</a>:<a className="text-sm underline" href="https://calendar.google.com/calendar/u/0/r" target="_blank" rel="noopener noreferrer">Open Google Calendar</a>}
  </article>)}
  {!busy&&!error&&!rows.length&&<p className="text-sm text-white/70">No Google Calendar bookings yet.</p>}
  {busy&&<p role="status">Loading bookings…</p>}
  <div className="flex gap-3"><button type="button" disabled={busy} className="text-sm underline" onClick={()=>{setCursor(null);setReload(value=>value+1);}}>Refresh bookings</button>{next&&<button type="button" disabled={busy} className="text-sm underline" onClick={()=>setCursor(next)}>Load more</button>}</div>
 </div>;
}
