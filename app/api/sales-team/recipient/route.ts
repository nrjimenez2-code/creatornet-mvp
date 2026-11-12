import {NextRequest} from "next/server";
import {teamId,teamRecipientSchemaReady,teamRecipientOnboardingReady,TeamSalesError} from "@/lib/salesTeams/policy";
import {teamRequest,teamJson,teamError} from "@/lib/salesTeams/server";
import {readTeamRecipientStatus,refreshTeamRecipient,startTeamRecipientOnboarding} from "@/lib/salesTeams/recipients";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
function installed(){if(!teamRecipientSchemaReady())throw new TeamSalesError("TEAM_RECIPIENT_NOT_ENABLED","Team payout setup is not available yet.",404);}
export async function GET(req:NextRequest){
 try{
  installed();const {admin,user}=await teamRequest(req),recipient=await readTeamRecipientStatus(admin,user.id);
  const links=await admin.from("sales_team_onboarding_links_v1").select("id,status,expires_at").eq("user_id",user.id).order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(links.error)throw links.error;
  return teamJson({recipient,onboarding:links.data,onboardingEnabled:teamRecipientOnboardingReady()});
 }
 catch(error){return teamError(error);}
}
export async function POST(req:NextRequest){
 try{
  installed();
  if(req.headers.get("origin")!==new URL(req.url).origin)throw new TeamSalesError("SAME_ORIGIN_REQUIRED","Use this CreatorNet page to continue payout setup.",403);
  const {user}=await teamRequest(req),body=await req.json().catch(()=>null);
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!["action","request_id"].includes(k))||
   !["refresh","onboard"].includes(body.action)||body.action==="refresh"&&body.request_id!==undefined)
   throw new TeamSalesError("INVALID_RECIPIENT_ACTION","Choose a payout setup action on this page.",400);
  if(body.action==="onboard"&&!teamRecipientOnboardingReady())throw new TeamSalesError("TEAM_RECIPIENT_ONBOARDING_HELD","New payout setup requests are currently paused.");
  const requestId=body.action==="onboard"?teamId(body.request_id):null;
  const composition=createTeamPaymentContext();
  const result=requestId?await startTeamRecipientOnboarding(composition,user.id,requestId):await refreshTeamRecipient(composition,user.id);
  return teamJson({recipient:result.status,...("url" in result?{url:result.url}:{})});
 }catch(error){return teamError(error);}
}
