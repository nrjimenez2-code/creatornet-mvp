import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { premiumPostingReady } from "@/lib/premiumReadiness";
import { isSafeBookingTarget } from "@/lib/bookingUrl";
import { recordBookingSetup, attributedBookingUrl } from "@/lib/discoverBookings";
import { completedFreeBooking } from "@/lib/freeBookingReceipt";
export { completedFreeBooking } from "@/lib/freeBookingReceipt";
export type FreeBookingRow={id:string;buyer_id:string;creator_id:string;post_id:string;destination:string;checkout_origin:string;stripe_session_id:string|null;status:string};
export async function completeFreeBooking(admin:SupabaseClient,session:Stripe.Checkout.Session,buyerId?:string){
 if(!completedFreeBooking(session)) throw Error("Free booking checkout is not complete and zero total.");
 const m=session.metadata!;
 const result=await admin.from("free_booking_checkouts").select("id,buyer_id,creator_id,post_id,destination,stripe_session_id,status").eq("id",m.free_booking_id).maybeSingle();
 const row=result.data as FreeBookingRow|null;
 if(result.error || !row || row.stripe_session_id!==session.id || row.buyer_id!==m.buyer_id ||
  buyerId && row.buyer_id!==buyerId || row.creator_id!==m.creator_id || row.post_id!==m.post_id ||
  row.destination!==m.booking_redirect_url || !isSafeBookingTarget(row.destination)) throw Error("Free booking ownership or source differs.");
 const source=await admin.from("posts").select("creator_id,allow_booking").eq("id",row.post_id).maybeSingle();
 if(source.error || source.data?.creator_id!==row.creator_id || source.data?.allow_booking!==true) throw Error("Free booking source differs.");
 const update=await admin.from("free_booking_checkouts").update({status:"complete",completed_at:new Date().toISOString()}).eq("id",row.id).eq("stripe_session_id",session.id).in("status",["open","creating","complete"]).select("id").maybeSingle();
 if(update.error || !update.data) throw Error("Free booking completion unavailable.");
 // Scheduling remains a separate event. Completion records attribution only.
 const attribution=await recordBookingSetup(session);
 return {kind:"booking",booking_attribution_only:true,booking_redirect_url:attributedBookingUrl(row.destination,attribution),post_id:row.post_id,creator_id:row.creator_id};
}
export async function createFreeBooking(admin:SupabaseClient,stripe:Stripe,input:{buyerId:string;creatorId:string;postId:string;destination:string;site:string}){
 if(!premiumPostingReady()) throw Error("New video checkout is not enabled yet.");
 const columns="id,buyer_id,creator_id,post_id,destination,checkout_origin,stripe_session_id,status";
 let result=await admin.from("free_booking_checkouts").select(columns).eq("buyer_id",input.buyerId).eq("post_id",input.postId).in("status",["creating","open"]).maybeSingle();
 if(result.error) throw Error("Booking recovery unavailable.");
 let row=result.data as FreeBookingRow|null;
 if(row?.stripe_session_id){
  const session=await stripe.checkout.sessions.retrieve(row.stripe_session_id);
  if(session.status==="open" && session.url) return {url:session.url,session_id:session.id};
  if(session.status==="complete") return {url:row.checkout_origin+"/success?session_id="+session.id+"&kind=booking",session_id:session.id};
  if(session.status!=="expired") throw Error("Booking requires recovery.");
  const retired=await admin.from("free_booking_checkouts").update({status:"expired"}).eq("id",row.id).eq("stripe_session_id",session.id);
  if(retired.error) throw Error("Booking expiry unavailable.");
  row=null;
 }
 if(!row){
  const claimed=await admin.from("free_booking_checkouts").insert({id:randomUUID(),buyer_id:input.buyerId,creator_id:input.creatorId,post_id:input.postId,destination:input.destination,checkout_origin:input.site}).select(columns).maybeSingle();
  if(claimed.error){
   result=await admin.from("free_booking_checkouts").select(columns).eq("buyer_id",input.buyerId).eq("post_id",input.postId).in("status",["creating","open"]).maybeSingle();
   if(result.error || !result.data) throw Error("Booking attempt unavailable.");
   row=result.data as FreeBookingRow;
  }else row=claimed.data as FreeBookingRow;
 }
 if(!row || row.creator_id!==input.creatorId || row.destination!==input.destination) throw Error("Booking source changed.");
 const session=await stripe.checkout.sessions.create({
  // Payment-mode zero totals skip payment details automatically on the SDK's
  // API version. payment_method_collection is only valid for subscriptions.
  mode:"payment",
  line_items:[{price_data:{currency:"usd",unit_amount:0,product_data:{name:"Free call"}},quantity:1}],
  metadata:{kind:"free_booking_v1",free_booking_id:row.id,buyer_id:row.buyer_id,buyer_user_id:row.buyer_id,creator_id:row.creator_id,post_id:row.post_id,booking_redirect_url:row.destination},
  success_url:row.checkout_origin+"/success?session_id={CHECKOUT_SESSION_ID}&kind=booking",cancel_url:row.checkout_origin+"/dashboard",
 },{idempotencyKey:"creatornet-free-booking:"+row.id});
 if(!session.url) throw Error("Booking checkout is unavailable.");
 const saved=await admin.from("free_booking_checkouts").update({stripe_session_id:session.id,status:"open"}).eq("id",row.id).eq("status","creating").select("id").maybeSingle();
 if(saved.error) throw Error("Booking session binding requires recovery.");
 if(!saved.data){
  const winner=await admin.from("free_booking_checkouts").select("stripe_session_id").eq("id",row.id).maybeSingle();
  if(winner.error || winner.data?.stripe_session_id!==session.id) throw Error("Booking session binding differs.");
 }
 return {url:session.url,session_id:session.id};
}
