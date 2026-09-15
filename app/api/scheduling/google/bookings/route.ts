import {NextRequest,NextResponse} from "next/server";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {allowRequest, tooManyRequests} from "@/lib/rateLimit";
import {supabaseAdmin as db} from "@/lib/supabaseAdmin";
import {isBookingId} from "@/lib/googleBookingUrl";
const headers={"Cache-Control":"private, no-store"};
export async function GET(req:NextRequest){
 const user=await getAuthenticatedUser(req);if(!user)return NextResponse.json({error:"Sign in to view bookings"},{status:401,headers});
 // Both triggers (Refresh, Load more) are disabled while a load is in flight, so
 // a human cannot approach this; it exists to stop a scripted loop.
 if(!allowRequest(`google-bookings:${user.id}`,{limit:120,windowMs:60_000}))return tooManyRequests();
 const q=req.nextUrl.searchParams,role=q.get("role")??"buyer",before=q.get("before"),beforeId=q.get("before_id");
 if(!["buyer","creator"].includes(role)||((before!==null)!==(beforeId!==null))||(before!==null&&(!Number.isFinite(Date.parse(before))||!isBookingId(beforeId))))return NextResponse.json({error:"Invalid booking page"},{status:400,headers});
 // A deployment that has not enabled the Google schema does not query its tables.
 if(process.env.GOOGLE_CALENDAR_ENABLED!=="true")return NextResponse.json({bookings:[],next:null},{headers});
 try{
  const result=await db.rpc("list_google_bookings_v1",{p_actor:user.id,p_role:role,p_before:before,p_before_id:beforeId});
  if(result.error)throw result.error;
  const rows=result.data??[],bookings=rows.slice(0,20),last=bookings.at(-1);
  return NextResponse.json({bookings,next:rows.length>20&&last?{before:last.created_at,before_id:last.id}:null},{headers});
 }catch{return NextResponse.json({error:"Could not load Google bookings. Try again."},{status:503,headers});}
}
