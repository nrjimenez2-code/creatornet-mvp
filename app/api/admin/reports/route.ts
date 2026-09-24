import { NextRequest, NextResponse } from "next/server";
import { adminAuthErrorResponse, requireAdmin } from "@/lib/admin/server";
import { fetchAdminReportsPage } from "@/lib/admin/reports";
import type { ReportStatus } from "@/lib/postReports";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try { await requireAdmin(req); } catch (error) { return adminAuthErrorResponse(error, "list-reports"); }
  const status = req.nextUrl.searchParams.get("status") ?? "open";
  const rawOffset = req.nextUrl.searchParams.get("offset") ?? "0";
  if (!(["open", "reviewed", "dismissed"] as string[]).includes(status) || !/^\d{1,6}$/.test(rawOffset)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  try {
    const page = await fetchAdminReportsPage(status as ReportStatus, Number(rawOffset));
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    console.error("[admin:reports] list failed", error);
    return NextResponse.json({ error: "Could not load reports" }, { status: 500 });
  }
}
