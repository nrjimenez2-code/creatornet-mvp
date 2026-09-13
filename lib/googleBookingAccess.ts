import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { googleCalendarConfig, schedulingOrigin } from "@/lib/schedulingConfig";
import { googleBookingConnectionFromUrl, isBookingId } from "@/lib/googleBookingUrl";
import { paidCallsReady, readPaidCallAccess, verifyPaidCallCapture } from "@/lib/paidCalls";
import { getStripe } from "@/lib/stripeClient";

export type GoogleBookingIntent = { attributionId?: string; purchaseId?: string; reservationId?: string };
export type GoogleBookingAccess = { connectionId: string; creatorId: string; buyerId: string; postId: string;
  attributionId: string; purchaseId: string | null; reservationId: string };
function reservationId(attribution: string): string {
  const value = createHash("sha256").update(`google-booking:${attribution}`).digest("hex");
  return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`;
}
/** Every booking starts from a verified setup intent or a captured paid-call purchase. */
export async function authorizeGoogleBooking(connectionId: string, buyerId: string, intent: GoogleBookingIntent): Promise<GoogleBookingAccess> {
  googleCalendarConfig();
  if (!isBookingId(connectionId) || [intent.attributionId,intent.purchaseId,intent.reservationId].filter(Boolean).length!==1) throw new Error("Open this calendar from your booking or purchase");
  if(intent.reservationId){
    if(!isBookingId(intent.reservationId))throw new Error("Booking not found");
    const stored=await db.from("google_booking_reservations_v1").select("attribution_id,purchase_id").eq("id",intent.reservationId).eq("buyer_id",buyerId).eq("connection_id",connectionId).maybeSingle();
    if(stored.error||!stored.data)throw new Error("Booking not found");
    const access=await authorizeGoogleBooking(connectionId,buyerId,stored.data.purchase_id?{purchaseId:stored.data.purchase_id}:{attributionId:stored.data.attribution_id});
    if(access.reservationId!==intent.reservationId)throw new Error("Booking attribution changed");
    return access;
  }
  const connection = await db.from("scheduling_connections_v1").select("creator_id,status").eq("id",connectionId).eq("provider","google").maybeSingle();
  if (connection.error || !connection.data || connection.data.status !== "connected" || connection.data.creator_id === buyerId) throw new Error("This creator's calendar is unavailable");
  const creatorId = connection.data.creator_id;
  let postId: string, attributionId: string;
  if (intent.purchaseId) {
    if (!isBookingId(intent.purchaseId) || !paidCallsReady()) throw new Error("Paid-call scheduling is unavailable");
    const access = await readPaidCallAccess(db,intent.purchaseId,buyerId);
    if (!access || access.creator_id !== creatorId || googleBookingConnectionFromUrl(access.scheduling_url,schedulingOrigin()) !== connectionId ||
      !await verifyPaidCallCapture(getStripe(),access)) throw new Error("A confirmed eligible payment is required");
    const current = await readPaidCallAccess(db,intent.purchaseId,buyerId);
    if (!current || JSON.stringify(current)!==JSON.stringify(access)) throw new Error("Your purchase access changed");
    const purchase = await db.from("purchases").select("post_id").eq("id",access.purchase_id).maybeSingle();
    if (purchase.error || !isBookingId(purchase.data?.post_id)) throw new Error("Original purchase video is unavailable");
    postId = purchase.data.post_id;
    const key = `paid-call:${access.purchase_id}`;
    const inserted = await db.from("discover_booking_attribution_v1").upsert({ setup_session_id:key,user_id:buyerId,creator_id:creatorId,post_id:postId },{onConflict:"setup_session_id",ignoreDuplicates:true});
    if(inserted.error) throw new Error("Could not preserve booking attribution");
    const attribution = await db.from("discover_booking_attribution_v1").select("id,user_id,creator_id,post_id").eq("setup_session_id",key).single();
    if(attribution.error || attribution.data.user_id!==buyerId || attribution.data.creator_id!==creatorId || attribution.data.post_id!==postId) throw new Error("Booking attribution changed");
    attributionId = attribution.data.id;
  } else {
    if(!isBookingId(intent.attributionId)) throw new Error("Complete booking setup before choosing a time");
    const attribution = await db.from("discover_booking_attribution_v1").select("id,user_id,creator_id,post_id,setup_session_id")
      .eq("id",intent.attributionId).eq("user_id",buyerId).eq("creator_id",creatorId).maybeSingle();
    if(attribution.error || !attribution.data || !attribution.data.setup_session_id.startsWith("cs_")) throw new Error("Complete booking setup before choosing a time");
    postId=attribution.data.post_id;attributionId=attribution.data.id;
    const post=await db.from("posts").select("creator_id,booking_url,allow_booking,active,hidden_at,removed_at").eq("id",postId).maybeSingle();
    if(post.error || !post.data || post.data.creator_id!==creatorId || !post.data.allow_booking || post.data.active===false || post.data.hidden_at || post.data.removed_at ||
      googleBookingConnectionFromUrl(post.data.booking_url ?? "",schedulingOrigin())!==connectionId) throw new Error("This video is not accepting bookings on this calendar");
  }
  return {connectionId,creatorId,buyerId,postId,attributionId,purchaseId:intent.purchaseId ?? null,reservationId:reservationId(attributionId)};
}
