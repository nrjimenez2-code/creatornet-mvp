import {NextRequest} from "next/server";
import {teamId,teamBankQueueSchemaReady,TeamSalesError} from "@/lib/salesTeams/policy";
import {teamError,teamJson,teamRequest,teamRpc} from "@/lib/salesTeams/server";

export async function GET(req:NextRequest){
 try{
  if(!teamBankQueueSchemaReady())throw new TeamSalesError("BANK_QUEUE_NOT_ENABLED","Payout review discovery is not available yet.",404);
  const {admin,user}=await teamRequest(req),cursor=req.nextUrl.searchParams.get("cursor");
  return teamJson(await teamRpc(admin,"read_sales_team_bank_exception_queue_v1",{
   p_creator_id:teamId(req.nextUrl.searchParams.get("creator_id")),p_actor_id:user.id,
   p_cursor:cursor?teamId(cursor):null,p_limit:20
  }));
 }catch(error){
  const message=String((error as {message?:string})?.message||"");
  if(message.includes("INVALID_BANK_QUEUE_CURSOR"))return teamJson({code:"INVALID_BANK_QUEUE_CURSOR",error:"Refresh the payout review list."},400);
  if(message.includes("BANK_REVIEW_ACCESS_DENIED")||message.includes("TEAM_STATEMENT_ACCESS_DENIED"))
   return teamJson({code:"BANK_REVIEW_ACCESS_DENIED",error:"This payout review list is unavailable to your account."},403);
  return teamError(error);
 }
}
