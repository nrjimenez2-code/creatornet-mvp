import { NextRequest } from "next/server";

const mockUser = jest.fn();
const mockAllow = jest.fn();
const mockSendEmail = jest.fn();
const mockPostLookup = jest.fn();
const mockInsert = jest.fn();
const mockNotificationUpdate = jest.fn();

jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: (...args: unknown[]) => mockUser(...args) }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: (...args: unknown[]) => mockAllow(...args), clientKey: () => "127.0.0.1", tooManyRequests: () => Response.json({ error: "Too many requests" }, { status: 429 }) }));
jest.mock("@/lib/admin/reportEmail", () => ({ sendReportEmail: (...args: unknown[]) => mockSendEmail(...args) }));
jest.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (table: string) => table === "posts" ? {
      select: () => ({ eq: () => ({ maybeSingle: () => mockPostLookup() }) }),
    } : {
      insert: () => ({ select: () => ({ single: () => mockInsert() }) }),
      update: () => ({ eq: () => mockNotificationUpdate() }),
    },
  },
}));

import { POST } from "@/app/api/post-reports/route";

const postId = "11111111-1111-4111-8111-111111111111";
const reportId = "22222222-2222-4222-8222-222222222222";
function request(body: unknown) {
  return new NextRequest("http://localhost/api/post-reports", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  mockUser.mockReset().mockResolvedValue({ id: "reporter" });
  mockAllow.mockReset().mockReturnValue(true);
  mockSendEmail.mockReset().mockResolvedValue(true);
  mockPostLookup.mockReset().mockResolvedValue({ data: { id: postId, creator_id: "owner", user_id: null, title: "Video" }, error: null });
  mockInsert.mockReset().mockResolvedValue({ data: { id: reportId, notification_status: "pending" }, error: null });
  mockNotificationUpdate.mockReset().mockResolvedValue({ error: null });
});

test("sign-in is required before looking up a video", async () => {
  mockUser.mockResolvedValue(null);
  const response = await POST(request({ postId, reason: "spam" }));
  expect(response.status).toBe(401);
  expect(mockPostLookup).not.toHaveBeenCalled();
});

test("invalid reasons and oversized details are rejected without a write", async () => {
  expect((await POST(request({ postId, reason: "invented" }))).status).toBe(400);
  expect((await POST(request({ postId, reason: "spam", details: "x".repeat(501) }))).status).toBe(400);
  expect(mockInsert).not.toHaveBeenCalled();
});

test("owner cannot report their own post", async () => {
  mockUser.mockResolvedValue({ id: "owner" });
  expect((await POST(request({ postId, reason: "spam" }))).status).toBe(400);
  expect(mockInsert).not.toHaveBeenCalled();
});

test("a database duplicate cannot generate another email", async () => {
  mockInsert.mockResolvedValue({ data: null, error: { code: "23505" } });
  expect((await POST(request({ postId, reason: "spam" }))).status).toBe(409);
  expect(mockSendEmail).not.toHaveBeenCalled();
});

test("a saved report succeeds even when email fails and records the failed alert", async () => {
  mockSendEmail.mockResolvedValue(false);
  const response = await POST(request({ postId, reason: "sexual_content", details: "Explicit imagery" }));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ ok: true, reportId });
  expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ reportId, postId, reason: "sexual_content" }));
  expect(mockNotificationUpdate).toHaveBeenCalledTimes(1);
});

test("per-user rate limit rejects excessive submissions", async () => {
  mockAllow.mockReturnValue(false);
  expect((await POST(request({ postId, reason: "spam" }))).status).toBe(429);
  expect(mockInsert).not.toHaveBeenCalled();
});
