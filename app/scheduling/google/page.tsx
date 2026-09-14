"use client";
import { useEffect, useState } from "react";
import { useUser } from "@/lib/useUser";
import { validateBookingAvailability, type BookingAvailability } from "@/lib/bookingAvailability";

type Calendar = { id: string; summary: string; timeZone: string; primary?: boolean };
type Setup = { accountName: string; calendars: Calendar[]; settings: { calendar_id: string; conflict_calendar_ids: string[]; availability: BookingAvailability; title: string } | null };
const weekdays = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const time = (minute: number) => `${String(Math.floor(minute/60)%24).padStart(2,"0")}:${String(minute%60).padStart(2,"0")}`;
const minute = (value: string) => { const [hour,min]=value.split(":").map(Number);return hour*60+min; };
export default function GoogleCalendarSetupPage() {
  const {userId,session,loading}=useUser();
  return <GoogleCalendarEditor key={userId ?? "guest"} userId={userId ?? null} token={session?.access_token} loading={loading} />;
}
function GoogleCalendarEditor({userId,token,loading}:{userId:string|null;token?:string;loading:boolean}) {
  const [setup,setSetup]=useState<Setup|null>(null);
  const [calendarId,setCalendarId]=useState("");
  const [conflicts,setConflicts]=useState<string[]>([]);
  const [title,setTitle]=useState("1-on-1 call");
  const [policy,setPolicy]=useState<BookingAvailability|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [saved,setSaved]=useState(false);
  const [reload,setReload]=useState(0);
  useEffect(()=>{
    if(loading) return;
    let active=true;
    setSetup(null);setPolicy(null);setSaved(false);
    if(!userId){setError("Sign in to CreatorNet in your original window, then reopen calendar setup.");return;}
    void (async()=>{
      try {
        const response=await fetch("/api/scheduling/google/settings",{credentials:"include",cache:"no-store",headers:token?{Authorization:`Bearer ${token}`}:{}});
        const data=await response.json();
        if(!response.ok) throw new Error(data.error || "Could not load calendars");
        if(!active) return;
        const next=data as Setup;
        const calendar=next.calendars.find(value=>value.id===next.settings?.calendar_id) ?? next.calendars.find(value=>value.primary) ?? next.calendars[0];
        setSetup(next);setCalendarId(calendar?.id ?? "");setConflicts(next.settings?.conflict_calendar_ids ?? (calendar?[calendar.id]:[]));setTitle(next.settings?.title ?? "1-on-1 call");
        setPolicy(next.settings?.availability ?? {timeZone:calendar?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          durationMinutes:30,stepMinutes:30,leadMinutes:120,horizonDays:30,bufferBeforeMinutes:0,bufferAfterMinutes:0,
          windows:[1,2,3,4,5].map(weekday=>({weekday,startMinute:540,endMinute:1020}))});
        setError(null);
      } catch(cause){if(active)setError(cause instanceof Error?cause.message:"Could not load calendars");}
    })();
    return ()=>{active=false;};
  },[loading,userId,token,reload]);
  async function save(event: React.FormEvent) {
    event.preventDefault();if(!policy)return;
    setError(null);setBusy(true);
    try {
      validateBookingAvailability(policy);
      const response=await fetch("/api/scheduling/google/settings",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},
        body:JSON.stringify({calendarId,conflictCalendarIds:conflicts,title,availability:policy})});
      const data=await response.json();if(!response.ok)throw new Error(data.error || "Could not save settings");
      setSaved(true);
    }catch(cause){setError(cause instanceof Error?cause.message:"Could not save settings");}finally{setBusy(false);}
  }
  return <main className="mx-auto max-w-2xl space-y-5 p-6 text-white">
    <h1 className="text-2xl font-semibold">Set up Google Calendar booking</h1>
    <p className="text-sm text-white/70">Choose where calls appear and when people can book you. Your post draft stays in the original window.</p>
    {error&&<p role="alert">{error} <button type="button" className="underline" onClick={()=>setReload(value=>value+1)}>Try loading again</button></p>}
    {saved?<><p role="status">Google Calendar connected. Your calendar and booking hours are saved.</p><button type="button" className="rounded bg-white px-4 py-2 text-black" onClick={()=>window.close()}>Return to CreatorNet</button><p>If this window stays open, switch to your original tab.</p></>:
      !setup||!policy?!error&&<p role="status">Loading your calendars…</p>:
      !setup.calendars.length?<p>No calendars owned by this Google account were found. Create a calendar in Google Calendar, then load again.</p>:
      <form onSubmit={event=>void save(event)} className="space-y-5">
        <p>{setup.accountName}</p>
        <label className="block">Booking calendar<select required value={calendarId} disabled={busy} className="mt-1 block w-full rounded bg-neutral-900 p-2" onChange={event=>{setCalendarId(event.target.value);setConflicts(values=>Array.from(new Set([...values,event.target.value])));}}>
          {setup.calendars.map(calendar=><option key={calendar.id} value={calendar.id}>{calendar.summary}</option>)}
        </select></label>
        <fieldset disabled={busy} className="space-y-2"><legend>Check for conflicts on</legend>{setup.calendars.map(calendar=><label className="block" key={calendar.id}><input type="checkbox" checked={conflicts.includes(calendar.id)} disabled={calendar.id===calendarId} onChange={event=>setConflicts(values=>event.target.checked?[...values,calendar.id]:values.filter(id=>id!==calendar.id))}/> {calendar.summary}</label>)}</fieldset>
        <label className="block">Call title<input required maxLength={160} value={title} disabled={busy} onChange={event=>setTitle(event.target.value)} className="mt-1 block w-full rounded bg-neutral-900 p-2"/></label>
        <label className="block">Time zone<input required value={policy.timeZone} disabled={busy} onChange={event=>setPolicy({...policy,timeZone:event.target.value})} className="mt-1 block w-full rounded bg-neutral-900 p-2"/><span className="text-sm text-white/70">For example, America/Phoenix or Europe/London.</span></label>
        <div className="grid grid-cols-2 gap-3">{([
          ["durationMinutes","Call length (minutes)",5,240],["stepMinutes","Start time spacing (minutes)",5,60],["leadMinutes","Minimum notice (minutes)",0,43200],
          ["horizonDays","Book ahead (days)",1,365],["bufferBeforeMinutes","Buffer before (minutes)",0,240],["bufferAfterMinutes","Buffer after (minutes)",0,240],
        ] as const).map(([key,label,min,max])=><label key={key}>{label}<input type="number" required min={min} max={max} step={1} disabled={busy} value={policy[key]} onChange={event=>setPolicy({...policy,[key]:Number(event.target.value)})} className="mt-1 block w-full rounded bg-neutral-900 p-2"/></label>)}</div>
        <fieldset disabled={busy} className="space-y-3"><legend>Weekly booking hours</legend>{policy.windows.map((window,index)=><div key={index} className="flex flex-wrap items-end gap-2">
          <label>Day<select aria-label={`Day ${index+1}`} value={window.weekday} className="block rounded bg-neutral-900 p-2" onChange={event=>setPolicy({...policy,windows:policy.windows.map((value,i)=>i===index?{...value,weekday:Number(event.target.value)}:value)})}>{weekdays.map((day,i)=><option key={day} value={i}>{day}</option>)}</select></label>
          <label>From<input type="time" required aria-label={`Start ${index+1}`} value={time(window.startMinute)} className="block rounded bg-neutral-900 p-2" onChange={event=>setPolicy({...policy,windows:policy.windows.map((value,i)=>i===index?{...value,startMinute:minute(event.target.value)}:value)})}/></label>
          <label>To<input type="time" required aria-label={`End ${index+1}`} value={time(window.endMinute)} className="block rounded bg-neutral-900 p-2" onChange={event=>setPolicy({...policy,windows:policy.windows.map((value,i)=>i===index?{...value,endMinute:event.target.value==="00:00"?1440:minute(event.target.value)}:value)})}/></label>
          <button type="button" aria-label={`Remove hours ${index+1}`} className="p-2 underline" onClick={()=>setPolicy({...policy,windows:policy.windows.filter((_,i)=>i!==index)})}>Remove</button>
        </div>)}<button type="button" disabled={policy.windows.length>=28} className="underline" onClick={()=>setPolicy({...policy,windows:[...policy.windows,{weekday:1,startMinute:540,endMinute:1020}]})}>Add hours</button></fieldset>
        <button type="submit" disabled={busy} className="rounded bg-white px-4 py-2 text-black disabled:opacity-50">{busy?"Saving…":"Save booking settings"}</button>
      </form>}
  </main>;
}
