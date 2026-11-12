import { NextRequest } from "next/server";
import { teamId,teamLedgerSchemaReady,teamPayoutStatementsSchemaReady,TeamSalesError } from "@/lib/salesTeams/policy";
import { teamError,teamJson,teamRequest,teamRpc } from "@/lib/salesTeams/server";

export async function GET(req:NextRequest){
 try{
  if(!teamLedgerSchemaReady())throw new TeamSalesError("TEAM_STATEMENTS_NOT_ENABLED","Team commission statements are not available yet.",404);
  const {admin,user}=await teamRequest(req),creator=req.nextUrl.searchParams.get("creator_id");
  if(!creator){
   const rows=await admin.from("sales_team_memberships_v1").select("creator_id,role,status").eq("user_id",user.id).order("created_at",{ascending:false}).limit(100);
   if(rows.error)throw rows.error;return teamJson({relationships:rows.data||[]});
  }
  const cursor=req.nextUrl.searchParams.get("cursor");
  return teamJson(await teamRpc(admin,teamPayoutStatementsSchemaReady()?"read_sales_team_payout_statement_v1":"read_sales_team_statement_v1",{p_creator_id:teamId(creator),p_actor_id:user.id,p_cursor:cursor?teamId(cursor):null,p_limit:20}));
 }catch(error){return teamError(error);}
}
