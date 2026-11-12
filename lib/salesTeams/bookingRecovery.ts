import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TeamSalesError, teamId } from "./policy";

export function originalBookingHeld() {
  return new TeamSalesError("TEAM_BOOKING_REVIEW_REQUIRED", "The original assigned booking needs review before scheduling.");
}

/** Requires the installed compatibility resolver, independently of new-work
 * flags. A missing routine, failed read or unrecognized response is unknown.
 * Only a successful exact-source negative permits ordinary scheduling. */
export async function readOriginalBooking(admin:SupabaseClient, input:{creatorId:string;buyerId:string;postId:string;
  sessionId?:string;attributionId?:string|null;freeCheckoutId?:string|null;lead?:boolean}) {
  const args={
    p_creator:teamId(input.creatorId),p_buyer:teamId(input.buyerId),p_post:teamId(input.postId),
    p_session:input.sessionId??null,p_attribution:input.attributionId?teamId(input.attributionId):null,
    p_free:input.freeCheckoutId?teamId(input.freeCheckoutId):null,p_lead:input.lead===true,
  };
  try {
    const result=await admin.rpc("resolve_original_team_booking_v1",args);
    if(result.error || !result.data || !["team","legacy"].includes(result.data.state))throw originalBookingHeld();
    if(result.data.state==="team" && !result.data.booking_id)throw originalBookingHeld();
    return result.data as {state:"team"|"legacy";booking_id?:string;booking_url?:string|null};
  }catch{throw originalBookingHeld();}
}
