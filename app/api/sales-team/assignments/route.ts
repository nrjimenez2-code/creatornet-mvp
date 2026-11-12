import { NextRequest } from "next/server";
import { teamId } from "@/lib/salesTeams/policy";
import { teamCalendarRoutingOrigin } from "@/lib/salesTeams/calendar";
import { teamError,teamJson,teamRequest,teamRpc } from "@/lib/salesTeams/server";

export async function POST(req:NextRequest){
 try{
  const {admin,user}=await teamRequest(req,true),body=await req.json();
  const membershipId=body.membership_id==null?null:teamId(body.membership_id);
  if(membershipId===null)teamCalendarRoutingOrigin();
  await teamRpc(admin,"assign_sales_team_booking_v1",{p_booking_id:teamId(body.booking_id),p_actor_id:user.id,
    p_membership_id:membershipId});
  // Assignment changes never grant a raw scheduling capability. Buyers must
  // return through canonical routing and the original-appointment checks.
  return teamJson({ok:true});
 }catch(error){return teamError(error);}
}
