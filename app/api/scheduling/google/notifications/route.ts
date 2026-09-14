import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { openSchedulingSecret } from "@/lib/schedulingSecrets";
import { verifyGoogleCalendarNotification } from "@/lib/googleCalendarProvider";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  const id=req.headers.get("x-goog-channel-id") ?? "";
  if (!/^[a-f0-9-]{36}$/i.test(id)) return new NextResponse(null,{status:404});
  try {
    const result=await db.from("google_calendar_watches_v1").select("id,connection_id,resource_id,expires_at,token_ciphertext,status").eq("id",id).maybeSingle();
    if(result.error) throw result.error;
    const watch=result.data;
    if(!watch || !["active","pending","retiring"].includes(watch.status)) return new NextResponse(null,{status:404});
    // Google may send its initial sync before the watch response has been saved.
    // A retry will validate the returned resource identity once it is available.
    if(!watch.resource_id) return new NextResponse(null,{status:503});
    const owner=await db.from("scheduling_connections_v1").select("creator_id").eq("id",watch.connection_id).eq("provider","google").single();
    if(owner.error) throw owner.error;
    const token=openSchedulingSecret(watch.token_ciphertext,`${owner.data.creator_id}:google:watch:${watch.id}`);
    if(!verifyGoogleCalendarNotification(req.headers,{id:watch.id,resourceId:watch.resource_id,expiration:String(Date.parse(watch.expires_at)),token})) return new NextResponse(null,{status:401});
    const saved=await db.rpc("request_google_calendar_sync_v1",{p_watch:watch.id});
    if(saved.error) throw saved.error;
    // The reconciliation worker fetches authoritative events; notification headers never award credit.
    return new NextResponse(null,{status:204});
  } catch { return new NextResponse(null,{status:503}); }
}
