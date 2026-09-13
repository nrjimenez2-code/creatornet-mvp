"use client";
import {Suspense,useCallback,useEffect,useRef,useState} from "react";
import {useParams,useSearchParams} from "next/navigation";
import {useUser} from "@/lib/useUser";

type Slot={start:string;end:string};
type Reservation=Slot & {id:string;status:string;revision:number};
type Options={title:string;timeZone:string;durationMinutes:number;slots:Slot[];reservation:Reservation|null};
function BookingEntry() {
  const params=useParams<{connection:string}>();const query=useSearchParams();const {userId,session,loading}=useUser();
  return <BuyerCalendar key={`${userId}:${params.connection}:${query.get("cn_attribution")}:${query.get("purchase_id")}`}
    connection={params.connection} attributionId={query.get("cn_attribution")??undefined} purchaseId={query.get("purchase_id")??undefined}
    reservationId={query.get("reservation_id")??undefined} userId={userId} token={session?.access_token} loading={loading}/>;
}
function BuyerCalendar({connection,attributionId,purchaseId,reservationId,userId,token,loading}:{connection:string;attributionId?:string;purchaseId?:string;reservationId?:string;userId:string|null;token?:string;loading:boolean}) {
  const [options,setOptions]=useState<Options|null>(null);const [reservation,setReservation]=useState<Reservation|null>(null);
  const [week,setWeek]=useState(0);const [selected,setSelected]=useState("");const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);const [cancelPrompt,setCancelPrompt]=useState(false);const [checking,setChecking]=useState(false);
  const [base]=useState(()=>Date.now());const request=useRef(0);const statusInFlight=useRef(false);
  const headers=useCallback(():Record<string,string>=>token?{Authorization:`Bearer ${token}`}:{},[token]);
  const fetchOptions=useCallback(async()=>{
    if(!userId)return;const id=++request.current;setChecking(true);setSelected("");
    try {
      if(reservationId) {
        const response=await fetch(`/api/scheduling/google/reservations/${reservationId}`,{cache:"no-store",credentials:"include",headers:headers()});
        const body=await response.json();if(!response.ok)throw new Error(body.error||"Could not check booking status");
        if(id===request.current){setReservation(body.reservation);setError(null);}
        if(!["held","failed"].includes(body.reservation.status))return;
      }
      const start=base+week*7*86400000;
      const query=new URLSearchParams({start:new Date(start).toISOString(),end:new Date(start+7*86400000).toISOString(),...(attributionId?{cn_attribution:attributionId}:{}),...(purchaseId?{purchase_id:purchaseId}:{})});
      const response=await fetch(`/api/scheduling/google/book/${connection}?${query}`,{cache:"no-store",credentials:"include",headers:headers()});
      const body=await response.json();if(!response.ok)throw new Error(body.error||"Could not load available times");
      if(id===request.current){setOptions(body);setReservation(body.reservation);setError(null);}
    }catch(cause){if(id===request.current){setOptions(null);setError(cause instanceof Error?cause.message:"Could not load available times");}}
    finally{if(id===request.current)setChecking(false);}
  },[userId,connection,attributionId,purchaseId,reservationId,week,base,headers]);
  useEffect(()=>{if(!loading)void fetchOptions();return()=>{request.current++;};},[loading,fetchOptions]);
  useEffect(()=>{
    if(reservation && reservationId!==reservation.id){const url=new URL(window.location.href);url.searchParams.set("reservation_id",reservation.id);window.history.replaceState(null,"",url);}
  },[reservation,reservationId]);
  const pending=!!reservation&&["creating","rescheduling","canceling"].includes(reservation.status);
  const checkReservation=useCallback(async()=>{
    if(!reservation||statusInFlight.current)return;
    statusInFlight.current=true;
    try {
      const response=await fetch(`/api/scheduling/google/reservations/${reservation.id}`,{cache:"no-store",credentials:"include",headers:headers()});
      const body=await response.json();if(!response.ok)throw new Error(body.error||"Could not check booking status");
      setReservation(body.reservation);setError(null);
    }catch(cause){setError(cause instanceof Error?cause.message:"Could not check booking status");}
    finally{statusInFlight.current=false;}
  },[reservation,headers]);
  useEffect(()=>{
    if(!pending)return;
    const interval=window.setInterval(()=>{if(document.visibilityState!=="hidden")void checkReservation();},10000);
    return()=>window.clearInterval(interval);
  },[pending,checkReservation]);
  async function book() {
    const slot=options?.slots.find(value=>value.start===selected);if(!slot)return;
    setBusy(true);setError(null);
    try {
      const response=await fetch(`/api/scheduling/google/book/${connection}`,{method:"POST",credentials:"include",headers:{...headers(),"Content-Type":"application/json"},body:JSON.stringify({...slot,attributionId,purchaseId})});
      const body=await response.json();if(!response.ok||!body.reservation)throw new Error(body.error||"Could not reserve that time");
      setReservation(body.reservation);setSelected("");
    }catch(cause){setError(cause instanceof Error?cause.message:"Could not reserve that time. Check availability before trying again.");}
    finally{setBusy(false);}
  }
  async function cancelBooking() {
    if(!reservation)return;setBusy(true);setError(null);
    try {
      const response=await fetch(`/api/scheduling/google/reservations/${reservation.id}`,{method:"DELETE",credentials:"include",headers:{...headers(),"Content-Type":"application/json"},body:JSON.stringify({revision:reservation.revision})});
      const body=await response.json();if(!response.ok||!body.reservation)throw new Error(body.error||"Could not request cancellation");
      setReservation(body.reservation);setCancelPrompt(false);
    }catch(cause){setError(cause instanceof Error?cause.message:"Could not request cancellation");}finally{setBusy(false);}
  }
  const returnQuery=new URLSearchParams({...attributionId?{cn_attribution:attributionId}:{},...purchaseId?{purchase_id:purchaseId}:{},...reservationId?{reservation_id:reservationId}:{}});
  const signInUrl="/auth?next="+encodeURIComponent(`/scheduling/book/${connection}?${returnQuery}`);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format=(value:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:"full",timeStyle:"short",timeZone:zone}).format(new Date(value));
  if(loading)return <main className="p-6 text-white"><p role="status">Loading your booking…</p></main>;
  if(!userId)return <main className="mx-auto max-w-xl space-y-4 p-6 text-white"><h1 className="text-2xl font-semibold">Sign in to book your call</h1><p>Sign in to CreatorNet to continue with this booking.</p><a href={signInUrl} className="underline">Sign in</a></main>;
  return <main className="mx-auto max-w-2xl space-y-5 p-6 text-white">
    <h1 className="text-2xl font-semibold">{options?.title??"Book your call"}</h1>
    {error&&<p role="alert" className="rounded border border-red-300/40 p-3">{error}</p>}
    {reservation&&!["held","failed"].includes(reservation.status)?<section className="space-y-3 rounded-xl border border-white/20 p-4">
      <h2 className="text-lg font-semibold">{reservation.status==="confirmed"?"Booking confirmed":reservation.status==="canceled"?"Booking canceled":reservation.status==="canceling"?"Confirming cancellation":reservation.status==="rescheduling"?"Confirming your new time":"Confirming with Google Calendar"}</h2>
      <p>{format(reservation.start)}</p><p className="text-sm text-white/70">Time zone: {zone}</p>
      {reservation.status==="confirmed" && (cancelPrompt?<div className="space-y-3"><p>Cancel this booking? The creator will receive the cancellation.</p><button type="button" disabled={busy} className="rounded border border-red-300 px-3 py-2" onClick={()=>void cancelBooking()}>{busy?"Requesting cancellation…":"Confirm cancellation"}</button><button type="button" disabled={busy} className="ml-3 underline" onClick={()=>setCancelPrompt(false)}>Keep booking</button></div>:<button type="button" className="underline" onClick={()=>setCancelPrompt(true)}>Cancel booking</button>)}
      {pending&&<><p role="status">Your request is saved. This page updates when Google confirms it. You can safely return to this booking link.</p><button type="button" className="underline" onClick={()=>void checkReservation()}>Check status</button></>}
    </section>:<>
      {checking?<p role="status">Checking available times…</p>:options&&<>
        <p>{options.durationMinutes}-minute call. Times shown in {zone}.</p>
        <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 font-medium">Choose a time</legend>
          {options.slots.map(slot=><label key={slot.start} className="flex cursor-pointer items-center gap-3 rounded-lg border border-white/20 p-3"><input type="radio" name="time" value={slot.start} checked={selected===slot.start} onChange={()=>setSelected(slot.start)}/>{format(slot.start)}</label>)}
          {!options.slots.length&&<p>No available times this week. Try another week.</p>}
        </fieldset>
        <div className="flex gap-4"><button type="button" disabled={busy||week===0} className="underline disabled:opacity-40" onClick={()=>setWeek(value=>Math.max(0,value-1))}>Previous week</button><button type="button" disabled={busy||week>=51} className="underline disabled:opacity-40" onClick={()=>setWeek(value=>value+1)}>Next week</button></div>
        <button type="button" disabled={!selected||busy} className="rounded-lg bg-white px-4 py-2 text-black disabled:opacity-40" onClick={()=>void book()}>{busy?"Reserving…":"Book this time"}</button>
      </>}
      {!checking&&<button type="button" disabled={busy} className="block underline" onClick={()=>void fetchOptions()}>Refresh availability</button>}
    </>}
  </main>;
}
export default function GoogleBuyerBookingPage(){return <Suspense fallback={<p>Loading booking…</p>}><BookingEntry/></Suspense>;}
