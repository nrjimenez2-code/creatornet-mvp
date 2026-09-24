import "server-only";
import { reportReasonLabel, type ReportReason } from "@/lib/postReports";
import { getSiteUrl } from "@/lib/siteUrl";

export interface ReportEmailInput {
  reportId: string;
  postId: string;
  title: string;
  reason: ReportReason;
}

/** A durable database row is saved before this best-effort alert is attempted. */
export async function sendReportEmail(input: ReportEmailInput): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_CODE_FROM;
  const to = process.env.REPORT_NOTIFICATION_EMAIL;
  if (!key || !from || !to) {
    console.error("[post-reports] moderation email configuration is incomplete");
    return false;
  }

  try {
    const adminUrl = new URL(`/admin/content?report=${encodeURIComponent(input.reportId)}`, getSiteUrl()).toString();
    const safeTitle = input.title.replace(/\s+/g, " ").trim().slice(0, 160) || "Untitled video";
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `CreatorNet video report: ${reportReasonLabel(input.reason)}`,
        text: `A video was reported for ${reportReasonLabel(input.reason)}.\n\nVideo: ${safeTitle}\nPost ID: ${input.postId}\nReport ID: ${input.reportId}\n\nReview: ${adminUrl}`,
      }),
    });
    if (!response.ok) {
      console.error("[post-reports] email provider rejected alert", response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[post-reports] email alert failed", error);
    return false;
  }
}
