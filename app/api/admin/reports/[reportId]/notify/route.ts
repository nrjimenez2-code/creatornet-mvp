import { NextRequest, NextResponse } from "next/server";
import { adminAuthErrorResponse, requireAdmin } from "@/lib/admin/server";
import { sendReportEmail } from "@/lib/admin/reportEmail";
import { isReportId, type ReportReason } from "@/lib/postReports";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ reportId: string }> }) {
  let context: Awaited<ReturnType<typeof requireAdmin>>;
  try { context = await requireAdmin(req); } catch (error) { return adminAuthErrorResponse(error, "notify-report"); }
  const { reportId } = await params;
  if (!isReportId(reportId)) return NextResponse.json({ error: "Invalid report" }, { status: 400 });
  try {
    const { data: report, error } = await context.admin.from("post_reports")
      .select("id, post_id, reason, notification_status").eq("id", reportId)
      .maybeSingle<{ id: string; post_id: string; reason: ReportReason; notification_status: string }>();
    if (error) throw error;
    if (!report) return NextResponse.json({ error: "Report not found" }, { status: 404 });
    if (report.notification_status === "sent") return NextResponse.json({ ok: true, notificationStatus: "sent" });
    const { data: post, error: postError } = await context.admin.from("posts").select("title")
      .eq("id", report.post_id).maybeSingle<{ title: string | null }>();
    if (postError) throw postError;
    const sent = await sendReportEmail({ reportId, postId: report.post_id, title: post?.title ?? "Untitled video", reason: report.reason });
    const notificationStatus = sent ? "sent" : "failed";
    const { error: updateError } = await context.admin.from("post_reports")
      .update({ notification_status: notificationStatus, notified_at: sent ? new Date().toISOString() : null })
      .eq("id", reportId);
    if (updateError) throw updateError;
    return NextResponse.json({ ok: sent, notificationStatus }, { status: sent ? 200 : 503 });
  } catch (error) {
    console.error("[admin:reports] notification retry failed", error);
    return NextResponse.json({ error: "Could not send alert" }, { status: 500 });
  }
}
