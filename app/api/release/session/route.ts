import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { hasPrivateAccess, loadReleaseSettings } from "@/lib/release/server";
import { featureOpen } from "@/lib/release/policy";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  let privateAccess = false;
  const settings = await loadReleaseSettings();
  try { privateAccess = await hasPrivateAccess(await getAuthenticatedUser(req), settings); } catch { /* deny */ }
  const registrationOpen = featureOpen(settings, "registration");
  // UI capability only; upstream signup/linking safety must be verified before enabling.
  const privateAppleSignInEnabled = settings !== null && !registrationOpen && process.env.PRIVATE_APPLE_SIGN_IN_ENABLED === "true";
  return NextResponse.json({
    privateAccess, publicFeed: featureOpen(settings, "feed"), registrationOpen,
    ...(privateAppleSignInEnabled ? { privateAppleSignInEnabled: true } : {}),
  }, { headers: { "Cache-Control": "private, no-store" } });
}
