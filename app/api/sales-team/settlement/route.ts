import {NextResponse} from "next/server";
import {authorizedSchedulingCron} from "@/lib/schedulingCron";
import {teamAutomaticSettlementReady,teamTransferExecutionReady} from "@/lib/salesTeams/policy";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {runTeamAutomaticSettlement} from "@/lib/salesTeams/settlement";
export const maxDuration=120;
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"private, no-store"}});
/** Proposed 15-minute cadence. No external scheduler is registered here. */
export async function GET(req:Request){
 if(!authorizedSchedulingCron(req))return reply({error:"Unauthorized"},401);
 if(!teamAutomaticSettlementReady())return reply({status:"held"},409);
 try{return reply(await runTeamAutomaticSettlement(createTeamPaymentContext(),{admitNew:teamTransferExecutionReady()}));}
 catch{console.error("[sales-team-settlement] original settlement requires review");return reply({error:"Settlement requires review. Existing originals and holds are preserved."},409);}
}
