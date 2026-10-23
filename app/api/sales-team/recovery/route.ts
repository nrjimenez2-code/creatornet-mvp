import {NextResponse} from "next/server";
import {authorizedSchedulingCron} from "@/lib/schedulingCron";
import {teamAutomaticRecoveryReady,teamAutomaticRefundRecoveryReady,teamFulfillmentReady} from "@/lib/salesTeams/policy";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {runTeamAutomaticRecovery} from "@/lib/salesTeams/recovery";
export const maxDuration=120;
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"private, no-store"}});
/** No scheduler is registered by this route. Activation needs separate scope. */
export async function GET(req:Request){
 if(!authorizedSchedulingCron(req))return reply({error:"Unauthorized"},401);
 if(!teamAutomaticRecoveryReady())return reply({status:"held"},409);
 try{return reply(await runTeamAutomaticRecovery(createTeamPaymentContext(),{fulfill:teamFulfillmentReady(),recoverRefunds:teamAutomaticRefundRecoveryReady()}));}
 catch{console.error("[sales-team-recovery] original inspection requires review");return reply({error:"Original recovery requires review. Existing holds are preserved."},409);}
}
