import "server-only";
import {randomUUID} from "node:crypto";
import {supabaseAdmin as db} from "@/lib/supabaseAdmin";
import {googleConnectionAccessToken,refreshGoogleCalendarConnection} from "@/lib/googleCalendarConnection";
import {getGoogleBookingEvent,googleBookingEventId,GoogleCalendarError,stopGoogleCalendarWatch} from "@/lib/googleCalendarProvider";

/** Scan persisted bookings using authoritative event reads, including deletions absent from a full event listing. */
export async function processGoogleCalendarSweep(){
 const worker=randomUUID();const claimed=await db.rpc("claim_google_calendar_sweep_v1",{p_worker:worker});
 if(claimed.error)throw new Error("Could not claim calendar reconciliation");const watch=claimed.data?.[0];if(!watch)return {processed:false};
 try{
  const connection=await db.from("scheduling_connections_v1").select("creator_id").eq("id",watch.connection_id).eq("provider","google").single();
  if(connection.error)throw new Error("Calendar owner unavailable");
  let query=db.from("google_booking_reservations_v1").select("id,revision,event_id,attribution_id").eq("connection_id",watch.connection_id).eq("calendar_id",watch.calendar_id).in("status",["confirmed","canceled"]).order("id").limit(11);
  if(watch.sweep_cursor)query=query.gt("id",watch.sweep_cursor);
  const found=await query;if(found.error)throw new Error("Could not read calendar bookings");const rows=found.data??[],page=rows.slice(0,10);
  const token=page.length?await googleConnectionAccessToken(watch.connection_id):"";
  // Each chunk bounds external I/O. Pending local operations are excluded and SQL checks the revision again.
  for(let offset=0;offset<page.length;offset+=5){
   const results=await Promise.allSettled(page.slice(offset,offset+5).map(async row=>{
    if(row.event_id!==googleBookingEventId(row.id))throw new Error("Booking event identity changed");
    let event;
    try{event=await getGoogleBookingEvent(token,watch.calendar_id,row.id,row.event_id);}
    catch(cause){if(!(cause instanceof GoogleCalendarError)||![404,410].includes(cause.status))throw cause;}
    const canceled=!event||event.status==='cancelled';
    if(event&&!canceled&&(event.status!=='confirmed'||event.extendedProperties?.private?.cn_creator_id!==connection.data.creator_id||event.extendedProperties?.private?.cn_attribution!==(row.attribution_id??'')))throw new Error("Calendar attribution changed");
    const result=await db.rpc("reconcile_google_calendar_booking_v1",{p_watch:watch.id,p_worker:worker,p_id:row.id,p_revision:row.revision,p_event:row.event_id,p_etag:event?.etag??null,
      p_start:event?.start?.dateTime??null,p_end:event?.end?.dateTime??null,p_canceled:canceled});
    if(result.error)throw new Error("Could not reconcile calendar booking");
   }));
   if(results.some(result=>result.status==='rejected'))throw new Error("Calendar reconciliation needs retry");
  }
  const saved=await db.rpc("finish_google_calendar_sweep_v1",{p_watch:watch.id,p_worker:worker,p_cursor:rows.length>10?page.at(-1)!.id:null});
  if(saved.error)throw new Error("Could not save calendar sweep progress");return {processed:true,count:page.length};
 }catch{
  await db.from("google_calendar_watches_v1").update({lease_id:null,lease_until:null}).eq("id",watch.id).eq("lease_id",worker);
  throw new Error("Calendar reconciliation needs retry");
 }
}
export async function maintainGoogleCalendarWatches(){
 const due=await db.from("google_calendar_watches_v1").select("connection_id,scheduling_connections_v1!inner(status)").eq("scheduling_connections_v1.status","connected").eq("status","active").lt("expires_at",new Date(Date.now()+86400000).toISOString()).order("expires_at").limit(1);
 if(due.error)throw new Error("Could not check notification expiry");
 if(due.data?.[0]){
  const owner=await db.from("scheduling_connections_v1").select("creator_id,status").eq("id",due.data[0].connection_id).single();
  if(owner.error)throw new Error("Calendar owner unavailable");
  if(owner.data.status==='connected')await refreshGoogleCalendarConnection(owner.data.creator_id);
 }
 const retired=await db.from("google_calendar_watches_v1").select("id,connection_id,resource_id,expires_at,status").in("status",["retiring","pending","error"]).or(`status.eq.retiring,expires_at.lt.${new Date().toISOString()}`).order("expires_at").limit(5);
 if(retired.error)throw new Error("Could not read retired notification channels");
 for(const watch of retired.data??[]){
  if(Date.parse(watch.expires_at)<=Date.now()){
   const stopped=await db.from("google_calendar_watches_v1").update({status:"stopped"}).eq("id",watch.id).eq("status",watch.status);if(stopped.error)throw new Error("Could not retire expired channel");continue;
  }
  if(watch.status!=='retiring'||!watch.resource_id)continue;
  await stopGoogleCalendarWatch(await googleConnectionAccessToken(watch.connection_id),{id:watch.id,resourceId:watch.resource_id,expiration:String(Date.parse(watch.expires_at))});
  const stopped=await db.from("google_calendar_watches_v1").update({status:"stopped"}).eq("id",watch.id).eq("status","retiring");if(stopped.error)throw new Error("Could not retire channel");
 }
}
