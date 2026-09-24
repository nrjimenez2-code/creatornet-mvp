import { NextRequest, NextResponse } from "next/server";
import { adminAuthErrorResponse, requireAdmin } from "@/lib/admin/server";
import { fetchAdminReportById } from "@/lib/admin/reports";
import { isReportId, type ReportStatus } from "@/lib/postReports";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ reportId: string }> }) {
  try { await requireAdmin(req); } catch (error) { return adminAuthErrorResponse(error, "read-report"); }
  const { reportId } = await params;
  if (!isReportId(reportId)) return NextResponse.json({ error: "Invalid report" }, { status: 400 });
  try {
    const report = await fetchAdminReportById(reportId);
    if (!report) return NextResponse.json({ error: "Report not found" }, { status: 404 });
    return NextResponse.json({ report }, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    console.error("[admin:reports] read failed", error);
    return NextResponse.json({ error: "Could not load report" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ reportId: string }> }) {
  let context: Awaited<ReturnType<typeof requireAdmin>>;
  try { context = await requireAdmin(req); } catch (error) { return adminAuthErrorResponse(error, "review-report"); }
  const { reportId } = await params;
  if (!isReportId(reportId)) return NextResponse.json({ error: "Invalid report" }, { status: 400 });
  const body: unknown = await req.json().catch(() => null);
  const status = (body && typeof body === "object" ? (body as Record<string, unknown>).status : null) as ReportStatus | null;
  if (status !== "reviewed" && status !== "dismissed" && status !== "open") {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  try {
    const { data, error } = await context.admin.from("post_reports")
      .update({ status, reviewed_by: status === "open" ? null : context.user.id, reviewed_at: status === "open" ? null : new Date().toISOString() })
      .eq("id", reportId).select("id").maybeSingle<{ id: string }>();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Report not found" }, { status: 404 });
    const { error: auditError } = await context.admin.from("admin_actions").insert({
      actor_id: context.user.id, action: status === "open" ? "reopen_report" : `${status}_report`,
      target_table: "post_reports", target_id: reportId, reason: null,
    });
    if (auditError) throw auditError;
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    console.error("[admin:reports] status update failed", error);
    return NextResponse.json({ error: "Could not update report" }, { status: 500 });
  }
}
