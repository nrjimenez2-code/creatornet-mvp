import {NextResponse} from "next/server";
import {authorizedSchedulingCron} from "@/lib/schedulingCron";
import {teamAutomaticCollectionSchemaReady,teamAutomaticCollectionReady} from "@/lib/salesTeams/policy";
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
import {runTeamAutomaticCollection} from "@/lib/salesTeams/automaticCollection";
export const maxDuration=120;
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"private, no-store"}});
/** Proposed bounded cadence only. No scheduler is registered by this route. */
export async function GET(req:Request){
 if(!authorizedSchedulingCron(req))return reply({error:"Unauthorized"},401);
 if(!teamAutomaticCollectionSchemaReady())return reply({status:"held"},409);
 try{return reply(await runTeamAutomaticCollection(createTeamPaymentContext(),{admitNew:teamAutomaticCollectionReady()}));}
 catch{console.error("[sales-team-collection] original collection requires review");return reply({error:"Collection requires review. Existing originals and Stop are preserved."},409);}
}
