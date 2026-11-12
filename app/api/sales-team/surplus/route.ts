import {NextResponse} from "next/server";
import {authorizedSchedulingCron} from "@/lib/schedulingCron";
import {teamSurplusDailySchemaReady,teamSurplusExecutionReady} from "@/lib/salesTeams/policy";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {runTeamDailySurplus} from "@/lib/salesTeams/dailySurplus";
export const maxDuration=120;
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"private, no-store"}});
/** One bounded daily slot. No scheduler is registered or activated here. */
export async function GET(req:Request){
 if(!authorizedSchedulingCron(req))return reply({error:"Unauthorized"},401);
 if(!teamSurplusDailySchemaReady())return reply({status:"held"},409);
 try{return reply(await runTeamDailySurplus(createTeamPaymentContext(),{admitNew:teamSurplusExecutionReady()}));}
 catch{console.error("[sales-team-surplus] original surplus requires review");return reply({error:"Surplus requires review. Existing originals and holds are preserved."},409);}
}
