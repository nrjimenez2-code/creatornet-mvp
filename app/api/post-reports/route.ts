import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { submitPostReport } from "@/lib/postReportServer";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return NextResponse.json({ error: "Sign in to report a video." }, { status: 401 });
    return await submitPostReport(req, user.id);
  } catch (error) {
    console.error("[post-reports] submission failed", error);
    return NextResponse.json({ error: "Could not save this report. Please try again." }, { status: 500 });
  }
}
