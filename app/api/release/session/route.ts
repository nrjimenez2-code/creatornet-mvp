import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { hasPrivateAccess, loadReleaseSettings } from "@/lib/release/server";
import { featureOpen } from "@/lib/release/policy";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  let privateAccess = false;
  const settings = await loadReleaseSettings();
  try { privateAccess = await hasPrivateAccess(await getAuthenticatedUser(req), settings); } catch { /* deny */ }
  return NextResponse.json({ privateAccess, publicFeed: featureOpen(settings, "feed"), registrationOpen: featureOpen(settings, "registration") }, { headers: { "Cache-Control": "private, no-store" } });
}
