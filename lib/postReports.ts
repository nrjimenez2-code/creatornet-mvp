export const REPORT_REASONS = [
  { value: "sexual_content", label: "Sexual content or nudity" },
  { value: "harassment", label: "Harassment or hate" },
  { value: "violence", label: "Violence or dangerous content" },
  { value: "spam", label: "Spam or scam" },
  { value: "other", label: "Other" },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]["value"];
export type ReportStatus = "open" | "reviewed" | "dismissed";
export type NotificationStatus = "pending" | "sent" | "failed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isReportId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isReportReason(value: unknown): value is ReportReason {
  return REPORT_REASONS.some((reason) => reason.value === value);
}

export function reportReasonLabel(value: ReportReason): string {
  return REPORT_REASONS.find((reason) => reason.value === value)?.label ?? "Other";
}

export interface AdminPostReport {
  id: string;
  postId: string;
  reporterId: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  notificationStatus: NotificationStatus;
  createdAt: string;
  reportCount: number;
  postTitle: string;
  videoUrl: string | null;
  posterUrl: string | null;
  creatorId: string | null;
  creatorUsername: string;
  postStatus: "live" | "hidden" | "removed";
}
