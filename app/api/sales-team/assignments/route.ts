import { NextRequest } from "next/server";
import { teamId } from "@/lib/salesTeams/policy";
import { teamError,teamJson,teamRequest,teamRpc } from "@/lib/salesTeams/server";

export async function POST(req:NextRequest){
 try{
  const {admin,user}=await teamRequest(req,true),body=await req.json();
  const result=await teamRpc(admin,"assign_sales_team_booking_v1",{p_booking_id:teamId(body.booking_id),p_actor_id:user.id,
    p_membership_id:body.membership_id==null?null:teamId(body.membership_id)});
  return teamJson(result);
 }catch(error){return teamError(error);}
}
