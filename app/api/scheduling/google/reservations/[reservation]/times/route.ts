import {NextRequest,NextResponse} from "next/server";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {getGoogleRescheduleOptions,rescheduleGoogleBuyerBooking} from "@/lib/googleBuyerBookings";
import {googleCalendarAvailable,schedulingOrigin} from "@/lib/schedulingConfig";
import {isBookingId} from "@/lib/googleBookingUrl";
import {allowRequest} from "@/lib/rateLimit";
export const runtime="nodejs";export const maxDuration=120;
const headers={"Cache-Control":"private, no-store"};
type Context={params:Promise<{reservation:string}>};
export async function GET(req:NextRequest,{params}:Context){
 const user=await getAuthenticatedUser(req);if(!user)return NextResponse.json({error:"Sign in first"},{status:401,headers});
 const {reservation:id}=await params;if(!isBookingId(id))return NextResponse.json({error:"Booking not found"},{status:404,headers});
 if(!googleCalendarAvailable())return NextResponse.json({error:"Calendar unavailable"},{status:503,headers});
 if(!allowRequest(`google-change-times:${user.id}`,{limit:20,windowMs:60000}))return NextResponse.json({error:"Please wait before checking again"},{status:429,headers});
 try{const now=Date.now(),query=req.nextUrl.searchParams;return NextResponse.json(await getGoogleRescheduleOptions(id,user.id,{start:query.get("start")??new Date(now).toISOString(),end:query.get("end")??new Date(now+7*86400000).toISOString()}),{headers});}
 catch{return NextResponse.json({error:"Could not load new times. Check your booking and try again."},{status:409,headers});}
}
export async function POST(req:NextRequest,{params}:Context){
 const user=await getAuthenticatedUser(req);if(!user)return NextResponse.json({error:"Sign in first"},{status:401,headers});
 const {reservation:id}=await params;if(!isBookingId(id))return NextResponse.json({error:"Booking not found"},{status:404,headers});
 if(!googleCalendarAvailable())return NextResponse.json({error:"Calendar unavailable"},{status:503,headers});
 if(req.headers.get("origin")!==schedulingOrigin())return NextResponse.json({error:"Invalid origin"},{status:403,headers});
 if(!allowRequest(`google-change:${user.id}`,{limit:10,windowMs:60000}))return NextResponse.json({error:"Please wait before trying again"},{status:429,headers});
 try{const body=await req.json();return NextResponse.json({reservation:await rescheduleGoogleBuyerBooking(id,user.id,body.revision,body.start,body.end)},{status:202,headers});}
 catch{return NextResponse.json({error:"Could not request the new time. Check your booking and refresh available times."},{status:409,headers});}
}
