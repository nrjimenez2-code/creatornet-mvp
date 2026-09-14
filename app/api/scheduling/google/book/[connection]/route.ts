import {NextRequest,NextResponse} from "next/server";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {getGoogleBookingOptions,submitGoogleBooking} from "@/lib/googleBuyerBookings";
import {googleCalendarAvailable,schedulingOrigin} from "@/lib/schedulingConfig";
import {allowRequest} from "@/lib/rateLimit";
export const runtime="nodejs";
export const maxDuration=60;
const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"};
type Context={params:Promise<{connection:string}>};
export async function GET(req:NextRequest,{params}:Context) {
  const user=await getAuthenticatedUser(req);
  if(!user)return NextResponse.json({error:"Sign in to book this call"},{status:401,headers});
  if(!googleCalendarAvailable())return NextResponse.json({error:"Google booking is unavailable"},{status:503,headers});
  if(!allowRequest(`google-slots:${user.id}`,{limit:30,windowMs:60000}))return NextResponse.json({error:"Please wait before checking again"},{status:429,headers});
  try {
    const query=req.nextUrl.searchParams;
    const now=Date.now();
    const result=await getGoogleBookingOptions((await params).connection,user.id,{attributionId:query.get("cn_attribution")??undefined,purchaseId:query.get("purchase_id")??undefined,reservationId:query.get("reservation_id")??undefined},
      {start:query.get("start")??new Date(now).toISOString(),end:query.get("end")??new Date(now+7*86400000).toISOString()});
    return NextResponse.json(result,{headers});
  }catch{return NextResponse.json({error:"Could not load booking times. Open this calendar from your booking or eligible purchase and try again."},{status:409,headers});}
}
export async function POST(req:NextRequest,{params}:Context) {
  const user=await getAuthenticatedUser(req);
  if(!user)return NextResponse.json({error:"Sign in to book this call"},{status:401,headers});
  if(!googleCalendarAvailable())return NextResponse.json({error:"Google booking is unavailable"},{status:503,headers});
  if(req.headers.get("origin")!==schedulingOrigin())return NextResponse.json({error:"Invalid origin"},{status:403,headers});
  if(!allowRequest(`google-reserve:${user.id}`,{limit:10,windowMs:60000}))return NextResponse.json({error:"Please wait before trying again"},{status:429,headers});
  try {
    const body=await req.json();
    const reservation=await submitGoogleBooking((await params).connection,user.id,{attributionId:body.attributionId,purchaseId:body.purchaseId,reservationId:body.reservationId},body.start,body.end);
    return NextResponse.json({reservation},{status:202,headers});
  }catch{return NextResponse.json({error:"Could not reserve that time. Check your booking status and choose an available time again."},{status:409,headers});}
}
