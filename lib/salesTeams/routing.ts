import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { isSafeBookingTarget } from "@/lib/bookingUrl";
import { completedFreeBooking } from "@/lib/freeBookingReceipt";
import { TeamSalesError, teamId, teamSchemaReady, teamSalesReady } from "./policy";
import { teamRpc } from "./server";

type Source = {kind:"lead";id?:never}|{kind:"attribution"|"free_checkout";id:string};
export type TeamBookingRoute={booking_id:string;booking_url:string;assignment:{membership_id:string;source:"weighted"|"manual"};scheduling_status:"awaiting_confirmation";lead_reused:boolean};
export async function teamRoutingEnabled(admin:SupabaseClient,creatorId:string){
 if(!teamSchemaReady())return false;
 const result=await admin.from("sales_team_creator_settings_v1").select("routing_enabled").eq("creator_id",teamId(creatorId)).maybeSingle();
 if(result.error)throw result.error;
 return result.data?.routing_enabled===true;
}
/** Actor comes from verified auth or an independently verified completion.
 * Source ownership and creator routing controls are rechecked in the transaction. */
export async function routeTeamBooking(admin:SupabaseClient,input:{creatorId:string;buyerId:string;postId:string;source?:Source}):Promise<TeamBookingRoute>{
 if(!teamSalesReady())throw new TeamSalesError("TEAM_SALES_DISABLED","New team bookings are temporarily unavailable.");
 const source=input.source||{kind:"lead"};
 const result=await teamRpc<TeamBookingRoute>(admin,"seed_sales_team_booking_v1",{
  p_creator_id:teamId(input.creatorId),p_buyer_id:teamId(input.buyerId),p_post_id:teamId(input.postId),
  p_source_kind:source.kind,p_source_id:source.id?teamId(source.id):null,
 });
 if(!result?.booking_id||!result.assignment?.membership_id||!isSafeBookingTarget(result.booking_url))
  throw new TeamSalesError("TEAM_BOOKING_REVIEW_REQUIRED","The assigned calendar needs manager review.");
 // A router link as its own selected destination would loop and obscure which
 // calendar is bound to the assigned person.
 const url=new URL(result.booking_url,"https://creatornet.invalid");
 if(url.pathname==="/api/book")throw new TeamSalesError("TEAM_CALENDAR_REQUIRED","Bind the closer's calendar directly.");
 return result;
}

/** Only independently retrieved/signed completed sessions reach this helper. */
export async function routeCompletedTeamBooking(admin:SupabaseClient,session:Stripe.Checkout.Session,attributionId:string|null){
 if(!teamSchemaReady())return null;
 const meta=session.metadata;
 if(!meta||session.status!=="complete"||!(session.mode==="setup"&&meta.kind==="booking"||completedFreeBooking(session)))return null;
 const creatorId=teamId(meta.creator_id),buyerId=teamId(meta.buyer_user_id||meta.buyer_id),postId=teamId(meta.post_id);
 if(!await teamRoutingEnabled(admin,creatorId))return null;
 return routeTeamBooking(admin,{creatorId,buyerId,postId,source:attributionId?{kind:"attribution",id:attributionId}:
  meta.free_booking_id?{kind:"free_checkout",id:meta.free_booking_id}:{kind:"lead"}});
}
