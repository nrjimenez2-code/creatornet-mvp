const postIds: string[][] = [];
const reportRows = [{
  id: "report-1", post_id: "old-post", reporter_id: "viewer", reason: "sexual_content",
  details: "Example", status: "open", notification_status: "failed", created_at: "2026-09-23T00:00:00Z",
}];

jest.mock("@/lib/admin/server", () => ({
  adminClient: () => ({
    from: (table: string) => {
      if (table === "post_reports") return {
        select: () => ({ eq: () => ({ order: () => ({ order: () => ({ range: () => ({ returns: async () => ({ data: reportRows, error: null, count: 1 }) }) }) }) }) }),
      };
      if (table === "posts") return {
        select: () => ({ in: (_column: string, ids: string[]) => {
          postIds.push(ids);
          return { returns: async () => ({ data: [{ id: "old-post", title: "Older video", video_url: "https://example.invalid/video.mp4", poster_url: null, creator_id: "creator", user_id: null, hidden_at: null, removed_at: null }], error: null }) };
        } }),
      };
      return { select: () => ({ in: () => ({ returns: async () => ({ data: [{ id: "creator", username: "maker" }], error: null }) }) }) };
    },
    rpc: async () => ({ data: [{ post_id: "old-post", report_count: 3 }], error: null }),
  }),
}));

import { fetchAdminReportsPage } from "@/lib/admin/reports";

test("admin queue joins a reported older video by id and shows its report count", async () => {
  const page = await fetchAdminReportsPage("open", 0);
  expect(postIds).toEqual([["old-post"]]);
  expect(page.total).toBe(1);
  expect(page.reports[0]).toEqual(expect.objectContaining({
    postId: "old-post", postTitle: "Older video", creatorUsername: "maker", reportCount: 3,
    notificationStatus: "failed", reason: "sexual_content",
  }));
});
