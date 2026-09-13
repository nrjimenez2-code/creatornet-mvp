import {createHash,timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {processNextGoogleBookingJob} from "@/lib/googleBookingJobs";
import {maintainGoogleCalendarWatches,processGoogleCalendarSweep} from "@/lib/googleCalendarReconciliation";
import {googleCalendarAvailable} from "@/lib/schedulingConfig";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=240;
const headers={"Cache-Control":"no-store"};
export async function GET(req:Request) {
  const secret=process.env.CRON_SECRET;
  const hash=(value:string)=>createHash("sha256").update(value).digest();
  if(!secret || secret.length<32 || !timingSafeEqual(hash(req.headers.get("authorization")??""),hash(`Bearer ${secret}`)))
    return NextResponse.json({error:"Unauthorized"},{status:401,headers});
  if(!googleCalendarAvailable())return NextResponse.json({processed:0,enabled:false},{headers});
  try {
    const deadline=Date.now()+60000;
    let processed=0,retries=0;
    while(processed<4 && Date.now()<deadline) {
      const result=await processNextGoogleBookingJob();
      if(!result.processed)break;
      processed++;if(result.retry)retries++;
    }
    let maintenanceFailed=false;
    try{await maintainGoogleCalendarWatches();}catch{maintenanceFailed=true;}
    try{await processGoogleCalendarSweep();}catch{maintenanceFailed=true;}
    if(maintenanceFailed)return NextResponse.json({processed,retries,error:"Calendar maintenance needs retry"},{status:503,headers});
    return NextResponse.json({processed,retries},{headers});
  }catch{return NextResponse.json({error:"Google booking processing needs retry"},{status:503,headers});}
}
