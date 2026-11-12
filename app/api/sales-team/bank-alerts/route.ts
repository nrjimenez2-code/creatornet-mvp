import {NextRequest} from "next/server";
import {teamId,teamBankAlertsSchemaReady,teamBankAlertsReadReady,TeamSalesError} from "@/lib/salesTeams/policy";
import {teamError,teamJson,teamRequest,teamRpc} from "@/lib/salesTeams/server";
function errorResponse(error:unknown){
 const message=String((error as {message?:string})?.message||"");
 if(["BANK_ALERT_ACCESS_DENIED","TEAM_STATEMENT_ACCESS_DENIED"].some(code=>message.includes(code)))
  return teamJson({code:"BANK_ALERT_ACCESS_DENIED",error:"These payout alerts are unavailable to your account."},403);
 if(message.includes("INVALID_BANK_ALERT_CURSOR"))return teamJson({code:"INVALID_BANK_ALERT_CURSOR",error:"Refresh the payout alerts."},400);
 if(message.includes("BANK_ALERT_AUTHORITY_REQUIRED"))return teamJson({code:"BANK_ALERT_AUTHORITY_REQUIRED",error:"Payout alerts are currently held."},409);
 return teamError(error);
}
export async function GET(req:NextRequest){
 try{
  if(!teamBankAlertsSchemaReady())throw new TeamSalesError("BANK_ALERTS_NOT_ENABLED","Payout alerts are not available yet.",404);
  const {admin,user}=await teamRequest(req),cursor=req.nextUrl.searchParams.get("cursor");
  const result=await teamRpc<Record<string,unknown>>(admin,"read_sales_team_bank_alerts_v1",{
   p_creator_id:teamId(req.nextUrl.searchParams.get("creator_id")),p_actor_id:user.id,p_cursor:cursor?teamId(cursor):null,p_limit:20
  });
  return teamJson({...result,canMarkRead:teamBankAlertsReadReady()});
 }catch(error){return errorResponse(error);}
}
export async function POST(req:NextRequest){
 try{
  if(!teamBankAlertsReadReady())throw new TeamSalesError("BANK_ALERT_READS_HELD","Marking payout alerts read is currently held.");
  if(req.headers.get("origin")!==new URL(req.url).origin)throw new TeamSalesError("SAME_ORIGIN_REQUIRED","Use this CreatorNet page to mark an alert read.",403);
  const {admin,user}=await teamRequest(req),raw=await req.text();
  if(raw.length>1024)throw new TeamSalesError("INVALID_BANK_ALERT_READ","Use a bounded alert request.",400);
  let body:unknown;try{body=JSON.parse(raw);}catch{throw new TeamSalesError("INVALID_BANK_ALERT_READ","Refresh the payout alerts.",400);}
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>!["creator_id","alert_id"].includes(key)))
   throw new TeamSalesError("INVALID_BANK_ALERT_READ","Choose an alert from your payout history.",400);
  const input=body as Record<string,unknown>;
  return teamJson(await teamRpc(admin,"mark_sales_team_bank_alert_read_v1",{p_creator_id:teamId(input.creator_id),p_actor_id:user.id,p_alert_id:teamId(input.alert_id)}));
 }catch(error){return errorResponse(error);}
}
