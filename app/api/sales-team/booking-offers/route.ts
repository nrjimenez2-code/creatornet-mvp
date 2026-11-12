import {NextRequest} from "next/server";
import {teamBookedOfferSchemaReady,teamId,TeamSalesError} from "@/lib/salesTeams/policy";
import {teamRequest,teamAccess,teamRpc,teamJson,teamError} from "@/lib/salesTeams/server";
const enabled=()=>{if(!teamBookedOfferSchemaReady())throw new TeamSalesError("TEAM_BOOKED_OFFERS_HELD","Booked sales offer settings are not enabled.",404);};
export async function GET(req:NextRequest){
 try{
  enabled();const {admin,user}=await teamRequest(req),creator=teamId(req.nextUrl.searchParams.get("creator_id")),booking=teamId(req.nextUrl.searchParams.get("booking_id"));
  const {role}=await teamAccess(admin,creator,user.id);if(role==="closer")throw new TeamSalesError("TEAM_MANAGER_REQUIRED","The creator or a manager attaches sales offers.",403);
  return teamJson(await teamRpc(admin,"read_sales_team_booked_offer_choices_v1",{p_creator_id:creator,p_actor_id:user.id,p_booking_id:booking}));
 }catch(error){return teamError(error);}
}
export async function POST(req:NextRequest){
 try{
  enabled();const {admin,user}=await teamRequest(req,true),body=await req.json();
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!["creator_id","booking_id","product_id","request_id","expected_revision","attached"].includes(k))||typeof body.attached!=="boolean"||!Number.isSafeInteger(body.expected_revision)||body.expected_revision<0)throw new TeamSalesError("INVALID_BOOKED_OFFER_CHANGE","Review the current booked offer before changing it.",400);
  const creator=teamId(body.creator_id),booking=teamId(body.booking_id),product=teamId(body.product_id),request=teamId(body.request_id);
  const {role}=await teamAccess(admin,creator,user.id);if(role==="closer")throw new TeamSalesError("TEAM_MANAGER_REQUIRED","The creator or a manager attaches sales offers.",403);
  return teamJson(await teamRpc(admin,"manage_sales_team_booked_offer_v1",{p_creator_id:creator,p_actor_id:user.id,p_booking_id:booking,p_product_id:product,p_request_id:request,p_expected_revision:body.expected_revision,p_attached:body.attached}));
 }catch(error){return teamError(error);}
}
