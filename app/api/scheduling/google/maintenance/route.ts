import {NextResponse} from "next/server";
import {maintainGoogleCalendarWatches} from "@/lib/googleCalendarReconciliation";
import {googleCalendarAvailable} from "@/lib/schedulingConfig";
import {authorizedSchedulingCron} from "@/lib/schedulingCron";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=240;
const headers={"Cache-Control":"no-store"};
export async function GET(req:Request){
 if(!authorizedSchedulingCron(req))return NextResponse.json({error:"Unauthorized"},{status:401,headers});
 if(!googleCalendarAvailable())return NextResponse.json({enabled:false},{headers});
 try{await maintainGoogleCalendarWatches();return NextResponse.json({ok:true},{headers});}
 catch{return NextResponse.json({error:"Calendar maintenance needs retry"},{status:503,headers});}
}
