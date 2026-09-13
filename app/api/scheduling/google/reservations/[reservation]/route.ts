import {NextRequest,NextResponse} from "next/server";
import {getAuthenticatedUser} from "@/lib/supabaseConnectAuth";
import {readGoogleBuyerReservation,cancelGoogleBuyerBooking} from "@/lib/googleBuyerBookings";
import {isBookingId} from "@/lib/googleBookingUrl";
import {googleCalendarAvailable,schedulingOrigin} from "@/lib/schedulingConfig";
import {allowRequest} from "@/lib/rateLimit";
const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"};
export async function GET(req:NextRequest,{params}:{params:Promise<{reservation:string}>}) {
  const user=await getAuthenticatedUser(req);
  if(!user)return NextResponse.json({error:"Sign in to view your booking"},{status:401,headers});
  const {reservation:id}=await params;
  if(!isBookingId(id))return NextResponse.json({error:"Booking not found"},{status:404,headers});
  try {
    const reservation=await readGoogleBuyerReservation(id,user.id);
    if(!reservation)return NextResponse.json({error:"Booking not found"},{status:404,headers});
    return NextResponse.json({reservation},{headers});
  }catch{return NextResponse.json({error:"Could not check your booking. Try again."},{status:503,headers});}
}

export async function DELETE(req:NextRequest,{params}:{params:Promise<{reservation:string}>}) {
  const user=await getAuthenticatedUser(req);
  if(!user)return NextResponse.json({error:"Sign in to manage your booking"},{status:401,headers});
  if(!googleCalendarAvailable())return NextResponse.json({error:"Google booking is unavailable"},{status:503,headers});
  if(req.headers.get("origin")!==schedulingOrigin())return NextResponse.json({error:"Invalid origin"},{status:403,headers});
  if(!allowRequest(`google-cancel:${user.id}`,{limit:10,windowMs:60000}))return NextResponse.json({error:"Please wait before trying again"},{status:429,headers});
  const {reservation:id}=await params;
  if(!isBookingId(id))return NextResponse.json({error:"Booking not found"},{status:404,headers});
  try {
    const body=await req.json();
    return NextResponse.json({reservation:await cancelGoogleBuyerBooking(id,user.id,body.revision)},{status:202,headers});
  }catch{return NextResponse.json({error:"Could not request cancellation. Check your booking status and try again."},{status:409,headers});}
}
