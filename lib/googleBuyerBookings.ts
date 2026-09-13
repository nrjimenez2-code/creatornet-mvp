import "server-only";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { authorizeGoogleBooking, type GoogleBookingIntent, type GoogleBookingAccess } from "@/lib/googleBookingAccess";
import { googleConnectionAccessToken } from "@/lib/googleCalendarConnection";
import { getGoogleBusyIntervals } from "@/lib/googleCalendarProvider";
import { availableBookingSlots, validateBookingAvailability, type BookingAvailability, type BookingInterval } from "@/lib/bookingAvailability";

type Settings = { calendar_id:string; conflict_calendar_ids:string[]; availability:BookingAvailability; title:string };
export type GoogleBuyerReservation = { id:string; status:string; start:string; end:string; revision:number };
async function settings(connectionId:string):Promise<Settings> {
  const row=await db.from("google_booking_settings_v1").select("calendar_id,conflict_calendar_ids,availability,title").eq("connection_id",connectionId).eq("active",true).single();
  if(row.error || !row.data)throw new Error("Booking hours are unavailable");
  const value=row.data as Settings;validateBookingAvailability(value.availability);return value;
}
export async function readGoogleBuyerReservation(id:string,buyer:string):Promise<GoogleBuyerReservation|null> {
  const result=await db.from("google_booking_reservations_v1").select("id,status,starts_at,ends_at,revision").eq("id",id).eq("buyer_id",buyer).maybeSingle();
  if(result.error)throw new Error("Could not check your booking");
  const row=result.data;
  return row?{id:row.id,status:row.status,start:row.starts_at,end:row.ends_at,revision:Number(row.revision)}:null;
}
async function slots(access:GoogleBookingAccess,config:Settings,range:BookingInterval) {
  const from=Date.parse(range.start),to=Date.parse(range.end);
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>7*86400000)throw new Error("Choose up to seven days of availability");
  const expanded={start:new Date(from-4*3600000).toISOString(),end:new Date(to+4*3600000).toISOString()};
  const local=await db.rpc("google_reserved_intervals_v1",{p_connection:access.connectionId,p_start:expanded.start,p_end:expanded.end,p_exclude:access.reservationId});
  if(local.error||!Array.isArray(local.data))throw new Error("Could not check reserved times");
  const busy=await getGoogleBusyIntervals(await googleConnectionAccessToken(access.connectionId),config.conflict_calendar_ids,expanded);
  return availableBookingSlots(config.availability,range,[...local.data,...busy]);
}
export async function getGoogleBookingOptions(connectionId:string,buyer:string,intent:GoogleBookingIntent,range:BookingInterval) {
  const access=await authorizeGoogleBooking(connectionId,buyer,intent);
  const config=await settings(connectionId);
  const reservation=await readGoogleBuyerReservation(access.reservationId,buyer);
  return {title:config.title,timeZone:config.availability.timeZone,durationMinutes:config.availability.durationMinutes,
    reservation,slots:reservation && !["held","failed"].includes(reservation.status)?[]:await slots(access,config,range)};
}
export async function submitGoogleBooking(connectionId:string,buyer:string,intent:GoogleBookingIntent,start:string,end:string) {
  const access=await authorizeGoogleBooking(connectionId,buyer,intent);
  const previous=await readGoogleBuyerReservation(access.reservationId,buyer);
  if(previous && ["creating","confirmed"].includes(previous.status)) {
    if(Date.parse(start)!==Date.parse(previous.start)||Date.parse(end)!==Date.parse(previous.end))throw new Error("Use reschedule to change an existing booking");
    return previous;
  }
  const config=await settings(connectionId);
  const options=await slots(access,config,{start,end});
  if(!options.some(slot=>Date.parse(slot.start)===Date.parse(start)&&Date.parse(slot.end)===Date.parse(end)))throw new Error("That time is no longer available");
  const reserved=await db.rpc("reserve_google_booking_checked_v1",{p_id:access.reservationId,p_connection:connectionId,p_buyer:buyer,p_post:access.postId,
    p_start:start,p_end:end,p_attribution:access.attributionId,p_purchase:access.purchaseId,p_calendar:config.calendar_id,p_policy:config.availability});
  if(reserved.error)throw new Error("That time or calendar configuration changed. Choose a time again.");
  const queued=await db.rpc("enqueue_google_booking_create_v1",{p_id:access.reservationId,p_buyer:buyer});
  if(queued.error)throw new Error("Could not queue your booking. Check its status before trying again.");
  return readGoogleBuyerReservation(access.reservationId,buyer);
}
export async function cancelGoogleBuyerBooking(id:string,buyer:string,revision:number) {
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error("Refresh your booking before canceling");
  const reservation=await readGoogleBuyerReservation(id,buyer);
  if(!reservation)throw new Error("Booking not found");
  const queued=await db.rpc("request_google_booking_change_v1",{p_id:id,p_buyer:buyer,p_revision:revision,p_action:"cancel"});
  if(queued.error)throw new Error("Could not request cancellation. Refresh your booking and try again.");
  return readGoogleBuyerReservation(id,buyer);
}
