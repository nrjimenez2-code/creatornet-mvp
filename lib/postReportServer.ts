import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { isReportId, isReportReason, type ReportReason } from "@/lib/postReports";
import { sendReportEmail } from "@/lib/admin/reportEmail";

type PostRow = { id: string; creator_id: string | null; user_id: string | null; title: string | null };
type InsertedReport = { id: string; notification_status: string };

/** Shared website/native report write. The verified reporter ID is never read from the body. */
export async function submitPostReport(req: NextRequest, reporterId: string): Promise<Response> {
  if (!allowRequest(`post-report-user:${reporterId}`, { limit: 20, windowMs: 3_600_000 })) return tooManyRequests();
  const ip = clientKey(req);
  if (ip !== "unknown" && !allowRequest(`post-report-ip:${ip}`, { limit: 60, windowMs: 3_600_000 })) return tooManyRequests();

  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid report." }, { status: 400 });
  const input = body as Record<string, unknown>;
  if (!isReportId(input.postId) || !isReportReason(input.reason) ||
      (input.details !== undefined && typeof input.details !== "string")) {
    return NextResponse.json({ error: "Choose a reason and try again." }, { status: 400 });
  }
  const details = typeof input.details === "string" ? input.details.trim() : "";
  if (details.length > 500) return NextResponse.json({ error: "Details must be 500 characters or less." }, { status: 400 });
  const reason: ReportReason = input.reason;

  const { data: post, error: postError } = await supabaseAdmin.from("posts")
    .select("id, creator_id, user_id, title").eq("id", input.postId).maybeSingle<PostRow>();
  if (postError) throw postError;
  if (!post) return NextResponse.json({ error: "Video not found." }, { status: 404 });
  if ((post.creator_id ?? post.user_id) === reporterId) {
    return NextResponse.json({ error: "You cannot report your own video." }, { status: 400 });
  }

  const { data: report, error: insertError } = await supabaseAdmin.from("post_reports")
    .insert({ post_id: post.id, reporter_id: reporterId, reason, details: details || null })
    .select("id, notification_status").single<InsertedReport>();
  if (insertError?.code === "23505") {
    return NextResponse.json({ error: "You already reported this video. Thank you for letting us know." }, { status: 409 });
  }
  if (insertError || !report) throw insertError ?? new Error("Report insert returned no row");

  const sent = await sendReportEmail({ reportId: report.id, postId: post.id, title: post.title ?? "Untitled video", reason });
  const { error: notificationError } = await supabaseAdmin.from("post_reports")
    .update({ notification_status: sent ? "sent" : "failed", notified_at: sent ? new Date().toISOString() : null })
    .eq("id", report.id);
  if (notificationError) console.error("[post-reports] could not record alert result", notificationError);
  return NextResponse.json({ ok: true, reportId: report.id }, { status: 201 });
}
