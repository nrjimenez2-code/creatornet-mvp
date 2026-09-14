import {NextResponse} from "next/server";
import {processNextGoogleBookingJob} from "@/lib/googleBookingJobs";
import {googleCalendarAvailable} from "@/lib/schedulingConfig";
import {authorizedSchedulingCron} from "@/lib/schedulingCron";
import {runSchedulingBatch} from "@/lib/googleSchedulingBatch";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=240;
const headers={"Cache-Control":"no-store"};
export async function GET(req:Request) {
 if(!authorizedSchedulingCron(req))return NextResponse.json({error:"Unauthorized"},{status:401,headers});
 if(!googleCalendarAvailable())return NextResponse.json({processed:0,enabled:false},{headers});
 const {processed,retries,failed}=await runSchedulingBatch(processNextGoogleBookingJob,{concurrency:4,maxAttempts:40,budgetMs:60000});
 return NextResponse.json({processed,retries,...failed?{error:"Google booking processing needs retry"}:{}},{status:failed?503:200,headers});
}
