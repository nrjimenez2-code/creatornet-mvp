import "server-only";
import { adminClient } from "@/lib/admin/server";
import type { AdminPostReport, NotificationStatus, ReportReason, ReportStatus } from "@/lib/postReports";

export const REPORT_PAGE_SIZE = 20;
type ReportRow = {
  id: string; post_id: string; reporter_id: string; reason: ReportReason;
  details: string | null; status: ReportStatus; notification_status: NotificationStatus; created_at: string;
};
type PostRow = { id: string; title: string | null; video_url: string | null; poster_url: string | null; creator_id: string | null; user_id: string | null; hidden_at: string | null; removed_at: string | null };
type ProfileRow = { id: string; username: string | null };
type CountRow = { post_id: string; report_count: number };

export interface ReportPage { reports: AdminPostReport[]; total: number; nextOffset: number | null }

async function hydrateReports(rows: ReportRow[]): Promise<AdminPostReport[]> {
  const admin = adminClient();
  const postIds = Array.from(new Set(rows.map((row) => row.post_id)));
  if (postIds.length === 0) return [];

  const [postResult, countResult] = await Promise.all([
    admin.from("posts").select("id, title, video_url, poster_url, creator_id, user_id, hidden_at, removed_at")
      .in("id", postIds).returns<PostRow[]>(),
    admin.rpc("post_report_counts", { p_post_ids: postIds }),
  ]);
  if (postResult.error) throw postResult.error;
  if (countResult.error) throw countResult.error;
  const posts = new Map((postResult.data ?? []).map((post) => [post.id, post]));
  const countRows = (countResult.data ?? []) as CountRow[];
  const counts = new Map(countRows.map((row) => [row.post_id, Number(row.report_count)]));
  const creatorIds = Array.from(new Set((postResult.data ?? []).map((post) => post.creator_id ?? post.user_id).filter((id): id is string => !!id)));
  const profilesResult = creatorIds.length ? await admin.from("profiles").select("id, username")
    .in("id", creatorIds).returns<ProfileRow[]>() : { data: [] as ProfileRow[], error: null };
  if (profilesResult.error) throw profilesResult.error;
  const profiles = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));

  return rows.map((row): AdminPostReport => {
    const post = posts.get(row.post_id);
    const creatorId = post?.creator_id ?? post?.user_id ?? null;
    return {
      id: row.id, postId: row.post_id, reporterId: row.reporter_id,
      reason: row.reason, details: row.details, status: row.status,
      notificationStatus: row.notification_status, createdAt: row.created_at,
      reportCount: counts.get(row.post_id) ?? 1,
      postTitle: post?.title ?? "Untitled video", videoUrl: post?.video_url ?? null,
      posterUrl: post?.poster_url ?? null, creatorId,
      creatorUsername: creatorId ? profiles.get(creatorId)?.username ?? "creator" : "creator",
      postStatus: post?.removed_at ? "removed" : post?.hidden_at ? "hidden" : "live",
    };
  });
}

export async function fetchAdminReportsPage(status: ReportStatus, offset: number): Promise<ReportPage> {
  const admin = adminClient();
  const { data, error, count } = await admin.from("post_reports")
    .select("id, post_id, reporter_id, reason, details, status, notification_status, created_at", { count: "exact" })
    .eq("status", status).order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(offset, offset + REPORT_PAGE_SIZE - 1).returns<ReportRow[]>();
  if (error) throw error;
  const rows = data ?? [];
  const reports = await hydrateReports(rows);
  const total = count ?? rows.length;
  return { reports, total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
}

export async function fetchAdminReportById(id: string): Promise<AdminPostReport | null> {
  const { data, error } = await adminClient().from("post_reports")
    .select("id, post_id, reporter_id, reason, details, status, notification_status, created_at")
    .eq("id", id).maybeSingle<ReportRow>();
  if (error) throw error;
  if (!data) return null;
  return (await hydrateReports([data]))[0] ?? null;
}
