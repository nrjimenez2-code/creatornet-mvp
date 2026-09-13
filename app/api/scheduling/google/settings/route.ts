import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { getGoogleCalendarSetup, saveGoogleCalendarSetup } from "@/lib/googleCalendarConnection";
import { googleCalendarAvailable, schedulingOrigin } from "@/lib/schedulingConfig";
import { allowRequest } from "@/lib/rateLimit";
export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };
export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error:"Sign in first" },{status:401,headers});
  if (!googleCalendarAvailable()) return NextResponse.json({error:"Google Calendar setup is unavailable"},{status:503,headers});
  try { return NextResponse.json(await getGoogleCalendarSetup(user.id),{headers}); }
  catch { return NextResponse.json({error:"Could not load calendars. Reconnect Google Calendar and try again."},{status:503,headers}); }
}
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({error:"Sign in first"},{status:401,headers});
  if (!googleCalendarAvailable()) return NextResponse.json({error:"Google Calendar setup is unavailable"},{status:503,headers});
  if (req.headers.get("origin") !== schedulingOrigin()) return NextResponse.json({error:"Invalid origin"},{status:403,headers});
  if (!allowRequest(`google-setup:${user.id}`,{limit:10,windowMs:60000})) return NextResponse.json({error:"Please wait before trying again"},{status:429,headers});
  try { await saveGoogleCalendarSetup(user.id,await req.json());return NextResponse.json({ok:true},{headers}); }
  catch { return NextResponse.json({error:"Could not save your calendar settings. Check your calendar selection and booking hours, then try again."},{status:503,headers}); }
}
